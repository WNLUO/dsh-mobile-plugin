// ZeroNews 线路挂载：把运行器接进装配层，隧道地址写回独立字段，随 effect 启停。
// 第一次接入的登录：`zeronews login` 要一直活着轮询设备授权码，浏览器确认后才把 token 落盘，
// 所以这里保留它继续跑、不设 NO_TTY、也不在拿到确认地址后就杀掉（见 defaultLogin）。
'use strict';

/**
 * 单独一个 wiring 是因为 `lib/impl.js` 有代码行数上限（test/assembly-layer.test.cjs 钉着）：
 * 那儿只留一句 require、一句 mount，进程生命周期在 runner.cjs，二进制获取在 provision.cjs。
 *
 * 面板点「连接」→ runner 走 ensure→login→start→建隧道→读域名；这里把域名写进独立字段
 * `zeroNewsUrl`（总控按 kind:'custom' 上报），并随配置变化自动重连 / 卸载时停进程。
 *
 * **稳定门面**：就地重载会重新 apply、新建一个 runner，但控制面路由只认第一次挂上去的那个
 * 对象引用。所以对外的 start/stop/status 一律转发到模块级 `current`（最新一次 mount 出来的
 * 那套 runner+写回），重载后路由调到的仍是最新实现。
 */

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');

const { createZeroNewsRunner } = require('./runner.cjs');
const { ensureZeroNews } = require('./provision.cjs');
const { createZeroNewsAccountReader } = require('./account.cjs');

/** 取命令行输出里的第一条 http(s) 链接：`zeronews login` 会把这台机器的确认页打在这一行。 */
function firstHttpUrl(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  }
  return '';
}

/**
 * 跑 `zeronews login`，把确认链接交出去，同时让这个进程继续在后台跑。
 *
 * 实测：不带 NO_TTY 时它打印完确认地址并不会退出——它一直轮询那个设备授权码，等用户在浏览器
 * 点了确认，才把 token 写进本机配置再退出。所以这里故意**不设 NO_TTY、拿到地址后也不杀掉它**：
 * 拿地址只是为了把确认页打开，进程留着轮询，授权一完成就自己落盘。之前用 NO_TTY=1 + 20 秒超时
 * 就杀的写法，只留下「待确认」却没人去兑换，于是浏览器显示授权成功、本机永远 login:false，
 * 面板卡在「正在接入」。
 *
 * 返回 `{ already, url, error, child }`：`child` 是仍在轮询的进程句柄，由调用方负责在重开 / 停止时收掉。
 */
function defaultLogin(binary, clientLabel, deps = {}) {
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : spawn;
  return new Promise((resolve) => {
    const args = ['login'];
    if (clientLabel) args.push('--client', clientLabel);
    let child;
    let settled = false;
    let buffer = '';
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      child = spawnFn(binary, args, { cwd: path.dirname(binary), windowsHide: true, env: { ...process.env } });
    } catch {
      return settle({ already: false, url: '', error: 'could not start login' });
    }
    const onChunk = (chunk) => {
      buffer += String(chunk || '');
      if (settled) return;
      const url = firstHttpUrl(buffer);
      if (url) settle({ already: false, url, error: '', child });
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onChunk);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', onChunk);
    if (typeof child.on === 'function') {
      child.on('error', () => settle({ already: false, url: '', error: 'could not start login' }));
      child.on('exit', (code) => {
        if (settled) return; // 已经拿到地址、正等用户确认，这次退出不用管
        if (/already logged in/i.test(buffer)) return settle({ already: true, url: '', error: '' });
        settle({ already: false, url: '', error: buffer.trim() || `zeronews login exited ${code}` });
      });
    }
  });
}

/**
 * 用系统默认浏览器打开一个地址。
 *
 * 面板跑在 DSH 的网页壳里，`window.open` 能不能落到系统浏览器取决于宿主；这里是本机 node
 * 进程，`open` / `start` / `xdg-open` 一定到得了。打不开就回 false，让面板把地址写出来给人
 * 手动点 —— 不假装开过。
 */
function openInBrowser(url, exec = execFile) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    try {
      // 命令退出（含打不开的报错）就是结果；只等 error 会在浏览器正常打开时永远等不到。
      const child = exec(command, args, { windowsHide: true }, (err) => resolve(!err));
      if (!child || typeof child.on !== 'function') resolve(false);
      else child.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

/** 最新一次 mount 出来的操作集。放 globalThis：就地重载会换掉整个模块作用域，只有全局变量
 *  能跨代存活，保证路由手里那份门面永远转发到最新一份实现。 */
const GLOBAL_KEY = '__dshZeroNewsCurrent';
const readCurrent = () => globalThis[GLOBAL_KEY] || null;
/** 只建一次的门面，路由长期持有；方法都转发到全局 current。 */
const facade = {
  start: (token) => (readCurrent() ? readCurrent().start(token) : Promise.resolve({ phase: 'off' })),
  stop: () => (readCurrent() ? readCurrent().stop() : Promise.resolve({ phase: 'off' })),
  status: () => (readCurrent() ? readCurrent().status() : { available: false, running: false, phase: 'off', url: '', error: '', configured: false }),
  prepare: () => (readCurrent() ? readCurrent().prepare() : Promise.resolve({ ok: false, error: '这台宿主没有接入 ZeroNews 线路能力' })),
  account: () => (readCurrent() ? readCurrent().account() : Promise.resolve({ ok: false, available: false, error: '这台宿主没有接入 ZeroNews 线路能力' })),
};

/** @param {{mount:Function, settings:object, getState:Function, control:object, warn:Function, ctx:object, name:string, portOf?:Function, runnerFactory?:Function, ensure?:Function, accountFactory?:Function, loginFlow?:Function, loginClient?:string, openUrl?:Function}} options */
function mountZeroNews(options) {
  const { mount, settings, getState, control, warn, ctx, name } = options;
  const makeRunner = typeof options.runnerFactory === 'function' ? options.runnerFactory : createZeroNewsRunner;
  const provision = typeof options.ensure === 'function' ? options.ensure : ensureZeroNews;
  const exec = typeof options.execFile === 'function' ? options.execFile : execFile;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const makeAccount = typeof options.accountFactory === 'function' ? options.accountFactory : () => createZeroNewsAccountReader();
  const accountReader = makeAccount();
  const loginFlow = typeof options.loginFlow === 'function'
    ? options.loginFlow
    : (binary) => defaultLogin(binary, options.loginClient, { spawn: spawnImpl });
  /** 上一次发起、仍在后台轮询设备授权码的 login 进程；重开 / 停止时要收掉，别让它和新的顶码。 */
  let loginChild = null;
  const killLogin = () => {
    if (loginChild && typeof loginChild.kill === 'function') { try { loginChild.kill(); } catch { /* 收进程失败不影响状态 */ } }
    loginChild = null;
  };
  // 自愈：客户端意外退出 / 启动失败时，只要还「配置过」，就按退避自动重连，别让线路卡死在错误上。
  // 插件自动更新 / 就地重载后由新实例重新挂载，这条重连负责把上一轮断掉的客户端重新接上。
  const retryBaseMs = Number(options.retryBaseMs) > 0 ? Number(options.retryBaseMs) : 3000;
  let retryTimer = null;
  let retryMs = retryBaseMs;
  const isConfigured = () => {
    const s = getState() || {};
    return s.zeroNewsEnabled === true || (typeof s.zeroNewsUrl === 'string' && s.zeroNewsUrl.trim() !== '');
  };
  const clearRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const scheduleRetry = () => {
    if (retryTimer || !isConfigured()) return;
    const delay = retryMs;
    retryMs = Math.min(Math.round(retryMs * 2), 60_000);
    retryTimer = setTimeout(() => { retryTimer = null; void start().catch(() => {}); }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  /** 身份看过没有：runner 这一进程见过的，或者落盘记录里做过都算。 */
  const statusOf = () => {
    const current = runner.status();
    return { ...current, configured: current.configured === true || getState().zeroNewsBound === true };
  };

  const runner = makeRunner({
    ensure: provision,
    portOf: () => Number(options.portOf && options.portOf()) || 0,
    // 客户端在我们「以为还连着」的时候退出（插件重载 / 自动更新 / 偶发崩溃）：安排一次自愈重连。
    onUnexpectedExit: () => scheduleRetry(),
  });

  const start = async (token) => {
    clearRetry();
    let result;
    try {
      result = await runner.start({ token });
    } catch (error) {
      result = runner.status();
      warn('启动 ZeroNews 线路失败：%s', error && error.message ? error.message : error);
    }
    // 拿到域名就写回状态；settings.update 会经 watch → applyServices → control.sync() 报给总控。
    if (result && result.phase === 'connected' && result.url && getState().zeroNewsUrl !== result.url) {
      try { await settings.update({ zeroNewsUrl: result.url, zeroNewsEnabled: true }); }
      catch (error) { warn('把 ZeroNews 地址写回状态失败：%s', error && error.message ? error.message : error); }
    }
    // 一旦确认这台机器有身份就落盘标记，面板下次不必再让人粘一遍 token（token 本身不存）。
    if (result && result.configured === true && getState().zeroNewsBound !== true) {
      try { await settings.update({ zeroNewsBound: true }); }
      catch (error) { warn('记录 ZeroNews 身份状态失败：%s', error && error.message ? error.message : error); }
    }
    // 连上就把退避重置；还停在错误上就安排下一轮自愈，实现自动更新 / 重载后自己恢复。
    if (result && result.phase === 'connected') retryMs = retryBaseMs;
    else if (result && result.phase === 'error') scheduleRetry();
    return statusOf();
  };

  /**
   * 第一次接入：把客户端装好，再走官方 `login` 拉起浏览器确认。
   *
   * 全部自动：命令会打印这台机器的确认链接，我们直接用系统浏览器打开；用户只需要在页面点一次
   * 「确认登录」。这里不等确认就返回（下载可能要几十秒，等确认不该占着一个请求），面板随后轮询
   * 登录状态，`login` 变真就自动接着起客户端、建隧道。已经登录过的机器命令会直接说 already，
   * 面板据此跳过等待——这也是老用户从「粘 token」切到新版本时无感的来源：他们的身份早就落盘了。
   */
  const prepare = async () => {
    let got;
    try {
      got = await provision();
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
    if (!got || !got.ok) {
      return { ok: false, error: got && got.code === 'unsupported-platform' ? '这台系统不支持自动安装 ZeroNews 客户端' : '下载 ZeroNews 客户端失败，请稍后重试' };
    }
    // 重开登录页时先把上一次还没确认的 login 进程收掉，免得两边各持一个设备码互相顶。
    killLogin();
    const started = await loginFlow(got.path);
    if (started && started.already) {
      return { ok: true, downloaded: got.source === 'downloaded', opened: false, already: true };
    }
    if (!started || !started.url) {
      return { ok: false, downloaded: got.source === 'downloaded', error: (started && started.error) || '没能开始登录，请稍后重试' };
    }
    // 交给后台继续轮询：用户在浏览器确认后它自己把 token 写进本机配置，面板轮询 status 就会看到登录成功。
    if (started.child) loginChild = started.child;
    const opened = await (typeof options.openUrl === 'function' ? options.openUrl(started.url) : openInBrowser(started.url, exec));
    return { ok: true, downloaded: got.source === 'downloaded', opened: opened === true, url: started.url, loginPending: true };
  };

  const stop = async () => {
    clearRetry();
    retryMs = retryBaseMs;
    killLogin();
    const result = runner.stop();
    try { await settings.update({ zeroNewsUrl: '', zeroNewsEnabled: false }); } catch { /* 停的时候写不回也不阻断 */ }
    return result;
  };

  const account = async () => {
    try { return await accountReader.read(); }
    catch (error) { return { ok: false, available: false, error: error && error.message ? error.message : String(error) }; }
  };

  globalThis[GLOBAL_KEY] = { start, stop, status: statusOf, prepare, account };

  mount('ZeroNews 线路', () => ctx.effect(() => {
    // 只要「配置过」就自动重连：zeroNewsEnabled 为真，或者状态里还留着上次连上的隧道地址
    // （zeroNewsUrl 非空 = 用户连过、且没显式断开，因为断开时会清空）。断开会把两者都清掉，
    // 所以清空之后不会自动再拉起。连不上让状态停在错误上，不阻塞启动。
    const s = getState();
    const configured = s.zeroNewsEnabled === true || (typeof s.zeroNewsUrl === 'string' && s.zeroNewsUrl.trim() !== '');
    if (configured) { void start().catch(() => {}); }
    return () => { clearRetry(); killLogin(); runner.stop(); };
  }, `${name}: zeronews runner`));
  return facade;
}

module.exports = { mountZeroNews };

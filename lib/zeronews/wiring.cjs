// 2026-11-28：客户端换代：新版预下到 <bin>.next，没人连着时换上去，起不来自动换回旧版。
// 2026-11-27：连上后落盘客户端身份，复用本机客户端前交给 runner 比对，另一个身份占位不冒充已连接。
// 2026-11-26：运行中才点连接时补挂体检定时器，否则客户端静默退出没人发现、线路卡在假连接。
// 2026-11-26：体检发现旧隧道落点端口没监听就清掉失效地址（notify:false）并通知兜底重新判定；不自动删/建云端隧道。
// 2026-11-25：端口失配时清掉状态里的旧地址，配对码 / 心跳 / 总控都不再带失效线路。
// 2026-11-25：连上后定时体检守护进程，发现进程没了自动走自愈重连。
// 2026-11-24：首次接入先开代理商邀请链接埋归属 cookie，让新注册用户无感归到代理商名下。
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

/**
 * 代理商邀请链接：新用户从插件首次接入 ZeroNews 时，得先让浏览器落一次这个地址，ZeroNews 才会
 * 把 agent 写进 zn_agent_ref cookie（域名 user.zeronews.cc、Path=/、30 天）。之后即使真正绑机
 * 走的是官方 CLI 确认页 /cli/login，它发出的登录请求也会带上这个 cookie，新账号就归到代理商名下。
 * 用户不用手动点邀请链接、也不用复制什么，只看到照常的浏览器确认页——这就是「无感」的来源。
 * 归属只对新注册生效（厂商规则：注册/邀请链接仅能绑定新用户），老的 ZeroNews 账号不受影响。
 */
const AGENT_INVITE_URL = 'https://user.zeronews.cc/login?agent=14ad108deb4142228c8607acd2f2aac2';

const fs = require('node:fs');

const { createZeroNewsRunner } = require('./runner.cjs');
const { ensureZeroNews, ownBinaryPath, activeMarkerPath } = require('./provision.cjs');
const { createClientUpdater, compareVersions } = require('./upgrade.cjs');
const { createZeroNewsAccountReader } = require('./account.cjs');
const { friendlyAuthError } = require('./login-error.cjs');
const { purgeZeroNews } = require('./purge.cjs');

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
 * 按官方 Skills 规程：带 `NO_TTY=1` 时 CLI 只打印 verify URL 就退出，并不会自己 open 浏览器，
 * 真正把授权兑换完成的是随后反复执行的 `status --json`（它会去控制面轮询设备码，成功后落盘）。
 * 所以这里只负责拿到链接、交给面板打开；登录是否完成由面板轮询状态判定。进程若提前退出也不用管，
 * 退出后照样能靠 status 轮询把登录补齐（旧版本会一直挂着轮询，这里两种行为都兼容）。
 *
 * 返回 `{ already, url, error, child }`：`child` 可能已经退出，由调用方在重开 / 停止时收掉。
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
      child = spawnFn(binary, args, { cwd: path.dirname(binary), windowsHide: true, env: { ...process.env, NO_TTY: '1' } });
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
  purge: () => (readCurrent() ? readCurrent().purge() : Promise.resolve({ ok: false, error: '这台宿主没有接入 ZeroNews 线路能力' })),
};

/** @param {{mount:Function, settings:object, getState:Function, control:object, warn:Function, ctx:object, name:string, portOf?:Function, runnerFactory?:Function, ensure?:Function, accountFactory?:Function, loginFlow?:Function, loginClient?:string, openUrl?:Function, onRouteStale?:Function}} options */
function mountZeroNews(options) {
  const { mount, settings, getState, control, warn, ctx, name } = options;
  // 落点失效清掉地址后要显式叫一次兜底重判：notify:false 不走 settings.watch，那边的
  // reconcile 不会自己跑。装配层把它接到 Cloudflare 的 reconcile。
  const onRouteStale = typeof options.onRouteStale === 'function' ? options.onRouteStale : null;
  const makeRunner = typeof options.runnerFactory === 'function' ? options.runnerFactory : createZeroNewsRunner;
  const provision = typeof options.ensure === 'function' ? options.ensure : ensureZeroNews;
  const purgeImpl = typeof options.purgeLocal === 'function' ? options.purgeLocal : purgeZeroNews;
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
    return s.zeroNewsEnabled !== false && (s.zeroNewsEnabled === true || (typeof s.zeroNewsUrl === 'string' && s.zeroNewsUrl.trim() !== ''));
  };
  const clearRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const scheduleRetry = () => {
    if (retryTimer || !isConfigured()) return;
    const delay = retryMs;
    retryMs = Math.min(Math.round(retryMs * 2), 60_000);
    retryTimer = setTimeout(() => { retryTimer = null; void start(undefined, true).catch(() => {}); }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  // `start` 命令一后台化就退出，没有退出事件能告诉接线层守护进程后来挂了。连着的时候
  // 定时问一次 CLI：运行器把状态打回 error 并回调，就走上面同一条自愈重连。
  const healthCheckMs = Number(options.healthCheckMs) > 0 ? Number(options.healthCheckMs) : 15_000;
  let healthTimer = null;
  const clearHealth = () => { if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; } };
  const startHealth = () => {
    if (healthTimer || typeof runner.checkAlive !== 'function') return;
    healthTimer = setTimeout(() => {
      healthTimer = null;
      if (!isConfigured()) return;
      void runner.checkAlive().then((result) => {
        // 落点端口没人监听：这条旧隧道名义上连着、实际拨不通。清掉地址，让
        // hasOtherRoute 不再把它算作可用线路，再通知兜底起一条能用的顶上。
        // notify:false 沿用既有约定：只落盘改内存，不走 watch → control.sync()，
        // 免得「configured 就自动重连」那条 mount effect 被同一份状态变更反复叫醒。
        if (result && result.phase === 'error' && result.errorReason === 'port-dead') {
          clearHealth();
          if (getState().zeroNewsUrl) {
            void settings.update({ zeroNewsUrl: '' }, { notify: false })
              .then(() => { if (onRouteStale) onRouteStale(); })
              .catch((error) => warn('清掉失效的 ZeroNews 旧地址失败：%s', error && error.message ? error.message : error));
          } else if (onRouteStale) onRouteStale();
          return;
        }
        // 每拍顺手看一眼客户端要不要换代：预热是纯下载，切换只在没人连着手机时发生。
        void upgradeStep().catch(() => {}).then(() => { startHealth(); });
      }).catch(() => { startHealth(); });
    }, healthCheckMs);
    if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref();
  };

  /** 身份看过没有：runner 这一进程见过的，或者落盘记录里做过都算。 */
  const statusOf = () => {
    const current = runner.status();
    return { ...current, configured: current.configured === true || getState().zeroNewsBound === true };
  };

  // 落点端口：已经有隧道在用时沿用它自己的端口（老用户可能仍指向 18787），只在没有隧道时
  // 才用判据给的首选值。反过来做会把在用的隧道判成端口失配 —— 官方 CLI 没公开删除参数，
  // 重建有风险，不如原地复用。
  const preferredPort = () => Number(options.portOf && options.portOf()) || 0;
  let runner = null;
  const tunnelPort = () => {
    const current = runner && typeof runner.status === 'function' ? runner.status() : null;
    const known = current ? Number(current.tunnelLocalPort) : 0;
    return Number.isInteger(known) && known > 0 ? known : preferredPort();
  };
  // 客户端换代（蓝绿式换法）：新版先预热到 `<bin>.next`，客户端停下来之后才动盘；
  // 新起来没连上就把旧版换回来。换客户端必然断一次线，所以只在没有手机长连接的时候换。
  const makeUpdater = typeof options.updaterFactory === 'function' ? options.updaterFactory : createClientUpdater;
  const updater = makeUpdater({});
  // 「现在有几条手机长连接」：与插件自动更新用的是同一份判据（外壳提供的 mux 服务），
  // 拿不到就当 0 —— 那台机器上也没人在用，照旧可以换。
  const activeConnections = typeof options.activeMuxConnections === 'function' ? options.activeMuxConnections : () => {
    try {
      const host = typeof ctx.get === 'function' ? ctx.get('dshMobileTransportMux') : null;
      return host ? Number(host.activeMuxConnections) || 0 : 0;
    } catch { return 0; }
  };
  /** 两次「查新版」至少隔这么久：别一到点就往官方下载地址上撞。 */
  const stageEveryMs = Number(options.upgradeCheckMs) > 0 ? Number(options.upgradeCheckMs) : 6 * 60 * 60 * 1000;
  let lastStageAt = 0;
  /** 已预热的版本，按可执行文件路径记：读一次 `--version` 就够，别每拍都去跑一个子进程。 */
  let stagedInfo = null;
  /** 换过一次但新版本起不来：这一代进程里别再拿同一版反复折腾。 */
  let failedVersion = '';
  /** 客户端装在只读位置（用户自己装到 /usr/local/bin、Program Files 等）：只能搬到插件自己的目录再升级。 */
  let adoptPending = false;
  let switching = false;

  runner = makeRunner({
    ensure: provision,
    portOf: tunnelPort,
    // 本机已有客户端在跑时，runner 用它自己的身份与这份落盘值比对：不一致就报错，不冒充已连接。
    identityOf: () => ({
      clientId: typeof getState().zeroNewsClientId === 'string' ? getState().zeroNewsClientId : '',
      node: typeof getState().zeroNewsNode === 'string' ? getState().zeroNewsNode : '',
    }),
    // 客户端在我们「以为还连着」的时候退出（插件重载 / 自动更新 / 偶发崩溃）：安排一次自愈重连。
    onUnexpectedExit: () => scheduleRetry(),
    // 上一次换代断在两个 rename 中间：进程起来之前把旧版挪回原位。
    onBinary: (binary) => { if (updater.recover(binary) === 'restored') warn('上一次 ZeroNews 客户端换代没走完，已换回旧版'); },
  });

  const start = async (token, automatic = false) => {
    clearRetry();
    if (automatic && !isConfigured()) return statusOf();
    let result;
    try {
      result = await runner.start({ token });
    } catch (error) {
      result = runner.status();
      warn('启动 ZeroNews 线路失败：%s', error && error.message ? error.message : error);
    }
    if (automatic && getState().zeroNewsEnabled === false) return statusOf();
    // 拿到域名就写回状态；settings.update 会经 watch → applyServices → control.sync() 报给总控。
    if (result && result.phase === 'connected' && result.url && (getState().zeroNewsUrl !== result.url || getState().zeroNewsEnabled !== true)) {
      try { await settings.update({ zeroNewsUrl: result.url, zeroNewsEnabled: true }); }
      catch (error) { warn('把 ZeroNews 地址写回状态失败：%s', error && error.message ? error.message : error); }
    }
    // 记下这次连上的客户端身份，下次重载 / 自动更新后本机已有客户端在跑时据此认人：
    // 另一个身份占了端口就明确报错，不能 attach 别人的线路当自己的。只记身份，不存 token。
    if (result && result.phase === 'connected' && (result.clientId || result.node)) {
      const state = getState();
      if (state.zeroNewsClientId !== (result.clientId || '') || state.zeroNewsNode !== (result.node || '')) {
        try { await settings.update({ zeroNewsClientId: result.clientId || '', zeroNewsNode: result.node || '' }); }
        catch (error) { warn('记录 ZeroNews 客户端身份失败：%s', error && error.message ? error.message : error); }
      }
    }
    // 端口失配：旧隧道指向的是旧端口，状态里那条域名虽然还在，手机拨过去却连不上。
    // 清掉它，让配对码 / 心跳 / 总控同源的 providerLinesOf 都不再带这条失效线路。
    // notify:false：只落盘并改内存状态，不走 watch → applyServices → control.sync()，
    // 免得「configured 就自动重连」那条 mount effect 被同一份状态变更反复叫醒。
    if (result && result.phase === 'error' && result.errorReason === 'port-mismatch' && getState().zeroNewsUrl) {
      try { await settings.update({ zeroNewsUrl: '' }, { notify: false }); }
      catch (error) { warn('清掉失配的 ZeroNews 旧地址失败：%s', error && error.message ? error.message : error); }
    }
    // 一旦确认这台机器有身份就落盘标记，面板下次不必再让人粘一遍 token（token 本身不存）。
    if (result && result.configured === true && getState().zeroNewsBound !== true) {
      try { await settings.update({ zeroNewsBound: true }); }
      catch (error) { warn('记录 ZeroNews 身份状态失败：%s', error && error.message ? error.message : error); }
    }
    // 连上就把退避重置；还停在错误上就安排下一轮自愈，实现自动更新 / 重载后自己恢复。
    // 但配额满 / 被拒 / token 冲突这类确定性错误重试也没用，不排（retryable=false），免得无限空转。
    // 挂载 effect 那会儿若还没配置过，体检定时器根本没开；运行中才点连接时在这里补挂，
    // 否则客户端静默退出没人发现，状态一直显示已连接、手机拿到的却是死线路。
    if (result && result.phase === 'connected') { retryMs = retryBaseMs; startHealth(); }
    else if (result && result.phase === 'error' && result.retryable !== false) scheduleRetry();
    return statusOf();
  };

  /** 有没有手机正连着：有就不换客户端，等下一拍空档。 */
  const phonesConnected = () => {
    try { return Number(activeConnections()) > 0; } catch { return false; }
  };

  /**
   * 把已经预热好的新版换上去。先让旧客户端自己退出再动盘（Windows 上占用中的可执行文件改不了名），
   * 换完用新版本起一遍；连不上就换回旧版再起，绝不让用户留在「升级完反而没线路」的状态。
   */
  const switchClient = async (binary, version) => {
    switching = true;
    try {
      await updater.shutdown(binary);
      runner.stop();
      const applied = await updater.apply(binary);
      if (!applied.ok) {
        warn('ZeroNews 客户端换版本没成功（%s），继续用当前版本', applied.error);
        return;
      }
      const after = await start(undefined, true).catch(() => null);
      if (after && after.phase === 'connected') {
        updater.cleanup(binary);
        stagedInfo = null;
        lastStageAt = Date.now();
        return;
      }
      // 新版本起不来：换回旧版重新起一次。用户该看到的只是「断了一下」，而不是「升级之后没了」。
      const back = updater.rollback(binary);
      // 记住这一版起不来：这一代进程里不再拿它试；也别马上重新下载，退到下一轮再查。
      failedVersion = version;
      stagedInfo = null;
      lastStageAt = Date.now();
      warn('ZeroNews 客户端 %s 起不来，已换回旧版%s', version, back.ok ? '' : '（回滚也失败了）');
      await start(undefined, true).catch(() => {});
    } finally {
      switching = false;
    }
  };

  /**
   * 客户端装在只读位置（用户自己装在 /usr/local/bin、Program Files 之类）时，那份文件换不了：
   * 把新版装到插件自己的目录、把客户端配置搬过去（身份跟着 config.yml 走，用户不用重新登录），
   * 再让插件之后都跑这一份。搬过去起不来就把标记撤掉，照旧跑原来的安装。
   */
  const switchToOwnCopy = async (binary) => {
    switching = true;
    const root = options.root;
    const target = ownBinaryPath({ root });
    const marker = activeMarkerPath({ root });
    try {
      if (target === binary) { adoptPending = false; return; }
      const running = await updater.versionOf(binary);
      const staged = await updater.stageInto(target, running);
      if (!staged.ok) {
        warn('ZeroNews 新版本没能装到插件自己的目录（%s），这一轮先不动', staged.error);
        lastStageAt = Date.now();
        return;
      }
      // 工作目录就是可执行文件所在目录：配置搬过去，身份、隧道与登录都不必重新来一遍。
      let config = '';
      try { config = fs.readFileSync(path.join(path.dirname(binary), 'config.yml'), 'utf8'); } catch { config = ''; }
      if (!config) {
        adoptPending = false;
        warn('读不到本机 ZeroNews 配置，先不把客户端搬到插件目录');
        return;
      }
      const committed = updater.commitStaged(target);
      if (!committed.ok) {
        warn('ZeroNews 新版没能落到插件目录（%s），继续用原来的安装', committed.error);
        lastStageAt = Date.now();
        return;
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(target), 'config.yml'), config, { mode: 0o600 });
        fs.writeFileSync(marker, target);
      } catch (error) {
        warn('把 ZeroNews 客户端搬到插件目录失败（%s），继续用原来的安装', error && error.message ? error.message : String(error));
        try { fs.rmSync(marker, { force: true }); } catch { /* 撤不掉也只影响下次选路 */ }
        return;
      }
      await updater.shutdown(binary);
      runner.stop();
      const after = await start(undefined, true).catch(() => null);
      const known = String(getState().zeroNewsClientId || '');
      const sameIdentityNow = !known || String((after && after.clientId) || '') === known;
      if (after && after.phase === 'connected' && sameIdentityNow) {
        adoptPending = false;
        lastStageAt = Date.now();
        return;
      }
      // 搬过去这份起不来或身份对不上：撤掉标记与搬过去的东西，退回原来的安装。
      adoptPending = false;
      for (const file of [marker, target, path.join(path.dirname(target), 'config.yml')]) {
        try { fs.rmSync(file, { force: true }); } catch { /* 删不掉不影响回退 */ }
      }
      runner.stop();
      warn('搬到插件目录的 ZeroNews 客户端没连上，已退回原来的安装');
      await start(undefined, true).catch(() => {});
    } finally {
      switching = false;
    }
  };

  /**
   * 换代的一拍，跟体检同频：没预热就先预热（只是往盘上多写一份文件，线路不受影响）；
   * 预热好了、又没人连着手机，就换上去。
   */
  const upgradeStep = async () => {
    if (switching) return;
    const current = runner.status();
    // 线路通着才换代；已经报错（旧隧道失配这类）也换——那正是换个新版才可能修好的情况，
    // 且那时本来就没人在用。只在真的没有可执行文件时才停手。
    if (current.phase !== 'connected' && current.phase !== 'error') return;
    const binary = typeof runner.binaryPath === 'function' ? runner.binaryPath() : '';
    if (!binary) return;
    if (!stagedInfo || stagedInfo.binary !== binary) {
      const staged = await updater.stagedVersion(binary);
      stagedInfo = staged ? { binary, version: staged } : null;
    }
    if (!stagedInfo && adoptPending) {
      if (phonesConnected()) return;
      await switchToOwnCopy(binary);
      return;
    }
    if (!stagedInfo) {
      if (Date.now() - lastStageAt < stageEveryMs) return;
      lastStageAt = Date.now();
      const running = await updater.versionOf(binary);
      // 已经是目标版本（或更高）就不折腾：官方下载地址在 macOS / Windows 上不带版本号。
      if (!running || compareVersions(running, updater.desiredVersion) >= 0) return;
      const staged = await updater.stage(binary);
      // 只读安装位置写不进去：记下来，等空档把新版装到插件自己的目录，再整个搬过去。
      if (!staged.ok && staged.code === 'no-permission') adoptPending = true;
      return;
    }
    // 这一版换过一次、起不来：别拿同一版反复折腾，等厂商再出新的。
    if (failedVersion && stagedInfo.version === failedVersion) return;
    if (phonesConnected()) return;
    await switchClient(binary, stagedInfo.version);
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
      // login 直接失败（例如免费套餐 client count limit）时，把原文翻成可操作的话，别甩英文。
      const raw = (started && started.error) || '';
      return { ok: false, downloaded: got.source === 'downloaded', error: friendlyAuthError(raw) || raw || '没能开始登录，请稍后重试' };
    }
    // 交给后台继续轮询：用户在浏览器确认后它自己把 token 写进本机配置，面板轮询 status 就会看到登录成功。
    if (started.child) loginChild = started.child;
    const open = (url) => (typeof options.openUrl === 'function' ? options.openUrl(url) : openInBrowser(url, exec));
    // 先开邀请链接埋归属 cookie，再开官方确认页。顺序要紧：必须在确认页登录之前让浏览器带上 agent
    // cookie，新账号才会归到代理商名下。邀请链接打不开不影响绑机（cookie 没埋上而已），故忽略结果。
    await open(AGENT_INVITE_URL);
    const opened = await open(started.url);
    return { ok: true, downloaded: got.source === 'downloaded', opened: opened === true, url: started.url, loginPending: true };
  };

  const stop = async () => {
    clearRetry();
    clearHealth();
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

  /**
   * 彻底清理：用户主动点的独立入口，与「断开」分开。停隧道和登录轮询、跑官方 reset 清本机
   * 身份与配置、删插件缓存的客户端，再把插件那三格状态一次清掉。reset 失败时保留二进制供
   * 手动重试，但状态照清——界面不该继续说「已绑定」。
   */
  const purge = async () => {
    clearRetry();
    clearHealth();
    retryMs = retryBaseMs;
    killLogin();
    const stopped = runner.stop();
    let result;
    try {
      result = await purgeImpl({ root: options.root });
    } catch (error) {
      result = { ok: false, reset: { attempted: false, ok: false, error: '' }, cacheRemoved: false, error: error && error.message ? error.message : String(error) };
    }
    try { await settings.update({ zeroNewsUrl: '', zeroNewsEnabled: false, zeroNewsBound: false, zeroNewsClientId: '', zeroNewsNode: '' }); }
    catch (error) { warn('清掉 ZeroNews 状态失败：%s', error && error.message ? error.message : error); }
    return { ok: result.ok === true, ...result, stopped };
  };

  globalThis[GLOBAL_KEY] = { start, stop, status: statusOf, prepare, account, purge };

  mount('ZeroNews 线路', () => ctx.effect(() => {
    // 显式关闭不恢复；旧配置未设开关时仍可沿用上次地址。连不上不阻塞启动。
    if (isConfigured()) {
      startHealth();
      void start(undefined, true).catch(() => {});
    } else {
      clearHealth();
    }
    return () => { clearRetry(); clearHealth(); killLogin(); runner.stop(); };
  }, `${name}: zeronews runner`));
  return facade;
}

module.exports = { mountZeroNews, AGENT_INVITE_URL };

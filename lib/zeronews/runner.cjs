// ZeroNews 客户端运行器：ensure→login→start→建隧道→读域名，进程生命周期与状态。
'use strict';

/**
 * 把官方客户端从「没有」带到「有一个指向本机端口、拿到公网域名的隧道」。顺序照厂商现行流程：
 *   ① ensureZeroNews 拿到可执行文件（用户不装）；
 *   ② 认证：优先用面板里粘贴的 AuthToken 跑 `authtoken`（厂商现行 CLI 的做法）；没给 token 时才退回
 *      `login` 拉起浏览器让用户确认（login_pending / status.login 判定）。浏览器这条是给「这台机器
 *      早就登录过」的用户留的快捷路，新机器一律要 token —— 快速开始页上的那串就是它；
 *   ③ `start` 起本地客户端 + HTTP API（幂等，已登录已运行就跳过）；
 *   ④ 本地 API 建一条 HTTPS 隧道指向本机端口（已有则复用，免费档一条额度，绝不重复建）；
 *   ⑤ 读 endpoints 拿公网域名 → 交调用方写进线路清单。
 *
 * 所有进程 / 网络 / 时钟都可注入，守卫用假体走完整条链，不连真网、不起真进程。
 */

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

const DEFAULT_BASE = 'http://127.0.0.1:37271';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 浏览器确认最长等 5 分钟，别一直挂在「登录中」。
const START_TIMEOUT_MS = 40_000;
// 轮询也按次数封顶：光看 wall-clock 的话，时钟源被替换或定时器被加速时会无限空转。
const LOGIN_POLL_MAX = 300;
const START_POLL_MAX = 40;

function endpointUrl(text) {
  const raw = String(text || '').trim();
  if (!/^https:\/\/[^\s/]+/i.test(raw)) return '';
  try { return new URL(raw).hostname ? raw.replace(/\/+$/, '') : ''; } catch { return ''; }
}

/** 默认的一次性命令执行器：execFile 拿到 stdout/stderr/退出码，不经过 shell。 */
function defaultRun(binary, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: opts.timeoutMs || 8000, cwd: path.dirname(binary), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 从 endpoints 响应里取第一条 active 的 HTTPS 域名（兼容 data.items / 裸数组 / endpoints）。 */
function pickEndpoint(payload) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.items)) ? data.items
      : (data && Array.isArray(data.endpoints)) ? data.endpoints : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const status = String(item.status || '').toLowerCase();
    if (status && status !== 'active') continue;
    const type = String(item.type || '').toUpperCase();
    if (type && type !== 'HTTPS') continue;
    const domain = typeof item.domain === 'string' && item.domain ? item.domain
      : typeof item.public_url === 'string' ? item.public_url : '';
    const url = endpointUrl(domain.includes('://') ? domain : `https://${domain}`);
    if (url) return url;
  }
  return '';
}

/**
 * @param {object} options
 * @param {() => Promise<{ok:boolean,path:string,code?:string}>} options.ensure 取二进制（provision）
 * @param {() => number} options.portOf 本机要映射的 LAN 端口
 * @param {object} [options.spawnImpl] spawn 注入
 * @param {(url:string, init:object)=>Promise<any>} [options.fetchImpl] 本地 API fetch 注入
 * @param {(bin:string,args:string[],opts:object)=>Promise<{code:number,stdout:string,stderr:string}>} [options.runImpl] 一次性命令注入
 * @param {string} [options.base] 本地 API 根
 */
function createZeroNewsRunner(options = {}) {
  const ensure = options.ensure;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => 0;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const runImpl = typeof options.runImpl === 'function' ? options.runImpl : defaultRun;
  const base = String(options.base || DEFAULT_BASE).replace(/\/+$/, '');
  const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms));

  // 客户端退出（非我们主动 stop）时的回调：交接线层去安排自动重连，别让线路卡死在错误上。
  const onUnexpectedExit = typeof options.onUnexpectedExit === 'function' ? options.onUnexpectedExit : null;

  let child = null;
  /** 本机已有一个不是我这次拉起的客户端在跑（插件重载 / 自动更新后常见）：复用，不再重复起一个。 */
  let attached = false;
  /** 面板递进来、还没写进客户端配置的 AuthToken；只在本进程内存里停一下，不落盘、不记日志。 */
  let pendingToken = '';
  /** 这台机器的客户端有没有账户身份（token 写成功 / CLI 报已登录都算）。面板据此收起粘贴框。 */
  let configured = false;
  /** 同一次 start 只跑一份：自动重连、点「连接」、watch 触发撞在一起时，别并发拉起两个客户端。 */
  let startPromise = null;
  let binary = '';
  let error = '';
  let url = '';
  let phase = 'off'; // off | installing | login | starting | connecting | connected | error
  let generation = 0;

  function status() {
    return {
      available: Boolean(binary) || phase !== 'off',
      running: Boolean(child) || attached,
      phase,
      url: phase === 'connected' ? url : '',
      error,
      // 只反映这一进程里见过的身份；落盘的那份由接线层并进来（见 wiring.cjs 的 statusOf）。
      configured,
    };
  }

  /** 一次性跑一条命令，汇总 stdout/stderr/退出码（login 起浏览器那条用 spawn 不 wait）。 */
  async function run(args) {
    const result = await runImpl(binary, args, { timeoutMs: 8000 });
    if (result && result.code !== 0) {
      const msg = String(result.stderr || result.stdout || '').trim();
      throw new Error(msg || `zeronews ${args[0]} 退出码 ${result.code}`);
    }
    return result;
  }

  /**
   * 登录状态只信 CLI `status --json`，不信本地 HTTP API：
   * 实测同一台已登录机器，CLI 报 `login:true`，而 `/api/v1/status` 报 `login:false`，两者不一致。
   * 厂商 AI 指引的完成判据也是「`status --json` 为 `login:true` 且 running」。
   */
  async function cliStatus() {
    try {
      const result = await runImpl(binary, ['status', '--json'], { timeoutMs: 5000 });
      const text = String((result && result.stdout) || '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      return JSON.parse(text.slice(start, end + 1));
    } catch { return null; }
  }

  async function api(pathname, init) {
    if (!doFetch) return null;
    let res;
    try {
      res = await doFetch(`${base}${pathname}`, { headers: { accept: 'application/json' }, ...(init || {}) });
    } catch {
      // 客户端刚起、端口还没监听时连不上是常态：返回 null 让上层继续轮询，不要当场抛。
      return null;
    }
    if (!res || res.ok !== true) return null;
    try { return await res.json(); } catch { return null; }
  }

  /** 轮询 status.login，等浏览器确认完成（或超时）。 */
  async function waitLogin(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < LOGIN_POLL_MAX && Date.now() < deadline; i += 1) {
      const s = await cliStatus();
      if (s && (s.login === true || s.login === 'true')) return true;
      await sleep(1000);
    }
    return false;
  }

  /** 轮询 endpoints 拿到隧道域名，最多等到 START_TIMEOUT_MS。 */
  async function waitEndpoint(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < START_POLL_MAX && Date.now() < deadline; i += 1) {
      const payload = await api('/api/v1/endpoints');
      const found = pickEndpoint(payload);
      if (found) return found;
      await sleep(1500);
    }
    return '';
  }

  /**
   * 确保有一条指向本机端口的 HTTPS 隧道：已有一条就复用（免费档只有一条额度）。
   * 建隧道走 CLI `add https --port N --json`（官方稳定接口；本地 /api/v1/tunnels 的字段口径会变，
   * 直接用裸 API 会因未知字段被拒）。`add` 的 JSON 里带 public_url 就直接用，没有就回读 endpoints。
   */
  async function ensureTunnel(port) {
    const existing = pickEndpoint(await api('/api/v1/endpoints'));
    if (existing) return existing;
    if (!Number.isInteger(port) || port <= 0) return '';
    let added = '';
    try {
      const result = await runImpl(binary, ['add', 'https', `--port=${port}`, '--json'], { timeoutMs: 20000 });
      const text = String((result && result.stdout) || '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        added = endpointUrl(parsed.public_url || parsed.domain || '');
      }
    } catch { /* add 失败（可能已有隧道额度占满）就回读 endpoints */ }
    if (added) return added;
    return waitEndpoint(START_TIMEOUT_MS);
  }

  async function runStart() {
    const gen = ++generation;
    error = '';
    url = '';
    try {
      phase = 'installing';
      const got = await ensure();
      if (!got || !got.ok) throw new Error(got && got.code === 'unsupported-platform' ? '这台系统不支持自动安装 ZeroNews 客户端' : '下载 ZeroNews 客户端失败，请稍后重试');
      binary = got.path;

      phase = 'login';
      const already = await cliStatus();
      // 有 token 就先写进客户端配置：之后照常起客户端、建隧道，不再拉浏览器。
      // 写完就把内存里那份清掉 —— 失败也一样，避免自动重连拿同一串无效 token 反复试。
      const token = pendingToken;
      pendingToken = '';
      if (token) {
        const applied = await runImpl(binary, ['authtoken', token], { timeoutMs: 15000 });
        if (!applied || applied.code !== 0) {
          const detail = String((applied && (applied.stderr || applied.stdout)) || '').trim();
          throw new Error(detail || 'AuthToken 写入失败，请确认从「快速开始」页复制完整');
        }
        configured = true;
      } else if (already && (already.login === true || already.login === 'true')) {
        // 这台机器早就有身份（以前登录过 / 以前粘过 token）：记下来，面板不用再要一次。
        configured = true;
      } else {
        // 没给 token 且这台机器没登录过：拉起浏览器登录，等用户确认。
        const who = spawnImpl(binary, ['login'], { stdio: 'ignore', cwd: path.dirname(binary) });
        if (who && typeof who.on === 'function') who.on('error', () => {});
        const loggedIn = await waitLogin(LOGIN_TIMEOUT_MS);
        if (gen !== generation) return status();
        if (!loggedIn) throw new Error('等待浏览器确认登录超时；请把「快速开始」页的 AuthToken 粘到面板里再试');
      }

      phase = 'starting';
      // 本机已经有一个客户端在跑（插件重载 / 自动更新后没被这次拉起、上一条还活着）：直接复用它，
      // 绝不再 spawn 第二个 —— 免费档只认一台设备，重复拉起会让第二个自己退出，表现成「客户端意外退出」。
      const externalRunning = Boolean(already && (already.running === true || already.running === 'true'));
      // start 常驻：后台拉起，不 wait；已运行时官方命令自身幂等。
      if (!child && !externalRunning) {
        child = spawnImpl(binary, ['start'], { stdio: 'ignore', detached: true, cwd: path.dirname(binary) });
        if (child && typeof child.on === 'function') {
          child.on('error', () => {});
          child.on('exit', () => {
            if (gen !== generation) return;
            child = null;
            // 只在「已经连上之后」退出才算意外；连接过程中的退出交给后面 healthz / 建隧道去判失败，
            // 免得把「start 命令自己后台化后正常退出」误报成崩溃。
            if (phase === 'connected') {
              url = '';
              phase = 'error';
              error = 'ZeroNews 客户端意外退出';
              if (onUnexpectedExit) { try { onUnexpectedExit(error); } catch { /* 回调失败不影响状态 */ } }
            }
          });
          if (typeof child.unref === 'function') child.unref();
        }
      } else if (externalRunning) {
        attached = true;
      }
      phase = 'connecting';
      const healthDeadline = Date.now() + START_TIMEOUT_MS;
      for (let i = 0; i < START_POLL_MAX && Date.now() < healthDeadline; i += 1) {
        if (await api('/healthz')) break;
        await sleep(1000);
      }
      url = await ensureTunnel(portOf());
      if (gen !== generation) return status();
      if (!url) throw new Error('客户端已连上，但还没拿到隧道公网地址，请稍后刷新');
      phase = 'connected';
    } catch (err) {
      if (gen !== generation) return status();
      phase = 'error';
      error = err && err.message ? err.message : String(err);
    }
    return status();
  }

  /**
   * 同一时刻只跑一次 start：并发调用共享同一个在飞 Promise，避免自动重连 + 点连接 + watch 撞车各起一个客户端。
   * `options.token` 是面板里粘贴的 AuthToken；不给就走「已登录」或浏览器登录那条老路。
   */
  function start(options = {}) {
    if (options && typeof options.token === 'string' && options.token.trim()) pendingToken = options.token.trim();
    if (startPromise) return startPromise;
    startPromise = runStart().finally(() => { startPromise = null; });
    return startPromise;
  }

  function stop() {
    generation += 1;
    if (child && typeof child.kill === 'function') { try { child.kill(); } catch {} }
    child = null;
    attached = false;
    url = '';
    error = '';
    phase = 'off';
    return status();
  }

  return { start, stop, status, pickEndpoint, endpointUrl };
}

module.exports = { DEFAULT_BASE, LOGIN_TIMEOUT_MS, START_TIMEOUT_MS, endpointUrl, pickEndpoint, createZeroNewsRunner };

// Cloudflare 快速隧道的进程起停、banner 地址解析、崩溃退避重连与用户开关标记。
'use strict';

/** 本机 cloudflared 快速隧道的进程生命周期管理。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dshHome } = require('../shared/paths.js');

const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// 起进程后这么久还没解析到隧道地址，就认定「连不上 Cloudflare」（国内被屏蔽/代理拦截很常见），
// 在状态里把原因说清，而不是一直假装「运行中」。进程不杀，交给它自己重试。
const CONNECT_TIMEOUT_MS = 40_000;
// 快速隧道分配的地址形如 https://<随机词>.trycloudflare.com，banner 里可能带装饰符或尾斜杠。
const TUNNEL_URL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const TRIM_RE = /^[|"'<>()[\]{},;]+|[|"'<>()[\]{},;]+$/g;

function describeSpawnFailure(err, binary) {
  const code = err && err.code ? String(err.code) : '';
  const raw = err && err.message ? err.message : String(err || '未知错误');
  const where = binary ? `（${binary}）` : '';
  if (code === 'UNKNOWN') {
    return `系统拒绝运行 cloudflared${where}：多半是安全软件（如 Windows Defender）拦了这个程序，或下载到的版本与本机芯片不符。请把它加入杀毒/安全软件的信任名单，或换成与本机匹配的 cloudflared 版本。`;
  }
  if (code === 'ENOEXEC') return `cloudflared${where} 不是这台机器能执行的程序：文件可能已损坏，或版本/架构不对。请重新获取一份与本机匹配的 cloudflared。`;
  if (code === 'EACCES' || code === 'EPERM') return `系统不允许运行 cloudflared${where}：权限被拒。请检查这个文件是否被禁止执行或被安全策略拦截。`;
  if (code === 'ENOENT') return `找不到 cloudflared 可执行文件${where}：它可能已被删除或路径失效，请重新获取。`;
  return `启动 cloudflared 失败：${raw}`;
}

/** 从一段（可能被装饰的）输出里取第一个合法的快速隧道地址，取不到返回空串。 */
function extractTunnelUrl(text) {
  for (const raw of String(text || '').split(/\s+/)) {
    const token = raw.replace(ANSI_RE, '').replace(TRIM_RE, '');
    if (!token) continue;
    if (TUNNEL_URL_RE.test(token)) return token.replace(/\/+$/, '');
  }
  return '';
}

function cloudflaredPaths(root) {
  // 与 provision 缓存分开，避免换二进制时清掉运行期标记。
  const dir = root || path.join(dshHome(), 'cloudflare-run');
  return { dir, enabled: path.join(dir, 'cloudflare.enabled') };
}

function createCloudflaredRunner(options = {}) {
  const paths = cloudflaredPaths(options.root);
  // 「这台机器能不能用 cloudflared」和「二进制此刻装没装」是两回事：前者按平台判，决定面板
  // 开关能不能点、点了会不会自动下载；后者看 binary。否则全新机器上二进制还没下来，available
  // 恒为 false，面板把开关禁用，就永远触发不了首次下载。
  let platformSupported = true;
  try {
    const provision = require('./provision.cjs');
    if (typeof provision.platformId === 'function') platformSupported = Boolean(provision.platformId());
  } catch { /* 取不到就按支持处理，真正 start 时再报具体原因。 */ }
  const ensure = typeof options.ensureBin === 'function'
    ? options.ensureBin
    : (typeof options.ensure === 'function'
      ? options.ensure
      // 懒加载 provision：它尚未落地时不影响本模块加载，真正 start 时才取用。
      : (opts) => require('./provision.cjs').ensureCloudflared(opts));
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => null;
  const fsImpl = options.fsImpl || fs;
  const setTimer = options.setTimerImpl || options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimerImpl || options.clearTimeoutImpl || clearTimeout;
  const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : null;
  // 连接超时单独一套定时器：默认走真实 setTimeout，和「崩溃重连」那套 setTimerImpl 互不影响。
  const connectTimeoutMs = Number(options.connectTimeoutMs) > 0 ? Number(options.connectTimeoutMs) : CONNECT_TIMEOUT_MS;
  const setConnectTimer = options.connectTimerImpl || options.setTimeoutImpl || setTimeout;
  const clearConnectTimerImpl = options.clearConnectTimerImpl || options.clearTimeoutImpl || clearTimeout;
  let connectTimer = null;
  let child = null;
  let binary = '';
  let error = '';
  let startedAt = 0;
  let url = '';
  let desired = false;
  let generation = 0;
  let starting = null;
  let retryTimer = null;
  let retries = 0;
  let requestedLocalPort = 0;
  let runningLocalPort = 0;
  let waitingForPort = false;
  let addressListener = typeof options.onAddress === 'function' ? options.onAddress : null;
  const exists = (p) => { try { return fsImpl.existsSync(p); } catch { return false; } };
  const localPort = () => {
    const port = Number(portOf());
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
  };

  function writeEnabled() {
    fsImpl.mkdirSync(paths.dir, { recursive: true });
    fsImpl.writeFileSync(paths.enabled, '1');
  }

  function removeEnabled() {
    try { fsImpl.rmSync(paths.enabled, { force: true }); } catch { /* 已不存在。 */ }
  }

  function clearConnectTimer() {
    if (connectTimer === null) return;
    try { clearConnectTimerImpl(connectTimer); } catch { /* 已触发/失效。 */ }
    connectTimer = null;
  }

  function status() {
    return {
      available: Boolean(binary) || platformSupported,
      running: Boolean(child),
      pid: child && child.pid ? child.pid : null,
      url: child ? url : '',
      error,
      startedAt,
      starting: Boolean(starting && !child),
      retrying: retryTimer !== null,
      waitingForPort,
      enabled: exists(paths.enabled),
    };
  }

  function scheduleRestart() {
    if (!desired || !exists(paths.enabled) || retryTimer !== null || retries >= RESTART_DELAYS_MS.length) return;
    const token = generation;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (desired && generation === token && exists(paths.enabled)) launch().catch(() => {});
    }, RESTART_DELAYS_MS[retries++]);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  async function launch() {
    if (child) return status();
    if (starting) { await starting; return status(); }
    const token = ++generation;
    const run = (async () => {
      requestedLocalPort = localPort();
      waitingForPort = requestedLocalPort === 0;
      if (waitingForPort) { error = ''; return; }
      let got;
      try { got = await ensure({}); }
      catch (err) { got = { ok: false, message: err && err.message ? err.message : String(err) }; }
      if (!desired || generation !== token) return;
      // ensureCloudflared 成功时回 { path, version, source }（没有 ok 字段），失败才抛错；
      // 这里按「有没有 path」判成功，兼容注入的假实现回 { ok:true, path } 的写法。
      if (!got || !got.path) {
        error = got && got.message ? got.message : '没拿到 cloudflared 可执行文件';
        scheduleRestart();
        return;
      }
      // 取二进制期间端口可能已变，启动前只取这一刻的实际监听端口。
      const port = localPort();
      requestedLocalPort = port;
      waitingForPort = port === 0;
      if (waitingForPort) { error = ''; return; }
      binary = got.path;
      let proc;
      try {
        proc = spawnImpl(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        error = describeSpawnFailure(err, binary);
        scheduleRestart();
        return;
      }
      child = proc;
      runningLocalPort = port;
      error = '';
      url = '';
      startedAt = Date.now();
      let tail = '';
      const isCurrent = () => desired && child === proc && generation === token;
      // 起进程后 connectTimeoutMs 还没解析到地址：多半是连不上 Cloudflare（国内常见）。
      // 不杀进程（它自己会重试），但把原因写进状态，面板显示「连不上」而不是假装「运行中」。
      clearConnectTimer();
      connectTimer = setConnectTimer(() => {
        connectTimer = null;
        if (isCurrent() && !url) error = '启动后还没连上 Cloudflare（可能网络无法访问 Cloudflare，如国内被屏蔽或被代理拦截），仍在后台重试';
      }, connectTimeoutMs);
      if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref();
      const consume = (chunk) => {
        tail = (tail + String(chunk)).slice(-4000);
        const found = extractTunnelUrl(tail);
        if (!found || !isCurrent() || found === url) return;
        url = found;
        error = '';
        clearConnectTimer();
        if (addressListener) {
          try {
            const returned = addressListener(found, isCurrent);
            if (returned && typeof returned.catch === 'function') returned.catch(() => { /* 地址写回失败不许反噬进程 */ });
          } catch { /* 监听同步抛错同样吞掉 */ }
        }
      };
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream || typeof stream.on !== 'function') continue;
        if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
        stream.on('data', consume);
      }
      if (typeof proc.on === 'function') {
        proc.on('error', (err) => { if (child === proc) error = describeSpawnFailure(err, binary); });
        // close 时两路输出已收全，保留 cloudflared 自己给的退出原因。
        proc.on('close', (code, signal) => {
          if (child !== proc) return;
          clearConnectTimer();
          child = null;
          runningLocalPort = 0;
          url = '';
          const lastLine = tail.trim() ? tail.trim().split('\n').pop() : '';
          error = `cloudflared 已退出（code=${code}${signal ? `, ${signal}` : ''}）${lastLine ? `：${lastLine}` : ''}`;
          scheduleRestart();
        });
      }
    })();
    starting = run;
    try { await run; }
    finally { if (starting === run) starting = null; }
    return status();
  }

  async function start() {
    if (!desired) { desired = true; retries = 0; }
    try { writeEnabled(); } catch (err) { error = `记录启用状态失败：${err && err.message ? err.message : err}`; }
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    return launch();
  }

  function stopProcess() {
    generation += 1;
    clearConnectTimer();
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    starting = null;
    const proc = child;
    child = null;
    runningLocalPort = 0;
    url = '';
    error = '';
    if (proc) { try { proc.kill('SIGTERM'); } catch { /* 已退出。 */ } }
  }

  /** 监听状态变化时同步；不会越过主动停止，也不为同一个端口重启。 */
  async function syncLocalPort() {
    if (!desired) return status();
    const port = localPort();
    if (!port) { waitingForPort = !child; return status(); }
    if (port === requestedLocalPort && !waitingForPort) return status();
    stopProcess();
    retries = 0;
    return launch();
  }

  async function stop() {
    desired = false;
    stopProcess();
    requestedLocalPort = 0;
    waitingForPort = false;
    removeEnabled();
    return status();
  }

  /** 宿主卸载/退出：杀进程、清地址、解绑监听，但保留 enabled 供下次启动自动恢复。 */
  function dispose() {
    desired = false;
    stopProcess();
    requestedLocalPort = 0;
    waitingForPort = false;
    addressListener = null;
    return status();
  }

  return {
    status, start, stop, syncLocalPort, dispose,
    get runId() { return generation; },
    setAddressListener(listener) {
      addressListener = typeof listener === 'function' ? listener : null;
      if (child && addressListener && url) {
        const proc = child;
        const token = generation;
        const isCurrent = () => desired && child === proc && generation === token;
        if (isCurrent()) {
          try {
            const returned = addressListener(url, isCurrent);
            if (returned && typeof returned.catch === 'function') returned.catch(() => { /* 同上 */ });
          } catch { /* 同上 */ }
        }
      }
    },
    async restart() { await stop(); return start(); },
    shouldAutoStart() { return exists(paths.enabled); },
    _paths: paths,
    _sleep: sleep,
  };
}

module.exports = {
  createCloudflaredRunner,
  extractTunnelUrl,
  cloudflaredPaths,
  describeSpawnFailure,
  RESTART_DELAYS_MS,
  CONNECT_TIMEOUT_MS,
};

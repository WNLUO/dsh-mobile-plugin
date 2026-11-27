// Cloudflare 快速隧道的进程起停、banner 地址解析、连没连上边缘、崩溃退避重连与用户开关标记。
// 内置保底隧道默认开：标记文件记的是「用户显式关掉」，没有这个文件就算开着。
// 进程消失以 exit 为准（stdio 管道被占时 close 可能不来），exit/close 共用幂等清理；spawn error 也清 child 并撤回地址。
'use strict';

/** 本机 cloudflared 快速隧道的进程生命周期管理。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dshHome } = require('../shared/paths.js');
const { nextRestartDelay } = require('../shared/restart-backoff.cjs');
const { cloudflaredEdgeIpVersion } = require('../relay/net-family.cjs');

const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// 起进程后这么久还没连上 Cloudflare 边缘，就认定「连不上」（国内被屏蔽/代理拦截很常见），
// 在状态里把原因说清，而不是一直假装「运行中」。进程不杀，交给它自己重试。
const CONNECT_TIMEOUT_MS = 40_000;
// banner 里那条地址是「隧道创建好了」，跟「已经连上边缘」是两回事：地址几秒就出来，
// 被网络/代理挡住时永远等不到这一行。真正的连通信号只有它。
const CONNECTED_RE = /Registered tunnel connection/i;
// 掉线：边缘那条连接断了，cloudflared 会照这些行自己重连（同一地址不变）。
const DISCONNECTED_RE = /Connection terminated|Unregistered tunnel connection|Lost connection with the edge/i;
const LOG_ERROR_RE = /\bERR\b/;
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

/** 把一行 cloudflared 日志收拾成人话：去掉时间戳与级别，太长的截断。 */
function cleanLogLine(line) {
  const cleaned = String(line || '').trim().replace(/^\S+\s+/, '').replace(/^ERR\s*/, '').trim();
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned;
}

/** 连不上边缘时写进状态的那句话：说清等多久、最常见的原因，再附 cloudflared 的原话。 */
function connectFailureText(reason, timeoutMs) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const detail = reason ? `；cloudflared 报：${reason}` : '';
  return `启动后 ${seconds} 秒还没连上 Cloudflare 边缘（常见原因是网络或代理挡了 7844 端口），仍在后台重试${detail}`;
}

function cloudflaredPaths(root) {
  // 与 provision 缓存分开，避免换二进制时清掉运行期标记。
  // 标记从「启用」反转为「关闭」：文件存在=用户显式关掉，没有=默认开。老版本留下的
  // cloudflare.enabled 不再读（那就当默认开），避免升级后把用户之前没碰过的隧道误开或误关。
  const dir = root || path.join(dshHome(), 'cloudflare-run');
  return { dir, disabled: path.join(dir, 'cloudflare.disabled') };
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
  const random = typeof options.random === 'function' ? options.random : Math.random;
  // 出站协议族策略可能是「取值器」（跟随时随配置变），也可能直接是字符串。
  const ipVersionPolicyOf = typeof options.ipVersionPolicy === 'function' ? options.ipVersionPolicy : () => options.ipVersionPolicy;
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
  /** 边缘那条连接真的建立了没有。banner 地址出来不等于有它——`running` 只认这一格。 */
  let registered = false;
  /** 已经写回状态的地址；撤回时只撤写过的，免得把用户手填的直连地址一起清掉。 */
  let publishedUrl = '';
  /** 逐行攒 cloudflared 的输出：连通/掉线是按整行认的，跨 chunk 切开的行得拼回去。 */
  let lineBuf = '';
  let desired = false;
  let generation = 0;
  let starting = null;
  let retryTimer = null;
  let retries = 0;
  let requestedLocalPort = 0;
  let runningLocalPort = 0;
  let waitingForPort = false;
  let addressListener = typeof options.onAddress === 'function' ? options.onAddress : null;
  /** 地址被撤回时的出口（停用 / 卸载 / 连不上放弃）：把状态里那条死链撤掉，别让总控继续发给手机。 */
  let goneListener = typeof options.onAddressGone === 'function' ? options.onAddressGone : null;
  const exists = (p) => { try { return fsImpl.existsSync(p); } catch { return false; } };
  const localPort = () => {
    const port = Number(portOf());
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
  };

  function writeDisabled() {
    fsImpl.mkdirSync(paths.dir, { recursive: true });
    fsImpl.writeFileSync(paths.disabled, '1');
  }

  function removeDisabled() {
    try { fsImpl.rmSync(paths.disabled, { force: true }); } catch { /* 已不存在。 */ }
  }

  function clearConnectTimer() {
    if (connectTimer === null) return;
    try { clearConnectTimerImpl(connectTimer); } catch { /* 已触发/失效。 */ }
    connectTimer = null;
  }

  /** 把最后那条地址从状态里撤掉：只在真写过的时候撤，且撤失败不许反噬进程。 */
  function withdrawAddress() {
    if (!publishedUrl) return;
    publishedUrl = '';
    if (!goneListener) return;
    try {
      const returned = goneListener();
      if (returned && typeof returned.catch === 'function') returned.catch(() => { /* 同上 */ });
    } catch { /* 同上 */ }
  }

  function status() {
    return {
      available: Boolean(binary) || platformSupported,
      // 进程在 ≠ 隧道通：只有边缘那条连接建立了才算这条兜底真的能用。
      running: Boolean(child) && registered,
      pid: child && child.pid ? child.pid : null,
      url: child ? url : '',
      error,
      startedAt,
      starting: Boolean(child) ? !registered : Boolean(starting),
      retrying: retryTimer !== null,
      waitingForPort,
      enabled: !exists(paths.disabled),
    };
  }

  function scheduleRestart() {
    if (!desired || exists(paths.disabled) || retryTimer !== null) return;
    const token = generation;
    // 退避表用尽后转固定长间隔继续重试：一次网络风暴耗光机会后兜底隧道不能就此静默死掉。
    const { ms } = nextRestartDelay(retries, { delays: RESTART_DELAYS_MS, random });
    retries += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (desired && generation === token && !exists(paths.disabled)) launch().catch(() => {});
    }, ms);
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
      // ipv4-first / ipv4-only 时让 cloudflared 只连 Cloudflare 边缘的 IPv4 地址，绕开 IPv6 黑洞。
      const edge = cloudflaredEdgeIpVersion(ipVersionPolicyOf());
      const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
      if (edge) args.push('--edge-ip-version', edge);
      try {
        proc = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        error = describeSpawnFailure(err, binary);
        scheduleRestart();
        return;
      }
      child = proc;
      runningLocalPort = port;
      error = '';
      url = '';
      registered = false;
      publishedUrl = '';
      lineBuf = '';
      startedAt = Date.now();
      let tail = '';
      /** cloudflared 最近一条 ERR：超时时要把它原话带进状态，光说「连不上」没法让人去放行端口。 */
      let lastErr = '';
      const isCurrent = () => desired && child === proc && generation === token;
      /** 地址只在真连上边缘之后才交出去：没连上的地址写进总控就是一条死链。 */
      const publish = () => {
        if (!registered || !url || !isCurrent() || publishedUrl === url) return;
        publishedUrl = url;
        if (!addressListener) return;
        try {
          const returned = addressListener(url, isCurrent);
          if (returned && typeof returned.catch === 'function') returned.catch(() => { /* 地址写回失败不许反噬进程 */ });
        } catch { /* 监听同步抛错同样吞掉 */ }
      };
      // 从「还没连上」重新计时：起进程时一次，掉线后再计一次。超时只写原因、不杀进程（它自己重试）。
      const armConnectTimer = () => {
        clearConnectTimer();
        connectTimer = setConnectTimer(() => {
          connectTimer = null;
          if (!isCurrent() || registered) return;
          error = connectFailureText(lastErr, connectTimeoutMs);
          withdrawAddress();
        }, connectTimeoutMs);
        if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref();
      };
      armConnectTimer();
      const consume = (chunk) => {
        const text = String(chunk);
        tail = (tail + text).slice(-4000);
        const found = extractTunnelUrl(tail);
        if (found && isCurrent()) url = found;
        lineBuf = (lineBuf + text).slice(-4000);
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          if (!isCurrent()) return;
          if (LOG_ERROR_RE.test(line)) lastErr = cleanLogLine(line);
          if (CONNECTED_RE.test(line)) {
            registered = true;
            error = '';
            clearConnectTimer();
            publish();
          } else if (DISCONNECTED_RE.test(line) && registered) {
            registered = false;
            armConnectTimer();
          }
        }
        publish();
      };
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream || typeof stream.on !== 'function') continue;
        if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
        stream.on('data', consume);
      }
      if (typeof proc.on === 'function') {
        /** 进程没了的最终原因；close 到得晚、输出更全，用它覆盖 exit 时那句粗略的原因。 */
        const setGoneError = (code, signal) => {
          const lastLine = tail.trim() ? tail.trim().split('\n').pop() : '';
          error = `cloudflared 已退出（code=${code}${signal ? `, ${signal}` : ''}）${lastLine ? `：${lastLine}` : ''}`;
        };
        let gone = false;
        /** exit 和 close 共用的幂等清理：谁先到谁做一次，管道被占住时 close 不来就靠 exit 兜底。 */
        const onGone = (code, signal) => {
          if (gone) return;
          gone = true;
          clearConnectTimer();
          child = null;
          runningLocalPort = 0;
          url = '';
          registered = false;
          lineBuf = '';
          // 进程没了，之前上报的地址一定连不上，先撤掉；重连成功会带着新地址再报一次。
          withdrawAddress();
          setGoneError(code, signal);
          scheduleRestart();
        };
        proc.on('error', (err) => {
          if (child !== proc || gone) return;
          error = describeSpawnFailure(err, binary);
          // spawn 失败时 child 还挂着，不清掉 launch() 里的 if(child) return 会永久卡死。
          child = null;
          withdrawAddress();
          scheduleRestart();
        });
        proc.on('exit', (code, signal) => { if (child === proc) onGone(code, signal); });
        proc.on('close', (code, signal) => {
          if (child === proc) onGone(code, signal);
          else if (gone) setGoneError(code, signal);
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
    try { removeDisabled(); } catch (err) { error = `记录启用状态失败：${err && err.message ? err.message : err}`; }
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
    registered = false;
    lineBuf = '';
    // 主动停用 / 卸载：地址必死，撤掉，别让总控还拿着它发给手机。
    withdrawAddress();
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
    // 显式关掉：写关闭标记落盘，下次宿主启动不再自动拉起。
    writeDisabled();
    return status();
  }

  /** 协议族策略变了：正在跑就重启一次让新的 --edge-ip-version 生效；没在跑就不管。 */
  async function restartForPolicy() {
    if (!desired) return status();
    stopProcess();
    retries = 0;
    return launch();
  }

  /** 宿主卸载/退出：杀进程、清地址、解绑监听，不动关闭标记（用户此刻的开/关意图照旧保留）。 */
  function dispose() {
    desired = false;
    stopProcess();
    requestedLocalPort = 0;
    waitingForPort = false;
    addressListener = null;
    return status();
  }

  return {
    status, start, stop, syncLocalPort, dispose, restartForPolicy,
    get runId() { return generation; },
    setAddressListener(listener) {
      addressListener = typeof listener === 'function' ? listener : null;
      if (!child || !addressListener || !registered || !url) return;
      const proc = child;
      const token = generation;
      const isCurrent = () => desired && child === proc && generation === token;
      if (!isCurrent()) return;
      publishedUrl = url;
      try {
        const returned = addressListener(url, isCurrent);
        if (returned && typeof returned.catch === 'function') returned.catch(() => { /* 同上 */ });
      } catch { /* 同上 */ }
    },
    setAddressGoneListener(listener) {
      goneListener = typeof listener === 'function' ? listener : null;
    },
    async restart() { await stop(); return start(); },
    shouldAutoStart() { return !exists(paths.disabled); },
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

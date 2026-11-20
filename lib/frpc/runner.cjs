// FRP 等待真实监听端口并跟随运行中变更，异常退出有限重试，主动停止取消待启动工作。
'use strict';

/** 本机 frpc 的配置准备、进程起停和服务端分配地址读取。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dshHome } = require('../shared/paths.js');
const { ensureFrpc } = require('./provision.cjs');
const DEFAULT_ADMIN_PORT = 17401;
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** INI 仍可在面板识别地址，但当前 frpc 不接受它作为运行配置。 */
function isIniConfig(text) {
  return /^\s*\[common\]\s*$/im.test(String(text || '')) || /^\s*server_addr\s*=/im.test(String(text || ''));
}

function alignLocalPort(text, port) {
  const source = String(text || '');
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0) return source;
  if (source.trimStart().startsWith('{')) {
    const config = JSON.parse(source);
    if (Array.isArray(config.proxies)) {
      for (const proxy of config.proxies) {
        if (proxy && typeof proxy === 'object') {
          proxy.localPort = value;
          if ('local_port' in proxy) delete proxy.local_port;
        }
      }
    }
    return JSON.stringify(config, null, 2);
  }
  return source.replace(/^(\s*local(?:Port|_port)\s*[=:]\s*)["']?\d+["']?/gim, `$1${value}`);
}

/** 管理接口只在未配置时补齐；JSON 保持 JSON，并使用相应的配置扩展名。 */
function withAdminPort(text, port) {
  const source = String(text || '');
  if (source.trimStart().startsWith('{')) {
    const config = JSON.parse(source);
    if (!config.webServer) config.webServer = { addr: '127.0.0.1', port };
    return JSON.stringify(config, null, 2);
  }
  if (/(?:^|\n)\s*(?:webServer\s*[.=]|\[\s*webServer\s*\])/i.test(source)) return source;
  if (!/\[\[\s*proxies\s*\]\]/i.test(source)) return source;
  return `webServer.addr = "127.0.0.1"\nwebServer.port = ${port}\n\n${source}`;
}

/** 从当前运行配置读取管理端口，支持 TOML 点键/表和 JSON，用户值优先。 */
function adminPortOf(text, fallback) {
  const source = String(text || '');
  if (source.trimStart().startsWith('{')) {
    try { return Number(JSON.parse(source).webServer?.port) || fallback; } catch { return fallback; }
  }
  const dotted = /^\s*webServer\.port\s*=\s*(\d+)/im.exec(source);
  if (dotted) return Number(dotted[1]);
  const table = /(?:^|\n)\s*\[\s*webServer\s*\]\s*\r?\n([\s\S]*?)(?=\n\s*\[|$)/i.exec(source);
  const entry = table && /^\s*port\s*=\s*(\d+)/im.exec(table[1]);
  return entry ? Number(entry[1]) : fallback;
}

function describeSpawnFailure(err, binary) {
  const code = err && err.code ? String(err.code) : '';
  const raw = err && err.message ? err.message : String(err || '未知错误');
  const where = binary ? `（${binary}）` : '';
  if (code === 'UNKNOWN') {
    return `系统拒绝运行 frpc${where}：多半是安全软件（如 Windows Defender）拦了这个程序，或下载到的版本与本机芯片不符。请把它加入杀毒/安全软件的信任名单，或换成与本机匹配的 frpc 版本。`;
  }
  if (code === 'ENOEXEC') return `frpc${where} 不是这台机器能执行的程序：文件可能已损坏，或版本/架构不对。请重新获取一份与本机匹配的 frpc。`;
  if (code === 'EACCES' || code === 'EPERM') return `系统不允许运行 frpc${where}：权限被拒。请检查这个文件是否被禁止执行或被安全策略拦截。`;
  if (code === 'ENOENT') return `找不到 frpc 可执行文件${where}：它可能已被删除或路径失效，请重新获取。`;
  return `启动 frpc 失败：${raw}`;
}

function frpcPaths(root) {
  // 与 provision 缓存分开，避免换二进制时清掉运行配置。
  const dir = root || path.join(dshHome(), 'frpc-run');
  return { dir, config: path.join(dir, 'frpc.toml'), jsonConfig: path.join(dir, 'frpc.json'), enabled: path.join(dir, 'frpc.enabled') };
}

function createFrpcRunner(options = {}) {
  const paths = frpcPaths(options.root);
  const ensure = typeof options.ensure === 'function' ? options.ensure : ensureFrpc;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const portOf = typeof options.portOf === 'function' ? options.portOf : () => null;
  const fsImpl = options.fsImpl || fs;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const adminPort = Number.isInteger(options.adminPort) ? options.adminPort : DEFAULT_ADMIN_PORT;
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  let child = null;
  let binary = '';
  let error = '';
  let startedAt = 0;
  let remoteAddress = '';
  let desired = false;
  let generation = 0;
  let starting = null;
  let retryTimer = null;
  let retries = 0;
  let activeAdminPort = adminPort;
  let requestedLocalPort = 0;
  let runningLocalPort = 0;
  let waitingForPort = false;
  let discovery = null;
  let addressListener = typeof options.onRemoteAddress === 'function' ? options.onRemoteAddress : null;
  const exists = (p) => { try { return fsImpl.existsSync(p); } catch { return false; } };
  const configPath = () => exists(paths.jsonConfig) ? paths.jsonConfig : paths.config;
  const readConfig = () => { try { return fsImpl.readFileSync(configPath(), 'utf8'); } catch { return null; } };
  const localPort = () => {
    const port = Number(portOf());
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
  };

  function status() {
    return {
      available: Boolean(binary), running: Boolean(child), pid: child && child.pid ? child.pid : null,
      error, startedAt, configPresent: exists(paths.config) || exists(paths.jsonConfig),
      enabled: exists(paths.enabled), starting: Boolean(starting && !child), retrying: retryTimer !== null,
      waitingForPort, localPort: child ? runningLocalPort : 0, remoteAddress: child ? remoteAddress : '',
    };
  }

  function writeRunConfig(text, port = localPort()) {
    if (isIniConfig(text)) throw new Error('旧 INI 格式不能运行，请让服务商提供 TOML 或 JSON 配置');
    const prepared = withAdminPort(alignLocalPort(text, port), adminPort);
    const json = prepared.trimStart().startsWith('{');
    const target = json ? paths.jsonConfig : paths.config;
    fsImpl.mkdirSync(paths.dir, { recursive: true });
    fsImpl.writeFileSync(target, prepared);
    fsImpl.rmSync(json ? paths.config : paths.jsonConfig, { force: true });
    return target;
  }

  function saveConfig(text) {
    const target = writeRunConfig(text);
    fsImpl.writeFileSync(paths.enabled, '1');
    return target;
  }

  function pickRemote(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const group of Object.values(payload)) {
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        const addr = entry && typeof entry.remote_addr === 'string' ? entry.remote_addr.trim() : '';
        if (addr && addr.includes(':')) return addr;
      }
    }
    return '';
  }

  async function readRemoteAddress(timeoutMs = 8000) {
    if (typeof fetchImpl !== 'function') return '';
    const token = generation;
    const proc = child;
    const deadline = performance.now() + Math.max(500, Number(timeoutMs) || 8000);
    const url = `http://127.0.0.1:${activeAdminPort}/api/status`;
    while (performance.now() < deadline) {
      if (!proc || child !== proc || generation !== token) return '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(1500, Math.max(1, deadline - performance.now())));
      try {
        const response = await fetchImpl(url, { signal: controller.signal });
        const addr = response && response.ok ? pickRemote(await response.json()) : '';
        if (child !== proc || generation !== token) return '';
        if (addr) {
          remoteAddress = addr;
          const isCurrent = () => desired && child === proc && generation === token;
          if (addressListener && isCurrent()) await addressListener(addr, isCurrent);
          return isCurrent() ? addr : '';
        }
      } catch { /* 管理接口还没起来，继续等。 */ }
      finally { clearTimeout(timer); }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return '';
  }

  function discoverRemoteAddress(timeoutMs = 8000) {
    if (discovery && discovery.proc === child) return discovery.promise;
    const entry = { proc: child, promise: null };
    entry.promise = readRemoteAddress(timeoutMs).finally(() => { if (discovery === entry) discovery = null; });
    discovery = entry;
    return entry.promise;
  }

  function scheduleRestart() {
    if (!desired || !exists(paths.enabled) || retryTimer !== null || retries >= RESTART_DELAYS_MS.length) return;
    const token = generation;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (desired && generation === token && exists(paths.enabled)) void launch();
    }, RESTART_DELAYS_MS[retries++]);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  async function launch() {
    if (child) return status();
    if (starting) { await starting; return status(); }
    const token = ++generation;
    const run = (async () => {
      const raw = readConfig();
      if (!raw) { error = '还没有导入 frpc 配置'; return; }
      requestedLocalPort = localPort();
      waitingForPort = requestedLocalPort === 0;
      if (waitingForPort) { error = ''; return; }
      let got;
      try { got = await ensure({}); }
      catch (err) { got = { ok: false, message: err && err.message ? err.message : String(err) }; }
      if (!desired || generation !== token) return;
      if (!got || got.ok !== true) {
        error = got && got.message ? got.message : '没拿到 frpc 可执行文件';
        scheduleRestart();
        return;
      }
      // 获取二进制期间监听可能尚未就绪或已经换号，启动前只取这一刻的实绑端口。
      const port = localPort();
      requestedLocalPort = port;
      waitingForPort = port === 0;
      if (waitingForPort) { error = ''; return; }
      let target;
      try { target = writeRunConfig(raw, port); }
      catch (err) { error = `写 frpc 配置失败：${err && err.message ? err.message : err}`; return; }
      binary = got.path;
      let proc;
      try {
        proc = spawnImpl(binary, ['-c', target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        error = describeSpawnFailure(err, binary);
        scheduleRestart();
        return;
      }
      child = proc;
      runningLocalPort = port;
      activeAdminPort = adminPortOf(readConfig(), adminPort);
      error = '';
      remoteAddress = '';
      startedAt = Date.now();
      let tail = '';
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream || typeof stream.on !== 'function') continue;
        if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
        stream.on('data', (chunk) => { tail = (tail + String(chunk)).slice(-1500); });
      }
      if (typeof proc.on === 'function') {
        proc.on('error', (err) => { if (child === proc) error = describeSpawnFailure(err, binary); });
        // close 时两路输出已收全，保留 frpc 自己给的退出原因。
        proc.on('close', (code, signal) => {
          if (child !== proc) return;
          child = null;
          runningLocalPort = 0;
          remoteAddress = '';
          const lastLine = tail.trim() ? tail.trim().split('\n').pop() : '';
          error = `frpc 已退出（code=${code}${signal ? `, ${signal}` : ''}）${lastLine ? `：${lastLine}` : ''}`;
          scheduleRestart();
        });
      }
      // 每代启动都读取实际分配地址；回调拿代次谓词，停止或换代后不能写回旧地址。
      if (addressListener) void discoverRemoteAddress().catch(() => '');
    })();
    starting = run;
    try { await run; }
    finally { if (starting === run) starting = null; }
    return status();
  }

  async function start() {
    if (!desired) { desired = true; retries = 0; }
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    return launch();
  }

  function stopProcess() {
    generation += 1;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    starting = null;
    const proc = child;
    child = null;
    runningLocalPort = 0;
    remoteAddress = '';
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
    return status();
  }

  return {
    status, start, stop, syncLocalPort, saveConfig, discoverRemoteAddress,
    get runId() { return generation; },
    setAddressListener(listener) {
      addressListener = typeof listener === 'function' ? listener : null;
      if (child && addressListener) void discoverRemoteAddress().catch(() => '');
    },
    async restart() { await stop(); return start(); },
    async clear() {
      await stop();
      fsImpl.rmSync(paths.enabled, { force: true });
      return status();
    },
    shouldAutoStart() { return exists(paths.enabled) && (exists(paths.config) || exists(paths.jsonConfig)); },
    dispose() { return stop(); },
    _paths: paths,
  };
}

module.exports = { createFrpcRunner, alignLocalPort, withAdminPort, frpcPaths, isIniConfig, adminPortOf };

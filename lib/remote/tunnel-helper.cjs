// 桌面出站隧道的独立助手 RPC；私钥只在本机 IPC 中传递，响应按请求编号关联。
'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveBinary, platformId, IPC_VERSION } = require('../tailcat/host-process.cjs');
const MAX_LINE = 64 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveRemoteBinary(options = {}) {
  const exists = options.exists || fs.existsSync;
  const override = (options.env || process.env).DSHM_REMOTE_TUNNEL_HELPER;
  if (typeof override === 'string' && override && exists(override)) return override;
  const root = options.root || path.resolve(__dirname, '../../..');
  const packageRoot = options.packageRoot || path.resolve(__dirname, '../..');
  const platform = options.platformId || platformId();
  if (platform) {
    const name = platform === 'win32-x64' ? 'dsh-tailcat-host.exe' : 'dsh-tailcat-host';
    const bundled = path.join(packageRoot, 'native', platform, name);
    if (exists(bundled)) return bundled;
    if (exists(path.join(root, 'tailcat-host', 'runtime-version.json'))) {
      const development = path.join(root, 'build', 'tailcat-runtime', platform, name);
      if (exists(development)) return development;
    }
  }
  return (options.fallback || resolveBinary)();
}

function createRemoteTunnelHelper(options = {}) {
  const binary = (options.resolve || resolveRemoteBinary)();
  const launch = options.spawn || spawn;
  const pending = new Map();
  let child;
  let ready;
  let closed = false;
  let unsupported = false;
  let generation = 0;

  function rejectPending(code) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(failure(code));
    }
    pending.clear();
  }

  function disable(code) {
    unsupported = code === 'remote-helper-unsupported';
    rejectPending(code);
    const proc = child;
    child = undefined;
    ready = undefined;
    proc?.stdin?.end();
    proc?.kill();
  }

  function handleLine(line) {
    if (Buffer.byteLength(line) > MAX_LINE) return disable('remote-helper-protocol');
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== 'object') return;
    if (value.event === 'error' && value.code === 'invalid-command') {
      if ([...pending.values()].some(item => item.command === 'remoteCapabilities')) disable('remote-helper-unsupported');
      return;
    }
    if (value.event !== 'remoteResult' || typeof value.requestId !== 'string') return;
    const item = pending.get(value.requestId);
    if (!item) return;
    pending.delete(value.requestId);
    clearTimeout(item.timer);
    if (value.ok === true && value.result && typeof value.result === 'object') item.resolve(value.result);
    else item.reject(failure('remote-helper-request'));
  }

  function send(command, fields = {}, timeoutMs = options.timeoutMs || 15000) {
    if (!child?.stdin?.writable) return Promise.reject(failure('remote-helper-closed'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const code = command === 'remoteCapabilities' ? 'remote-helper-unsupported' : 'remote-helper-timeout';
        reject(failure(code));
        // start 可能稍后才返回，排在它后面的单设备清理会收回句柄，不影响其他电脑。
        if (fields.deviceId && child?.stdin?.writable) {
          child.stdin.write(`${JSON.stringify({ command: 'remoteClose', requestId: randomUUID(), deviceId: fields.deviceId })}\n`);
        } else disable(code);
      }, timeoutMs);
      pending.set(requestId, { command, resolve, reject, timer });
      const text = JSON.stringify({ ...fields, command, requestId });
      if (Buffer.byteLength(text) > MAX_LINE) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(failure('remote-helper-request'));
        return;
      }
      child.stdin.write(`${text}\n`, error => {
        if (error && pending.has(requestId)) disable('remote-helper-closed');
      });
    });
  }

  function start() {
    if (closed) return Promise.reject(failure('remote-helper-closed'));
    if (!binary) return Promise.reject(failure('remote-helper-unavailable'));
    if (unsupported) return Promise.reject(failure('remote-helper-unsupported'));
    if (ready) return ready;
    let proc;
    try { proc = launch(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch { return Promise.reject(failure('remote-helper-unavailable')); }
    child = proc;
    generation += 1;
    let buffer = '';
    proc.on('error', () => { if (child === proc) disable('remote-helper-unavailable'); });
    proc.stdin.on('error', () => { if (child === proc) disable('remote-helper-closed'); });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      if (child !== proc) return;
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handleLine(line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) disable('remote-helper-protocol');
    });
    proc.on('exit', () => { if (child === proc) disable('remote-helper-closed'); });
    proc.stdin.write(`${JSON.stringify({ version: IPC_VERSION, localPort: 19449, name: 'remote-computer-client', state: null, allowedClients: [] })}\n`);
    ready = send('remoteCapabilities', {}, options.capabilityTimeoutMs || 3000).then(result => {
      if (result.version !== 1 || !result.tailcat || !result.p2p) {
        disable('remote-helper-unsupported');
        throw failure('remote-helper-unsupported');
      }
      return result;
    });
    return ready;
  }

  return {
    status: () => ({ available: Boolean(binary) && !unsupported && !closed, running: Boolean(child), generation }),
    async request(command, fields = {}) { await start(); return send(command, fields); },
    async closeDevice(deviceId) {
      if (child && !closed && !unsupported) await send('remoteClose', { deviceId });
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending('remote-helper-closed');
      const proc = child;
      child = undefined;
      if (!proc || proc.exitCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { proc.kill(); resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.stdin.end();
      });
    },
  };
}

module.exports = { createRemoteTunnelHelper, resolveRemoteBinary };

// 桌面助手 RPC 仅在明确不支持时停用，能力探测超时按现有退避恢复。
'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveBinary, platformId, IPC_VERSION } = require('../tailcat/host-process.cjs');
const MAX_LINE = 64 * 1024;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

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
  const listeners = new Set();
  let child;
  let ready;
  let closed = false;
  let unsupported = false;
  let generation = 0;
  let restartTimer;
  let backoff = 0;
  let readyAt = 0;
  let lastError = '';
  const status = () => ({ available: Boolean(binary) && !unsupported && !closed,
    running: Boolean(child), ready: readyAt > 0, restarting: Boolean(restartTimer), generation, error: lastError });
  function notify() {
    const snapshot = status();
    for (const listener of listeners) {
      try { Promise.resolve(listener(snapshot)).catch(() => {}); } catch { /* 观察者不影响助手。 */ }
    }
  }
  function rejectPending(code) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(failure(code));
    }
    pending.clear();
  }
  function scheduleRestart() {
    if (closed || unsupported || !binary || restartTimer) return;
    const delay = BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)];
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void start().catch(() => {});
    }, delay);
    restartTimer.unref?.();
  }
  function disable(code) {
    if (closed) return;
    unsupported = code === 'remote-helper-unsupported';
    if (readyAt && performance.now() - readyAt >= 30000) backoff = 0;
    lastError = code;
    readyAt = 0;
    rejectPending(code);
    const proc = child;
    child = undefined;
    ready = undefined;
    proc?.stdin?.end();
    proc?.kill();
    if (unsupported && restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    else scheduleRestart();
    notify();
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
    const proc = child;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const code = command === 'remoteCapabilities' ? 'remote-helper-capability-timeout' : 'remote-helper-timeout';
        reject(failure(code));
        if (fields.deviceId && child === proc && proc.stdin?.writable) {
          proc.stdin.write(`${JSON.stringify({ command: 'remoteClose', requestId: randomUUID(), deviceId: fields.deviceId })}\n`);
        } else disable(code);
      }, timeoutMs);
      pending.set(requestId, { command, resolve, reject, timer });
      const text = JSON.stringify({ ...fields, command, requestId });
      if (Buffer.byteLength(text) > MAX_LINE) {
        clearTimeout(timer); pending.delete(requestId); reject(failure('remote-helper-request')); return;
      }
      proc.stdin.write(`${text}\n`, error => {
        if (error && child === proc && pending.has(requestId)) disable('remote-helper-closed');
      });
    });
  }
  function start() {
    if (closed) return Promise.reject(failure('remote-helper-closed'));
    if (!binary) return Promise.reject(failure('remote-helper-unavailable'));
    if (unsupported) return Promise.reject(failure('remote-helper-unsupported'));
    if (restartTimer) return Promise.reject(failure('remote-helper-restarting'));
    if (ready) return ready;
    let proc;
    try { proc = launch(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch { disable('remote-helper-unavailable'); return Promise.reject(failure('remote-helper-unavailable')); }
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
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); handleLine(line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) disable('remote-helper-protocol');
    });
    proc.on('exit', () => { if (child === proc) disable('remote-helper-closed'); });
    proc.stdin.write(`${JSON.stringify({ version: IPC_VERSION, localPort: 19449, name: 'remote-computer-client', state: null, allowedClients: [] })}\n`);
    ready = send('remoteCapabilities', {}, options.capabilityTimeoutMs || 3000).then(result => {
      if (child !== proc || closed) throw failure('remote-helper-closed');
      if (result.version !== 1 || !result.tailcat || !result.p2p) {
        disable('remote-helper-unsupported'); throw failure('remote-helper-unsupported');
      }
      readyAt = performance.now() || Number.EPSILON;
      lastError = '';
      notify();
      return result;
    });
    return ready;
  }
  return {
    status,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(command, fields = {}) { await start(); return send(command, fields); },
    async closeDevice(deviceId) {
      if (child && !closed && !unsupported && readyAt) await send('remoteClose', { deviceId });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = undefined; listeners.clear();
      rejectPending('remote-helper-closed');
      const proc = child;
      child = undefined; readyAt = 0;
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

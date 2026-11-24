// mux 握手遵守查看权限，连接归属随身份迁移并保留有界吊销回执。
'use strict';

/**
 * 对话页长连接（mux）：一条 WebSocket 上的双向多路复用服务（宿主侧）。
 *
 * 背景见 `docs/mux-long-connection-design.md`。要点：App 侧握住一条持久 WS，把「发送」「实时事件」
 * 以及其它**文本类**请求都变成这条 WS 上的逻辑流（按 id 并行）；宿主在这里按 id 把它们逐条转成
 * 本地回环 HTTP（`127.0.0.1:<webPort>`）打到既有的移动 API 上。于是：
 *
 *  - 业务处理器、鉴权、E2EE、按路由权限统统**一行不动**——mux 只是搬运工，逐路由权限仍由回环
 *    HTTP 那一层（`guarded`）判；本服务只负责「这条 WS 是否一台已配对设备」和按 id 拆装。
 *  - 中转零改动：手机 WS 经中转原样代理到宿主这个升级路由（与内置浏览器预览同一条现成管道）。
 *  - 兜底永远在：mux 连不上/不支持时 App 走原来的 HTTPS+SSE，最坏不比今天差。
 *
 * 载体口径：**文本帧**（JSON 直接放 UTF-8 文本）。mux 只承载文本类移动 API（发送 / 事件订阅 /
 * JSON 读），二进制下载（文件、附件字节）仍走 HTTP，不进 mux。宿主用 `StringDecoder` 切响应体，
 * 保证分块边界不会劈开一个多字节字符。
 *
 * 帧契约见设计文档 §11：一条 WS 消息 = 一帧 JSON。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { StringDecoder } = require('node:string_decoder');
const { WebSocketServer } = require('ws');
const { withViaHeader } = require('../shared/via-header');
const { resolvePermission, hasPermission } = require('./permissions');

const MOBILE_PATH = /^\/api\/mobile\/v1\/[a-zA-Z0-9/_-]+(?:\?[^\r\n#]*)?$/;
const CONNECTION_HEADERS = new Set([
  'authorization', 'cookie', 'x-dsh-device-credential', 'x-dsh-device', 'x-dsh-instance',
  'x-dsh-device-name', 'x-dsh-device-model', 'x-dsh-platform', 'x-dsh-os-version',
  'x-dsh-app-version', 'x-dsh-package-id', 'x-dsh-build-number', 'x-dsh-channel', 'x-dsh-lan-discovery',
]);

/** 单帧上限：与中转 `MAX_WS_MESSAGE_BYTES` / 宿主预览管道对齐（8 MiB）。 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** 单连接并行逻辑流上限：够用且挡住失控。 */
const MAX_STREAMS_PER_CONNECTION = 64;
/** 宿主侧同时存在的 mux 连接上限。 */
const MAX_CONNECTIONS = 32;

/** 往手机方向的水位：缓冲超过高水位就把上游按住，落到低水位再放开。 */
const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 1 * 1024 * 1024;
const SEND_RESUME_POLL_MS = 20;
const REVOKE_DRAIN_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 45_000;

/** 上游拨号超时：只覆盖「还没拿到响应头」这一段，之后是长连接，不能有读超时。 */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;

/** 不往上游转发的逐跳头（与隧道/预览同一口径）。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** 当前实现的鉴权提供给稳定外壳，旧 mux 也使用本代的查看权限判定。 */
function createMuxAuthorizer(authOutcome) {
  return (req) => {
    try {
      const outcome = authOutcome(req);
      if (!outcome.ok || !outcome.record) return false;
      if (!hasPermission(outcome.record, resolvePermission('/api/mobile/v1/mux', 'GET'))) return false;
      req.__dshRecord = outcome.record;
      return true;
    } catch { return false; }
  };
}

/**
 * 建一个 mux 服务。
 *
 * @param {object} opts
 * @param {{host?:string, port:number, agent?:import('node:http').Agent}} opts.upstream 本地移动 API 地址（一般 `127.0.0.1:<webPort>`）。
 * @param {(req: import('node:http').IncomingMessage) => boolean} opts.authorize 握手鉴权。
 * @param {(msg: string) => void} [opts.onLog]
 */
function createMuxService(opts = {}) {
  const upstreamHost = opts.upstream && opts.upstream.host ? opts.upstream.host : '127.0.0.1';
  const upstreamPort = opts.upstream ? Number(opts.upstream.port) : 0;
  const authorize = typeof opts.authorize === 'function' ? opts.authorize : () => false;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let connectionCount = 0;
  const deviceConnections = new Map();

  /**
   * 宿主 webServer 的升级处理器（`ctx.webServer.registerUpgrade`）。
   *
   * 鉴权与拒绝必须发生在 `handleUpgrade` **之前**：那时 socket 还是普通 HTTP 连接，能干净地回
   * 一个 401 关掉；握手之后再拒就只是给对端一条立断的 WS。
   */
  function handleUpgrade(req, socket, head) {
    let allowed = false;
    try { allowed = authorize(req) === true; } catch { allowed = false; }
    if (!allowed) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* 已断 */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const need = resolvePermission('/api/mobile/v1/mux', 'GET');
    if (need === 'unknown' || (need && !hasPermission(req.__dshRecord, need))) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* 已断 */ }
      try { socket.destroy(); } catch { /* 已关闭 */ }
      return;
    }
    if (connectionCount >= MAX_CONNECTIONS) {
      try { socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const trustedHeaders = {};
    for (const [name, value] of Object.entries(req.headers || {})) {
      const key = name.toLowerCase();
      if (CONNECTION_HEADERS.has(key)) trustedHeaders[key] = value;
    }
    wss.handleUpgrade(req, socket, head, (ws) => openConnection(ws, req, trustedHeaders));
  }

  function openConnection(ws, upgradeReq, trustedHeaders) {
    connectionCount += 1;
    const identity = { deviceId: upgradeReq.__dshRecord?.deviceId || '', instanceId: upgradeReq.__dshRecord?.instanceId || '' };
    deviceConnections.set(ws, identity);
    /** id → 一条在飞的本地请求。 */
    const streams = new Map();
    let closed = false;
    let revoking = false;
    let gracefulId = null;
    let closeTimer = null;
    let drainPoll = null;
    let finishDrain = null;
    let lastPong = performance.now();
    let heartbeatTimer = null;

    const send = (obj, callback) => {
      if (closed || ws.readyState !== 1 /* OPEN */) { callback?.(new Error('mux closed')); return; }
      try { ws.send(JSON.stringify(obj), callback); } catch (error) { callback?.(error); }
    };
    const closeAfterDrain = () => {
      if (closed) return;
      if (ws.bufferedAmount > 0) { drainPoll = setTimeout(closeAfterDrain, SEND_RESUME_POLL_MS); return; }
      try { ws.close(1000, 'device revoked'); } catch { ws.terminate(); }
    };
    const fail = (id, message) => send({ t: 'err', id, message: String(message || 'error') });

    const releaseUpstreamSocket = (entry) => {
      if (entry.activeUpstreamSocket && entry.onUpstreamSocketClose) entry.activeUpstreamSocket.off('close', entry.onUpstreamSocketClose);
      entry.activeUpstreamSocket = null;
      entry.onUpstreamSocketClose = null;
    };

    const clearHeaderTimer = (entry) => {
      clearTimeout(entry.headerTimer);
      entry.headerTimer = null;
    };

    /** 收掉一条逻辑流：销毁上游请求、释放槽位。 */
    const dropStream = (id, reason) => {
      const entry = streams.get(id);
      if (!entry) return;
      streams.delete(id);
      clearHeaderTimer(entry);
      if (entry.resumeTimer) clearTimeout(entry.resumeTimer);
      releaseUpstreamSocket(entry);
      try { if (!entry.responseEnded) entry.req?.destroy(); } catch { /* ignore */ }
      if (reason) fail(id, reason);
    };

    const scheduleResume = (entry, res, id) => {
      if (entry.resumeTimer) return;
      entry.resumeTimer = setTimeout(() => {
        entry.resumeTimer = null;
        if (closed || streams.get(id) !== entry) return;
        if (ws.bufferedAmount > SEND_LOW_WATER_BYTES) { scheduleResume(entry, res, id); return; }
        entry.paused = false;
        try { res.resume(); } catch { /* ignore */ }
      }, SEND_RESUME_POLL_MS);
    };

    const startRequest = (frame) => {
      const id = frame.id;
      if (typeof id !== 'number' || revoking) return;
      if (streams.has(id)) { fail(id, 'duplicate id'); return; }
      if (streams.size >= MAX_STREAMS_PER_CONNECTION) { fail(id, 'too many streams'); return; }
      const method = String(frame.method || 'GET').toUpperCase();
      const path = typeof frame.path === 'string' ? frame.path : '';
      if (!MOBILE_PATH.test(path)) { fail(id, 'mobile API path required'); return; }
      const forwarded = {};
      if (frame.headers && typeof frame.headers === 'object') {
        for (const [k, v] of Object.entries(frame.headers)) {
          if (!k || HOP_BY_HOP.has(k.toLowerCase()) || CONNECTION_HEADERS.has(k.toLowerCase())) continue;
          forwarded[k.toLowerCase()] = v;
        }
      }
      const headers = withViaHeader({ ...forwarded, ...trustedHeaders }, 'mux', `${upstreamHost}:${upstreamPort}`);
      // 正文由bodyEnd结束，所有方法都交给Node分块，GET/HEAD也不能退化成裸字节追加。
      headers['transfer-encoding'] = 'chunked';
      const entry = { req: null, res: null, activeUpstreamSocket: null, onUpstreamSocketClose: null, responseEnded: false, paused: false, resumeTimer: null, headerTimer: null, decoder: new StringDecoder('utf8') };
      streams.set(id, entry);
      const headerTimer = setTimeout(() => {
        if (entry.headerTimer === headerTimer && !closed && streams.get(id) === entry && !entry.res) dropStream(id, 'upstream header timeout');
      }, UPSTREAM_HEADER_TIMEOUT_MS);
      entry.headerTimer = headerTimer;
      headerTimer.unref?.();

      let req;
      try {
        req = http.request({ host: upstreamHost, port: upstreamPort, method, path, headers, ...(opts.upstream?.agent ? { agent: opts.upstream.agent } : {}) }, (res) => {
          clearHeaderTimer(entry);
          if (closed || streams.get(id) !== entry) { res.destroy(); return; }
          entry.res = res;
          const respHeaders = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (!k || HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-length') continue;
            respHeaders[k] = v;
          }
          send({ t: 'resp', id, status: res.statusCode || 200, headers: respHeaders });
          res.on('data', (buf) => {
            if (closed || streams.get(id) !== entry) return;
            // dec.write 只吐出完整字符，残缺的多字节尾巴自己留着，等下一块补上。
            const text = entry.decoder.write(buf);
            if (text) send({ t: 'chunk', id, text });
            if (!entry.paused && ws.bufferedAmount > SEND_HIGH_WATER_BYTES) {
              entry.paused = true;
              res.pause();
              scheduleResume(entry, res, id);
            }
          });
          res.on('end', () => {
            if (streams.get(id) !== entry) return;
            entry.responseEnded = true;
            releaseUpstreamSocket(entry);
            entry.req = null;
            const rest = entry.decoder.end();
            if (rest) send({ t: 'chunk', id, text: rest });
            send({ t: 'end', id }, (error) => {
              if (streams.get(id) === entry) streams.delete(id);
              if (revoking && gracefulId === id) {
                if (error) ws.terminate();
                else closeAfterDrain();
              }
            });
          });
          res.on('error', () => { if (streams.get(id) === entry) dropStream(id, 'upstream response error'); });
        });
      } catch (error) {
        dropStream(id, error && error.message ? error.message : 'upstream request failed');
        return;
      }
      entry.req = req;
      req.on('socket', (socket) => {
        if (closed || streams.get(id) !== entry || entry.responseEnded || req.destroyed || socket.destroyed) return;
        releaseUpstreamSocket(entry);
        entry.activeUpstreamSocket = socket;
        entry.onUpstreamSocketClose = () => releaseUpstreamSocket(entry);
        socket.once('close', entry.onUpstreamSocketClose);
      });
      req.on('error', (error) => { if (streams.get(id) === entry) dropStream(id, error && error.message ? error.message : 'upstream error'); });
      if (frame.body !== undefined && frame.body !== null) {
        if (typeof frame.body !== 'string') { dropStream(id, 'bad body'); return; }
        try { req.write(Buffer.from(frame.body, 'utf8')); } catch { /* error 会收 */ }
      }
    };

    const onFrame = (frame) => {
      if (!frame || typeof frame !== 'object') return;
      if (revoking && (frame.id !== gracefulId || !['body', 'bodyEnd'].includes(frame.t))) return;
      switch (frame.t) {
        case 'req': startRequest(frame); break;
        case 'body': {
          const entry = streams.get(frame.id);
          if (!entry || !entry.req) return;
          if (typeof frame.text !== 'string') { fail(frame.id, 'bad body'); return; }
          try { entry.req.write(Buffer.from(frame.text, 'utf8')); } catch { /* ignore */ }
          break;
        }
        case 'bodyEnd': {
          const entry = streams.get(frame.id);
          if (entry && entry.req) { try { entry.req.end(); } catch { /* ignore */ } }
          break;
        }
        case 'cancel': dropStream(frame.id); break;
        case 'ping': send({ t: 'pong' }); break;
        default: break; // 未知帧忽略（前向兼容）
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      clearTimeout(closeTimer);
      clearTimeout(drainPoll);
      finishDrain?.();
      deviceConnections.delete(ws);
      connectionCount -= 1;
      for (const entry of streams.values()) {
        clearHeaderTimer(entry);
        if (entry.resumeTimer) clearTimeout(entry.resumeTimer);
        releaseUpstreamSocket(entry);
        try { entry.req && entry.req.destroy(); } catch { /* ignore */ }
      }
      streams.clear();
    };

    heartbeatTimer = setInterval(() => {
      if (closed || revoking) return;
      if (ws.readyState !== 1 || performance.now() - lastPong >= PONG_TIMEOUT_MS) {
        cleanup();
        try { ws.terminate(); } catch { /* 已关闭 */ }
        return;
      }
      try { ws.ping(); } catch {
        cleanup();
        try { ws.terminate(); } catch { /* 已关闭 */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    ws.on('pong', () => { if (!closed) lastPong = performance.now(); });

    identity.revoke = (response) => {
      const socket = response?.socket;
      const owner = socket && !socket.destroyed && [...streams].find(([, entry]) => {
        const upstream = entry.activeUpstreamSocket;
        return !entry.responseEnded && entry.req && !entry.req.destroyed && upstream && !upstream.destroyed
          && upstream.localPort === socket.remotePort && upstream.remotePort === socket.localPort;
      });
      if (!owner) { ws.terminate(); return; }
      revoking = true;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      clearHeaderTimer(owner[1]);
      gracefulId = owner[0];
      response.__dshMuxDrained = new Promise(resolve => { finishDrain = resolve; });
      closeTimer = setTimeout(() => { try { ws.terminate(); } catch { /* 已关闭 */ } }, REVOKE_DRAIN_TIMEOUT_MS);
      closeTimer.unref?.();
      for (const id of [...streams.keys()]) if (id !== gracefulId) dropStream(id);
    };

    ws.on('message', (data, isBinary) => {
      if (closed || isBinary) return; // 契约只走 JSON 文本帧
      const frame = safeJson(data.toString('utf8'));
      if (!frame) { onLog('mux: bad json frame'); return; }
      onFrame(frame);
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  const dropConnections = (deviceId, instanceId, response) => {
    let count = 0;
    for (const [ws, identity] of deviceConnections) {
      if (instanceId !== undefined && identity.instanceId !== String(instanceId || '')) continue;
      if (deviceId !== undefined && identity.deviceId !== deviceId) continue;
      deviceConnections.delete(ws);
      if (ws.readyState === 3) continue;
      count += 1;
      try { identity.revoke(response); } catch { ws.terminate(); }
    }
    return count;
  };
  const reassignInstance = (fromInstanceId, toInstanceId) => {
    const from = String(fromInstanceId || '');
    const to = String(toInstanceId || '');
    for (const identity of deviceConnections.values()) {
      if (identity.instanceId === from) identity.instanceId = to;
    }
  };
  const dropDevice = (deviceId, instanceId, response) => dropConnections(deviceId, instanceId, response);
  const dropAll = (instanceId, response) => dropConnections(undefined, instanceId, response);
  return { handleUpgrade, dropDevice, dropAll, reassignInstance, MAX_MESSAGE_BYTES };
}

/** mux 主链路「实现指纹」：外壳按它决定提交时是否换服务。 */
function muxFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const rel of ['mux.js', 'permissions.js', '../shared/via-header.js']) {
    try { hash.update(fs.readFileSync(path.join(__dirname, rel))); } catch { hash.update(rel); }
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = { createMuxService, createMuxAuthorizer, muxFingerprint, MAX_MESSAGE_BYTES, MAX_STREAMS_PER_CONNECTION, MAX_CONNECTIONS, REVOKE_DRAIN_TIMEOUT_MS };

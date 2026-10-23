'use strict';

/**
 * 出站隧道客户端 v2：连接 dsh-mobile-server 中转，把中转发来的 HTTP/WS 请求转发到
 * 本机 dsh web（127.0.0.1:<port>）。
 *
 * 协议 v2 相对 v1 的变更（见 ../../relay/PROTOCOL.md）：
 *  - 二进制帧取代 JSON/base64 文本帧（数据通道不再 base64）；
 *  - 手机请求 body 流式转发（httpRequest + httpBody*），不再整包缓冲；
 *  - 应用层 ping/pong 心跳（对 NAT/代理更可靠）。
 */

const http = require('node:http');
const { WebSocket } = require('ws');
const { T, jsonFrame, encodeFrame, createFrameDecoder, parseJson, encodeClosePayload, decodeClosePayload } = require('./protocol.js');
const { isFreshRequest } = require('../shared/fresh-request');
const { encodeJsonBody } = require('../shared/http-util');
const { withViaHeader } = require('../shared/via-header');

const HEARTBEAT_INTERVAL_MS = 15_000;
// Relay currently expires an idle tunnel after 60s. Keep a wider client-side
// grace period so scheduling jitter or a delayed pong cannot make the client
// race the relay's timeout.
const PONG_TIMEOUT_MS = 90_000;
const MAX_TUNNEL_BUFFERED_BYTES = 16 * 1024 * 1024;
const TUNNEL_BUFFER_LOW_WATER_BYTES = MAX_TUNNEL_BUFFERED_BYTES / 2;
const HTTP_RESPONSE_CHUNK_BYTES = 256 * 1024;
const MAX_HTTP_RESPONSE_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_TUNNEL_HTTP_RESPONSE_PENDING_BYTES = 32 * 1024 * 1024;
const HTTP_RESPONSE_PUMP_MS = 25;
const HTTP_RESPONSE_BACKPRESSURE_TIMEOUT_MS = 30_000;
const HTTP_RESPONSE_RELAY_PAUSE_TIMEOUT_MS = 30_000;
const UPSTREAM_HEADER_TIMEOUT_MS = 7_000;
const UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS = 30_000;
// Keep reconnect storms from monopolizing the local Host HTTP server.
//
// 64 与局域网那条直连闸（lan-proxy 的 MAX_UPSTREAM_SSE_CONNECTIONS）取同一个数：两条路
// 通向的是同一个宿主、同一种资源，之前这里 16、那边 64，结果一台手机的几个被丢弃的连接
// 就能把走中转的所有设备一起挡在 429 外面。上限的作用是挡住失控重连，不是给正常多设备
// 使用设配额 —— 一台手机正常只占两条（会话流 + 设备级流）。
const MAX_UPSTREAM_SSE_CONNECTIONS = 64;
class RelayTunnel {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl  隧道 WSS 地址（含 /tunnel），如 wss://relay.example.com/tunnel
   * @param {string} opts.instanceId
   * @param {string} [opts.pairingCode] 仅本进程自用（面板显示）；**不发往中转**，见 registrationPayload
   * @param {string} [opts.name]
   * @param {string[]} [opts.lanUrls] LAN sidecar candidates (metadata only)
   * @param {object[]} [opts.lanCandidates] LAN candidate metadata (metadata only)
   * @param {string} opts.upstream  本地上游，如 http://127.0.0.1:52323
   * @param {string} [opts.registerSecret] 中转侧 TUNNEL_REGISTER_SECRET 的对偶值。
   *        优先于环境变量 DSH_RELAY_REGISTER_SECRET：桌面版 DSH 是从图标/启动台
   *        拉起的，拿不到 shell 环境变量，密钥只能走 relay.json（0600）。
   * @param {() => void} [opts.onRegistered] 注册成功回调（用于状态展示）
   * @param {(code: number, reason: string) => void} [opts.onClose] 连接断开回调（用于断线重连）
   * @param {(msg: {requestId: string, device?: {name?: string, ip?: string, platform?: string, osVersion?: string, version?: string, appVersion?: string, id?: string, deviceId?: string}}) => void} [opts.onPairRequest]
   *        中转转发来的配对授权请求（手机配对码已通过校验，需桌面用户确认）
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.instanceId = opts.instanceId;
    this.pairingCode = opts.pairingCode || '';
    this.name = opts.name || '';
    this.lanUrls = Array.isArray(opts.lanUrls) ? opts.lanUrls.slice() : [];
    this.lanCandidates = Array.isArray(opts.lanCandidates) ? opts.lanCandidates.slice() : [];
    this.upstream = new URL(opts.upstream);
    // 注册密钥：relay.json 里的显式值优先，环境变量作为无头/命令行场景的兜底。
    this.registerSecret = typeof opts.registerSecret === 'string' && opts.registerSecret
      ? opts.registerSecret
      : (process.env.DSH_RELAY_REGISTER_SECRET || '');
    // 读取隔离：可选的本地快照读取回调，命中时直接回（不再连主进程）。
    this.readSnapshot = typeof opts.readSnapshot === 'function' ? opts.readSnapshot : null;
    this.onRegistered = opts.onRegistered || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.onPairRequest = opts.onPairRequest || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.ws = null;
    this.wsClients = new Map();  // relay 侧 ws id -> 上游 ws client
    this.reqClients = new Map(); // relay 侧 http id -> { req, res }
    this.sseClients = new Set();
    // Tombstones close races where an upstream callback is already queued when
    // Relay cancels the request. They are bounded because ids are monotonic.
    this.cancelledHttp = new Set();
    this.cancelledWs = new Set();
    this.hbTimer = null;
    this.httpPumpTimer = null;
    this.httpPumpCursor = 0;
    this.pendingHttpResponseBytes = 0;
    this.lastPong = 0;
    // 清除所有授权的等待回调（一次一个）；由 requestRevokeAll 注入，revokeAllAck 触发。
    this._revokeAllAck = null;
  }

  log(...args) {
    this.onLog(`[relay ${this.instanceId}]`, ...args);
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 中转路上活着的上游 SSE 条数。自检台账（`/api/relay/status` 的 `selfCheck`）读它：
   * 局域网那条路有同名上限，两条路放一起才看得出「上游长流是不是只涨不落」。
   */
  get upstreamSseCount() {
    return this.sseClients.size;
  }

  /**
   * 发送队列积压到上限时**只丢这一帧，不断开隧道**。
   *
   * 旧实现在两个分支里都 `ws.terminate()`：积压超限时把整条隧道掐掉。可积压本身是
   * 「手机/中转读得慢」，不是「隧道坏了」——掐掉它，所有设备（包括正在正常转发的
   * 那些）一起掉线，还要等 5s 重连。中转侧的同名判定（dsh-mobile-server/lib/proxy-http.js
   * 的 sendFrame）已经改成只 `return false`，两侧口径必须一致：丢一帧可以恢复，
   * 关一条隧道是全网断流。
   *
   * 真正的「隧道已死」由心跳兜底：PONG_TIMEOUT_MS 收不到 pong 时才会 terminate。
   */
  dropOverBudget(bytes, frameLength) {
    const total = bytes + frameLength;
    this.log(`发送队列积压 ${total} 字节，超过上限 ${MAX_TUNNEL_BUFFERED_BYTES}，丢弃该帧（隧道保持连接）`);
    return false;
  }
  trySendEncodedFrame(frame) {
    if (!this.connected) return 'unavailable';
    const buffered = Number(this.ws.bufferedAmount || 0);
    if (buffered > MAX_TUNNEL_BUFFERED_BYTES || buffered + frame.length > MAX_TUNNEL_BUFFERED_BYTES) {
      this.dropOverBudget(buffered, frame.length);
      return 'backpressure';
    }
    try { this.ws.send(frame); return 'sent'; } catch { return 'error'; }
  }
  trySendFrame(type, id, payload) {
    try { return this.trySendEncodedFrame(encodeFrame(type, id, payload)); } catch { return 'error'; }
  }
  trySendJson(type, id, obj) {
    try { return this.trySendEncodedFrame(jsonFrame(type, id, obj)); } catch { return 'error'; }
  }
  sendFrame(type, id, payload) { return this.trySendFrame(type, id, payload) === 'sent'; }
  sendJson(type, id, obj) { return this.trySendJson(type, id, obj) === 'sent'; }
  createHttpResponseEntry(req = null, res = null, isSse = false) {
    return {
      req, res, isSse, relayPaused: false, bufferPaused: false, pendingFrames: [], pendingResponseBytes: 0,
      pendingHttpPayloadBytes: 0, headerTimer: null, responseIdleTimer: null, backpressureTimer: null,
      relayPauseTimer: null, terminalQueued: false, done: false,
    };
  }
  armUpstreamHeaderTimeout(id, entry) {
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    entry.headerTimer = setTimeout(() => {
      entry.headerTimer = null;
      if (entry.done || entry.res || this.cancelledHttp.has(id)) return;
      this.log(`upstream response header timeout: id=${id}`);
      try { entry.req?.destroy(new Error('upstream response headers timeout')); } catch { /* ignore */ }
    }, UPSTREAM_HEADER_TIMEOUT_MS);
  }
  clearUpstreamResponseIdleTimeout(entry) {
    if (entry.responseIdleTimer) clearTimeout(entry.responseIdleTimer);
    entry.responseIdleTimer = null;
  }
  clearHttpRelayPauseTimeout(entry) {
    if (entry.relayPauseTimer) clearTimeout(entry.relayPauseTimer);
    entry.relayPauseTimer = null;
  }
  armHttpRelayPauseTimeout(id, entry) {
    if (!entry || entry.done || entry.relayPauseTimer) return;
    entry.relayPauseTimer = setTimeout(() => {
      entry.relayPauseTimer = null;
      if (entry.done || !entry.relayPaused) return;
      this.log(`HTTP relay pause timeout: id=${id}`);
      if (!this.queueHttpTerminalError(id, entry, 'client response backpressure timeout')) {
        this.finishHttpRequest(id, entry, true);
      }
    }, HTTP_RESPONSE_RELAY_PAUSE_TIMEOUT_MS);
  }
  armUpstreamResponseIdleTimeout(id, entry) {
    this.clearUpstreamResponseIdleTimeout(entry);
    if (entry.done || entry.terminalQueued || entry.isSse || !entry.res || entry.relayPaused || entry.bufferPaused) return;
    entry.responseIdleTimer = setTimeout(() => {
      entry.responseIdleTimer = null;
      if (entry.done || entry.relayPaused || entry.bufferPaused) return;
      this.log(`upstream response idle timeout: id=${id}`);
      this.queueHttpTerminalError(id, entry, 'upstream response idle timeout');
    }, UPSTREAM_RESPONSE_IDLE_TIMEOUT_MS);
  }
  finishHttpRequest(id, entry, destroy = false) {
    if (!entry || entry.done) return;
    entry.done = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    entry.headerTimer = null;
    this.clearUpstreamResponseIdleTimeout(entry);
    this.clearHttpRelayPauseTimeout(entry);
    if (entry.backpressureTimer) clearTimeout(entry.backpressureTimer);
    entry.backpressureTimer = null;
    this.pendingHttpResponseBytes = Math.max(0, this.pendingHttpResponseBytes - (entry.pendingHttpPayloadBytes || 0));
    entry.pendingHttpPayloadBytes = 0;
    entry.pendingFrames = [];
    entry.pendingResponseBytes = 0;
    entry.bufferPaused = false;
    entry.relayPaused = false;
    this.sseClients.delete(id);
    if (this.reqClients.get(id) === entry) this.reqClients.delete(id);
    if (destroy) {
      try { entry.req?.destroy(); } catch { /* ignore */ }
      try { entry.res?.destroy(); } catch { /* ignore */ }
    }
    if (![...this.reqClients.values()].some((item) => item.pendingFrames?.length)) this.clearHttpPumpTimer();
  }
  clearHttpPumpTimer() {
    if (this.httpPumpTimer) clearTimeout(this.httpPumpTimer);
    this.httpPumpTimer = null;
  }
  queueHttpTerminalError(id, entry, message) {
    if (!entry || entry.done) return false;
    const queuedError = entry.pendingFrames.find((item) => item.type === T.httpError);
    if (entry.terminalQueued && !queuedError) return false;
    entry.terminalQueued = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    entry.headerTimer = null;
    this.clearUpstreamResponseIdleTimeout(entry);
    this.clearHttpRelayPauseTimeout(entry);
    if (entry.backpressureTimer) clearTimeout(entry.backpressureTimer);
    entry.backpressureTimer = null;
    entry.relayPaused = false;
    entry.bufferPaused = false;
    this.pendingHttpResponseBytes = Math.max(0, this.pendingHttpResponseBytes - (entry.pendingHttpPayloadBytes || 0));
    entry.pendingHttpPayloadBytes = 0;
    try { entry.req?.destroy(); } catch { /* ignore */ }
    try { entry.res?.destroy(); } catch { /* ignore */ }
    if (queuedError) {
      entry.pendingFrames = [queuedError];
      entry.pendingResponseBytes = queuedError.size;
    } else {
      const frame = jsonFrame(T.httpError, id, { message });
      entry.pendingFrames = [{ type: T.httpError, frame, payload: null, offset: 0, size: frame.length, terminal: true }];
      entry.pendingResponseBytes = frame.length;
    }
    entry.backpressureTimer = setTimeout(() => {
      if (!entry.done && entry.pendingFrames.length) {
        this.log(`HTTP terminal error delivery timeout: id=${id}`);
        this.finishHttpRequest(id, entry, true);
      }
    }, HTTP_RESPONSE_BACKPRESSURE_TIMEOUT_MS);
    this.scheduleHttpResponsePump();
    return true;
  }
  queueHttpResponseFrame(id, entry, type, payload, asJson = false) {
    if (!entry || entry.done || entry.terminalQueued) return false;
    const terminal = type === T.httpEnd || type === T.httpError;
    const isChunk = type === T.httpChunk;
    let frame = null;
    let body = null;
    try {
      if (isChunk) body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      else frame = asJson ? jsonFrame(type, id, payload) : encodeFrame(type, id, payload);
    } catch {
      this.finishHttpRequest(id, entry, true);
      return false;
    }
    const size = isChunk ? body.length : frame.length;
    const mustQueue = isChunk && body.length > HTTP_RESPONSE_CHUNK_BYTES;
    if (!entry.pendingFrames.length && !mustQueue && !entry.relayPaused) {
      const result = isChunk ? this.trySendFrame(type, id, body) : this.trySendEncodedFrame(frame);
      if (result === 'sent') {
        if (type === T.httpEnd || type === T.httpError) this.finishHttpRequest(id, entry);
        return true;
      }
      if (result === 'error') {
        return this.queueHttpTerminalError(id, entry, 'relay failed to accept upstream response');
      }
      if (result !== 'backpressure') {
        this.finishHttpRequest(id, entry, true);
        return false;
      }
    }
    const nextRequestBytes = entry.pendingResponseBytes + size;
    const nextTunnelPayloadBytes = this.pendingHttpResponseBytes + (isChunk ? size : 0);
    if (nextRequestBytes > MAX_HTTP_RESPONSE_PENDING_BYTES) {
      this.log(`HTTP response buffer limit exceeded: id=${id} bytes=${nextRequestBytes}`);
      return this.queueHttpTerminalError(id, entry, 'upstream response backpressure limit exceeded');
    }
    if (nextTunnelPayloadBytes > MAX_TUNNEL_HTTP_RESPONSE_PENDING_BYTES) {
      this.log(`Tunnel HTTP response buffer limit exceeded: id=${id} bytes=${nextTunnelPayloadBytes}`);
      return this.queueHttpTerminalError(id, entry, 'tunnel response backpressure limit exceeded');
    }
    entry.pendingFrames.push({ type, frame, payload: body, offset: 0, size, terminal });
    if (terminal) entry.terminalQueued = true;
    entry.pendingResponseBytes += size;
    if (isChunk) {
      entry.pendingHttpPayloadBytes += size;
      this.pendingHttpResponseBytes += size;
    }
    entry.bufferPaused = true;
    this.clearUpstreamResponseIdleTimeout(entry);
    entry.res?.pause();
    if (!entry.backpressureTimer) {
      entry.backpressureTimer = setTimeout(() => {
        if (entry.done || !entry.pendingFrames.length) return;
        this.log(`HTTP response backpressure timeout: id=${id}`);
        if (!this.queueHttpTerminalError(id, entry, 'upstream response backpressure timeout')) {
          this.finishHttpRequest(id, entry, true);
        }
      }, HTTP_RESPONSE_BACKPRESSURE_TIMEOUT_MS);
    }
    this.scheduleHttpResponsePump();
    return true;
  }
  scheduleHttpResponsePump() {
    if (this.httpPumpTimer) return;
    this.httpPumpTimer = setTimeout(() => {
      this.httpPumpTimer = null;
      this.pumpHttpResponses();
    }, HTTP_RESPONSE_PUMP_MS);
  }
  pumpHttpResponses() {
    if (!this.connected) return this.clearHttpPumpTimer();
    const all = [...this.reqClients.entries()];
    const count = all.length;
    if (!count) return this.clearHttpPumpTimer();
    const start = this.httpPumpCursor % count;
    if (!all.some(([, entry]) => !entry.done && !entry.relayPaused && entry.pendingFrames?.length)) {
      return this.clearHttpPumpTimer();
    }
    if (Number(this.ws.bufferedAmount || 0) > TUNNEL_BUFFER_LOW_WATER_BYTES) return this.scheduleHttpResponsePump();
    for (let step = 0; step < count; step += 1) {
      const index = (start + step) % count;
      const [id, entry] = all[index];
      if (entry.done || entry.relayPaused || !entry.pendingFrames?.length) continue;
      if (Number(this.ws.bufferedAmount || 0) + HTTP_RESPONSE_CHUNK_BYTES + 16 > MAX_TUNNEL_BUFFERED_BYTES) break;
      const item = entry.pendingFrames[0];
      let result;
      if (item.type === T.httpChunk) {
        const end = Math.min(item.offset + HTTP_RESPONSE_CHUNK_BYTES, item.payload.length);
        const chunk = item.payload.subarray(item.offset, end);
        result = this.trySendFrame(item.type, id, chunk);
        if (result === 'sent') {
          item.offset = end;
          entry.pendingResponseBytes -= chunk.length;
          entry.pendingHttpPayloadBytes -= chunk.length;
          this.pendingHttpResponseBytes = Math.max(0, this.pendingHttpResponseBytes - chunk.length);
          if (item.offset >= item.payload.length) entry.pendingFrames.shift();
        }
      } else {
        result = this.trySendEncodedFrame(item.frame);
        if (result === 'sent') {
          entry.pendingResponseBytes -= item.size;
          entry.pendingFrames.shift();
        }
      }
      if (result === 'backpressure') break;
      if (result === 'error' && item.type !== T.httpError) {
        this.queueHttpTerminalError(id, entry, 'relay failed to accept upstream response');
        this.httpPumpCursor = (index + 1) % count;
        continue;
      }
      if (result !== 'sent') {
        this.finishHttpRequest(id, entry, true);
        continue;
      }
      this.httpPumpCursor = (index + 1) % count;
      if (item.terminal && !entry.pendingFrames.length) {
        this.finishHttpRequest(id, entry);
        continue;
      }
      if (!entry.pendingFrames.length) {
        entry.bufferPaused = false;
        if (entry.backpressureTimer) clearTimeout(entry.backpressureTimer);
        entry.backpressureTimer = null;
        if (!entry.relayPaused) {
          entry.res?.resume();
          this.armUpstreamResponseIdleTimeout(id, entry);
        }
      }
    }
    if ([...this.reqClients.values()].some((entry) => !entry.done && !entry.relayPaused && entry.pendingFrames?.length)) {
      this.scheduleHttpResponsePump();
    } else {
      this.clearHttpPumpTimer();
    }
  }
  rememberCancelled(set, id) {
    set.add(id);
    while (set.size > 4096) set.delete(set.values().next().value);
  }

  /**
   * 更新配对码。
   *
   * **不再告诉中转**（§5.2）。中转那边从来没用过它 —— `ws.rs` 写明「不保存也不校验
   * 注册帧里的实例号 / 配对码」，唯一的用处是控制台准入校验的 `license` 字段。删掉之后
   * 「中转看得见配对码」这个既成事实就不存在了，而这一轮之后配对码本身也不再是
   * 新协议的凭证（票据才是）。
   *
   * 保留这个方法只因为 `updateRegistration` 那条路还在用它更新本地值。
   */
  updatePairingCode(code) {
    this.pairingCode = code;
  }

  /**
   * 注册帧的载荷。连接建立时发一次，之后元信息变了再由 updateRegistration 重发。
   *
   * **不带配对码**（§5.2）：中转从来没读过它，而带上它就等于把「谁能配这台机器」的
   * 一半凭证交给链路上的第三方。删掉零成本。
   */
  registrationPayload() {
    return {
      instanceId: this.instanceId,
      name: this.name,
      // 可选：与中转端 TUNNEL_REGISTER_SECRET 对应，防止他人抢注 instanceId。
      ...(this.registerSecret ? { secret: this.registerSecret } : {}),
      ...(this.lanUrls.length ? { lanUrls: this.lanUrls } : {}),
      ...(this.lanCandidates.length ? { lanCandidates: this.lanCandidates } : {}),
    };
  }

  /**
   * 在**现有连接上**重报一次注册信息（配对码 / 名字 / 局域网候选），不断连接。
   *
   * 中转那边同一个实例重复注册是幂等的（不会把自己顶掉），所以这条只是「更新名片」。
   * 以前这类变化是把整条隧道拆了重建，代价是手机所有在途请求一起断——真机现场就是
   * 「切个网络，接下来几秒点什么都失败」。真正决定「连到哪台」的字段（实例、中转
   * 地址、注册密钥）不在这里更新，它们变了必须重建，由 worker 的 configure 判定。
   */
  updateRegistration(patch = {}) {
    if (typeof patch.pairingCode === 'string' && patch.pairingCode) this.pairingCode = patch.pairingCode;
    if (typeof patch.name === 'string') this.name = patch.name;
    if (Array.isArray(patch.lanUrls)) this.lanUrls = patch.lanUrls.slice();
    if (Array.isArray(patch.lanCandidates)) this.lanCandidates = patch.lanCandidates.slice();
    if (this.connected) this.sendJson(T.register, 0, this.registrationPayload());
  }

  /**
   * 回传桌面端弹窗授权结果：approved + 桌面签发的移动 token（拒绝时无 token）。
   * `hostPlatform` 是**宿主自己的** `process.platform`，经中转原样回给手机，
   * 让配对那一刻就把「这台是什么系统」落盘（设备行不等 status 轮询）。
   */
  sendPairConfirm(requestId, approved, token, hostPlatform) {
    this.sendJson(T.pairConfirm, 0, {
      requestId,
      approved,
      ...(approved && token ? { token } : {}),
      ...(approved && typeof hostPlatform === 'string' && hostPlatform ? { hostPlatform } : {}),
    });
  }

  /**
   * 请求中转清空本实例全部设备授权（清除所有授权）。
   * resolve 于收到 revokeAllAck，reject 于未连接 / 超时。
   * @param {number} [timeoutMs] 等待回执的毫秒数，默认 10s
   */
  requestRevokeAll(timeoutMs = 10_000) {
    if (!this.connected) return Promise.reject(new Error('tunnel not connected'));
    if (this._revokeAllAck) return Promise.reject(new Error('revoke-all already in flight'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._revokeAllAck = null;
        reject(new Error('revoke-all timeout'));
      }, timeoutMs);
      this._revokeAllAck = (result) => {
        clearTimeout(timer);
        this._revokeAllAck = null;
        resolve(result || {});
      };
      this.sendJson(T.revokeAll, 0, { at: Date.now() });
    });
  }

  /** 建立连接并注册；resolve 于收到 registered，reject 于连接/注册失败 */
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (!settled) {
          settled = true;
          fn(arg);
        }
      };
      // 中转侧是 tokio-tungstenite 手写的 101，从不回 `sec-websocket-extensions`，
      // 所以 permessage-deflate 一次都没协商成功过；开着只会让人以为隧道压过。
      // 真省字节靠的是响应体的 gzip（见 lib/shared/http-util.js）。
      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        done(reject, new Error('注册超时'));
        try { ws.close(); } catch { /* ignore */ }
      }, 8000);

      const push = createFrameDecoder((frame) => {
        if (frame.type === T.registered) {
          clearTimeout(timer);
          done(resolve);
          this.onRegistered();
          return;
        }
        this.handleFrame(frame);
      });

      ws.on('open', () => {
        this.sendJson(T.register, 0, this.registrationPayload());
      });
      ws.on('message', (data, isBinary) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.stopHeartbeat();
        this.log(`tunnel closed: ${code} ${reason}`);
        this.ws = null;
        this.clearHttpPumpTimer();
        for (const [, client] of this.wsClients) {
          try { client.terminate(); } catch { /* ignore */ }
        }
        this.wsClients.clear();
        for (const [id, entry] of this.reqClients) this.finishHttpRequest(id, entry, true);
        this.reqClients.clear();
        this.sseClients.clear();
        this.cancelledHttp.clear();
        this.cancelledWs.clear();
        this.onClose(code, reason);
        done(reject, new Error(`隧道关闭: ${code} ${reason}`));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        done(reject, err);
      });

      this.startHeartbeat();
    });
  }

  stop() {
    this.stopHeartbeat();
    this.clearHttpPumpTimer();
    for (const [, client] of this.wsClients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    for (const [id, entry] of this.reqClients) this.finishHttpRequest(id, entry, true);
    this.reqClients.clear();
    this.sseClients.clear();
    this.cancelledHttp.clear();
    this.cancelledWs.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ── 心跳 ──────────────────────────────────────────────────────────
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    this.hbTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
        this.log('心跳超时，断开隧道');
        try { this.ws.terminate(); } catch { /* ignore */ }
        return;
      }
      this.sendFrame(T.ping, 0, Buffer.alloc(0));
    }, HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  // ── 帧分发 ────────────────────────────────────────────────────────
  handleFrame(frame) {
    const { type, id, payload } = frame;
    switch (type) {
      case T.httpRequest: {
        const msg = parseJson(payload);
        this.cancelledHttp.delete(id);
        const isSse = String(msg.headers?.accept || '').toLowerCase().includes('text/event-stream');
        const entry = this.createHttpResponseEntry(null, null, isSse);
        this.reqClients.set(id, entry);
        if (isSse && this.sseClients.size >= MAX_UPSTREAM_SSE_CONNECTIONS) {
          // 留一行日志：这条 429 的正文是空的，手机侧只会看到「连不上」，事后没法反推是被
          // 本地这道闸挡的，还是中转那边挡的（两边上限同名同数）。
          this.log(`上游长流已达上限 ${MAX_UPSTREAM_SSE_CONNECTIONS}，拒绝 ${msg.path}`);
          this.queueHttpResponseFrame(id, entry, T.httpHead, { status: 429, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' } }, true);
          this.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0));
          return;
        }
        if (isSse) this.sseClients.add(id);
        // 读取隔离：命中本地快照时也走有界发送队列，避免快照响应在buffer高水位时丢帧。
        // 例外：带 ?fresh=1 的写后刷新必须回源（判定与实测见 lib/shared/fresh-request.js）。
        if (this.readSnapshot && !isFreshRequest(msg.path) && (msg.method === 'GET' || msg.method === undefined)) {
          const body = this.readSnapshot({ method: msg.method, path: msg.path });
          if (body && body.ok) {
            // 这条捷径回的是列表 / 工作区 / 消息 / 统计这几条最重的读取，压缩的收益全在这儿。
            const encoded = encodeJsonBody(JSON.stringify(body), msg.headers?.['accept-encoding']);
            this.queueHttpResponseFrame(id, entry, T.httpHead, {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                vary: 'accept-encoding',
                ...(encoded.gzip ? { 'content-encoding': 'gzip' } : {}),
              },
            }, true);
            this.queueHttpResponseFrame(id, entry, T.httpChunk, encoded.body);
            this.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0));
            return;
          }
        }
        const req = http.request(
          {
            host: this.upstream.hostname,
            port: this.upstream.port,
            method: msg.method,
            path: msg.path,
            headers: withViaHeader(msg.headers, 'relay', this.upstream.host),
          },
          (res) => {
            entry.res = res;
            if (entry.headerTimer) clearTimeout(entry.headerTimer);
            entry.headerTimer = null;
            if (this.cancelledHttp.has(id)) return this.finishHttpRequest(id, entry, true);
            this.queueHttpResponseFrame(id, entry, T.httpHead, { status: res.statusCode, headers: res.headers }, true);
            if (entry.relayPaused || entry.bufferPaused) res.pause();
            else this.armUpstreamResponseIdleTimeout(id, entry);
            res.on('data', (chunk) => {
              if (!this.cancelledHttp.has(id)) {
                this.armUpstreamResponseIdleTimeout(id, entry);
                this.queueHttpResponseFrame(id, entry, T.httpChunk, chunk);
              }
            });
            res.on('end', () => {
              this.clearUpstreamResponseIdleTimeout(entry);
              const cancelled = this.cancelledHttp.has(id);
              if (!cancelled) this.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0));
              else this.finishHttpRequest(id, entry);
              if (cancelled) this.cancelledHttp.delete(id);
            });
            res.on('error', (err) => {
              this.clearUpstreamResponseIdleTimeout(entry);
              const cancelled = this.cancelledHttp.has(id);
              if (!cancelled) this.queueHttpResponseFrame(id, entry, T.httpError, { message: err.message }, true);
              else this.finishHttpRequest(id, entry);
              if (cancelled) this.cancelledHttp.delete(id);
            });
          },
        );
        entry.req = req;
        this.reqClients.set(id, entry);
        req.on('error', (err) => {
          if (entry.headerTimer) clearTimeout(entry.headerTimer);
          entry.headerTimer = null;
          const cancelled = this.cancelledHttp.has(id);
          if (!cancelled) this.queueHttpResponseFrame(id, entry, T.httpError, { message: err.message }, true);
          else this.finishHttpRequest(id, entry);
          if (cancelled && !entry.res) this.cancelledHttp.delete(id);
        });
        break;
      }
      case T.httpBody: {
        const entry = this.reqClients.get(id);
        if (!entry || this.cancelledHttp.has(id)) break;
        if (payload.length === 0) {
          try {
            entry.req.end();
            this.armUpstreamHeaderTimeout(id, entry);
          } catch { /* ignore */ }
        } else {
          try { entry.req.write(payload); } catch { /* ignore */ }
        }
        break;
      }
      case T.httpCancel: {
        const entry = this.reqClients.get(id);
        this.rememberCancelled(this.cancelledHttp, id);
        if (entry) this.finishHttpRequest(id, entry, true);
        else this.sseClients.delete(id);
        break;
      }
      case T.httpPause: {
        const entry = this.reqClients.get(id);
        if (entry) {
          if (!entry.relayPaused) {
            entry.relayPaused = true;
            this.armHttpRelayPauseTimeout(id, entry);
          }
          this.clearUpstreamResponseIdleTimeout(entry);
          entry.res?.pause();
        }
        break;
      }
      case T.httpResume: {
        const entry = this.reqClients.get(id);
        if (entry) {
          entry.relayPaused = false;
          this.clearHttpRelayPauseTimeout(entry);
          if (!entry.bufferPaused) {
            entry.res?.resume();
            this.armUpstreamResponseIdleTimeout(id, entry);
          }
          if (entry.pendingFrames?.length) this.scheduleHttpResponsePump();
        }
        break;
      }
      case T.wsUpgrade: {
        const msg = parseJson(payload);
        this.cancelledWs.delete(id);
        this.forwardWs(id, msg.path, msg.headers);
        break;
      }
      case T.wsText:
      case T.wsBinary: {
        const client = this.wsClients.get(id);
        if (!this.cancelledWs.has(id) && client && client.readyState === WebSocket.OPEN) {
          client.send(payload, { binary: type === T.wsBinary });
        }
        break;
      }
      case T.wsClose: {
        const client = this.wsClients.get(id);
        this.rememberCancelled(this.cancelledWs, id);
        this.wsClients.delete(id);
        if (client) {
          const { code, reason } = decodeClosePayload(payload);
          try { client.close(code, reason); } catch { /* ignore */ }
        }
        break;
      }
      case T.pairRequest: {
        const msg = parseJson(payload);
        this.onPairRequest(msg);
        break;
      }
      case T.ping:
        this.sendFrame(T.pong, 0, Buffer.alloc(0));
        break;
      case T.pong:
        this.lastPong = Date.now();
        break;
      case T.revokeAllAck: {
        const msg = parseJson(payload);
        if (this._revokeAllAck) this._revokeAllAck(msg);
        break;
      }
      default:
        break;
    }
  }

  /** 把手机发来的 WS 升级请求桥接到本地上游 WS */
  forwardWs(id, path, headers) {
    const url = `ws://${this.upstream.host}${path}`;
    let client;
    try {
      client = new WebSocket(url, { headers: withViaHeader(headers, 'relay', this.upstream.host) });
    } catch (err) {
      if (!this.cancelledWs.has(id)) this.sendJson(T.wsError, id, { message: err.message });
      return;
    }
    this.wsClients.set(id, client);
    client.on('open', () => {
      if (this.cancelledWs.has(id)) return client.close();
      this.sendFrame(T.wsOpen, id, Buffer.alloc(0));
    });
    client.on('message', (data, isBinary) => {
      if (!this.cancelledWs.has(id)) this.sendFrame(isBinary ? T.wsBinary : T.wsText, id, data);
    });
    client.on('close', (code, reason) => {
      this.wsClients.delete(id);
      if (!this.cancelledWs.has(id)) this.sendFrame(T.wsClose, id, encodeClosePayload(code, reason));
    });
    client.on('error', (err) => {
      if (!this.cancelledWs.has(id)) this.sendJson(T.wsError, id, { message: err.message });
      this.wsClients.delete(id);
    });
  }
}

module.exports = { RelayTunnel, HEARTBEAT_INTERVAL_MS, PONG_TIMEOUT_MS };

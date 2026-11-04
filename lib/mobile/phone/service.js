'use strict';

/**
 * 手机操作通道的宿主端：一台手机一条常驻连接，宿主在这条连接上发动作、收结果。
 *
 * ## 为什么是「一条连接对应一台手机」而不是一条会话
 *
 * 一块虚拟屏一个任务，而任务属于会话；但连接属于手机 —— 同一台手机上可能同时跑两个会话的
 * 任务，而断线重连应当一次接回全部。所以键是 deviceId，帧里带 sessionId 让手机自己分派。
 *
 * ## 谁发起、往哪走
 *
 * 手机在户外、电脑在任何地方，两者只能互连在**已有的加密通道**上（局域网直连 / 公网中转
 * 都落地到同一个 webServer 升级口）。所以这条和预览、终端同一条机制：手机建 WebSocket，
 * 宿主完成鉴权后接管。手机上不额外开监听端口。
 *
 * ## 帧
 *
 * 文本帧，JSON。手机 → 宿主：
 *   - `{t:'hello', device:{model, platform, osVersion, appVersion}, capabilities:[…]}`
 *   - `{t:'result', id, ok:true, data}` / `{t:'result', id, ok:false, error:{code,message}}`
 *   - `{t:'event', kind:'needs-human'|'progress', sessionId, …}` —— 暂只记账，不转发
 *
 * 宿主 → 手机：
 *   - `{t:'op', id, sessionId, action, args}`
 *   - `{t:'cancel', id}`
 *
 * 动作名是封闭的一小张表（见 `ACTIONS`）；手机端认不出的动作回 `unsupported`，宿主不会因为
 * 版本错位把整条连接打断。
 *
 * ## 超时与断开
 *
 * 每个 op 带自己的预算（看屏宽松、点击紧凑）。超时按 `timeout` 失败返回，并把 `cancel` 发
 * 过去 —— 手机那边可能正卡在一个慢动作里，不撤销就会在下一个 op 上错位。连接断开时，所有
 * 在途 op 立刻以 `offline` 结束，调用方（工具的 execute）据此给模型一句说清楚的话。
 */

const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');

/** 一条帧的上限：截图是 base64 塞在 JSON 里的，留足余量；更大的东西手机不会发。 */
const MAX_PAYLOAD = 12 * 1024 * 1024;
/** 心跳：手机每 20 秒至少要有一次 ping/pong 往返，否则按掉线处理（等它自己重连）。 */
const HEARTBEAT_MS = 20_000;
/** 单次 op 的默认预算；每个动作另有自己的一档（见 ACTIONS）。 */
const DEFAULT_OP_TIMEOUT_MS = 30_000;

/**
 * 动作表：`action → 预算(ms)`。
 *
 * 它不是「白名单」这种可有可无的礼貌：手机端按这张表实现、宿主按这张表校验，多一个动作
 * 就是扩一次能力面，两边必须同时改。**这里永远不会有通用执行** —— 没有 `shell`、没有
 * `exec`、没有可以拼参数的入口。
 */
const ACTIONS = new Map([
  ['screen.read', 15_000],
  ['screen.screenshot', 20_000],
  ['tap', 15_000],
  ['type', 20_000],
  ['swipe', 20_000],
  ['key', 15_000],
  ['app.open', 30_000],
  ['app.close', 15_000],
  ['app.list', 20_000],
  ['wait', 30_000],
  ['task.release', 20_000],
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function statusOf(socket) {
  return socket && socket.readyState === 1;
}

/**
 * @param {object} deps
 * @param {(req: object) => boolean} deps.authorized 现有那条鉴权判定（`mobile/auth.js`）
 * @param {(message: string) => void} [deps.onLog]
 */
function createPhoneService({ authorized, onLog } = {}) {
  /** deviceId → 连接。同一台手机重连时新的顶掉旧的（旧的那条先被关掉）。 */
  const devices = new Map();
  let closed = false;
  let seq = 0;

  const log = (message) => { try { onLog?.(message); } catch { /* 日志失败不影响搬运 */ } };

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });

  function nextId() {
    seq += 1;
    return `p${seq}`;
  }

  /** 关掉一条连接并结算它的在途 op。 */
  function drop(deviceId, reason) {
    const link = devices.get(deviceId);
    if (!link) return;
    devices.delete(deviceId);
    for (const [, pending] of link.pending) {
      pending.settleErr({
        code: reason,
        message: reason === 'offline'
          ? '手机已经断开连接'
          : '这台手机重新连上了，上一条连接上的这一步作废',
      });
    }
    link.pending.clear();
    try { link.socket.close(); } catch { /* 已经断了 */ }
  }

  function attach(socket, deviceId, hello) {
    const previous = devices.get(deviceId);
    // 同一台手机重连：旧的先结算掉，否则那几条在途 op 会一直等到各自超时。
    if (previous && previous.socket !== socket) drop(deviceId, 'replace');
    const link = {
      socket,
      deviceId,
      device: hello && hello.device && typeof hello.device === 'object' ? hello.device : {},
      capabilities: hello && Array.isArray(hello.capabilities) ? hello.capabilities.filter((c) => typeof c === 'string') : [],
      connectedAt: Date.now(),
      alive: true,
      pending: new Map(),
    };
    devices.set(deviceId, link);
    log(`phone ${deviceId}: 接上了`);

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        return; // 畸形帧丢掉就好，不该让一条坏帧打断整条连接
      }
      if (!frame || typeof frame !== 'object') return;
      if (frame.t === 'pong') {
        link.alive = true;
        return;
      }
      if (frame.t === 'hello') {
        // 身份在连上之后补上来（不必挤进升级头里）：机型 / 系统版本只用于显示与自检。
        if (frame.device && typeof frame.device === 'object') link.device = frame.device;
        if (Array.isArray(frame.capabilities)) {
          link.capabilities = frame.capabilities.filter((c) => typeof c === 'string');
        }
        return;
      }
      if (frame.t === 'result') {
        const pending = link.pending.get(text(frame.id));
        if (!pending) return;
        link.pending.delete(text(frame.id));
        if (frame.ok) pending.settleOk(frame.data === undefined ? null : frame.data);
        else {
          const error = frame.error && typeof frame.error === 'object' ? frame.error : {};
          pending.settleErr({
            code: text(error.code) || 'failed',
            message: text(error.message) || '手机那边没能完成这一步',
          });
        }
        return;
      }
      if (frame.t === 'event') {
        // 目前只用来更新「这台上有没有等人的事」，没有订阅方就不传播。
        if (frame.kind === 'needs-human' && typeof frame.sessionId === 'string') {
          link.needsHuman = { sessionId: frame.sessionId, reason: text(frame.reason), at: Date.now() };
        }
      }
    });

    socket.on('close', () => {
      if (devices.get(deviceId) === link) drop(deviceId, 'offline');
      log(`phone ${deviceId}: 断开了`);
    });
    socket.on('error', () => { /* close 会跟着来，账在那边结 */ });

    // 心跳：手机端不实现自动 pong 的话（RN 的 WebSocket 有），这里照样按超时判掉线。
    link.heartbeat = setInterval(() => {
      if (!statusOf(socket)) return;
      if (!link.alive) {
        log(`phone ${deviceId}: 心跳丢了，按断线处理`);
        drop(deviceId, 'offline');
        return;
      }
      link.alive = false;
      try { socket.send(JSON.stringify({ t: 'ping', at: Date.now() })); } catch { /* 下面 close 会来 */ }
    }, HEARTBEAT_MS);
    link.heartbeat.unref?.();

    try {
      socket.send(JSON.stringify({
        t: 'welcome',
        actions: [...ACTIONS.keys()],
        serverTime: Date.now(),
      }));
    } catch { /* 刚连上就断的，等 close */ }
  }

  /**
   * 在一台手机上执行一个动作。
   *
   * @returns {Promise<{ok: true, data: any}>} 失败一律 reject 成 `{code, message}`
   */
  function call(deviceId, sessionId, action, args, { signal, timeoutMs } = {}) {
    const id = text(deviceId);
    const link = devices.get(id);
    if (closed) return Promise.reject({ code: 'unavailable', message: '手机操作服务没在运行' });
    if (!link || !statusOf(link.socket)) return Promise.reject({ code: 'offline', message: '那台手机没连上' });
    if (!ACTIONS.has(action)) return Promise.reject({ code: 'unknown-action', message: `不支持的动作 ${action}` });

    const opId = nextId();
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : (ACTIONS.get(action) || DEFAULT_OP_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        link.pending.delete(opId);
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const pending = {
        settleOk: (data) => settle(resolve, { ok: true, data }),
        settleErr: (error) => settle(reject, error),
      };
      const timer = setTimeout(() => {
        settle(reject, { code: 'timeout', message: '迟迟没有回应这一步' });
        try { link.socket.send(JSON.stringify({ t: 'cancel', id: opId })); } catch { /* 已断 */ }
      }, budget);
      timer.unref?.();
      const onAbort = () => {
        settle(reject, { code: 'aborted', message: '这一步被取消了' });
        try { link.socket.send(JSON.stringify({ t: 'cancel', id: opId })); } catch { /* 已断 */ }
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener?.('abort', onAbort, { once: true });
      }
      link.pending.set(opId, pending);
      try {
        link.socket.send(JSON.stringify({ t: 'op', id: opId, sessionId: text(sessionId), action, args: args || {} }));
      } catch {
        settle(reject, { code: 'offline', message: '发不出去，那台手机断开了' });
      }
    });
  }

  /** 这台手机此刻在不在线。 */
  function isOnline(deviceId) {
    const link = devices.get(text(deviceId));
    return Boolean(link && statusOf(link.socket));
  }

  /** 一台手机的连接信息（给 App 的状态页用）。 */
  function statusOfDevice(deviceId) {
    const link = devices.get(text(deviceId));
    if (!link || !statusOf(link.socket)) return { online: false };
    return {
      online: true,
      connectedAt: link.connectedAt,
      device: link.device,
      capabilities: link.capabilities,
    };
  }

  /** 让这台手机重连（用户点了「重新连接」）：断开后它自己会回来。 */
  function kick(deviceId) {
    drop(text(deviceId), 'offline');
  }

  /** 升级处理：`/api/mobile/v1/phone/control`。 */
  function handleUpgrade(req, socket, head) {
    if (closed) return refuse(socket, 503, 'Service Unavailable', '手机操作服务已关闭');
    let allowed = false;
    try {
      allowed = Boolean(authorized && authorized(req));
    } catch {
      allowed = false;
    }
    if (!allowed) return refuse(socket, 401, 'Unauthorized', '移动端凭据无效');

    // 认这台手机靠它自带的 deviceId（与 `x-dsh-device` 同一个头）。缺了就没法把动作路由到
    // 具体某一台，拒绝比猜一台好。
    const header = req.headers && req.headers['x-dsh-device'];
    const deviceId = text(Array.isArray(header) ? header[0] : header);
    if (!deviceId) return refuse(socket, 400, 'Bad Request', '缺少设备标识');

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, deviceId, null));
  }

  function close() {
    closed = true;
    for (const [deviceId, link] of devices) {
      clearInterval(link.heartbeat);
      drop(deviceId, 'offline');
    }
    for (const client of wss.clients) {
      try { client.close(); } catch { /* 已关 */ }
    }
    wss.close?.();
  }

  return { handleUpgrade, call, isOnline, statusOfDevice, kick, close, ACTIONS, devices };
}

function refuse(socket, status, reason, bodyText) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(bodyText, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
  socket.end();
}

/** 从请求头里认这台手机（与 `shared/device-headers.js` 同一口径：缺了就是空串）。 */
function deviceIdOf(req) {
  const raw = req && req.headers ? req.headers['x-dsh-device'] : undefined;
  return text(Array.isArray(raw) ? raw[0] : raw);
}

module.exports = { createPhoneService, deviceIdOf, ACTIONS, DEFAULT_OP_TIMEOUT_MS };

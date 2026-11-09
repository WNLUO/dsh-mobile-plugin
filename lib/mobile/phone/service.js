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
 *   - `{t:'op', id, sessionId, action, args, timeout}` —— timeout 是这一发自适应算出的预算(ms)
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
/** 心跳间隔：每 20 秒发一次 ping。 */
const HEARTBEAT_MS = 20_000;
/**
 * 连续丢这么多次心跳（约 60 秒）才按掉线处理，对齐手机端 60s 看门狗。
 * 弱网下偶发一两次丢 pong 不算掉线，免得来回假掉线、把在途 op 全抹成 offline。
 */
const MAX_MISSED_HEARTBEATS = 3;
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
  // `batch` 是多个动作打包：这里的数字只是它作为「一个动作」登记进表时的占位 seed，
  // 真实预算由 budgetForBatch 按步数与等待上限单独算（见下），不走单动作那套。
  ['batch', 120_000],
  ['screen.wait', 30_000],
  ['gesture', 20_000],
  ['app.link', 20_000],
  // 结构化：提取 / 查询 / 滚动查找 / 多屏采集。
  ['extract', 20_000],
  ['query', 20_000],
  ['find', 60_000],
  ['collect', 60_000],
  // 滚轮选择器一次转到位。
  ['wheel.set', 25_000],
  // 分享一段文字到指定 App。
  ['share.text', 20_000],
  // 系统动作：闹钟 / 计时器 / 看闹钟 / 日历插入（标准 Intent）。
  ['system.alarm', 20_000],
  ['system.timer', 20_000],
  ['system.show_alarms', 20_000],
  ['system.calendar_insert', 20_000],
  // 任务结束时某个 App 的去留标记（只记下，不当场关）。
  ['app.after_task', 20_000],
]);

/**
 * 帧压缩的测量开关，默认关。
 *
 * 宿主端 deflate 是「CPU 换带宽」：手机常在弱网，压缩看着划算，但每一帧都要在宿主上现算，
 * 低端机与高频小帧下 CPU 代价明显，而这条通道的大头（截图 base64）早就一帧一封。到底值不值
 * 要真机量过 p50/p99 延迟与宿主的占用才能定，所以默认维持原样关闭，只留一个环境变量把压缩
 * 打开来测量，不擅自改线上默认。
 */
const COMPRESS_FRAMES = process.env.DSH_MOBILE_PHONE_COMPRESS === '1';

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
 * @param {object} [deps.permission] 逐路由权限位校验（形状与 `lib/http/routing.js` 的同一份）：
 *   `{ resolve(path, method) -> need|null|'unknown', has(record, need) -> boolean, recordOf(req) -> record|null }`。
 *   升级路由不过 `guarded`，所以这一步只能在服务里自己做；不注入就完全不校验（只给测试用）。
 */
function createPhoneService({ authorized, onLog, permission = null } = {}) {
  /** 权限位：`resolve` 把 path 摘成所需位，`has` 判这条凭据够不够，`recordOf` 取凭据记录。 */
  const resolvePermission = permission && typeof permission.resolve === 'function' ? permission.resolve : null;
  const hasPermission = permission && typeof permission.has === 'function' ? permission.has : null;
  const recordOf = permission && typeof permission.recordOf === 'function' ? permission.recordOf : null;
  /** deviceId → 连接。同一台手机重连时新的顶掉旧的（旧的那条先被关掉）。 */
  const devices = new Map();
  let closed = false;
  let seq = 0;

  /** 耗时 EWMA 的平滑系数：动作耗时用 0.3，心跳 RTT 用 0.2。 */
  const EWMA_ALPHA = 0.3;
  const RTT_ALPHA = 0.2;

  function ewma(prev, sample, alpha) {
    if (!prev || !(prev.n > 0) || !Number.isFinite(prev.value)) return { value: sample, n: 1 };
    return { value: prev.value * (1 - alpha) + sample * alpha, n: prev.n + 1 };
  }

  /** 成功回包按「发送 → 收到」耗时更新 perAction 与全体两类统计。 */
  function recordLatency(link, action, sample) {
    if (!Number.isFinite(sample) || sample < 0) return;
    const lat = link.latency;
    lat.perAction.set(action, ewma(lat.perAction.get(action), sample, EWMA_ALPHA));
    lat.all = ewma(lat.all, sample, EWMA_ALPHA);
  }

  /**
   * 某动作这一发该给多少预算：估时 est 取自本动作（样本够）或全体，套 est*2.5 + rtt*2 + 1500，
   * 冷启动抬到 seed*1.5 兜底，最后夹进 [max(2500, seed/2), min(120000, max(seed*8, floor))]。
   * `ACTIONS` 里的数字只是这个 seed，不再直接当预算。
   */
  function budgetFor(link, action, args) {
    if (action === 'batch') return budgetForBatch(link, args);
    const seed = ACTIONS.get(action) || DEFAULT_OP_TIMEOUT_MS;
    const lat = link.latency;
    const pa = lat.perAction.get(action);
    let est = seed;
    if (pa && pa.n >= 2) est = pa.value;
    else if (lat.all && lat.all.n >= 2) est = lat.all.value;
    const rtt = lat.rtt > 0 ? lat.rtt : 0;
    let budget = est * 2.5 + rtt * 2 + 1500;
    const cold = Date.now() - link.connectedAt < 20_000 || !lat.all || lat.all.n < 1;
    if (cold) budget = Math.max(budget, seed * 1.5);
    const floor = Math.max(2500, seed * 0.5);
    const ceil = Math.min(120_000, Math.max(seed * 8, floor));
    return Math.round(Math.min(Math.max(budget, floor), ceil));
  }

  /**
   * `batch` 的预算要按整批放，不能沿用单动作的估法 —— 一批十几步，每步都可能带一段等待，
   * 单步预算乘一乘就把手机端「整批共用宿主下发 timeout」的约定撑破了。
   *
   * 累加三样：每步各自的估时（有实测 EWMA 就用实测，没有就用该动作的 seed），每步 `until`
   * 声明的等待上限（与手机侧同口径：默认 8000、封顶 20000），以及每步一次往返的网络余量。
   * 结果夹在 [5s, 180s]：低于 5s 连正常几步都装不下；高于 180s 基本是手机卡死，再等没意义。
   */
  function budgetForBatch(link, args) {
    const steps = args && Array.isArray(args.steps) ? args.steps : [];
    const lat = link.latency;
    const rtt = lat.rtt > 0 ? lat.rtt : 0;
    let total = 0;
    for (const step of steps) {
      const action = text(step && step.action);
      const seed = ACTIONS.get(action) || DEFAULT_OP_TIMEOUT_MS;
      const pa = lat.perAction.get(action);
      let est = seed;
      if (pa && pa.n >= 2) est = pa.value;
      else if (lat.all && lat.all.n >= 2) est = lat.all.value;
      total += est;
      const until = step && step.until;
      if (until && typeof until === 'object') {
        const t = Number(until.timeoutMs);
        total += Number.isFinite(t) && t > 0 ? Math.min(t, 20_000) : 8_000;
      }
    }
    total += rtt * 2 * steps.length;
    // 手机侧还要按 pacing 在步与步之间停一下（standard 约每步 0.5–1.2s、新屏更久；careful/human 更久），
    // 这段等待是在手机侧真睡掉的、要占同一笔预算，不给它留就会「批跑到一半被自己的停顿撞上超时」。
    const pace = args && args.pacing;
    if (pace && typeof pace === 'object') {
      const careful = pace.place === 'careful' || pace.mode === 'human';
      total += (careful ? 5_000 : 1_500) * steps.length;
    }
    return Math.round(Math.min(Math.max(total, 5_000), 180_000));
  }

  const log = (message) => { try { onLog?.(message); } catch { /* 日志失败不影响搬运 */ } };

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: COMPRESS_FRAMES ? { threshold: 1024 } : false,
    maxPayload: MAX_PAYLOAD,
  });

  function nextId() {
    seq += 1;
    return `p${seq}`;
  }

  /**
   * 关掉一条连接并结算它的在途 op。
   *
   * 这里不区分动作：`batch` 和单步一样挂在 `link.pending` 上，走到一半断线就连同它的结果一起
   * 以 offline 结算，手机侧那套「整批共用宿主 timeout」不需要宿主特殊对待。
   */
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
    try { clearInterval(link.heartbeat); } catch { /* 已经清过了 */ }
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
      missed: 0,
      latency: { perAction: new Map(), all: null, rtt: 0 },
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
        if (Number.isFinite(link.pingAt) && link.pingAt > 0) {
          const sample = Date.now() - link.pingAt;
          const prev = link.latency.rtt;
          link.latency.rtt = prev > 0 ? prev * (1 - RTT_ALPHA) + sample * RTT_ALPHA : sample;
          link.pingAt = 0;
        }
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
        if (frame.ok) {
          if (pending.action && Number.isFinite(pending.sentAt)) {
            recordLatency(link, pending.action, Date.now() - pending.sentAt);
          }
          pending.settleOk(frame.data === undefined ? null : frame.data);
        } else {
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
        link.missed += 1;
        if (link.missed >= MAX_MISSED_HEARTBEATS) {
          log(`phone ${deviceId}: 连续 ${link.missed} 次心跳没回应，按断线处理`);
          drop(deviceId, 'offline');
          return;
        }
        log(`phone ${deviceId}: 心跳丢了（${link.missed}/${MAX_MISSED_HEARTBEATS}），再等等`);
      } else {
        link.missed = 0;
      }
      link.alive = false;
      link.pingAt = Date.now();
      try { socket.send(JSON.stringify({ t: 'ping', at: link.pingAt })); } catch { /* 下面 close 会来 */ }
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
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : budgetFor(link, action, args);
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
        action,
        sentAt: Date.now(),
        settleOk: (data) => settle(resolve, { ok: true, data }),
        settleErr: (error) => settle(reject, error),
      };
      // 超时 / 取消都发同一条 `cancel` 帧 —— 帧里只带 id，手机侧自己按 id 找那条 op，
      // 所以正在跑的 `batch` 也能被这一步撤销，不需要另加批专用的停止帧。
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
        link.socket.send(JSON.stringify({ t: 'op', id: opId, sessionId: text(sessionId), action, args: args || {}, timeout: budget }));
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

  /**
   * 这台手机报没报某项能力（工具层据此决定某个参数是否生效）。
   *
   * 手机在 hello / attached 帧里上行 `capabilities`，没连上或没报过就一律当作不支持 ——
   * 「没听说」和「不支持」在这里是同一件事，宁可让工具层多说一句「需要升级手机上的 App」，
   * 也不要凭空假定它能做。
   */
  function hasCapability(deviceId, capName) {
    const link = devices.get(text(deviceId));
    if (!link || !statusOf(link.socket)) return false;
    const name = text(capName);
    return name !== '' && Array.isArray(link.capabilities) && link.capabilities.includes(name);
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

    // 逐路由按设备权限位校验。这条是**动作通道**：连上就能收执行动作，只验凭据不验
    // `operate` 等于让只读档设备直接摸到手机的动作面。升级请求还没握手，所以能老实回 403。
    if (resolvePermission) {
      const method = String(req.method || 'GET').toUpperCase();
      const need = resolvePermission(req.url || '', method);
      if (need === 'unknown') return refuse(socket, 403, 'Forbidden', '这条接口没有登记所需权限，暂不放行');
      let record = null;
      try { record = recordOf ? recordOf(req) : null; } catch { record = null; }
      if (need && (!hasPermission || !hasPermission(record, need))) {
        return refuse(socket, 403, 'Forbidden', '这台设备没有执行该操作的权限');
      }
    }

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

  return {
    handleUpgrade,
    call,
    isOnline,
    statusOfDevice,
    hasCapability,
    kick,
    close,
    ACTIONS,
    devices,
    // 测量开关的当前取值，供自检 / 日志读出（真实压缩在 wss 构造时就定了）。
    compressionEnabled: COMPRESS_FRAMES,
  };
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

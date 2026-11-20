// 首次入口就绪补连总控，更新收到回执后才标记已发布。
// 加密上报真实可用地址，并用握手期限与协议心跳维护总控连接。
'use strict';

/**
 * 总控（地址目录）客户端：把本机的**全部连接地址**加密后上报给总控，拿回一枚设备令牌交给 APP。
 * 信封里另带「当前连上的中转 + 隧道通没通 + 采样时刻」——总控只存密文、原样转发，加字段不用动服务端。
 *
 * 地址（中转 / 局域网 / IPv6 / 直连，含自建中转）用**实例历史密钥 HK** 封成密文信封再上报，
 * 总控只存密文、不持钥、解不开；APP 用自己那份 HK 解开。这样总控能做「宿主换了地址之后的
 * 保底查询」，又看不到用户到底连了哪些地址。加密口径直接复用历史 blob 那套（`mirror/history-blob.cjs`
 * 与 `app/src/services/viewmodels/history-blob.ts` 逐字节一致），AAD 用 `dsh-history-v1|control|<instanceId>`。
 *
 * 令牌：首次注册总控发一枚，之后重连必须带同一枚（总控据此拒绝冒充）。令牌落盘在 relay.json，
 * 插件重启后照样带得上；同时经已鉴权的状态心跳交给 APP。
 *
 * 地址没变就不发——链路平时是静的，只在地址变化时推一次。
 * 总控地址是内置常量，可用 `DSH_CONTROL_URL` 覆盖（本地联调用）。
 */

const WebSocket = require('ws');
const { performance } = require('node:perf_hooks');
const {
  advertisedCandidates,
  orderCandidates,
  manualCandidate,
  ipv6Candidates,
  withManualIpv6Candidate,
  tcpDirectTarget,
} = require('./lan-network.cjs');
const { sealHistoryBlob } = require('../mirror/history-blob.cjs');

// 内置总控入口（与 APP 侧常量一致）。末尾斜杠去掉，拼接时统一。
const CONTROL_BASE_URL = (process.env.DSH_CONTROL_URL || 'https://ai-hub.wnluo.com/findme').replace(/\/+$/, '');
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 45_000;

/** https→wss、http→ws。总控的 WebSocket 端点挂在同一前缀下。 */
function controlWsUrl(base = CONTROL_BASE_URL) {
  return String(base).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/**
 * 折出本机要上报的全部连接地址（明文，上送前再加密）。
 * 中转只取当前实际注册的线路；局域网只走 `advertisedCandidates`（网卡扫到的），手填直连地址
 * 单独标成 `direct`，绝不并进 `lan`；IPv6 走 `ipv6Candidates` 并缀上手填那条，与局域网开关独立；
 * 端口未监听时不发布。
 * 「TCP 直连」目标（`manualTcpUrl`）单独一条，**不受 `lanEnabled` 影响**：它不挂在局域网监听上，
 * 是一条独立的裸 TCP 出站通道。这一格必须报上来——配了 TCP（或手填直连）时公用中转会被规则关掉，
 * 而 TCP 又替换不了「宿主地址」在手机上的同步：手机离开局域网后连不上宿主，只能靠总控把 TCP
 * 目标补给它。漏了这一格，总控这条兜底就等于空转。
 */
function controlAddresses(state, port, connectedRelay = '') {
  const out = [];
  if (typeof connectedRelay === 'string' && /^https?:\/\//i.test(connectedRelay)) out.push({ kind: 'relay', url: connectedRelay });
  const lanPort = Number.isInteger(port) ? port : 0;
  if (state.lanEnabled && lanPort > 0) {
    try {
      // 局域网这一类**只装网卡扫到的地址**（有私网就只私网，没有才退公网）。用户手填的直连
      // 地址（穿透域名 / 公网 IP）单独标成 `direct`，绝不并进 `lan`：它和局域网是两种地址，
      // 并进同一格会让手机把它当成局域网写进「局域网地址」栏（就是这个 bug）。
      const candidates = orderCandidates(advertisedCandidates(lanPort), state.preferredLanAddress);
      for (const c of candidates) if (c && c.url) out.push({ kind: 'lan', url: c.url });
      const direct = manualCandidate(state.manualLanUrl);
      if (direct) out.push({ kind: 'direct', url: direct.url });
    } catch {
      /* 网卡扫不出来只是少几条 LAN 候选，不影响上报主链路 */
    }
  }
  if (lanPort > 0) {
    try {
      const v6 = withManualIpv6Candidate(ipv6Candidates(lanPort), state.manualIpv6Url);
      for (const c of v6) if (c && c.url) out.push({ kind: 'ipv6', url: c.url });
    } catch {
      /* 同上 */
    }
  }
  // TCP 直连：用户填的 `host:port`（可能带方括号 IPv6）。不受 `lanEnabled` 管——它是一条独立的
  // 裸 TCP 出站通道，关掉局域网直连时它照样能用；而它恰恰是「公用中转被关掉」那种配置下手机
  // 唯一还能连上的地址，必须进总控这份兜底清单。
  const tcp = tcpDirectTarget(state.manualTcpUrl);
  if (tcp) out.push({ kind: 'tcp', url: tcp });
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    if (!a || !a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    dedup.push(a);
  }
  // 清单里本来就有可连地址、而 TCP 这一格是空的：再补一条**空 url 的 tcp 标记**。
  // 手机据此把「电脑上清掉了 TCP 目标」落到本地；老手机读到空 url 直接忽略，行为不变。
  // 一条别的地址都没有时不补：那种状态下手机也没别的路可学，补了只会白建一条总控连接。
  if (!tcp && dedup.length) dedup.push({ kind: 'tcp', url: '' });
  return dedup;
}

/**
 * 信封里除了地址，再带一格「这台电脑此刻连在哪条中转上、隧道通不通、什么时候采的」。
 *
 * 总控只存密文、原样转发，所以加字段不用动服务端：老手机解开的 plain 里没有 meta 就当
 * 不知道，新手机才用。connectedRelay 取宿主写回的当前主用（`relayUrl` 就是「当前接上了
 * 哪一条」，见 docs/relay-multi-address.md），不是配置里随便挑的一条。
 */
function controlMeta(state, connected = false, connectedRelay) {
  const raw = connected === true && typeof connectedRelay === 'string' ? connectedRelay.trim().replace(/\/+$/, '') : '';
  return {
    connectedRelay: /^https?:\/\//i.test(raw) ? raw : '',
    relayConnected: connected === true,
    at: Date.now(),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.state 宿主状态（就地改：写入令牌）
 * @param {() => void} [deps.persist] 令牌变了之后落盘（通常是 `core.saveState(state)`）
 * @param {() => number} deps.getPort 当前实绑的局域网端口取值器
 * @param {() => string} deps.getHistoryKey 取实例历史密钥（HK，base64url）；缺失时会惰性生成
 * @param {(state: object) => Array<{kind?: string, url: string}>} [deps.getAddresses] 地址来源覆盖（测试用）
 * @param {() => boolean} [deps.getRelayConnected] 中转隧道此刻通没通（宿主侧权威状态）
 * @param {(msg: string, ...rest: any[]) => void} [deps.log]
 */
function createControlClient(options = {}) {
  const { persist, getPort, getHistoryKey, getAddresses, getRelayConnected, getConnectedRelay, log = () => {}, onIdentityConflict = null } = options
  // `getState` 让控制客户端读到**当前这一代**的状态（换代后状态对象会换一份）：老的直接传
  // `state` 的用法保留为兜底，测试与旧调用方行为不变。
  const getState = typeof options.getState === 'function' ? options.getState : () => options.state 
  const build = typeof getAddresses === 'function'
    ? getAddresses
    : (s) => controlAddresses(s, typeof getPort === 'function' ? getPort() : undefined, typeof getConnectedRelay === 'function' ? getConnectedRelay() : '');
  const connectedOf = typeof getRelayConnected === 'function' ? getRelayConnected : () => false;

  let sock = null;
  let running = false;
  let connected = false;
  // 建客户端那一刻的令牌只是初值：稳定外壳先 createControlClient、稍后才经 setProviders
  // 注入真正的状态（见 shell/transport-host.js），那时这里读到的还是空对象。所以每次
  // 拨号前都要从当前状态重取一次，否则会用空令牌去注册，被总控当成冒充而触发换身份。
  let token = typeof getState().controlToken === 'string' ? getState().controlToken : '';
  let lastSent = '';
  let lastAcknowledged = '';
  let awaitingAck = '';
  let ackTimer = null;
  let hasPublished = false;
  let attempt = 0;
  let reconnectTimer = null;
  let tickTimer = null;
  let releaseSocket = null;
  // 「身份冲突」连续计数：同一台机器被别处占了令牌时会持续收到 identity_conflict。
  // 累计到阈值（且都在一个窗口内）就触发一次换身份，把本机换成新号从冲突里出来；
  // 换完若还冲突，靠冷却期避免反复触发放大（换身份本身会重连，别在里头死循环）。
  let identityConflictStreak = 0;
  let lastIdentityConflictAt = 0;
  let identityConflictCooldownUntil = 0;
  const IDENTITY_CONFLICT_THRESHOLD = 3;
  const IDENTITY_CONFLICT_WINDOW_MS = 60_000;
  const IDENTITY_CONFLICT_COOLDOWN_MS = 10 * 60_000;

  /** 记一次身份冲突；够阈值就调一次 onIdentityConflict（换身份），并进入冷却。 */
  function noteIdentityConflict() {
    if (typeof onIdentityConflict !== 'function') return;
    const now = Date.now();
    if (now < identityConflictCooldownUntil) return;
    if (now - lastIdentityConflictAt > IDENTITY_CONFLICT_WINDOW_MS) identityConflictStreak = 0;
    lastIdentityConflictAt = now;
    identityConflictStreak += 1;
    if (identityConflictStreak < IDENTITY_CONFLICT_THRESHOLD) return;
    identityConflictStreak = 0;
    identityConflictCooldownUntil = now + IDENTITY_CONFLICT_COOLDOWN_MS;
    try {
      const pending = onIdentityConflict();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* 换身份失败就让退避继续，不在这里抛 */ }
  }

  // `at` 是采样时刻，每次 tick 都会变；不进 canonical，否则每分钟都会白推一次 update。
  const canonical = (list, meta) => JSON.stringify([
    [...list].map((a) => [a.kind || '', a.url]).sort(),
    meta.connectedRelay,
    meta.relayConnected,
  ]);

  function hk() {
    try {
      const value = typeof getHistoryKey === 'function' ? getHistoryKey() : getState().historyKey;
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  /** 明文地址 + 健康 → 密文信封 JSON。HK 缺了就返回空串（不连）。 */
  function seal(addresses, meta) {
    const key = hk();
    if (!key) return '';
    try {
      return sealHistoryBlob(key, 'control', getState().instanceId || '', { addresses, meta });
    } catch (error) {
      log('control: seal failed', error && error.message);
      return '';
    }
  }

  function send(obj) {
    if (sock && sock.readyState === 1) {
      try { sock.send(JSON.stringify(obj)); } catch { /* 发送失败交给 close 事件重连 */ }
    }
  }

  function publish(addresses, meta, type) {
    const payload = seal(addresses, meta);
    if (!payload) return false;
    awaitingAck = canonical(addresses, meta);
    lastSent = awaitingAck;
    clearTimeout(ackTimer);
    const timer = setTimeout(() => { if (ackTimer === timer) releaseSocket?.(); }, HANDSHAKE_TIMEOUT_MS);
    ackTimer = timer;
    timer.unref?.();
    send({ type, payload });
    return true;
  }

  function acknowledge() {
    if (!awaitingAck) return;
    lastAcknowledged = awaitingAck;
    awaitingAck = '';
    clearTimeout(ackTimer);
    ackTimer = null;
    tick();
  }

  function scheduleReconnect() {
    if (!running) return;
    attempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    clearTimeout(reconnectTimer);
    const timer = setTimeout(() => {
      if (reconnectTimer !== timer) return;
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer = timer;
    timer.unref?.();
  }

  function connect() {
    if (!running || sock) return;
    if (!getState().enabled) return;
    // 用户在面板关掉了「自动上报网络地址」：立刻不连（sync/stop 会把已在连的这条也收掉）。
    if (getState().controlReportEnabled === false) return;
    const addresses = build(getState());
    if (!Array.isArray(addresses) || (addresses.length === 0 && !hasPublished)) {
      connected = false;
      return;
    }
    const meta = controlMeta(getState(), addresses.length > 0 && connectedOf(), typeof getConnectedRelay === 'function' ? getConnectedRelay() : '');
    const payload = seal(addresses, meta);
    if (!payload) {
      connected = false;
      return;
    }
    // 拨号前重取一次令牌（见文件上方 `token` 初值的说明）：外壳注入状态晚于建客户端，
    // 只在建时读一次会一直用空令牌去注册，被总控判成身份冲突后误触发换身份。
    const storedToken = getState().controlToken;
    if (typeof storedToken === 'string') token = storedToken;
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    const url = `${controlWsUrl()}/ws/device?instanceId=${encodeURIComponent(getState().instanceId || '')}${tokenQuery}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      log('control: dial failed');
      scheduleReconnect();
      return;
    }
    sock = ws;
    connected = false;
    lastSent = '';
    let handshakeTimer = null;
    let heartbeatTimer = null;
    let lastPong = 0;
    const retire = (retry = true) => {
      clearTimeout(handshakeTimer);
      clearTimeout(heartbeatTimer);
      handshakeTimer = null;
      heartbeatTimer = null;
      if (sock !== ws) return;
      clearTimeout(ackTimer);
      ackTimer = null;
      awaitingAck = '';
      lastAcknowledged = '';
      connected = false;
      sock = null;
      releaseSocket = null;
      try { ws.terminate(); } catch { /* 已关闭 */ }
      if (retry) scheduleReconnect();
    };
    releaseSocket = retire;
    handshakeTimer = setTimeout(() => {
      if (handshakeTimer && sock === ws) retire();
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
    const scheduleHeartbeat = () => {
      const timer = setTimeout(() => {
        if (heartbeatTimer !== timer || sock !== ws || !running) return;
        heartbeatTimer = null;
        if (ws.readyState !== 1 || performance.now() - lastPong >= PONG_TIMEOUT_MS) { retire(); return; }
        try { ws.ping(); } catch { retire(); return; }
        scheduleHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer = timer;
      timer.unref?.();
    };
    ws.on('pong', () => { if (sock === ws && connected) lastPong = performance.now(); });
    ws.addEventListener('open', () => {
      if (sock !== ws || !running) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      // 注意：这里**不**清零退避。连上不等于能用——服务端可能刚连上就以 unauthorized 断开；
      // 若在 open 就清零，每次被拒后都按最短 1 秒重连，等于把「被拒」放大成每秒一次的热循环。
      // 退避在收到 registered（真正注册成功）时再清零，见 message 处理。
      connected = true;
      lastPong = performance.now();
      scheduleHeartbeat();
      const currentAddresses = build(getState());
      const currentMeta = controlMeta(getState(), currentAddresses.length > 0 && connectedOf(), typeof getConnectedRelay === 'function' ? getConnectedRelay() : '');
      if (!publish(currentAddresses, currentMeta, 'register')) { retire(); return; }
      hasPublished = true;
    });
    ws.addEventListener('message', (event) => {
      if (sock !== ws) return;
      let msg;
      try {
        const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg && msg.type === 'registered') {
        // 真正注册成功，链路可用，退避清零。
        attempt = 0;
        identityConflictStreak = 0;
        if (typeof msg.token === 'string' && msg.token !== token) {
          token = msg.token;
          getState().controlToken = msg.token;
          try { persist?.(); } catch { /* 落盘失败下次注册还会拿到同一枚，不必打断 */ }
        }
        acknowledge();
      } else if (msg && msg.type === 'updated') {
        acknowledge();
      } else if (msg && msg.type === 'error') {
        // 包括 unauthorized（同一 instanceId 被别处占了令牌、或令牌对不上）：断开后按指数退避重连，
        // 不在 open 时清零，所以最多退到 30 秒一次，不会再每秒硬撞。
        // 明确的 identity_conflict 额外累计，够次数就触发换身份（换到唯一的新号）。
        if (String(msg.message || '') === 'identity_conflict') noteIdentityConflict();
        log('control: server error');
        retire();
      }
    });
    ws.addEventListener('close', () => retire());
    ws.addEventListener('error', () => retire());
  }

  /** 复核地址与健康有没有变，变了就重新加密并 update。 */
  function tick() {
    if (!sock && running && !reconnectTimer) { connect(); return; }
    if (!connected || !sock || awaitingAck) return;
    const addresses = build(getState());
    if (!Array.isArray(addresses)) return;
    const meta = controlMeta(getState(), addresses.length > 0 && connectedOf(), typeof getConnectedRelay === 'function' ? getConnectedRelay() : '');
    const signature = canonical(addresses, meta);
    if (signature !== lastSent) {
      publish(addresses, meta, 'update');
    }
  }

  function snapshot() {
    const addresses = build(getState());
    const meta = controlMeta(getState(), addresses.length > 0 && connectedOf(), typeof getConnectedRelay === 'function' ? getConnectedRelay() : '');
    return { url: CONTROL_BASE_URL, connected: connected && !!sock, token: token || null,
      published: connected && !!lastAcknowledged && lastAcknowledged === canonical(addresses, meta) };
  }

  function start() {
    if (!running) {
      running = true;
      // 每 30 秒重读一次本机网卡（开销只是本地接口枚举，`tick` 只在地址签名真变了才推 update）。
      // 光猫重启 / 运营商换 IPv6 前缀后，新地址最多半分钟就上报总控，手机在外网重连更快拿到。
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 30_000);
      if (tickTimer.unref) tickTimer.unref();
    }
    if (getState().enabled && getState().controlReportEnabled !== false && !sock && !reconnectTimer) connect();
    return snapshot();
  }

  function stop() {
    running = false;
    connected = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(tickTimer);
    tickTimer = null;
    releaseSocket?.(false);
    attempt = 0;
  }

  /** 配置变更后复核；已发布的地址变空也要沿现有连接清空目录。 */
  function sync() {
    if (!getState().enabled || getState().controlReportEnabled === false || !hk()) {
      stop();
      return;
    }
    if (!running) {
      start();
      return;
    }
    if (!sock && !reconnectTimer) connect();
    else tick();
  }

  return { start, stop, sync, snapshot, get targetUrl() { return CONTROL_BASE_URL; } };
}

module.exports = { CONTROL_BASE_URL, controlWsUrl, controlAddresses, controlMeta, createControlClient };

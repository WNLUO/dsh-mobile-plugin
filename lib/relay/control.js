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

const {
  advertisedCandidates,
  phoneCandidates,
  ipv6Candidates,
  withManualIpv6Candidate,
  tcpDirectTarget,
} = require('./lan-network.cjs');
const { relayAddressesOf } = require('./core.js');
const { sealHistoryBlob } = require('../mirror/history-blob.cjs');

// 内置总控入口（与 APP 侧常量一致）。末尾斜杠去掉，拼接时统一。
const CONTROL_BASE_URL = (process.env.DSH_CONTROL_URL || 'https://ai-hub.wnluo.com/findme').replace(/\/+$/, '');

/** https→wss、http→ws。总控的 WebSocket 端点挂在同一前缀下。 */
function controlWsUrl(base = CONTROL_BASE_URL) {
  return String(base).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/**
 * 折出本机要上报的全部连接地址（明文，上送前再加密）。
 * 与配对二维码同源：中转取 `relayUrls`；局域网走 `phoneCandidates(advertisedCandidates)`；
 * IPv6 走 `ipv6Candidates` 并缀上手填那条。`lanEnabled` 关掉或端口拿不到时不含局域网/IPv6。
 * 「TCP 直连」目标（`manualTcpUrl`）单独一条，**不受 `lanEnabled` 影响**：它不挂在局域网监听上，
 * 是一条独立的裸 TCP 出站通道。这一格必须报上来——配了 TCP（或手填直连）时公用中转会被规则关掉，
 * 而 TCP 又替换不了「宿主地址」在手机上的同步：手机离开局域网后连不上宿主，只能靠总控把 TCP
 * 目标补给它。漏了这一格，总控这条兜底就等于空转。
 */
function controlAddresses(state, port) {
  const out = [];
  let relay = { relayUrls: [] };
  try {
    relay = relayAddressesOf(state);
  } catch {
    relay = { relayUrls: [] };
  }
  for (const url of relay.relayUrls || []) {
    if (typeof url === 'string' && url) out.push({ kind: 'relay', url });
  }
  const lanPort = Number.isInteger(port) ? port : 0;
  if (state.lanEnabled && lanPort > 0) {
    try {
      const candidates = phoneCandidates(advertisedCandidates(lanPort), {
        preferred: state.preferredLanAddress,
        manual: state.manualLanUrl,
      });
      for (const c of candidates) if (c && c.url) out.push({ kind: 'lan', url: c.url });
    } catch {
      /* 网卡扫不出来只是少几条 LAN 候选，不影响上报主链路 */
    }
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
function controlMeta(state, connected = false) {
  const raw = typeof state?.relayUrl === 'string' ? state.relayUrl.trim().replace(/\/+$/, '') : '';
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
  const { persist, getPort, getHistoryKey, getAddresses, getRelayConnected, log = () => {}, onIdentityConflict = null } = options
  // `getState` 让控制客户端读到**当前这一代**的状态（换代后状态对象会换一份）：老的直接传
  // `state` 的用法保留为兜底，测试与旧调用方行为不变。
  const getState = typeof options.getState === 'function' ? options.getState : () => options.state 
  const build = typeof getAddresses === 'function'
    ? getAddresses
    : (s) => controlAddresses(s, typeof getPort === 'function' ? getPort() : undefined);
  const connectedOf = typeof getRelayConnected === 'function' ? getRelayConnected : () => false;

  let sock = null;
  let running = false;
  let connected = false;
  let token = typeof getState().controlToken === 'string' ? getState().controlToken : '';
  let lastSent = '';
  let attempt = 0;
  let reconnectTimer = null;
  let tickTimer = null;
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

  function scheduleReconnect() {
    if (!running) return;
    attempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (!running || sock) return;
    if (!getState().enabled) return;
    // 用户在面板关掉了「自动上报网络地址」：立刻不连（sync/stop 会把已在连的这条也收掉）。
    if (getState().controlReportEnabled === false) return;
    const addresses = build(getState());
    if (!Array.isArray(addresses) || addresses.length === 0) {
      connected = false;
      return;
    }
    const meta = controlMeta(getState(), connectedOf());
    const payload = seal(addresses, meta);
    if (!payload) {
      connected = false;
      return;
    }
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    const url = `${controlWsUrl()}/ws/device?instanceId=${encodeURIComponent(getState().instanceId || '')}${tokenQuery}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      log('control: dial failed', error && error.message);
      scheduleReconnect();
      return;
    }
    sock = ws;
    connected = false;
    lastSent = '';
    ws.addEventListener('open', () => {
      if (sock !== ws) return;
      // 注意：这里**不**清零退避。连上不等于能用——服务端可能刚连上就以 unauthorized 断开；
      // 若在 open 就清零，每次被拒后都按最短 1 秒重连，等于把「被拒」放大成每秒一次的热循环。
      // 退避在收到 registered（真正注册成功）时再清零，见 message 处理。
      connected = true;
      send({ type: 'register', payload });
      lastSent = canonical(addresses, meta);
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
      } else if (msg && msg.type === 'error') {
        // 包括 unauthorized（同一 instanceId 被别处占了令牌、或令牌对不上）：断开后按指数退避重连，
        // 不在 open 时清零，所以最多退到 30 秒一次，不会再每秒硬撞。
        // 明确的 identity_conflict 额外累计，够次数就触发换身份（换到唯一的新号）。
        if (String(msg.message || '') === 'identity_conflict') noteIdentityConflict();
        log('control: server error', msg.message);
        try { ws.close(); } catch { /* ignore */ }
      }
    });
    const done = () => {
      if (sock !== ws) return;
      connected = false;
      sock = null;
      scheduleReconnect();
    };
    ws.addEventListener('close', done);
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
  }

  /** 复核地址与健康有没有变，变了就重新加密并 update。 */
  function tick() {
    if (!connected || !sock) return;
    const addresses = build(getState());
    if (!Array.isArray(addresses) || addresses.length === 0) return;
    const meta = controlMeta(getState(), connectedOf());
    const signature = canonical(addresses, meta);
    if (signature !== lastSent) {
      const payload = seal(addresses, meta);
      if (!payload) return;
      send({ type: 'update', payload });
      lastSent = signature;
    }
  }

  function snapshot() {
    return { url: CONTROL_BASE_URL, connected: connected && !!sock, token: token || null };
  }

  function start() {
    if (!running) {
      running = true;
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 60_000);
      if (tickTimer.unref) tickTimer.unref();
    }
    if (getState().enabled && getState().controlReportEnabled !== false && !sock) connect();
    return snapshot();
  }

  function stop() {
    running = false;
    connected = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(tickTimer);
    tickTimer = null;
    if (sock) {
      try { sock.close(); } catch { /* ignore */ }
      sock = null;
    }
    attempt = 0;
  }

  /** 配置变更后调用：没开 / 用户关了上报 / 没地址 / 没 HK 就停；否则起连或复核。 */
  function sync() {
    if (!getState().enabled || getState().controlReportEnabled === false || build(getState()).length === 0 || !hk()) {
      stop();
      return;
    }
    if (!running) {
      start();
      return;
    }
    if (!sock) connect();
    else tick();
  }

  return { start, stop, sync, snapshot };
}

module.exports = { CONTROL_BASE_URL, controlWsUrl, controlAddresses, controlMeta, createControlClient };

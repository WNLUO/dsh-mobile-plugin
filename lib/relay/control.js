// 2026-11-24：服务商线路清单改由「当前这一代」注入（`getProviderLines`），外壳不再静态 require 那份计算 ——
// 这样加/改服务商只换代，不动外壳、不重启 DSH。清单本身仍与配对二维码 / 手机心跳同源。
// 2026-11-23：服务商线路清单收口到 provider-lines，与配对二维码 / 手机心跳同源。
// 首次入口就绪补连总控，更新收到回执后才标记已发布。
// 加密上报真实可用地址，并用握手期限与协议心跳维护总控连接。
// 2026-11-21：对外多给一份「此刻会报上去的明文清单」，供手机「立即同步」与总控那份逐条比对。
// 2026-11-22：收到总控转达的「请自检」就回一份诊断（同一份内容，见 mobile/relay-control.js）。
// 2026-11-22：通用线路引擎——第三方线路清单（customRoutes）按 kind:'custom' 连同 transport 一起加密上报。
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
 *
 * 另一件事：手机连不上插件时会请总控转一句「请自检」。插件收到就地把「这台电脑此刻怎么样」
 * 封成答案回过去（scope `diagnose`，与地址那份分开）。总控只转达，不知道是谁问的。
 */

const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { sealHistoryBlob } = require('../mirror/history-blob.cjs');
// 网卡枚举 / 手填地址解析这些「候选计算」住在「代」里，由当前这一代经 `lanTools` 注入；外壳不认识它们。
// 服务商线路清单与配对二维码 / 手机心跳同源，但那件计算住在「代」里：由当前这一代经
// `getProviderLines` 注入进来。外壳不认识它 —— 改清单、加服务商都只换代，不动外壳。

// 内置总控入口（与 APP 侧常量一致）。末尾斜杠去掉，拼接时统一。
const CONTROL_BASE_URL = (process.env.DSH_CONTROL_URL || 'https://ai-hub.wnluo.com/findme').replace(/\/+$/, '');
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 45_000;
/** 连着两次「请自检」的最小间隔：手机上连点两下别把同一份诊断翻两遍。 */
const DIAGNOSE_COOLDOWN_MS = 2_000;

/** https→wss、http→ws。总控的 WebSocket 端点挂在同一前缀下。 */
function controlWsUrl(base = CONTROL_BASE_URL) {
  return String(base).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/**
 * 折出本机要上报的全部连接地址（明文，上送前再加密）。
 * 中转只取当前实际注册的线路；局域网只走 `advertisedCandidates`（网卡扫到的），手填直连地址
 * 单独标成 `direct`，绝不并进 `lan`；IPv6 走 `ipv6Candidates` 并缀上手填那条，与局域网开关独立；
 * 端口未监听时不发布。
 * 「Cloudflare 兜底隧道」是**一条独立线路**：自己的地址类型 `kind:'cf'`，只取运行时写进
 * `cloudflareUrl` 的那条地址（非空才报），**不受 `lanEnabled` 影响**，也不并进 `direct`。
 * 「TCP 直连」目标（`manualTcpUrl`）单独一条，**不受 `lanEnabled` 影响**：它不挂在局域网监听上，
 * 是一条独立的裸 TCP 出站通道。这一格必须报上来——配了 TCP（或手填直连）时没有中转兜底，
 * 而 TCP 又替换不了「宿主地址」在手机上的同步：手机离开局域网后连不上宿主，只能靠总控把 TCP
 * 目标补给它。漏了这一格，总控这条兜底就等于空转。
 * 「通用线路」是接入方运行时加进来的一批线路：每条单独一条 `kind:'custom'`，带 `name` 与
 * `transport`（http / tcp），不并进任何既有格。清单为空时上报内容与加引擎之前逐字一致。
 */
function controlAddresses(state, port, connectedRelay = '', options = {}) {
  // 第 4 个参数既接受旧的「清单取值器函数」，也接受选项对象 —— 两种都有人用，别让调用方猜。
  const opts = options && typeof options === 'object' ? options : {};
  const getProviderLines = typeof options === 'function' ? options
    : (typeof opts.getProviderLines === 'function' ? opts.getProviderLines : null);
  // 网卡枚举 / 手填地址解析这些「候选计算」住在代里，由 `options.lanTools` 注入（模块对象，或返回对象的函数，两种都认）。
  const lanToolsProvided = opts.lanTools;
  const lanToolsResolved = typeof lanToolsProvided === 'function' ? lanToolsProvided() : lanToolsProvided;
  const tools = lanToolsResolved && typeof lanToolsResolved === 'object' ? lanToolsResolved : null;
  const out = [];
  if (typeof connectedRelay === 'string' && /^https?:\/\//i.test(connectedRelay)) out.push({ kind: 'relay', url: connectedRelay });
  const lanPort = Number.isInteger(port) ? port : 0;
  if (tools && state.lanEnabled && lanPort > 0) {
    try {
      // 局域网这一类**只装网卡扫到的地址**（有私网就只私网，没有才退公网）。用户手填的直连
      // 地址（穿透域名 / 公网 IP）单独标成 `direct`，绝不并进 `lan`：它和局域网是两种地址，
      // 并进同一格会让手机把它当成局域网写进「局域网地址」栏（就是这个 bug）。
      const candidates = tools.orderCandidates(tools.advertisedCandidates(lanPort), state.preferredLanAddress);
      for (const c of candidates) if (c && c.url) out.push({ kind: 'lan', url: c.url });
      const direct = tools.manualCandidate(state.manualLanUrl);
      if (direct) out.push({ kind: 'direct', url: direct.url });
    } catch {
      /* 网卡扫不出来只是少几条 LAN 候选，不影响上报主链路 */
    }
  }
  if (tools && lanPort > 0) {
    try {
      const v6 = tools.withManualIpv6Candidate(tools.ipv6Candidates(lanPort), state.manualIpv6Url);
      for (const c of v6) if (c && c.url) out.push({ kind: 'ipv6', url: c.url });
    } catch {
      /* 同上 */
    }
  }
  // 「Cloudflare 兜底隧道」：一条独立线路，自己的地址类型 `kind:'cf'`，**不受 `lanEnabled`
  // 管**（和 tcp 一样，关掉局域网直连照样报）。只在运行时确实拿到了隧道地址
  // （`state.cloudflareUrl` 非空）时才 push —— 空值没有可拨的地址，塞进来只会让总控白存一条。
  // 它不并进 `direct` / `lan`：用户手填的直连地址原样保留，两条线路互不覆盖。
  const cfUrl = typeof state.cloudflareUrl === 'string' ? state.cloudflareUrl.trim() : '';
  if (cfUrl) out.push({ kind: 'cf', url: cfUrl });
  // TCP 直连：用户填的 `host:port`（可能带方括号 IPv6）。不受 `lanEnabled` 管——它是一条独立的
  // 裸 TCP 出站通道，关掉局域网直连时它照样能用；而它恰恰是「没配中转」那种配置下手机
  // 唯一还能连上的地址，必须进总控这份兜底清单。
  const tcp = tools ? tools.tcpDirectTarget(state.manualTcpUrl) : '';
  if (tcp) out.push({ kind: 'tcp', url: tcp });
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    if (!a || !a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    dedup.push(a);
  }
  // 通用线路单独追加在去重之后：每条线路都要再报一条**老 APP 认识的等价条目**，排在它前面。
  // 老 APP 按 url 去重、先到先得：直连 / TCP 那条先占住 seen，custom 就被跳过，行为与加引擎
  // 之前一模一样（ZeroNews 地址本来就是用户从直连栏读进去的），不会因为不认 custom 而把它
  // 当成局域网地址、再被「手填直连不进局域网」那条规则过滤掉，最后判当前连接失效而离线。
  // 新 APP 反过来先预扫 custom、跳过同址的直连 / TCP，走通用线路引擎（见 APP 的分组预扫）。
  const custom = [];
  const legacy = [];
  // 线路清单与配对二维码 / 手机心跳同源（那一份住在「代」里）：由注入的 `getProviderLines`
  // 给出 ZeroNews、节点小宝、FRP、用户自定义线路，每条再补一条老 APP 认识的等价条目
  // （http→direct、tcp→tcp），排在它前面。没注入（老代回滚到这一版）就当空清单，退回旧行为。
  // 注入的清单算不出来（代里的 providerLinesOf 抛错）时退回空表：不能让一条线路清单把整份
  // 总控上报 / `/status` 一起打掉（其余地址照报）。
  let lines = [];
  try { lines = typeof getProviderLines === 'function' ? (getProviderLines(state) || []) : []; } catch { lines = []; }
  for (const row of lines) {
    custom.push({ kind: 'custom', url: row.url, name: row.name, transport: row.transport });
    if (row.transport === 'tcp') legacy.push({ kind: 'tcp', url: row.url });
    else if (/^https?:\/\//i.test(row.url)) legacy.push({ kind: 'direct', url: row.url });
  }
  for (const row of legacy) {
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    dedup.push(row);
  }
  dedup.push(...custom);
  // 清单里本来就有可连地址、而 TCP 这一格是空的：再补一条**空 url 的 tcp 标记**。
  // 手机据此把「电脑上清掉了 TCP 目标」落到本地；老手机读到空 url 直接忽略，行为不变。
  // 一条别的地址都没有时不补：那种状态下手机也没别的路可学，补了只会白建一条总控连接。
  // 有线路自己补了 TCP 条目时也不补：否则老 APP 会拿这条空标记把刚学会的目标又清掉。
  if (!dedup.some((row) => row.kind === 'tcp' && row.url) && dedup.length) dedup.push({ kind: 'tcp', url: '' });
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
 * @param {(state: object) => Array<{url: string, name?: string, transport?: string}>} [deps.getProviderLines]
 *   服务商线路清单（住在「代」里，注入进来）；缺省当空清单
 * @param {() => object|null} [deps.getLanTools] 网卡枚举 / 手填地址解析这批「候选计算」（住在「代」里，注入进来）；缺省当没有
 * @param {() => boolean} [deps.getRelayConnected] 中转隧道此刻通没通（宿主侧权威状态）
 * @param {(msg: string, ...rest: any[]) => void} [deps.log]
 */
function createControlClient(options = {}) {
  const { persist, getPort, getHistoryKey, getAddresses, getProviderLines = null, getLanTools = null, getRelayConnected, getConnectedRelay, getDiagnostics = null, log = () => {}, onIdentityConflict = null } = options
  // `getState` 让控制客户端读到**当前这一代**的状态（换代后状态对象会换一份）：老的直接传
  // `state` 的用法保留为兜底，测试与旧调用方行为不变。
  const getState = typeof options.getState === 'function' ? options.getState : () => options.state 
  // 候选计算来自当前这一代：`getLanTools` 可能是「返回工具对象的函数」，也可能直接是对象；统一成取值器。
  const lanToolsOf = typeof getLanTools === 'function' ? getLanTools : () => (getLanTools && typeof getLanTools === 'object' ? getLanTools : null)
  const build = typeof getAddresses === 'function'
    ? getAddresses
    : (s) => controlAddresses(s, typeof getPort === 'function' ? getPort() : undefined, typeof getConnectedRelay === 'function' ? getConnectedRelay() : '', { getProviderLines, lanTools: lanToolsOf() });
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
  // 上一次回答「请自检」的时刻（见 DIAGNOSE_COOLDOWN_MS）。
  let lastDiagnoseAt = 0;
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
  // 通用线路带上 transport：同一地址从 http 改成 tcp 要推给手机（拨法变了），name 只用于显示。
  const canonical = (list, meta) => JSON.stringify([
    [...list].map((a) => [a.kind || '', a.url, a.transport || '']).sort(),
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

  /**
   * 收到总控转达的「请自检」：把「这台电脑此刻怎么样」封成答案回过去。
   *
   * 内容与 `/relay/diagnostics` 是**同一份**（`getDiagnostics` 就是那个 handler 的实现），
   * 另加两格只有这条路上才有意义的东西：总控这条腿自己（连着、发布过没有），以及此刻**会**
   * 报上去的明文地址清单 —— 手机手上那份是不是旧的，一比对就知道。
   *
   * 封在 `diagnose` 这个 scope 下（地址那份是 `control`）：总控解不开，也没法拿它去冒充地址。
   */
  function answerDiagnose() {
    const now = Date.now();
    if (now - lastDiagnoseAt < DIAGNOSE_COOLDOWN_MS) return;
    lastDiagnoseAt = now;
    const key = hk();
    if (!key) return;
    let diagnostics = null;
    try {
      diagnostics = typeof getDiagnostics === 'function' ? getDiagnostics() : null;
    } catch (error) {
      log('control: diagnostics failed', error && error.message);
    }
    const current = snapshot();
    const plain = {
      kind: 'diagnose',
      at: now,
      instanceId: getState().instanceId || '',
      // 总控这条腿：手机能问进来，说明它此刻是通的。
      control: { connected: current.connected, published: current.published },
      reported: addresses(),
      diagnostics: diagnostics || null,
    };
    let payload = '';
    try {
      payload = sealHistoryBlob(key, 'diagnose', getState().instanceId || '', plain);
    } catch (error) {
      log('control: diagnose seal failed', error && error.message);
      return;
    }
    send({ type: 'answer', payload });
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
      } else if (msg && msg.type === 'ask') {
        // 总控只转达，不说是谁问的；回一份诊断就够了，不回执、不重发。
        answerDiagnose();
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

  /**
   * 此刻**会**报上去的那几条**有地址的**（与 `publish` 用的是同一个 `build`，不另算一套）。
   *
   * 空 url 的 TCP 标记不带：那不是一条地址，只是「这条通道现在没目标」的声明，`controlSyncGap`
   * 本来也只比地址。给手机「立即同步」用：它拿这份与总控里那份逐条比，才能分清「总控存的是
   * 旧的」还是「这台压根没改」。同样的地址手机本来就能用 HK 从总控解开，不新增能力面。
   */
  function addresses() {
    const list = build(getState());
    return Array.isArray(list) ? list.map(({ kind, url, name, transport }) => ({
      kind: kind || '', url: String(url || ''),
      ...(name ? { name } : {}), ...(transport ? { transport } : {}),
    })).filter((a) => a.url) : [];
  }

  return { start, stop, sync, snapshot, addresses, get targetUrl() { return CONTROL_BASE_URL; } };
}

/**
 * 从「外壳持有的 provider 仓库」造一个总控客户端：getter 每次现读仓库，换代只更新仓库、不换客户端
 * 引用（外壳在提交成功后才换实例）。外壳按实现指纹持有客户端；`create` 由当前这一代交给它。
 */
function createAdoptedControlClient(store) {
  const s = () => (store && typeof store === 'object' ? store : {});
  return createControlClient({
    getState: () => (typeof s().getState === 'function' ? s().getState() : {}),
    persist: () => { if (typeof s().persist === 'function') s().persist() },
    getPort: () => (typeof s().getPort === 'function' ? s().getPort() : 0),
    getHistoryKey: () => (typeof s().getHistoryKey === 'function' ? s().getHistoryKey() : ''),
    getRelayConnected: () => (typeof s().getRelayConnected === 'function' ? s().getRelayConnected() : false),
    getConnectedRelay: () => (typeof s().getConnectedRelay === 'function' ? s().getConnectedRelay() : ''),
    getDiagnostics: () => (typeof s().getDiagnostics === 'function' ? s().getDiagnostics() : null),
    getProviderLines: state => (typeof s().getProviderLines === 'function' ? s().getProviderLines(state) : []),
    getLanTools: () => { const raw = s().getLanTools; const t = typeof raw === 'function' ? raw() : raw; return t && typeof t === 'object' ? t : null },
    log: (...args) => { if (typeof s().log === 'function') s().log(...args) },
    onIdentityConflict: (...args) => (typeof s().onIdentityConflict === 'function' ? s().onIdentityConflict(...args) : undefined),
  })
}

/** 总控上报实现依赖的本地文件（相对 lib/relay）：control 本体 + 历史 blob 密封 + 其用到的 e2ee。 */
function controlFingerprintFiles() {
  return ['control.js', '../mirror/history-blob.cjs', '../shared/e2ee.js'];
}

/** 总控上报「实现指纹」：外壳按它决定提交时是否换客户端——改了 control 实现才换。 */
function controlFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const rel of controlFingerprintFiles()) {
    try { hash.update(fs.readFileSync(path.join(__dirname, rel))); } catch { hash.update(rel); }
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = { CONTROL_BASE_URL, controlWsUrl, controlAddresses, controlMeta, createControlClient, createAdoptedControlClient, controlFingerprint, controlFingerprintFiles };

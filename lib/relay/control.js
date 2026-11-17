'use strict';

/**
 * 总控（地址目录）客户端：把本机的**全部连接地址**加密后上报给总控，拿回一枚设备令牌交给 APP。
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
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    if (!a || !a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    dedup.push(a);
  }
  return dedup;
}

/**
 * @param {object} deps
 * @param {object} deps.state 宿主状态（就地改：写入令牌）
 * @param {() => void} [deps.persist] 令牌变了之后落盘（通常是 `core.saveState(state)`）
 * @param {() => number} deps.getPort 当前实绑的局域网端口取值器
 * @param {() => string} deps.getHistoryKey 取实例历史密钥（HK，base64url）；缺失时会惰性生成
 * @param {(state: object) => Array<{kind?: string, url: string}>} [deps.getAddresses] 地址来源覆盖（测试用）
 * @param {(msg: string, ...rest: any[]) => void} [deps.log]
 */
function createControlClient({ state, persist, getPort, getHistoryKey, getAddresses, log = () => {} }) {
  const build = typeof getAddresses === 'function'
    ? getAddresses
    : (s) => controlAddresses(s, typeof getPort === 'function' ? getPort() : undefined);

  let sock = null;
  let running = false;
  let connected = false;
  let token = typeof state.controlToken === 'string' ? state.controlToken : '';
  let lastSent = '';
  let attempt = 0;
  let reconnectTimer = null;
  let tickTimer = null;

  const canonical = (list) => JSON.stringify([...list].map((a) => [a.kind || '', a.url]).sort());

  function hk() {
    try {
      const value = typeof getHistoryKey === 'function' ? getHistoryKey() : state.historyKey;
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  /** 明文地址 → 密文信封 JSON。HK 缺了就返回空串（不连）。 */
  function seal(addresses) {
    const key = hk();
    if (!key) return '';
    try {
      return sealHistoryBlob(key, 'control', state.instanceId || '', { addresses });
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
    if (!state.enabled) return;
    const addresses = build(state);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      connected = false;
      return;
    }
    const payload = seal(addresses);
    if (!payload) {
      connected = false;
      return;
    }
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    const url = `${controlWsUrl()}/ws/device?instanceId=${encodeURIComponent(state.instanceId || '')}${tokenQuery}`;
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
      attempt = 0;
      connected = true;
      send({ type: 'register', payload });
      lastSent = canonical(addresses);
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
      if (msg && msg.type === 'registered' && typeof msg.token === 'string') {
        if (msg.token !== token) {
          token = msg.token;
          state.controlToken = msg.token;
          try { persist?.(); } catch { /* 落盘失败下次注册还会拿到同一枚，不必打断 */ }
        }
      } else if (msg && msg.type === 'error') {
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

  /** 复核地址有没有变，变了就重新加密并 update。 */
  function tick() {
    if (!connected || !sock) return;
    const addresses = build(state);
    if (!Array.isArray(addresses) || addresses.length === 0) return;
    if (canonical(addresses) !== lastSent) {
      const payload = seal(addresses);
      if (!payload) return;
      send({ type: 'update', payload });
      lastSent = canonical(addresses);
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
    if (state.enabled && !sock) connect();
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

  /** 配置变更后调用：没开 / 没地址 / 没 HK 就停；否则起连或复核。 */
  function sync() {
    if (!state.enabled || build(state).length === 0 || !hk()) {
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

module.exports = { CONTROL_BASE_URL, controlWsUrl, controlAddresses, createControlClient };

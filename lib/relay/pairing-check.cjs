// 2026-11-28：服务商 TCP 线路（FRP）在码里是裸 host:port，自检前补 tcp:// 才拨得通。
// 2026-11-26：配对地址自检——把二维码里要带的每条地址真拨一次，拨不通的别写进码里。
'use strict';

/**
 * 配对地址自检：`GET /api/relay/pairing-check`。
 *
 * 二维码里那条地址到底通不通，原来只能靠用户扫一次才知道：扫不上，面板上还是一片正常，
 * 人只能去猜是防火墙、端口还是服务商。这一份从**这台电脑**出发，把码里会带的每条地址
 * （局域网 / 手填直连 / 服务商线路 / 中转 / TCP 直连）真拨一次。
 *
 * 它证明不了什么，这一点必须说清：拨自己是走本机网卡，手机能不能到达还要过防火墙、看是不是
 * 同一个网段、有没有开访客网络隔离。所以结果分两档 —— 「本机回环可达」与「外部线路可达」，
 * 前者只说明监听在、请求能进门，不说明手机连得上。面板据此说话，不许把回环写成「局域网正常」。
 *
 * 只做 GET，不落任何配置；targets 全部来自当前状态自己拼出来的那一份，不接受调用方传地址。
 */

const net = require('node:net');
const os = require('node:os');

const { pairingPayload } = require('./pairing-payload.cjs');

/** 单条地址最多等这么久。四条并行，整体也就是一次握手的时间。 */
const DEFAULT_TIMEOUT_MS = 4000;

/** 本机所有网卡上的地址（IPv4 + IPv6，去掉 zone 后缀），用来判「这条地址是不是在拨自己」。 */
function localAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);
  for (const rows of Object.values(interfaces)) {
    for (const row of rows || []) {
      const address = typeof row.address === 'string' ? row.address.trim() : '';
      if (address) out.add(address.replace(/%.+$/, ''));
    }
  }
  return out;
}

/** 地址里的主机名：`https://[240e::1]:18787` 要取成 `240e::1`。 */
function hostOf(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 码里会带哪些地址、各是哪一类。
 *
 * 同一串地址可能出现在好几栏里（老包兼容会把服务商地址再写一份进 `lanUrls`），这里按地址
 * 去重，留下说明力更强的那一类：有名字的服务商线路优先于匿名的局域网条目。
 */
function targetsOf(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const byUrl = new Map();
  const add = (row) => {
    const url = typeof row.url === 'string' ? row.url.trim().replace(/\/+$/, '') : '';
    if (!url) return;
    const seen = byUrl.get(url);
    // 已经按服务商线路记下的，别再被 `lanUrls` 里那份副本盖成匿名条目。
    if (seen && seen.kind !== 'lan') return;
    byUrl.set(url, {
      kind: row.kind,
      url,
      ...(row.name ? { name: row.name } : {}),
      ...(row.transport === 'tcp' ? { transport: 'tcp' } : {}),
    });
  };

  if (typeof p.relayUrl === 'string' && p.relayUrl) add({ kind: 'relay', url: p.relayUrl });
  for (const row of Array.isArray(p.routes) ? p.routes : []) {
    const url = row && typeof row.url === 'string' ? row.url.trim().replace(/\/+$/, '') : '';
    // FRP 这类 TCP 线路在码里是裸 `host:port`（见 provider-lines.cjs），和下面 tcpUrl 那一支
    // 走同一口径补上 scheme，probeTarget 的 new URL 才认得。customRoutes 里可能已带 scheme，
    // 幂等：有 scheme 就不动。
    const normalized = row && row.transport === 'tcp' && url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)
      ? `tcp://${url}`
      : url;
    add({ kind: 'route', url: normalized, name: row && row.name, transport: row && row.transport });
  }
  if (typeof p.directUrl === 'string' && p.directUrl) add({ kind: 'direct', url: p.directUrl });
  if (typeof p.tcpUrl === 'string' && p.tcpUrl) add({ kind: 'tcp', url: `tcp://${p.tcpUrl}`, transport: 'tcp' });
  for (const url of Array.isArray(p.lanUrls) ? p.lanUrls : []) add({ kind: 'lan', url });
  return [...byUrl.values()];
}

/** 拨一次 http(s)：拿到任何 HTTP 回答都算拨到了；5xx 说明对面在、但那一层自己起不来。 */
async function probeHttp(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-mobile-panel/pairing-check' },
    });
    // 丢掉 body：这一发只关心「门开没开」，不读内容。
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 500) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (error) {
    const name = error && error.name === 'TimeoutError' ? 'timeout' : '';
    return { ok: false, error: name || (error && error.message) || String(error) };
  }
}

/** 拨一次裸 TCP（TCP 直连那一条走不了 HTTP）。 */
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (error) => finish({ ok: false, error: error.code || error.message }));
  });
}

/** 一条目标怎么拨：`tcp://` 走裸连接，其余走 HTTP。 */
async function probeTarget(target, timeoutMs, local) {
  if (target.transport === 'tcp') {
    const url = new URL(target.url);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return { ...target, local, ok: false, error: 'bad-target' };
    return { ...target, local, ...(await probeTcp(url.hostname, port, timeoutMs)) };
  }
  if (!/^https?:\/\//i.test(target.url)) return { ...target, local, ok: false, error: 'bad-target' };
  return { ...target, local, ...(await probeHttp(target.url, timeoutMs)) };
}

/**
 * 汇总：能不能去扫码。
 *
 * @param {Array<{local: boolean, ok: boolean}>} results
 */
function summarize(results) {
  const okRows = results.filter((row) => row.ok);
  const remoteOk = okRows.some((row) => !row.local);
  const localOk = okRows.some((row) => row.local);
  return {
    total: results.length,
    okCount: okRows.length,
    /** 有外部线路通了（服务商 / 中转 / 公网直连）—— 这才值得说「可以扫码了」。 */
    remoteOk,
    /** 只有拨自己的那几条通了：监听在，但手机能不能连上仍未知。 */
    localOk,
    allFailed: results.length > 0 && okRows.length === 0,
    nothingToCheck: results.length === 0,
  };
}

/**
 * 跑一次自检。
 *
 * @param {object} state relay.json 那份状态
 * @param {object} [options]
 * @param {number} [options.lanPort] 实绑的局域网端口
 * @param {number} [options.timeoutMs]
 * @param {object} [options.interfaces] 只给测试用
 */
async function pairingCheck(state, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const { payload } = pairingPayload(state, Number.isInteger(options.lanPort) ? options.lanPort : state && state.lanPort);
  const locals = localAddresses(options.interfaces);
  const targets = targetsOf(payload);
  const results = await Promise.all(
    targets.map((target) => probeTarget(target, timeoutMs, locals.has(hostOf(target.url)))),
  );
  return {
    ok: true,
    checkedAt: Date.now(),
    timeoutMs,
    targets: results,
    // 这几条不是 HTTP，拨不了：Tailcat 走助手自己的协议、点对点要两边同时起。
    notChecked: [
      ...(payload.tailcat ? ['tailcat'] : []),
      ...(payload.p2p ? ['p2p'] : []),
    ],
    summary: summarize(results),
  };
}

module.exports = { pairingCheck, targetsOf, summarize, localAddresses, hostOf, DEFAULT_TIMEOUT_MS };

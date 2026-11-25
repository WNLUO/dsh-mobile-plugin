// IPv6 候选按真实监听端口生成，独立于 IPv4 局域网候选开关。
// 2026-11-22：远程桌面候选也带上插件上报的第三方线路（含 ZeroNews），与手机共用同一批。
'use strict';
// 电脑间已认证控制信令只提供隧道会合，目标固定为本机插件入口。
const { relayAddressesOf } = require('../relay/core.js');
const { advertisedCandidates, phoneCandidates, ipv6Candidates, withManualIpv6Candidate, tcpDirectTarget } = require('../relay/lan-network.cjs');

function routesOf({ state, lanPortInUse, lanAvailable = () => state.lanEnabled, interfaces }) {
  const routes = [];
  const push = (url, channel) => {
    if (typeof url !== 'string' || !url || routes.some(row => row.url === url)) return;
    let parsed;
    try { parsed = new URL(url); } catch { return; } // 运行时写入的线路地址可能半截，别让整份候选崩掉
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    routes.push({ url: parsed.href.replace(/\/$/, ''), channel });
  };
  const port = Number(lanPortInUse());
  if (lanAvailable()) {
    for (const item of phoneCandidates(advertisedCandidates(port, interfaces), { manual: state.manualLanUrl })) push(item.url, 'lan');
  }
  // lanPortInUse 为 0 表示没有监听，不能把配置端口或中转回环口发布成 v6 直连。
  if (Number.isInteger(port) && port > 0) {
    for (const item of withManualIpv6Candidate(ipv6Candidates(port, interfaces), state.manualIpv6Url)) push(item.url, 'ipv6');
  }
  for (const url of relayAddressesOf(state).relayUrls) push(url, 'relay');
  // 「TCP 直连」目标：公网可达、手机靠裸 TCP 拨的那条，电脑对电脑同样能走（明文 http 转发到本机入口）。
  // 它与直连地址一样只是「手机直连这台电脑」，不会让电脑注册到中转上，也不顶替中转，
  // 所以这里必须把它也当候选，否则远程电脑反而少一条可用的公网线路。
  const tcp = tcpDirectTarget(state.manualTcpUrl);
  if (tcp) push(`http://${tcp}`, 'tcp');
  // 通用线路：手机与远程桌面共用同一批。ZeroNews 由插件自己读本机 API 写进独立字段；
  // 其余线路由接入方运行时写入。远程侧按 URL + 通道名记账，custom 作为表外通道排最后。
  const zeroNews = typeof state.zeroNewsUrl === 'string' ? state.zeroNewsUrl.trim().replace(/\/+$/, '') : '';
  if (zeroNews) push(zeroNews, 'custom');
  for (const route of (Array.isArray(state.customRoutes) ? state.customRoutes : [])) {
    if (!route || typeof route !== 'object') continue;
    push(customRouteUrl(route.url, route.transport), 'custom');
  }
  return routes;
}
/** 通用线路地址：http(s) 原样，tcp 的 host:port 补 http 前缀（远程侧要的是可解析 URL）。 */
function customRouteUrl(value, transport) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!text) return '';
  if (transport === 'tcp' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return `http://${text}`;
  return text;
}

function candidates(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 96).slice(0, 16);
}
function createHostControl({ state, tailcat, p2p, lanPortInUse, lanAvailable }) {
  const pending = new Map();
  const currentRoutes = () => routesOf({ state, lanPortInUse, lanAvailable });
  return {
    routesOf: currentRoutes,
    connectionInfo: () => ({ routes: currentRoutes() }),
    async onControl(record, request) {
      if (request?.op !== 'tunnels' && request?.op !== 'tunnels.refresh') throw new Error('unsupported-control');
      if (!record || record.remoteWeb !== true) throw new Error('remote-web-denied');
      const key = record.deviceId;
      if (pending.has(key)) return pending.get(key);
      const result = (async () => {
        const tailcatKey = request.tailcatPublicKey;
        const point = request.p2p;
        const enroll = /^nodekey:[0-9a-f]{64}$/.test(tailcatKey || '') && tailcat?.enroll
          ? tailcat.enroll(tailcatKey).catch(() => null) : Promise.resolve(null);
        const punch = /^[A-Za-z0-9+/]{43}=$/.test(point?.publicKey || '') && p2p?.open
          ? p2p.open({ phonePublicKey: point.publicKey, candidates: candidates(point.candidates),
            localCandidates: candidates(point.localCandidates), targetPort: p2p.targetPort() }).catch(() => null)
          : Promise.resolve(null);
        const [tunnel, peer] = await Promise.all([enroll, punch]);
        return {
          routes: currentRoutes(),
          ...(tunnel?.address ? { tailcat: { address: tunnel.address, port: tunnel.port } } : {}),
          ...(peer?.ok && peer.publicKey ? { p2p: { publicKey: peer.publicKey, port: p2p.constants.P2P_PORT,
            candidates: candidates(peer.candidates), localCandidates: candidates(peer.localCandidates) } } : {}),
        };
      })();
      pending.set(key, result);
      try { return await result; } finally { pending.delete(key); }
    },
  };
}
module.exports = { createHostControl, routesOf };

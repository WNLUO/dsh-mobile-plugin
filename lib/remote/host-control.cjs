// IPv6 候选按真实监听端口生成，独立于 IPv4 局域网候选开关。
'use strict';
// 电脑间已认证控制信令只提供隧道会合，目标固定为本机插件入口。
const { relayAddressesOf } = require('../relay/core.js');
const { advertisedCandidates, phoneCandidates, ipv6Candidates, withManualIpv6Candidate } = require('../relay/lan-network.cjs');

function routesOf({ state, lanPortInUse, lanAvailable = () => state.lanEnabled, interfaces }) {
  const routes = [];
  const push = (url, channel) => {
    if (typeof url !== 'string' || !url || routes.some(row => row.url === url)) return;
    const parsed = new URL(url);
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
  return routes;
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

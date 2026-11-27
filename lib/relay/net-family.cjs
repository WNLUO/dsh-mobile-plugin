'use strict';
// 出站协议族策略的单一出口：把「auto / ipv4-first / ipv4-only」翻译成
//   - 出站 WebSocket 的 agent（强制 IPv4 时 family:4），
//   - cloudflared 的 --edge-ip-version，
//   - 是否还产出/上报 IPv6 直连候选。
// 别处不要再各写一份，改口径只改这里。
const http = require('node:http');
const https = require('node:https');

const POLICIES = ['auto', 'ipv4-first', 'ipv4-only'];

/** 只有这三档是合法值，其余（含老配置缺失）一律按 auto。 */
function normalizeIpVersionPolicy(value) {
  return POLICIES.includes(value) ? value : 'auto';
}

/** 还要不要产出 / 上报 IPv6 直连候选：只有 ipv4-only 一刀切掉。 */
function allowsIpv6Candidates(policy) {
  return normalizeIpVersionPolicy(policy) !== 'ipv4-only';
}

/**
 * 出站 WS 用的 agent：auto 交给系统（返回 undefined，行为与历史完全一致）；
 * 其余强制 family:4，按目标 ws / wss 选 http / https agent。
 */
function outboundAgentFor(policy, secure) {
  if (normalizeIpVersionPolicy(policy) === 'auto') return undefined;
  return secure ? new https.Agent({ family: 4 }) : new http.Agent({ family: 4 });
}

/** cloudflared 的 --edge-ip-version 取值：auto 不传（undefined）；其余传 '4'。 */
function cloudflaredEdgeIpVersion(policy) {
  return normalizeIpVersionPolicy(policy) === 'auto' ? undefined : '4';
}

module.exports = { POLICIES, normalizeIpVersionPolicy, allowsIpv6Candidates, outboundAgentFor, cloudflaredEdgeIpVersion };

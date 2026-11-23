// 2026-11-23：服务商线路收成唯一一份清单，总控信封 / 手机心跳 / 配对二维码三处共用。
// 以后加服务商只往这里加，二维码与手机都自动跟上，不再一处一处补。
'use strict';

/**
 * 服务商线路清单。
 *
 * 这几家（ZeroNews / 节点小宝 / FRP）是插件自己从运行时读到的独立字段，用户自己加的第三方
 * 线路在 `customRoutes` 里。它们的共同形状只有两种：一条 http(s) 地址，或一条 `主机:端口`
 * 的裸 TCP 地址。手机端（心跳的 `customRoutes`、总控信封的 `kind:'custom'`）和配对二维码
 * 认的是同一份形状，所以这里只产出一次，别处不许再各拼一遍——三处各拼一次迟早漏一处，
 * 表现就是「心跳里有这条线路、二维码里没有」这种最难查的分叉。
 *
 * 每条：`{ url, name, transport }`，`transport` 只会是 `'http'` 或 `'tcp'`。
 * 空地址、重复地址丢掉；顺序即配置顺序（ZeroNews → 节点小宝 → FRP → 用户自定义）。
 *
 * 注意：Cloudflare 兜底隧道**不在这里**。它在三处都单独一格（心跳 `cloudflare`、信封
 * `kind:'cf'`），并进这份清单会让手机把它当成第三方线路重复画一遍。二维码那边要带它，
 * 由调用方单独补一条即可。
 */
function providerLinesOf(state) {
  const out = [];
  const seen = new Set();
  const push = (url, name, transport) => {
    const clean = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({
      url: clean,
      name: typeof name === 'string' ? name.trim().slice(0, 80) : '',
      transport: transport === 'tcp' ? 'tcp' : 'http',
    });
  };
  const s = state && typeof state === 'object' ? state : {};
  const zero = typeof s.zeroNewsUrl === 'string' ? s.zeroNewsUrl.trim().replace(/\/+$/, '') : '';
  if (zero) push(zero, 'ZeroNews', 'http');
  // 节点小宝有「网页服务（https 域名）」与「TCP服务（主机:端口）」两类，由 lineOf 认形状。
  const { lineOf } = require('../jdxb/probe.cjs');
  const jdxb = lineOf(s.jdxbUrl);
  if (jdxb) push(jdxb.url, '节点小宝', jdxb.transport);
  // FRP 是本机 frpc 分到的公网地址，算一条独立线路。
  const frp = lineOf(s.frpUrl);
  if (frp) push(frp.url, 'FRP', frp.transport);
  if (Array.isArray(s.customRoutes)) {
    for (const route of s.customRoutes) {
      if (!route || typeof route !== 'object') continue;
      push(route.url, route.name, route.transport);
    }
  }
  return out;
}

module.exports = { providerLinesOf };

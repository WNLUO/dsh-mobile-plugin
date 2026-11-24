'use strict';
// 控制面不再按跨站来源拒绝：反代、公网域名、桌面壳自定义协议下都放行，只留转发与 method 守卫。
// 转发里放行手机「网页版」那条管道（`preview-webapp`），中转与局域网代理仍然拒绝。
// 设备能力和入口恢复只在请求信封验过之后记账。

/**
 * 插件 HTTP 路由基建：控制面守卫的地基，也是外壳故障自检口需要的最小来源判定与响应工具。
 * 本机与局域网直连分别判定，共用来源与转发头校验。
 *
 * 都是只依赖 req/res 的纯函数，抽到这里才能直接 require 并喂假 req/res 测试。它们挡的是
 * 「谁能调控制面」，写错一行的后果是鉴权被绕过，不是页面显示不出来。
 *
 * 移动端那套守卫（token + 协议 v2 信封）**不在这里**：它住在 `lib/mobile/guarded.js`（代里），
 * 以免改信封或移动鉴权时外壳被连带冻住、逼用户重启 DSH。
 */

const net = require('node:net');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { isPrivateLanAddress } = require('../shared/private-address.js');

/**
 * 「这个请求是谁转发的」。
 *
 * 中转与局域网代理都跑在这台机器上，它们转给本地上游的请求 socket 对端就是回环地址，
 * `host` 还会被补成 `127.0.0.1:<上游端口>` —— 于是**任何看来源地址或 Host 的判据都对它们
 * 失效**，经中转打进来的控制面请求长得和本机 DSH 设置页一模一样（实测：不带实例头、不带
 * cookie 的 `POST /api/relay/config` 照样执行，能改中转地址、改注册密钥、`revoke-all`）。
 *
 * 所以判据换成「谁转发的」这个事实：两个代理在转发前**先删掉客户端自带的同名头、再写入
 * 自己的值**（`relay` / `lan`），控制面见到它就按远程处理。客户端自己塞一个也没用 ——
 * 代理会先把它删掉。
 */
const VIA_HEADER = 'x-dsh-via';

/**
 * 手机「网页版」那条预览管道写的值（`lib/relay/preview-webapp.cjs`）。
 *
 * 它是唯一按本机界面放行的转发方：管道只接受已配对设备的令牌，而且只允许拨宿主自己的
 * web 端口（见 `lib/relay/preview.js` 的 webapp 档）。手机上打开的整份网页版里装着全部
 * 插件的管理界面，控制面得对它可用；中转与局域网代理没有设备凭据，仍然拒绝。
 */
const HOST_WEB_VIA = 'preview-webapp';

/** 请求里所有 `x-dsh-via` 的值（同名头可能多个，值统一小写去空白）。 */
const viaValues = (req) => {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return [];
  const values = [];
  // 按小写比对而不是直接取键：Node 会把入站头名压成小写，但假 req、反代注入、
  // 以及 `WebSocket` 升级那条路的 headers 对象不保证如此，靠大小写绕过太便宜。
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== VIA_HEADER) continue;
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const value = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (value) values.push(value);
    }
  }
  return values;
};

/** 请求是否由代理转发而来（值即转发方）。 */
const proxiedRequest = (req) => viaValues(req).length > 0;

// Relay pairing cookies and instance headers are routing credentials only;
// never allow them to reach the local control plane.
//
// `x-dsh-via` 也在这里：它是「转发来的」这个事实本身。手机走 `/api/mobile/v1/**` 时通常
// 既不待实例头也不带 cookie，只靠这两条挡不住转发来的控制面请求。
// 唯一例外是网页版管道（`preview-webapp`）：它由已配对设备建立、只能拨宿主自己的 web 端口，
// 手机上那整份网页版要靠控制面才能打开插件管理页。
const remoteRelayRequest = (req) => {
  const vias = viaValues(req);
  if (vias.length > 0 && !vias.every((via) => via === HOST_WEB_VIA)) return true;
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {};
  if (typeof headers['x-dsh-instance'] === 'string' && headers['x-dsh-instance']) return true;
  return /(?:^|;\s*)dsh_(?:pair|lan)=/.test(String(headers.cookie || ''));
};

// 控制面不按「来源」拦截：跨站、反代改写了 Host、桌面壳自定义协议下都一样放行。
// 不管这台机器部署在哪儿（本机、局域网、公网域名、反代后面），控制面只认「谁转发的」
// 这一条，并钉住每个路由的 method —— 经中转 / 局域网代理转发来的仍按远程处理。

// 本机界面与局域网界面各有来源范围；两者都要求 socket 与 Host 同属可信网络，
// 并拒绝代理转发标记，不以客户端自带的来源头扩大信任。
const isLoopbackAddress = (address) => {
  if (typeof address !== 'string' || !address) return false
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  const ipv4 = mapped ? mapped[1] : value
  if (net.isIP(ipv4) !== 4) return false
  return Number(ipv4.split('.')[0]) === 127
}

const isLocalNetworkAddress = (address) => {
  if (isLoopbackAddress(address)) return true
  if (typeof address !== 'string' || !address) return false
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateLanAddress(mapped[1])
  if (net.isIP(value) === 4) return isPrivateLanAddress(value)
  return net.isIP(value) === 6 && (/^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value))
}

const trustedNetworkUi = (req, acceptsAddress) => {
  const socket = req?.socket || req?.connection
  if (!acceptsAddress(socket?.remoteAddress)) return false
  // 转发来的一律不算可信直连：隧道与局域网代理都会从回环连出去，光看 socket 分不出来。
  if (proxiedRequest(req)) return false
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {}
  for (const [name, value] of Object.entries(headers)) {
    if (/^(?:forwarded$|x-forwarded-|x-real-ip$|via$|true-client-ip$|cf-connecting-ip$)/i.test(name)
      && String(value || '').trim()) return false
  }
  const host = headers.host
  if (typeof host !== 'string' || !host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || acceptsAddress(hostname)
  } catch {
    return false
  }
}

const trustedLocalUi = (req) => trustedNetworkUi(req, isLoopbackAddress)
const trustedLocalNetworkUi = (req) => trustedNetworkUi(req, isLocalNetworkAddress)

// `method` 可以是单个方法名，也可以是方法名数组（同一个路径上挂 GET+POST）。
// 单方法时的 405 文案保持不变。
const localOnly = (method, handler) => async (req, res) => {
  if (remoteRelayRequest(req)) return sendJson(res, 403, { ok: false, error: { code: 'local_only', message: '控制面仅允许本机访问' } })
  const allowed = Array.isArray(method) ? method : [method]
  const actual = String(req.method || 'GET').toUpperCase()
  if (!allowed.includes(actual)) {
    const label = Array.isArray(method) ? method.join(' / ') : method
    return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `仅支持 ${label}` } })
  }
  return handler(req, res)
}

const readJson = (req) => readJsonBody(req, 256 * 1024).then(body => body || {})

module.exports = {
  remoteRelayRequest,
  proxiedRequest,
  VIA_HEADER,
  isLoopbackAddress,
  isLocalNetworkAddress,
  trustedLocalUi,
  trustedLocalNetworkUi,
  localOnly,
  readJson,
  // 移动端信封守卫（token + 协议 v2）不在这里：它住在 `lib/mobile/guarded.js`（代里），
  // 免得信封/移动鉴权一改就把外壳连带冻住、逼用户重启 DSH。
  // shared/http-util 重出一次：这个文件里的守卫全都用它写响应，
  // 让「路由基建」成为一处完整的地基，而不是散在三个文件里各写一半。
  sendJson,
};
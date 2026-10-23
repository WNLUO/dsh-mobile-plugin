'use strict';

/**
 * 插件 HTTP 路由基建：控制面与移动端两套守卫的共用地基。
 *
 * 这些函数此前是 lib/index.js 里的局部闭包，紧挨着 65 条路由注册写在一起。它们
 * 本身是纯函数（只依赖 req/res），却因为住在 apply() 里而无法单测——而这几条守卫
 * 恰好是最该有测试的地方：它们挡的是「谁能调控制面」「谁能调移动端」，写错一行的
 * 后果是鉴权被绕过而不是某个页面显示不出来。
 *
 * 抽出来单独放一个文件是为了让它们能被直接 require 并喂假 req/res 测试。抽出后
 * 两套守卫并排放在一个文件里，肉眼就能对照出「控制面多挡了跨站与 method，移动端只
 * 挡 token」这个刻意的不对称。
 */

const net = require('node:net');
const { isProto2, openRequest, sealResponse, readRawBody } = require('../shared/e2ee-request');
const { sendJson, readJsonBody } = require('../shared/http-util');

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

/** 请求是否由本机的中转或局域网代理转发而来（值即转发方）。 */
const proxiedRequest = (req) => {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return false;
  // 按小写比对而不是直接取键：Node 会把入站头名压成小写，但假 req、反代注入、
  // 以及 `WebSocket` 升级那条路的 headers 对象不保证如此，靠大小写绕过太便宜。
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== VIA_HEADER) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
};

// Relay pairing cookies and instance headers are routing credentials only;
// never allow them to reach the local control plane.
//
// `x-dsh-via` 也在这里：它是「转发来的」这个事实本身。手机走 `/api/mobile/v1/**` 时通常
// 既不待实例头也不带 cookie，只靠这两条挡不住转发来的控制面请求。
const remoteRelayRequest = (req) => Boolean(
  proxiedRequest(req)
    || (typeof req.headers['x-dsh-instance'] === 'string' && req.headers['x-dsh-instance'])
    || /(?:^|;\s*)dsh_(?:pair|lan)=/.test(String(req.headers.cookie || '')),
)

// Cross-site guard for the control plane.
//
// `localOnly` alone only rejected requests that carried relay routing
// credentials, so a plain cross-site `GET /api/relay/revoke-all` from any page
// the user had open still executed (the routes had no method check either).
// Rejecting cross-site fetches and pinning each route to one method closes
// that: a control-plane call now has to be a same-origin top-level/`same-origin`
// request, and it has to use the documented verb.
const crossSiteRequest = (req) => {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin) return false
  const host = req.headers.host
  if (typeof host !== 'string' || !host) return true
  try { return new URL(origin).host !== host } catch { return true }
}

// `trustedLocalUi` 是唯一允许开启网页管理窗口的来源判定，不等同于 localOnly：
// 既要 socket 直连 loopback，也要 Host 是 loopback/localhost，并拒绝常见代理转发头。
// 代理若改写 Host 且剥掉所有来源标记，后端无法从 HTTP 请求辨认原始客户端；这种代理配置
// 不支持用它开启窗口（应从本机直连或 SSH 隧道访问）。
const isLoopbackAddress = (address) => {
  if (typeof address !== 'string' || !address) return false
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  const ipv4 = mapped ? mapped[1] : value
  if (net.isIP(ipv4) !== 4) return false
  return Number(ipv4.split('.')[0]) === 127
}

const trustedLocalUi = (req) => {
  const socket = req?.socket || req?.connection
  if (!isLoopbackAddress(socket?.remoteAddress)) return false
  // 转发来的一律不算本机界面：隧道与局域网代理都是从回环连出去的，光看 socket 分不出来。
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
    return hostname === 'localhost' || isLoopbackAddress(hostname)
  } catch {
    return false
  }
}

// `method` 可以是单个方法名，也可以是方法名数组（同一个路径上挂 GET+POST，
// 例如 /api/relay/desktop-view 既读快照又收回传）。单方法时的 405 文案保持不变。
const localOnly = (method, handler) => async (req, res) => {
  if (remoteRelayRequest(req)) return sendJson(res, 403, { ok: false, error: { code: 'local_only', message: '控制面仅允许本机访问' } })
  if (crossSiteRequest(req)) return sendJson(res, 403, { ok: false, error: { code: 'cross_site', message: '控制面拒绝跨站请求' } })
  const allowed = Array.isArray(method) ? method : [method]
  const actual = String(req.method || 'GET').toUpperCase()
  if (!allowed.includes(actual)) {
    const label = Array.isArray(method) ? method.join(' / ') : method
    return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `仅支持 ${label}` } })
  }
  return handler(req, res)
}

const readJson = (req) => readJsonBody(req, 256 * 1024).then(body => body || {})

/**
 * 移动端路由守卫：token + 把 handler 抛出的异常统一收成 500 信封。
 *
 * 与 localOnly 的不对称是刻意的：移动端请求本来就要从公网进来，跨站不是它的风险；
 * 它的风险是「没带 token 也能读别人的会话」，所以只校验 token。
 *
 * @param {object} ctx 插件 ctx，透传给 handler
 * @param {(req: object) => boolean} authorized 移动 token 校验，由调用方注入
 * @param {() => void} [note] 通过 token 校验之后叫一声：宿主用它记「手机来过」的时刻，
 *   引导最后一页据此说「手机已经连上了」。**只在校验通过之后叫**，401 那条不算——
 *   否则随便谁打一下也能把面板骗成「连上了」。
 * @returns {(handler: (ctx: object, req: object, res: object) => Promise<unknown>) => (req: object, res: object) => Promise<unknown>}
 */
/**
 * 移动端路由守卫：token + 协议 v2 信封 + 把 handler 抛出的异常统一收成 500 信封。
 *
 * 与 localOnly 的不对称是刻意的：移动端请求本来就要从公网进来，跨站不是它的风险；
 * 它的风险是「没带 token 也能读别人的会话」，所以只校验 token。
 *
 * **信封的顺序在这里定死**（§8.3(11)）：鉴权（token）→ 验签 → 重放 → 解封请求体 →
 * 业务 handler → 封响应。鉴权放在最前，是因为「这台设备是谁」决定了拿哪把密钥验签；
 * 而鉴权自身失败时回的是明文 401（`e2ee-unknown-device` 之外的一切凭据问题），
 * 因为 App 必须先在解不开信封的情况下读懂它。
 *
 * @param {object} ctx 插件 ctx，透传给 handler
 * @param {(req: object) => boolean} authorized 移动 token 校验，由调用方注入
 * @param {() => void} [note] 通过 token 校验之后叫一声：宿主用它记「手机来过」的时刻，
 *   引导最后一页据此说「手机已经连上了」。**只在校验通过之后叫**，401 那条不算——
 *   否则随便谁打一下也能把面板骗成「连上了」。
 * @param {(req: object) => void} [onAuthorized] 带请求对象的记账（要读凭据记录时用）。
 * @param {object} [envelope] 协议 v2 的信封钩子：`{ keyFor, readBody }`。不给就是纯明文。
 * @returns {(handler: (ctx: object, req: object, res: object) => Promise<unknown>) => (req: object, res: object) => Promise<unknown>}
 */
const createGuarded = (ctx, authorized, note = null, extra = {}) => {
  const onAuthorized = typeof extra.onAuthorized === 'function' ? extra.onAuthorized : null
  const envelope = extra.envelope && typeof extra.envelope === 'object' ? extra.envelope : null
  return (handler) => async (req, res) => {
    // 鉴权失败要**说清是哪一种**（§3.8）：被吊销 / 已过期 / 只是没有 token。
    //
    // 前两种必须让手机知道「我被踢了」并停止轮询 —— 只回一句「缺少或无效的移动 token」，
    // 用户看到的是「请求失败」，而它其实已经不能再做任何事了。这三条响应都是明文：
    // 客户端要在解不开信封的情况下读懂它们。
    // `authorized` 的两种返回值都认：布尔（老调用方/测试）与带 reason 的对象（宿主用，
    // 这样才能区分「被踢了」与「没带 token」）。
    const outcome = authorized(req)
    const passed = outcome === true || (outcome && typeof outcome === 'object' && outcome.ok === true)
    if (!passed) {
      const reason = outcome && typeof outcome === 'object' ? outcome.reason : 'unauthorized'
      if (reason === 'revoked') return sendJson(res, 401, { ok: false, error: { code: 'device-revoked', message: '这台设备已被解除绑定，请重新扫码' } })
      if (reason === 'expired') return sendJson(res, 401, { ok: false, error: { code: 'device-expired', message: '这台设备的授权已过期，请重新扫码' } })
      return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } })
    }
    if (note) {
      // 记账本身绝不能影响请求结果：它坏了也只是面板少一个确认。
      try { note() } catch { /* 忽略 */ }
    }
    if (onAuthorized) {
      try { onAuthorized(req) } catch { /* 同上 */ }
    }

    // 协议 v2：只有带 `X-Dsh-Proto: 2` 的请求才走信封。老客户端没有这个头，一字不改地照旧。
    let sealed = null
    if (envelope && isProto2(req)) {
      let rawBody
      try {
        rawBody = await envelope.readBody(req)
      } catch {
        return sendJson(res, 413, { ok: false, error: { code: 'e2ee-bad-envelope', message: '请求体过大' } })
      }
      const opened = openRequest(req, { keyFor: envelope.keyFor }, rawBody)
      if (!opened.ok) {
        // 错误响应永远明文（§8.3(11)）：App 要先读懂它才谈得上重发或校准时钟。
        if (opened.extra) sendJson(res, opened.status, { ok: false, error: { code: opened.code, ...opened.extra } })
        else sendJson(res, opened.status, { ok: false, error: { code: opened.code } })
        return
      }
      sealed = opened
      // 业务 handler 拿到的是明文 JSON：域代码一行业务逻辑都不用知道信封存在。
      if (opened.body !== undefined) req.body = opened.body
      // SSE 那条路要逐帧封装（帧没有请求头可用），所以把密钥与这次请求的 AAD 材料
      // 挂在 req 上，由开流那一处取。**只在内存里、只活这一条请求**。
      req.__dshE2ee = { keys: opened.keys, req: opened.req }
    }

    try {
      if (!sealed) {
        await handler(ctx, req, res)
        return
      }
      // 封响应：业务代码照常 `sendJson(res, status, payload)`，这里把**写出去的那一份**包成
      // 信封。劫的是 `res.end` 而不是 `res.json` —— 宿主侧写响应一律走 `sendJson`，
      // 而它内部是 `writeHead` + `end`，没有 `res.json` 这一层。
      const originalEnd = res.end.bind(res)
      const originalWriteHead = res.writeHead.bind(res)
      let chosenStatus = 200
      res.writeHead = (status, ...rest) => {
        chosenStatus = Number(status) || 200
        return originalWriteHead(status, ...rest)
      }
      res.end = (chunk, ...rest) => {
        res.end = originalEnd
        res.writeHead = originalWriteHead
        let payload = chunk
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          if (parsed !== null) {
            const sealedPayload = sealResponse(req, { statusCode: chosenStatus }, sealed.keys, sealed.req, parsed)
            payload = JSON.stringify(sealedPayload)
          }
        }
        return originalEnd(payload, ...rest)
      }
      await handler(ctx, req, res)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
    }
  }
}

module.exports = {
  remoteRelayRequest,
  proxiedRequest,
  VIA_HEADER,
  crossSiteRequest,
  isLoopbackAddress,
  trustedLocalUi,
  localOnly,
  readJson,
  createGuarded,
  // shared/http-util 重出一次：这个文件里的守卫全都用它写响应，
  // 让「路由基建」成为一处完整的地基，而不是散在三个文件里各写一半。
  sendJson,
};
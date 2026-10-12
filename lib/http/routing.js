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
const { sendJson, readJsonBody } = require('../shared/http-util');

// Relay pairing cookies and instance headers are routing credentials only;
// never allow them to reach the local control plane.
const remoteRelayRequest = (req) => Boolean(
  (typeof req.headers['x-dsh-instance'] === 'string' && req.headers['x-dsh-instance'])
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
const createGuarded = (ctx, authorized, note = null) => (handler) => async (req, res) => {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } })
  if (note) {
    // 记账本身绝不能影响请求结果：它坏了也只是面板少一个确认。
    try { note() } catch { /* 忽略 */ }
  }
  try { await handler(ctx, req, res) } catch (error) {
    sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
  }
}

module.exports = {
  remoteRelayRequest,
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
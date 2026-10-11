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
 * @returns {(handler: (ctx: object, req: object, res: object) => Promise<unknown>) => (req: object, res: object) => Promise<unknown>}
 */
const createGuarded = (ctx, authorized) => (handler) => async (req, res) => {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或无效的移动 token' } })
  try { await handler(ctx, req, res) } catch (error) {
    sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
  }
}

module.exports = {
  remoteRelayRequest,
  crossSiteRequest,
  localOnly,
  readJson,
  createGuarded,
  // shared/http-util 重出一次：这个文件里的守卫全都用它写响应，
  // 让「路由基建」成为一处完整的地基，而不是散在三个文件里各写一半。
  sendJson,
};
// 移动端路由守卫（token + 协议 v2 信封）住在「代」里，不进外壳：外壳一旦静态引用信封那几件，
// 信封或移动鉴权改一次就得让用户重启 DSH。外壳只保留故障自检口真正需要的来源判定与响应工具
// （见 lib/http/routing.js）。放在 lib/mobile/ 前缀下，外壳边界守卫会禁止外壳引用它，防止又被搬回去。
'use strict';

const { isProto2, openRequest, sealResponse } = require('../shared/e2ee-request');
const { sendJson } = require('../shared/http-util');

/**
 * 移动端路由守卫：token + 协议 v2 信封 + 把 handler 抛出的异常统一收成 500 信封。
 *
 * 与 localOnly 的不对称是刻意的：移动端请求本来就要从公网进来，跨站不是它的风险；
 * 它的风险是「没带 token 也能读别人的会话」，所以只校验 token。
 *
 * 信封顺序定死：鉴权（token）→ 验签 → 重放 → 解封请求体 → 业务 handler → 封响应。
 * 鉴权在最前，因为「这台设备是谁」决定拿哪把密钥验签；鉴权自身失败回明文 401，
 * App 必须能在解不开信封时读懂它。
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
  // 按设备权限子集做逐路由校验的钩子（见 lib/mobile/permissions.js）。两个函数由装配层注入，
  // 本文件仍然**不含任何具体路由**（测试钉着这一点）：resolve 把 path+method 摘成所需权限位，
  // has 判断这条凭据记录够不够。不给就完全不校验（纯明文测试/老调用方）。
  const permission = extra.permission && typeof extra.permission === 'object' ? extra.permission : null
  const resolvePermission = permission && typeof permission.resolve === 'function' ? permission.resolve : null
  const hasPermission = permission && typeof permission.has === 'function' ? permission.has : null
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
    // 鉴权结果里的凭据记录挂到请求上：流那条路要按设备登记（吊销时主动断流，§3.3），
    // 而设备 id 只在这条记录里。挂在 req 上而不是再查一次库，是因为这一条请求上已经查过了。
    if (outcome && typeof outcome === 'object' && outcome.record) req.__dshRecord = outcome.record
    if (note) {
      // 记账本身绝不能影响请求结果：它坏了也只是面板少一个确认。
      try { note() } catch { /* 忽略 */ }
    }

    // 按设备权限子集校验本条路由（见 lib/mobile/permissions.js）。位置定死在「已鉴权、
    // 已挂 record」之后、「解封」之前：越权能直接回**明文 403**，客户端不必解信封就能读懂；
    // 而 401（没登录/被踢/过期）与 403（登录了但缺这一位）必须是两种处置，不能混。
    // BASE 路由 resolve 回 null、老凭据 / 无记录 has 恒真，都自然放行。
    if (resolvePermission) {
      const need = resolvePermission(req.url || req.originalUrl || '', req.method)
      if (need === 'unknown') {
        // 没分类的路由 fail-closed：宁可这条功能报错，也别给它开一个静默的全权口子。
        return sendJson(res, 403, { ok: false, error: { code: 'permission-unclassified', message: '这条接口没有登记所需权限，暂不放行' } })
      }
      if (need && (!hasPermission || !hasPermission(req.__dshRecord, need))) {
        const granted = req.__dshRecord && Array.isArray(req.__dshRecord.permissions) ? req.__dshRecord.permissions.slice() : null
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'permission-denied', message: '这台手机没有这个操作的权限，请到电脑端的插件里把权限提上来', required: need, granted },
        })
      }
    }

    // **被动降级要被发现，不能悄悄变明文**（§8.3(7) 的 `e2ee-required`）。
    //
    // 判据：这枚凭据的记录里有 `deviceKey`（说明它当初是按协议 v2 配的），而这条请求没带
    // `X-Dsh-Proto` —— 中转把那个头删掉时就是这个形状。不判的话宿主会按老协议解析一个
    // 信封 JSON，得到一个「请求体不是合法 JSON」的 400，看起来像 App 的 bug。
    // 老 App 的凭据里没有 `deviceKey`，不受这一条影响。
    const authRecord = req.__dshRecord
    if (envelope && authRecord && authRecord.deviceKey && !isProto2(req)) {
      return sendJson(res, 400, { ok: false, error: { code: 'e2ee-required', message: '这条会话是加密的，请用信封重发' } })
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

    if (onAuthorized) {
      try { onAuthorized(req) } catch { /* 记账不影响请求 */ }
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
            // **封完直接发，不再 gzip**：`content-encoding` 只能在头出去之前声明，而这个
            // 钩子跑在 `sendJson` 的 `writeHead` 之后，`setHeader` 会被静默忽略 —— 结果
            // 是「线上是 gzip、头却说 identity」，客户端解不开，报「请求失败 (HTTP 200)」。
            // 信封是 base64 密文，外层压缩本来也只省几个百分点；
            // 要省带宽靠载荷裁剪，不靠这一层。
            payload = JSON.stringify(sealedPayload)
          }
        }
        return originalEnd(payload, ...rest)
      }
      await handler(ctx, req, res)
    } catch (error) {
      try {
        const method = String(req.method || 'GET').toUpperCase()
        const path = String(req.url || req.originalUrl || '/').split('?')[0]
        ctx?.logger?.error?.('dsh-mobile-plugin: 移动请求异常 %s %s: %s%s', method, path,
          String(error?.message || error), error?.stack ? `\n${error.stack}` : '')
      } catch { /* 日志失败不影响错误响应 */ }
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message || error) } })
    }
  }
}


module.exports = { createGuarded };

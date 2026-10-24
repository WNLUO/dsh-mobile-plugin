'use strict'

/**
 * 局域网直连端到端验收（需求 3(b)：局域网环境下 APP 通过局域网连接插件端，然后可以直接使用）。
 *
 * 这份测试**启动真实的 lan-proxy HTTP 监听**，用 App 实际发出的请求契约打进去，
 * 覆盖静态路由比对无法证明的三件事：
 *   1. 未认证的请求一律拿 JSON 401，**不给任何网页** —— 浏览器导航也一样，
 *      手机端只有 App 一条路（网页版配对入口 2026-10 已砍掉）；
 *   2. `deny` 策略下「配对码错误」与「码对但被桌面端拒绝」返回完全一样的响应，
 *      配对码不可被逐位探测；
 *   3. 三条 App 侧鉴权路径（Bearer 宿主令牌 / dsh_lan cookie / dshc_ 设备凭据）
 *      都能打通到宿主，且设备凭据被吊销后立即失效。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// 必须在 require credentials.js 之前指向临时文件，否则测试会污染真实凭据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-e2e-'))
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json')

const { createLanProxy } = require('../lib/relay/lan-proxy.js')
const core = require('../lib/relay/core.js')
const e2ee = require('../lib/shared/e2ee.js')
const credentials = require('../dsh-mobile-credentials/lib/credentials.js')

const INSTANCE = 'lane2e01'
const CODE = '135790'
/** 协议 v2 的一次性票据（32 字节 base64url）；局域网配对要用它派生配对密钥。 */
const TICKET = 'Qk3Yb7mZ0pXc1vTn5rLd8sHf2gWj4uAy6ePi9oKt3Nx'
const SECRET = 'lan-e2e-secret-0123456789'
const LAN_PORT = Number(process.env.LAN_E2E_PORT || 18731)

/** 假宿主：记录每个请求看到的 URL 与 Authorization，用于验证代理透传与令牌替换。 */
function startUpstream() {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '' })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        upstream: true,
        path: req.url,
        sawAuthorization: req.headers.authorization || '',
      }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }))
  })
}

function call(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const isProxied = (res) => res.status === 200 && res.body.includes('"upstream":true')
const isHtml = (res) => /text\/html/.test(String(res.headers['content-type'])) || /<html/i.test(res.body)
/** 未认证的请求必须是 JSON 401，绝不能是任何 HTML 页面。 */
const isApiUnauthorized = (res) => {
  if (res.status !== 401) return false
  if (!/application\/json/.test(String(res.headers['content-type']))) return false
  try {
    const body = JSON.parse(res.body)
    return body.ok === false && body.error?.code === 'unauthorized'
  } catch { return false }
}

;(async () => {
  const upstream = await startUpstream()
  const hostToken = core.signLanToken(SECRET, INSTANCE, core.MOBILE_BEARER_TTL_SEC)
  const approvedDevices = []
  // 由测试控制桌面端授权结果：先拒绝（验证不可探测），再批准（验证可用）。
  const policy = { approve: false }

  const proxy = createLanProxy({
    lanPort: LAN_PORT,
    pairingCode: CODE,
    // 协议 v2 的配对票：局域网配对要拿它派生出配对密钥才能解开 App 发来的加密请求。
    // 漏了这一项时的现场见 `configure-diff.test.cjs` 的「契约面」那条。
    pairingTicket: TICKET,
    instanceId: INSTANCE,
    lanSecret: SECRET,
    upstreamPort: upstream.port,
    onApprove: async (device) => {
      approvedDevices.push(device)
      return policy.approve ? { approved: true, token: hostToken } : { approved: false }
    },
  })
  await proxy.start()

  try {
    // 1. 健康检查（局域网探测用，必须无需鉴权）
    const health = await call(LAN_PORT, { path: '/healthz' })
    assert.equal(health.status, 200, 'healthz 应返回 200')
    assert.equal(health.body, 'ok')

    // 2. 未认证的 API 请求 → JSON 401（**不能**是 200 + 任何网页）。
    //
    // 旧实现把 `/api/mobile/v1/*` 也答成 200 + 配对页，App 的 `app/src/api.ts`
    // 会把它当成成功（`response.ok` 为真 → `publishRoute` 把连接通道钉在局域网
    // 并重置局域网熔断），随后 `res.json()` 解析失败抛「请求失败 (HTTP 200)」。
    // 结果是桌面端换过 lanSecret、或设备凭据被吊销之后，App 会永久卡在局域网
    // 通道上：既不回退到中转，也不提示重新配对。
    const anon = await call(LAN_PORT, { path: '/api/mobile/v1/status' })
    assert.ok(isApiUnauthorized(anon), '未认证的 API 请求必须是 JSON 401')
    assert.ok(!isHtml(anon), '未认证的 API 请求不得返回 HTML')
    assert.ok(!isProxied(anon), '未认证不得被代理到宿主')

    // 2b. 浏览器导航（Accept 含 text/html）同样拿 JSON 401：网页版配对页与配对后
    //     能进入的网页本体 2026-10 已整体砍掉，手机端只剩 App 一条路。
    const browse = await call(LAN_PORT, {
      path: '/',
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
    assert.ok(isApiUnauthorized(browse), '浏览器导航也不得拿到网页，只回 JSON 401')
    assert.ok(!isHtml(browse), '浏览器导航不得返回 HTML 配对页')

    // 2c. 不带 Accept 的程序化请求（curl / RN fetch 默认）同理
    const bare = await call(LAN_PORT, { path: '/' })
    assert.ok(isApiUnauthorized(bare), '非 HTML 客户端同样只拿 JSON 401')

    // 3. 配对码位数不符 → 400
    const malformed = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '12' }),
    })
    assert.equal(malformed.status, 400)

    // 4. 错误配对码 → 401
    const wrongCode = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    assert.equal(wrongCode.status, 401)

    // 5. 配对码正确但桌面端拒绝 → 与「配对码错误」完全相同的响应（不可探测）
    const denied = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODE, device: { name: '测试手机', platform: 'ios' } }),
    })
    assert.equal(denied.status, 401, 'deny 策略下正确配对码也应 401')
    assert.equal(denied.body, wrongCode.body, '两种失败必须无法通过响应区分')
    assert.deepEqual(
      Object.keys(denied.headers).filter((k) => k === 'set-cookie'),
      [],
      '被拒绝时不得下发 cookie',
    )

    // 5b. 认得协议（带 `proto`）却还带六位码 → 过期旧图，400 `legacy-pairing-retired`
    //     （与 `/pair` 同一条收口，§10.4(d)）。这一条要在「码对且授权通过」的条件下试，
    //     否则分不清拒的是形状还是码。
    policy.approve = true
    const stale = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODE, proto: 1, device: { name: '测试手机', platform: 'ios' } }),
    })
    assert.equal(stale.status, 400, '过期旧图应当 400')
    assert.equal(JSON.parse(stale.body).code, 'legacy-pairing-retired')
    assert.equal(
      Object.keys(stale.headers).filter((k) => k === 'set-cookie').length, 0,
      '过期旧图不得下发 cookie',
    )

    // 5c. 协议 v2：App 扫到带票据的二维码后发的是密文（`{instanceId, sealed}`）。宿主必须
    //     用**票据派生出来的密钥**解开它，回包也得封成密文 —— 里面是 token / cookie /
    //     设备凭据，明文回等于把通行证白送。这一条同时钉住「旁路的配对配置里必须有票据」：
    //     票据为空时这里必然 401，而主进程那条 `/pair` 照样是好的。
    const pairKey = e2ee.derivePairKey(Buffer.from(TICKET, 'base64url'), INSTANCE)
    const sealedPlain = Buffer.from(JSON.stringify({
      deviceKey: Buffer.alloc(32, 7).toString('base64url'),
      keyId: '0011223344556677',
      device: { name: '加密手机', platform: 'ios' },
    }), 'utf8')
    const sealedBody = e2ee.seal(pairKey, sealedPlain, e2ee.pairAad(INSTANCE))
    const sealedPair = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: INSTANCE, sealed: sealedBody.toString('base64') }),
    })
    assert.equal(sealedPair.status, 200, '带票据的密文配对必须能配上')
    const sealedReply = JSON.parse(sealedPair.body)
    assert.ok(sealedReply.sealed, '回包必须是密文')
    const opened = JSON.parse(
      e2ee.open(pairKey, Buffer.from(sealedReply.sealed, 'base64'), e2ee.pairAad(INSTANCE)).toString('utf8'),
    )
    assert.equal(opened.ok, true)
    assert.equal(opened.proto, 2)
    assert.ok(opened.token && opened.cookie, '解开的回包里要有 token 与 cookie')
    assert.ok(
      String(sealedPair.headers['set-cookie'] && sealedPair.headers['set-cookie'][0] || '').startsWith('dsh_lan='),
      'cookie 头照旧要下发',
    )

    // 6. 授权通过 → 签发 token / cookie / 设备凭据，设备元数据完整送达宿主
    const paired = await call(LAN_PORT, {
      method: 'POST', path: '/__lan_pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: CODE, device: { name: '测试手机', platform: 'ios', osVersion: '17.4' } }),
    })
    assert.equal(paired.status, 200)
    const grant = JSON.parse(paired.body)
    assert.equal(grant.ok, true)
    assert.equal(grant.instanceId, INSTANCE)
    // §3.2 的 T1 口径：token / cookie / deviceCredential 是**同一枚**每设备凭据，
    // 形状 `<实例号>.<到期秒>.<32 字节随机>`。三段只为兼容老 App「缺实例号时从第一段补」，
    // 服务端按整串哈希查库，不解析它。
    assert.equal(grant.token, grant.deviceCredential, 'token 与 deviceCredential 必须是同一枚')
    assert.equal(grant.cookie, `dsh_lan=${grant.deviceCredential}`, 'cookie 也是同一枚')
    assert.equal(grant.token.split('.')[0], INSTANCE, '第一段是实例号（老 App 靠它补路由键）')
    assert.equal(grant.token.split('.').length, 3, '保留三段形状')
    assert.ok(grant.credentialExpiresAt > Date.now(), '到期时间来自记录')
    assert.ok(grant.deviceId, '应返回 deviceId')
    assert.equal(approvedDevices[0]?.name, '测试手机', '设备元数据应送达宿主授权回调')
    assert.equal(approvedDevices[0]?.platform, 'ios')

    // 7. App 主路径：Bearer 宿主令牌 + cookie（authHeaders 同时带两者，与中转态一致）
    const appHeaders = {
      authorization: `Bearer ${grant.token}`,
      cookie: grant.cookie,
      'x-dsh-instance': INSTANCE,
      'x-dsh-device': grant.deviceId,
      'x-dsh-device-credential': grant.deviceCredential,
    }
    const viaApp = await call(LAN_PORT, { path: '/api/mobile/v1/status', headers: appHeaders })
    assert.ok(isProxied(viaApp), 'App 契约应打通到宿主')
    assert.equal(JSON.parse(viaApp.body).path, '/api/mobile/v1/status')

    // 8. 只有 cookie（RN 可能丢弃 Authorization）也必须可用
    const viaCookie = await call(LAN_PORT, {
      path: '/api/mobile/v1/sessions', headers: { cookie: grant.cookie },
    })
    assert.ok(isProxied(viaCookie), 'cookie 单独应可用')

    // 9. 只有 Bearer 宿主令牌（RN 可能丢弃手动 Cookie 头）也必须可用
    const viaBearer = await call(LAN_PORT, {
      path: '/api/mobile/v1/connection-info', headers: { authorization: `Bearer ${grant.token}` },
    })
    assert.ok(isProxied(viaBearer), 'Bearer 单独应可用')

    // 10. 只带设备凭据头（App 在部分平台会丢弃 Authorization）：宿主看到的必须
    //     是被替换后的宿主令牌，而不是 dshc_ 本身。
    const viaCredential = await call(LAN_PORT, {
      path: '/api/mobile/v1/status', headers: { 'x-dsh-device-credential': grant.deviceCredential },
    })
    assert.ok(isProxied(viaCredential), '设备凭据头单独应可用')
    // 新 T1 记录不存 hostToken（§3.2）：上游看到的就是请求里出示的那一枚。
    // 宿主自己认它（同一份凭据库），所以「只带凭据头」这条路照样通。
    assert.equal(
      JSON.parse(viaCredential.body).sawAuthorization,
      `Bearer ${grant.deviceCredential}`,
      '出示的凭据原样转发给上游',
    )

    // 11. 吊销设备凭据后立即失效，且不回落成任何其它身份。
    //     这里必须用**真实 App 的请求形状**：Bearer 仍是有效期一年的宿主令牌，
    //     dshc_ 走独立请求头。旧实现只在 Authorization 里找 dshc_，这种形状下
    //     吊销完全不生效；而把 dshc_ 塞进 Bearer 的写法恰好迁就了缺陷实现，
    //     会让它逃过测试。
    assert.ok(credentials.revoke(grant.deviceCredential, INSTANCE), '吊销应成功')
    const afterRevoke = await call(LAN_PORT, {
      path: '/api/mobile/v1/status',
      headers: {
        authorization: `Bearer ${grant.token}`,
        'x-dsh-device-credential': grant.deviceCredential,
      },
    })
    assert.ok(!isProxied(afterRevoke), '已吊销的设备凭据不得再被代理')
    // 回的原因要能认出来（§3.8）：只回一句「未授权」的话，被踢的手机看到的还是
    // 「请求失败」，用户既不知道是被解绑、也不知道该重新扫码。
    assert.equal(afterRevoke.status, 401, '已吊销必须是 401，而不是配对页')
    assert.equal(JSON.parse(afterRevoke.body).error?.code, 'device-revoked', '要回可识别的原因')

    // 12. 本机**不认识**的设备凭据必须回退到宿主令牌，而不是一律拒绝：公网配对
    //     时 dshc_ 由中转签发、存在中转的凭据库里，宿主这里查不到。若一律拒绝，
    //     「公网配对后回到局域网直连」会直接 401 —— 那正是本功能的主要用法。
    // 这里必须用**升级前的旧会话形状**：一枚 lanSecret 签的无状态 HMAC token（老 App
    // 手上就这个）加一枚本机没见过的凭据头。用新配对的 token 不行 —— 它本身就是刚被
    // 吊销的那一枚，被拒才是对的。
    const legacyToken = core.signLanToken(SECRET, INSTANCE, core.MOBILE_BEARER_TTL_SEC)
    const foreignCredential = `dshc_${Buffer.from('relay-issued-credential').toString('base64url')}`
    const viaForeign = await call(LAN_PORT, {
      path: '/api/mobile/v1/status',
      headers: { authorization: `Bearer ${legacyToken}`, 'x-dsh-device-credential': foreignCredential },
    })
    assert.ok(isProxied(viaForeign), '本机没见过的凭据不得阻断旧会话的局域网直连')

    // 13. cookie 里装的就是同一枚凭据（§3.2），所以吊销之后它同样不能用 ——
    //     这正是「一枚凭据当三样用」的必然结果：没有第二条绕过吊销的路。
    const cookieAfterRevoke = await call(LAN_PORT, {
      path: '/api/mobile/v1/status', headers: { cookie: grant.cookie },
    })
    assert.ok(!isProxied(cookieAfterRevoke), '吊销后 cookie 那条路也必须失效')
    assert.equal(JSON.parse(cookieAfterRevoke.body).error?.code, 'device-revoked')

    // 14. 网页版配对入口的登出路由已随配对页一起删除：它现在只是一条未知路径，
    //     未认证时与其它路径一样回 JSON 401，不再有任何清 cookie 的行为。
    const logout = await call(LAN_PORT, { path: '/__lan_logout' })
    assert.equal(logout.status, 401, '登出路由已删，应按未认证处理')
    assert.equal(logout.headers['set-cookie'], undefined, '不得再下发清 cookie 的响应头')

    console.log('lan direct e2e tests passed')
  } finally {
    proxy.stop()
    await new Promise((resolve) => upstream.server.close(resolve))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })

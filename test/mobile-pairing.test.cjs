'use strict'

/**
 * 配对路由（`POST /api/mobile/v1/pair`）的行为。
 *
 * 这条路由归宿主：手机在中转上用自己的配对码换 token 与设备凭据。旧实现把它长在独立
 * 的中转进程里，换成 Rust 中转时整块漏了搬，于是手机上点「配对并添加」收到宿主的 405。
 *
 * 钉住四件事：对的码能换到凭据、错的码被拒、连错会被锁、限流锁过之后对的码照样能过。
 *
 * 运行：node --test test/mobile-pairing.test.cjs
 */

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')

const { createPairHandler, resetPairLocks, PAIR_MAX_FAILS } = require(path.join(__dirname, '..', 'lib', 'mobile', 'pairing.js'))
const core = require(path.join(__dirname, '..', 'lib', 'relay', 'core.js'))
const pairingApproval = require(path.join(__dirname, '..', 'lib', 'relay', 'pairing-policy.js'))

const INSTANCE = 'testpair1'
const CODE = '123456'
const SECRET = 'x'.repeat(64)

/** 最小 res 假体：记下状态码与 JSON 体。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    headers: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers || {}) },
    setHeader(k, v) { this.headers[k] = v },
    end(raw) {
      if (raw && this.status === 0) this.status = 200
      try { this.body = JSON.parse(raw) } catch { this.body = raw }
    },
  }
}

/** 带请求体的 req 假体。 */
function fakeReq(payload, ip = '10.0.0.1') {
  const req = new EventEmitter()
  req.headers = { 'x-real-ip': ip }
  req.socket = { remoteAddress: ip }
  req.setEncoding = () => {}
  process.nextTick(() => {
    if (payload !== undefined) req.emit('data', JSON.stringify(payload))
    req.emit('end')
  })
  return req
}

function makeHandler({ policy = 'code' } = {}) {
  const issued = []
  const state = { instanceId: INSTANCE, pairingCode: CODE, lanSecret: SECRET, pairingPolicy: policy }
  const credentials = {
    issue(instanceId, device, token) {
      issued.push({ instanceId, device })
      return { deviceId: device.deviceId || 'dev-1', credential: 'dshc_test', expiresAt: 1 }
    },
  }
  const handler = createPairHandler({ state, core, credentials, pairingApproval, log: (...a) => issues.push(a) })
  return { handler, issued }
}

const issues = []

test('配对码正确时签发 token 与设备凭据', async () => {
  resetPairLocks()
  const { handler, issued } = makeHandler()
  const res = fakeRes()
  await handler(fakeReq({ code: CODE, device: { deviceId: 'dev-1', name: 'iPhone', platform: 'ios' } }), res)

  assert.equal(res.status, 200, `应当 200，实际 ${res.status}`)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.instanceId, INSTANCE)
  // 只有 cookie 不够：App 拿 token 当 `Authorization: Bearer`，空串会让它卡在
  // 「配对响应缺少 token/cookie」这一步（真机上就是这么撞出来的）。
  assert.match(res.body.token, /^\S+$/, 'token 必须是非空串，App 用它做 Bearer')
  assert.notEqual(res.body.token, res.body.cookie, 'token 与 cookie 是两样东西，各自签')
  assert.match(res.body.cookie, /^dsh_lan=.+/, 'cookie 要按宿主签名发出来')
  assert.equal(res.body.deviceCredential, 'dshc_test')
  // 键名必须恰好是 `hostPlatform`：App 落盘的就是它（见 app/src/services/pairApi.ts），
  // 局域网那条（lan-proxy.js）给的也是它。写成 `platform` 时 App 收不到，设备行退回
  // 通用图标——真机上那台 Linux 少的就是企鹅。
  assert.equal(res.body.hostPlatform, process.platform, '宿主系统标识要带给手机，设备行不用等轮询')
  assert.equal(res.body.platform, undefined, '别再顺手多给一个 platform，App 不认它')
  assert.equal(res.body.deviceId, 'dev-1')
  assert.equal(issued.length, 1, '凭据库应当被调用一次')
  assert.equal(issued[0].instanceId, INSTANCE)
})

test('配对码错误被拒，且不签发凭据', async () => {
  resetPairLocks()
  const { handler, issued } = makeHandler()
  const res = fakeRes()
  await handler(fakeReq({ code: '000000', device: { deviceId: 'dev-1' } }), res)

  assert.equal(res.status, 401)
  assert.equal(res.body.ok, false)
  assert.equal(issued.length, 0, '错的码绝不能签发凭据')
})

test('配对码不是 6 位数字时回 400', async () => {
  resetPairLocks()
  const { handler } = makeHandler()
  for (const code of ['', 'abc', '12345', '1234567']) {
    const res = fakeRes()
    await handler(fakeReq({ code }), res)
    assert.equal(res.status, 400, `配对码 ${JSON.stringify(code)} 应当是 400`)
    assert.equal(res.body.ok, false)
  }
})

test('连错达到上限之后暂时锁住，且锁住期间对的码也进不来', async () => {
  resetPairLocks()
  const { handler } = makeHandler()
  for (let i = 0; i < PAIR_MAX_FAILS; i += 1) {
    const res = fakeRes()
    await handler(fakeReq({ code: '000000' }), res)
    assert.equal(res.status, 401, `第 ${i + 1} 次错码应当 401`)
  }
  const locked = fakeRes()
  await handler(fakeReq({ code: CODE }), locked)
  assert.equal(locked.status, 429, '锁住之后哪怕码对也得挡回去')
})

test('配对策略是 deny 时一律拒绝', async () => {
  resetPairLocks()
  const { handler, issued } = makeHandler({ policy: 'deny' })
  const res = fakeRes()
  await handler(fakeReq({ code: CODE, device: { deviceId: 'dev-1' } }), res)

  assert.equal(res.status, 401, 'deny 模式下对的码也不能进')
  assert.equal(issued.length, 0)
})

test('配对码错误与策略拒绝回同一个响应，码的真假不可探测', async () => {
  resetPairLocks()
  const wrong = fakeRes()
  await makeHandler().handler(fakeReq({ code: '000000' }), wrong)

  resetPairLocks()
  const denied = fakeRes()
  await makeHandler({ policy: 'deny' }).handler(fakeReq({ code: CODE }), denied)

  assert.equal(wrong.status, denied.status, '两种失败的状态码必须一致')
  assert.deepEqual(wrong.body, denied.body, '两种失败的响应体必须一致')
})

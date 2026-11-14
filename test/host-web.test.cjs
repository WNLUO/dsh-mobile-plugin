'use strict'
/**
 * 网页版入口同时声明电脑插件导航能力，端口和令牌缺失时仍如实回不可用。
 *
 * 这条端点的两个值都来自宿主里别的服务，形状不受插件控制：连接服务可能没装（无头部署）、
 * 可能在宿主升级后换了字段、`ctx.get` 本身也可能抛。所以这里全部按**取不到**的形状造一遍
 * 假 ctx——要求它如实回 `available: false`，而不是把一次能力探测变成 500。
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

const { handleHostWeb } = require('../lib/mobile/host-web.js')

/** 假 ServerResponse：只记最后一次 writeHead + end（与 mobile-route-dispatch.test.cjs 同一形状）。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(raw) { this.body = JSON.parse(String(raw)) },
  }
}

/** 一个带 web 端口的宿主上下文；`get` 由用例自己给。 */
function fakeCtx({ port = 3080, get } = {}) {
  return {
    webServer: port === null ? undefined : { port },
    ...(get ? { get } : {}),
  }
}

/** 调一次 handler，收回它写出的响应。 */
async function call(ctx) {
  const res = fakeRes()
  await handleHostWeb(ctx, { headers: {}, method: 'GET' }, res)
  return res
}

test('端口与令牌都在时回可用，两个值原样给出', async () => {
  const res = await call(fakeCtx({
    port: 51291,
    get: (name) => (name === 'connection' ? { browserAuth: { launchToken: 'launch-token-abc' } } : null),
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, available: true, port: 51291, token: 'launch-token-abc', pluginPages: true })
})

test('拿不到端口时回 no-port', async () => {
  for (const ctx of [
    fakeCtx({ port: null, get: () => ({ browserAuth: { launchToken: 't' } }) }),
    fakeCtx({ port: 0, get: () => ({ browserAuth: { launchToken: 't' } }) }),
    fakeCtx({ port: 70000, get: () => ({ browserAuth: { launchToken: 't' } }) }),
  ]) {
    const res = await call(ctx)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, available: false, reason: 'no-port' })
  }
})

test('令牌取不到的各种形状都回 no-launch-token，且不抛', async () => {
  const shapes = [
    // 连接服务根本没装：无头部署 / 宿主版本没有它。
    { get: () => null },
    { get: () => undefined },
    // 服务在，但这一版宿主没有 browserAuth。
    { get: () => ({ browserPeer: {} }) },
    // browserAuth 在，但没有 launchToken。
    { get: () => ({ browserAuth: {} }) },
    // launchToken 不是非空字符串。
    { get: () => ({ browserAuth: { launchToken: '' } }) },
    { get: () => ({ browserAuth: { launchToken: 42 } }) },
    { get: () => ({ browserAuth: { launchToken: null } }) },
    // `ctx.get` 自己抛（服务解析失败）。
    { get: () => { throw new Error('service unavailable') } },
    // 连 `get` 都没有。
    {},
  ]
  for (const shape of shapes) {
    const res = await call(fakeCtx({ get: shape.get }))
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, available: false, reason: 'no-launch-token' },
      `形状 ${JSON.stringify(Object.keys(shape))} 没回 no-launch-token`)
  }
})

test('上下文本身残缺也不抛（一律当不可用）', async () => {
  for (const ctx of [null, undefined, {}]) {
    const res = await call(ctx)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.available, false)
  }
})

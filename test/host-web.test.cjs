'use strict'
/**
 * 网页版入口声明电脑插件导航能力，端口和令牌缺失时仍如实回不可用。
 *
 * 这条端点的两个值都来自宿主里别的服务，形状不受插件控制：连接服务可能没装（无头部署）、
 * 可能在宿主升级后换了字段、`ctx.get` 本身也可能抛。所以这里全部按**取不到**的形状造一遍
 * 假 ctx——要求它如实回 `available: false`，而不是把一次能力探测变成 500。
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

const { handleHostWeb, launchTokenOf } = require('../lib/mobile/host-web.js')

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

/**
 * 新宿主：认证拆到独立包，`connection` 里没有 `browserAuth`，令牌由 entry-url 事件同步交回。
 * `emit` 按 Cordis 的调用序收 (thisArg, 事件名, baseUrl, entries)，就地往 entries 填入口。
 */
function newHostCtx({ port = 3080, entries = [], emit } = {}) {
  return {
    webServer: { port },
    get: (name) => (name === 'connection' ? { browserPeer: {} } : null),
    emit(thisArg, name, baseUrl, collected) {
      assert.ok(thisArg, '第一个对象参数应当作为 thisArg 传给事件')
      assert.equal(name, 'webserver/entry-url')
      assert.equal(baseUrl, `http://127.0.0.1:${port}`, 'baseUrl 用已知端口自拼，不依赖 getOrigin')
      for (const entry of entries) collected.push(entry)
    },
    ...(emit ? { emit } : {}),
  }
}

test('老宿主仍走 browserAuth，取到就不触发 entry-url', () => {
  let emitted = 0
  const ctx = newHostCtx({ entries: [{ url: 'http://127.0.0.1:3080/?token=wrong' }] })
  ctx.get = (name) => (name === 'connection' ? { browserAuth: { launchToken: 'legacy-token' } } : null)
  ctx.emit = () => { emitted += 1 }
  assert.equal(launchTokenOf(ctx), 'legacy-token')
  assert.equal(emitted, 0, '老路径命中就不该去 emit')
})

test('新宿主没有 browserAuth 时，从 entry-url 同步收回令牌', async () => {
  const ctx = newHostCtx({
    port: 51291,
    entries: [{ url: 'http://127.0.0.1:51291/?token=new-host-token' }],
  })
  assert.equal(launchTokenOf(ctx), 'new-host-token')
  const res = await call(ctx)
  assert.deepEqual(res.body, {
    ok: true, available: true, port: 51291, token: 'new-host-token', pluginPages: true,
  })
})

test('同事件的别的服务入口不串 token，只认环回且端口匹配的入口', () => {
  const ctx = newHostCtx({ port: 3080, entries: [
    { url: 'https://other.example.com/?token=secret-of-other' },
    { url: 'http://example.com:3080/?token=secret-of-same-port' },
    { url: 'http://127.0.0.1:9999/?token=secret-of-other-port' },
    { url: 'http://localhost:3080/?token=mine' },
  ] })
  assert.equal(launchTokenOf(ctx), 'mine')

  const onlyForeign = newHostCtx({ port: 3080, entries: [
    { url: 'http://127.0.0.1:9999/?token=foreign' },
    { url: 'https://localhost:3080/?token=https-not-web' },
  ] })
  assert.equal(launchTokenOf(onlyForeign), null, '没有匹配的入口就回 null，不吃别人家的 token')
})

test('entry-url 兜底取不到的各种形状都回 null，不抛', async () => {
  const cases = [
    newHostCtx(),
    newHostCtx({ entries: [{ url: 'not a url' }] }),
    newHostCtx({ entries: [{ url: 'http://127.0.0.1:3080/' }] }),
    newHostCtx({ entries: [{ url: 'http://127.0.0.1:3080/?token=' }] }),
  ]
  for (const ctx of cases) assert.equal(launchTokenOf(ctx), null)
  assert.equal(launchTokenOf({ webServer: { port: 3080 }, get: () => null }), null, '没有 emit 也回 null')
  const res = await call(newHostCtx({ entries: [{ url: 'http://127.0.0.1:3080/' }] }))
  assert.deepEqual(res.body, { ok: true, available: false, reason: 'no-launch-token' })
})

test('emit 抛异常时回 null，不把能力探测变成 500', async () => {
  const ctx = newHostCtx({ port: 3080, emit: () => { throw new Error('listener exploded') } })
  assert.equal(launchTokenOf(ctx), null)
  const res = await call(ctx)
  assert.deepEqual(res.body, { ok: true, available: false, reason: 'no-launch-token' })
})

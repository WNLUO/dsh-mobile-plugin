// 中转健康响应有界，延迟与失败账只跟单调经过时间，墙钟跳变不改变有效期。
'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { probeRelayHealth, createRelayRegistrationLedger, relayFailureMessage } = require('../lib/relay/relay-probe.js')

const HEALTH = { ok: true, service: 'dsh-mobile-relay' }

async function startHealthServer(t, handler) {
  const sockets = new Set()
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    handler(req, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${server.address().port}`, requests }
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

test('健康探测：完整 2xx 中转身份响应才返回首字节延迟，保留部署前缀', async (t) => {
  const relay = await startHealthServer(t, (_req, res) => sendJson(res, 200, HEALTH))
  const latency = await probeRelayHealth(`${relay.url}/relay/`)
  assert.equal(typeof latency, 'number')
  assert.ok(Number.isFinite(latency) && latency >= 0)
  assert.deepEqual(relay.requests, ['/relay/api/mobile/v1/health'])
})

test('健康探测：非 2xx、门户页、非法 JSON 和错误身份都不可达', async (t) => {
  const cases = [
    [403, HEALTH],
    [503, HEALTH],
    [200, { ok: false, service: 'dsh-mobile-relay' }],
    [200, { ok: 'true', service: 'dsh-mobile-relay' }],
    [200, { ok: true, service: 'dsh-mobile-plugin' }],
    [200, { ok: true }],
    [200, null],
    [200, []],
  ]
  for (const [status, body] of cases) {
    await t.test(`${status} ${JSON.stringify(body)}`, async (t) => {
      const relay = await startHealthServer(t, (_req, res) => sendJson(res, status, body))
      assert.equal(await probeRelayHealth(relay.url), null)
    })
  }
  for (const body of ['<html>请登录网络</html>', 'ok', '{"ok":true,']) {
    await t.test(body, async (t) => {
      const relay = await startHealthServer(t, (_req, res) => { res.writeHead(200); res.end(body) })
      assert.equal(await probeRelayHealth(relay.url), null)
    })
  }
})

test('健康探测：重定向即失败，不追到另一个健康页面', async (t) => {
  const relay = await startHealthServer(t, (req, res) => {
    sendJson(res, req.url === '/accepted' ? 200 : 302, HEALTH, { location: '/accepted' })
  })
  assert.equal(await probeRelayHealth(relay.url), null)
  assert.deepEqual(relay.requests, ['/api/mobile/v1/health'])
})

test('健康探测：响应头早到也必须等完整响应体，延迟仍取首字节', { timeout: 2000 }, async (t) => {
  let finishBody
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"ok":true,')
    finishBody = () => res.end('"service":"dsh-mobile-relay"}')
  })
  const started = Date.now()
  let settled = false
  const pending = probeRelayHealth(relay.url, { timeoutMs: 1500 }).then((value) => { settled = true; return value })
  while (!finishBody) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(settled, false, '没有完整身份响应不能提前接受')
  finishBody()
  const latency = await pending
  assert.equal(typeof latency, 'number')
  assert.ok(Date.now() - started - latency >= 50, '读取响应体的等待不混入首字节延迟')
})

test('健康探测：恰好达到响应体上限仍可通过', async (t) => {
  const body = { ...HEALTH, padding: '' }
  body.padding = 'x'.repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(body)))
  const relay = await startHealthServer(t, (_req, res) => sendJson(res, 200, body))
  assert.equal(typeof await probeRelayHealth(relay.url), 'number')
})

test('健康探测：大 content-length 在收正文前拒绝', { timeout: 1000 }, async (t) => {
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-length': 16 * 1024 + 1 })
    res.flushHeaders()
  })
  assert.equal(await probeRelayHealth(relay.url, { timeoutMs: 5000 }), null)
})

test('健康探测：无长度分块按字节限读，超限立即终止', { timeout: 1000 }, async (t) => {
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(JSON.stringify({ ...HEALTH, padding: '中'.repeat(6000) }))
  })
  assert.equal(await probeRelayHealth(relay.url, { timeoutMs: 5000 }), null)
})

test('健康探测：连接后一直不回响应头也受总超时限制', { timeout: 1000 }, async (t) => {
  const relay = await startHealthServer(t, () => {})
  assert.equal(await probeRelayHealth(relay.url, { timeoutMs: 60 }), null)
})

test('健康探测：响应体持续滴流不能续期总超时', { timeout: 1000 }, async (t) => {
  let interval
  t.after(() => clearInterval(interval))
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{')
    interval = setInterval(() => res.write(' '), 10)
    res.on('close', () => clearInterval(interval))
  })
  assert.equal(await probeRelayHealth(relay.url, { timeoutMs: 80 }), null)
})

test('健康探测：已收到完整 JSON 但 HTTP 响应未结束仍须超时', { timeout: 1000 }, async (t) => {
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(JSON.stringify(HEALTH))
  })
  assert.equal(await probeRelayHealth(relay.url, { timeoutMs: 60 }), null)
})

test('健康探测：截断响应和连接错误都返回 null', { timeout: 1000 }, async (t) => {
  const relay = await startHealthServer(t, (_req, res) => {
    res.writeHead(200, { 'content-length': 100 })
    res.write('{"ok":true,')
    res.destroy()
  })
  assert.equal(await probeRelayHealth(relay.url), null)
  assert.equal(await probeRelayHealth('http://127.0.0.1:0'), null)
})

test('健康探测：非法地址与不支持的协议不发请求', async () => {
  for (const url of ['not a url', 'file:///tmp/relay', 'ws://relay.example']) {
    assert.equal(await probeRelayHealth(url), null)
  }
})

test('注册失败账：健康重采不能清账，真实成功才立即清账，时间衰减后仍重试', () => {
  let now = 1000
  const ledger = createRelayRegistrationLedger({ now: () => now })
  const urls = ['https://a', 'https://b']
  const health = new Map([['https://a', 1], ['https://b', 300]])
  assert.deepEqual(ledger.order(urls, health), urls)
  ledger.noteFailure('https://a')
  for (let i = 0; i < 5; i++) {
    health.set('https://a', i + 1)
    assert.deepEqual(ledger.order(urls, health), ['https://b', 'https://a'])
  }
  ledger.noteSuccess('https://a')
  assert.deepEqual(ledger.order(urls, health), urls)
  for (let i = 0; i < 20; i++) ledger.noteFailure('https://a')
  now += 4 * 300000
  assert.deepEqual(ledger.order(urls, health), urls, '失败惩罚有上限且随时间消退')
})

test('注册失败账：未知地址也有失败成本，全未知时保持原序或轮换失败项，不丢候选', () => {
  const ledger = createRelayRegistrationLedger()
  const urls = ['https://a', 'https://b', 'https://c']
  assert.deepEqual(ledger.order(urls, new Map()), urls)
  ledger.noteFailure(urls[0])
  assert.deepEqual(ledger.order(urls, new Map()), ['https://b', 'https://c', 'https://a'])
  assert.deepEqual(urls, ['https://a', 'https://b', 'https://c'])
})

test('注册失败账：惩罚封顶后也轮换最近失败项，池中地址不会永久饿死', () => {
  let now = 1000
  const ledger = createRelayRegistrationLedger({ now: () => now })
  const urls = ['https://a', 'https://b', 'https://c', 'https://d']
  for (let i = 0; i < 4; i++) for (const url of urls) ledger.noteFailure(url)
  now += 1000
  for (const url of urls.slice(0, 3)) ledger.noteFailure(url)
  assert.equal(ledger.order(urls, new Map())[0], 'https://d')
  now += 30000
  assert.equal(ledger.order(urls, new Map()).length, urls.length, '冷却从不剔除地址')
})

test('健康 RTT 使用单调经过时间，墙钟回拨或前跳都不产生负延迟或巨值', async (t) => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const { createRequire } = require('node:module')
  const file = require.resolve('../lib/relay/relay-probe.js')
  const requireReal = createRequire(file)
  for (const jump of [-3600000, 3600000]) {
    let elapsed = 100
    let wall = 1000000
    const relay = await startHealthServer(t, (_req, res) => {
      elapsed += 40; wall += jump
      sendJson(res, 200, HEALTH)
    })
    const loaded = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module: loaded, exports: loaded.exports, Buffer, process, URL, setTimeout, clearTimeout,
      Date: { now: () => wall },
      require: name => name === 'node:perf_hooks' ? { performance: { now: () => elapsed } } : requireReal(name),
    })
    assert.equal(await loaded.exports.probeRelayHealth(relay.url), 40)
  }
})

test('默认注册失败账使用单调时钟：回拨不饿死封顶后备，前跳不提前冷却或衰减', () => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const { createRequire } = require('node:module')
  const file = require.resolve('../lib/relay/relay-probe.js')
  const requireReal = createRequire(file)
  const loaded = { exports: {} }
  let elapsed = 1000
  let wall = 1000000
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: loaded, exports: loaded.exports, Buffer, process, URL, setTimeout, clearTimeout,
    Date: { now: () => wall },
    require: name => name === 'node:perf_hooks' ? { performance: { now: () => elapsed } } : requireReal(name),
  })
  const ledger = loaded.exports.createRelayRegistrationLedger()
  const urls = ['https://a', 'https://b', 'https://c', 'https://d', 'https://e']
  const allUnknown = {}
  const ordered = () => Array.from(ledger.order(urls, allUnknown))
  for (let i = 0; i < 4; i++) for (const url of urls) ledger.noteFailure(url)
  elapsed += 1000
  wall -= 3600000
  urls.slice(0, 3).forEach(url => ledger.noteFailure(url))
  assert.equal(ordered()[0], 'https://d', '回拨后新失败不能排到未来旧失败之前饿死后备')
  ledger.noteFailure('https://d')
  assert.equal(ordered()[0], 'https://e', '四条以上封顶候选也持续轮换')
  wall += 7200000
  assert.equal(ordered()[0], 'https://e', '前跳不能让未到时的失败账提前消失')
  elapsed += 4 * 300000
  assert.deepEqual(ordered(), urls, '真实五分钟一级衰减，封顶四级后按经过时间归零')

  const cooling = loaded.exports.createRelayRegistrationLedger()
  cooling.noteFailure('https://a')
  elapsed += 1000
  cooling.noteFailure('https://b')
  const pair = ['https://a', 'https://b']
  const health = { 'https://a': 100, 'https://b': 1 }
  assert.equal(cooling.order(pair, health)[0], 'https://a', '短冷却都在时先试最旧失败')
  wall -= 86400000
  elapsed += 31000
  assert.equal(cooling.order(pair, health)[0], 'https://b', '真实三十秒后退出短冷却，回拨不延长')
  cooling.noteSuccess('https://b')
  cooling.noteSuccess('https://a')
  cooling.noteFailure('https://a')
  wall += 172800000
  assert.equal(cooling.order(pair, health)[0], 'https://b', '墙钟前跳不提前抹掉惩罚')
  elapsed += 300001
  assert.equal(cooling.order(pair, { 'https://a': 1, 'https://b': 100 })[0], 'https://a', '真实五分钟后单级惩罚消退')
})

test('代理失败提示：真实配置只暴露变量名，不泄露地址或密码；无证据不推断代理故障', () => {
  const message = relayFailureMessage(new Error('连接超时'), { HTTPS_PROXY: 'http://user:secret@proxy.internal:8080' })
  assert.match(message, /HTTPS_PROXY/)
  assert.match(message, /只支持直连出网/)
  assert.doesNotMatch(message, /user|secret|proxy\.internal|8080/)
  assert.equal(relayFailureMessage(new Error('连接超时'), {}), '连接超时')
  assert.match(relayFailureMessage('Unexpected server response: 407', {}), /代理认证或连接错误/)
  assert.equal(relayFailureMessage(message, { HTTP_PROXY: 'http://another' }), message, '已有提示不重复追加')
})

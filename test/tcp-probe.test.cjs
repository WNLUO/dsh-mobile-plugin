// 2026-11-25：回环 health 守卫：403 页面与异 service 都不算本插件。
// TCP 直连检测读的是 HTTP 响应正文：chunked 与 content-length 两种分帧都要认，非 JSON 一律当没通。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const test = require('node:test')
const { probeTcpHealth } = require('../lib/routes/control-plane.js')
const { loopbackVerdictOf } = require('../lib/relay/connection-check.js')

const HEALTH = { ok: true, service: 'dsh-mobile-plugin', instanceId: 'abc123', apiVersion: '1' }

/** 起一台只听 127.0.0.1 的 HTTP 服务（端口系统分配），返回端口与等它收干净。 */
async function startServer(t, handler) {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return server.address().port
}

test('TCP 检测：插件那种 chunked 响应也能解出 JSON（少了分帧就是永远不通）', async (t) => {
  const port = await startServer(t, (_req, res) => {
    // 不写 content-length，node 自己按 chunked 发 —— 与插件答 /api/mobile/v1/health 时一致。
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.write(JSON.stringify(HEALTH).slice(0, 10))
    res.end(JSON.stringify(HEALTH).slice(10))
  })
  assert.deepEqual(await probeTcpHealth('127.0.0.1', port, 2000), HEALTH)
})

test('TCP 检测：带 content-length 的响应照旧能解', async (t) => {
  const port = await startServer(t, (_req, res) => {
    const text = JSON.stringify(HEALTH)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  })
  assert.deepEqual(await probeTcpHealth('127.0.0.1', port, 2000), HEALTH)
})

test('TCP 检测：回的是一张网页就不是我们的健康接口', async (t) => {
  const port = await startServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>请登录网络</html>')
  })
  assert.equal(await probeTcpHealth('127.0.0.1', port, 2000), null)
})

test('TCP 检测：端口没人听就是 null，不抛错', async () => {
  // 先占一个端口再放掉：拿一个确定没人听的号，避免撞上真在跑的服务。
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await probeTcpHealth('127.0.0.1', port, 1000), null)
})

test('回环 health：代理回 403 页面时裸 TCP 通也得报被抢', async (t) => {
  // 这正是本机代理客户端抢占 127.0.0.1:<port> 的现场：端口有人听，但不是插件在答。
  const port = await startServer(t, (_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('403 Request not allowed')
  })
  const body = await probeTcpHealth('127.0.0.1', port, 2000)
  assert.equal(body, null, '403 不是 health JSON')
  assert.equal(loopbackVerdictOf(body).state, 'blocked')
})

test('回环 health：异 service 报被抢，插件形状才算通', async (t) => {
  const wrongPort = await startServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'dsh-mobile-relay' }))
  })
  const rightPort = await startServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(HEALTH))
  })
  assert.equal(loopbackVerdictOf(await probeTcpHealth('127.0.0.1', wrongPort, 2000)).state, 'blocked')
  assert.deepEqual(loopbackVerdictOf(await probeTcpHealth('127.0.0.1', rightPort, 2000)), { state: 'ok', reason: '' })
})

test('接线：自检用 control-plane 的裸 TCP 探针打回环 health', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js'), 'utf8')
  assert.match(source, /probeLoopback: \(port\) => probeTcpHealth\('127\.0\.0\.1', port, LOOPBACK_PROBE_TIMEOUT_MS\)/)
  assert.match(source, /LOOPBACK_PROBE_TIMEOUT_MS = 1500/, '本机回环 1~2 秒超时')
})

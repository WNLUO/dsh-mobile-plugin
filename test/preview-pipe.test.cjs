'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { test } = require('node:test')

const WebSocket = require('ws')
const { createPreviewService } = require('../lib/relay/preview.js')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'preview.js'), 'utf8')

/** 借一个空闲端口再还回去：不要用 `port + 1` 猜，macOS 临时端口段里可能正被别人占着。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** 本机是否真的能听 `::1`（IPv6 被关掉的机器上这条用例没有意义，跳过而不是失败）。 */
async function hasIpv6Loopback() {
  const probe = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '::1', resolve)
    })
    return true
  } catch {
    return false
  } finally {
    try { probe.close() } catch { /* 没监听成 */ }
  }
}

/**
 * 把预览服务挂到一个 HTTP 监听上，形状与宿主一致：`ctx.webServer` 是**先**给升级
 * socket 挂了 error 兜底，再把 `(req, socket, head)` 交给路由处理器的。手机拿到
 * 401/403 之后会立刻丢弃自己的 socket，服务端这条 socket 随后就会读到一个
 * ECONNRESET——没有兜底就是一个未捕获异常。
 */
async function startFront(service) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    service.handleUpgrade(req, socket, head)
  })
  const port = await listen(server)
  return { server, port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * 假 dev server：把每个完整请求记下来并回一段带标记的正文。
 * 走的是原始字节，所以这里收到的应该是浏览器真正会发的那个形状。
 */
function startDevServer() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host || '' })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<h1>dev ok</h1><p>host=${req.headers.host}</p>`)
  })
  return { server, seen }
}

/** 手机侧：一条预览 WS，把原始请求字节灌进去，收齐回程字节。 */
function pipe(servicePort, targetPort, { request, headers = {}, settleMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${servicePort}/api/mobile/v1/preview?port=${targetPort}`, { headers })
    const chunks = []
    let handshakeError = null
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* 已断开 */ } }, settleMs)
    const done = () => {
      clearTimeout(timer)
      resolve({ text: Buffer.concat(chunks).toString('utf8'), handshakeError })
    }
    ws.on('open', () => { if (request) ws.send(request) })
    ws.on('message', (data) => chunks.push(Buffer.from(data)))
    ws.on('error', (error) => { handshakeError = error.message; clearTimeout(timer); done() })
    ws.on('close', () => setTimeout(done, 30))
  })
}

function httpGet(hostHeader, extra = 'Connection: close\r\n') {
  return Buffer.from(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}\r\n`)
}

/**
 * 这套用例锚定的是「字节管道」这一层的可观测契约：手机在 WS 握手完成后**立刻**就会把
 * 请求字节发出来，而 `net.connect(127.0.0.1, port)` 还在路上。这段窗口里的字节必须被
 * 存住再补写，否则表现为「页面时好时坏、偶尔整页空白」——概率性丢字节，真机上极难复现。
 */
test('上游连上之前的首批字节不会丢', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev.server)

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    // 并发拉满：旧实现（监听挂在 upstream.on('connect') 里）在这个规模下必然丢。
    const rounds = await Promise.all(
      Array.from({ length: 24 }, () => pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`) })),
    )
    const ok = rounds.filter((r) => r.text.includes('<h1>dev ok</h1>'))
    assert.equal(ok.length, rounds.length, `有 ${rounds.length - ok.length} 条管道回程是空的（首批字节被丢）`)
    for (const r of rounds) {
      assert.match(r.text, /^HTTP\/1\.1 200 OK/, `回程不是完整响应：${JSON.stringify(r.text.slice(0, 60))}`)
      assert.ok(r.text.includes(`host=localhost:${devPort}`), 'Host 被改写了，dev server 生成的绝对地址会全部指向手机自己')
    }
    assert.equal(dev.seen.length, rounds.length, 'dev server 收到的请求数不对，说明有请求字节没送上去')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('内层 WebSocket 升级原样穿过（HMR 的结构性前提）', async () => {
  const dev = startDevServer()
  const hmr = new WebSocket.Server({ server: dev.server, path: '/hmr' })
  hmr.on('connection', (socket) => socket.send('hmr-hello'))
  const devPort = await listen(dev.server)

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    const upgrade = Buffer.from(
      `GET /hmr HTTP/1.1\r\nHost: localhost:${devPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    const { text } = await pipe(frontPort, devPort, { request: upgrade, settleMs: 1500 })
    assert.match(text, /101 Switching Protocols/, '内层 WS 升级没有穿过，热更新会断')
    assert.ok(text.includes('hmr-hello'), '升级之后的帧也没有穿过')
  } finally {
    hmr.close()
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('拒绝发生在握手之前（手机侧拿到的是状态码，不是空白页）', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev.server)

  const service = createPreviewService({
    authorized: (req) => /^Bearer good$/.test(req.headers.authorization || ''),
    protectedPorts: () => new Set([3080]),
    onLog: () => {},
  })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    const noAuth = await pipe(frontPort, devPort, { request: null, settleMs: 600 })
    assert.match(String(noAuth.handshakeError), /401/, '没带凭据必须 401')

    const badAuth = await pipe(frontPort, devPort, { request: null, headers: { authorization: 'Bearer bad' }, settleMs: 600 })
    assert.match(String(badAuth.handshakeError), /401/, '凭据不对必须 401')

    const protectedPort = await pipe(frontPort, 3080, { request: null, headers: { authorization: 'Bearer good' }, settleMs: 600 })
    assert.match(String(protectedPort.handshakeError), /403/, 'DSH 自身端口必须 403')

    const badPort = new WebSocket(`ws://127.0.0.1:${frontPort}/api/mobile/v1/preview?port=99999`, {
      headers: { authorization: 'Bearer good' },
    })
    const badPortError = await new Promise((resolve) => {
      badPort.on('error', (error) => resolve(error.message))
      badPort.on('open', () => resolve('opened'))
    })
    assert.match(badPortError, /400/, '越界端口必须 400')

    // 受保护端口是按「身份」判的，不是按数字拉黑：改成别的端口就必须放行。
    const allowed = await pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`), headers: { authorization: 'Bearer good' } })
    assert.ok(allowed.text.includes('<h1>dev ok</h1>'), '合法端口被误伤')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('目标端口没人监听时，管道里送回 502 失败页', async () => {
  const dead = await freePort()
  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    const { text } = await pipe(frontPort, dead, { request: httpGet(`localhost:${dead}`), settleMs: 1500 })
    assert.match(text, /^HTTP\/1\.1 502 Bad Gateway/, '死端口应回 502，而不是让 WebView 显示系统错误页')
    assert.ok(text.includes('<!doctype html'), '失败页正文缺失')
  } finally {
    await front.close()
    service.close()
  }
})

/**
 * 环回不止 `127.0.0.1`。macOS 上 Vite 之类的 dev server 默认只监听 `::1`，而宿主过去
 * 写死拨 IPv4——结果是「前端明明起来了，内置浏览器只看到『电脑上这个端口没有服务』」。
 */
test('dev server 只监听 [::1] 时，管道照样接通', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('本机没有 IPv6 环回')
    return
  }
  // 端口号先按 `127.0.0.1` 借一次再还回去，然后拿**同一个号**去听 `::1`。用例要断言的
  // 就是「拨 IPv4 失败之后还肯试 ::1」；若交给内核在 `::1` 上随机挑号，这个号完全可能
  // 正被别的进程占在 `127.0.0.1` 上——第一个地址反而接通了，用例会以「读到了别人的
  // 服务」这种莫名其妙的方式失败。
  const devPort = await freePort()
  const dev = startDevServer()
  await new Promise((resolve) => dev.server.listen(devPort, '::1', resolve))

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    const { text } = await pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`), settleMs: 1500 })
    assert.ok(text.includes('<h1>dev ok</h1>'),
      `只监听 [::1] 的 dev server 接不上（宿主没有试第二个环回地址）；dev server 收到 ${dev.seen.length} 个请求，回程：${JSON.stringify(text.slice(0, 80))}`)
    assert.equal(dev.seen.length, 1, '请求没送到那个只监听 [::1] 的 dev server 上')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

/**
 * 上面那条并发用例能把回归摁住，但它依赖时序窗口；下面这条源码契约是同一件事的
 * 确定性表述——顺序写反了就是丢字节，与并发规模无关。
 */
test('源码契约：message 监听必须先于 net.connect 挂上', () => {
  const open = SOURCE.indexOf('function openPipe(ws, port)')
  assert.notEqual(open, -1, '缺少 openPipe')
  const message = SOURCE.indexOf("ws.on('message'", open)
  const connect = SOURCE.indexOf('net.connect(', open)
  assert.notEqual(message, -1, 'openPipe 里没有挂 ws 的 message 监听')
  assert.notEqual(connect, -1, 'openPipe 里没有 net.connect')
  assert.ok(message < connect, 'ws.on(\'message\') 挂在了 net.connect 之后：握手到上游连上之间的字节会被丢掉')
  assert.ok(SOURCE.includes('MAX_PREVIEW_PENDING_BYTES'), '上游连不上时的攒字节上限丢失，会无限吃内存')
})
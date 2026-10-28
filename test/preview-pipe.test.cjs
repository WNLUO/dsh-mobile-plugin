'use strict'
/**
 * 内置预览管道的宿主侧契约：拨号目标（`host` / `scheme`）怎么解析、哪些目标能拨、https 的
 * TLS 在宿主这侧怎么发，以及「上游连上之前的字节不许丢」这类搬运前提。
 *
 * 全部用例都站在同一个前提下——手机只跟自己环回上的管道说一段明文 WS，电脑那头拨谁由宿主
 * 决定。所以假 dev server 收的都是**原始字节**：要断言的就是升级请求与 Host 头原样穿过。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const tls = require('node:tls')
const { test } = require('node:test')

const WebSocket = require('ws')
const { createPreviewService, isAllowedPreviewHost, previewDialTargets } = require('../lib/relay/preview.js')

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

/** 这台机器上一块真实私网网卡的 IPv4：用例要的是「host 指哪就拨哪」，得有一个真能 listen 的地址。 */
function privateIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const [a, b] = item.address.split('.').map(Number)
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return item.address
    }
  }
  return null
}

/**
 * 假 https dev server：真 TLS 握手，收明文 HTTP 字节。
 *
 * 证书直接嵌在这里（自签、CN=localhost）。用例要断言的正是「自签也连得上」，因此换成
 * 本机 mkcert 之类签出来的证书，反而会把测试绑在那台机器上。
 */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpadPkdIICiPGOzWc
3FubRr1IMMfPrzsab5QQEWVdSC+hRANCAAQW+JSzLIjzHYoLQrfSKWbuC2pUMF3o
vqp8iL7BawaTJUnfWzZe7rU5dBgM1GbGg3pJb67ZD1hEgpVmIJ88gQ0Y
-----END PRIVATE KEY-----
`
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBczCCARqgAwIBAgIUfCb3gnVZRYr1N7tdFN/wMrMssU4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyODE5MTUyN1oYDzIxMjYxMDA0
MTkxNTI3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQW+JSzLIjzHYoLQrfSKWbuC2pUMF3ovqp8iL7BawaTJUnfWzZe7rU5
dBgM1GbGg3pJb67ZD1hEgpVmIJ88gQ0Yo0gwRjAdBgNVHQ4EFgQUDKr02RZibAkJ
3XwIRkQQRsn/r/AwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhv
c3QwCgYIKoZIzj0EAwIDRwAwRAIgN1KZHRsqhniJxiiczk3+BpmLZCWWJX6a95ce
JYxrwbUCICz12wLonvZZyq58WOTaJAmi23046UB+XeuxraMU/B6I
-----END CERTIFICATE-----
`

function startTlsDevServer() {
  const requests = []
  const servernames = []
  const server = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
    servernames.push(socket.servername || '')
    socket.on('error', () => {})
    let buffered = ''
    let answered = false
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      if (answered || !buffered.includes('\r\n\r\n')) return
      answered = true
      requests.push(buffered)
      const body = '<h1>dev ok</h1><p>tls</p>'
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    })
  })
  return { server, requests, servernames }
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
function pipe(servicePort, targetPort, { request, headers = {}, settleMs = 2000, query = '' } = {}) {
  return new Promise((resolve) => {
    const suffix = query ? `&${query}` : ''
    const ws = new WebSocket(`ws://127.0.0.1:${servicePort}/api/mobile/v1/preview?port=${targetPort}${suffix}`, { headers })
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
 *
 * 后一轮用地址栏那种带方括号的 `[::1]`：它必须仍被认成环回、仍走双栈。剥方括号少了这一步，
 * 用户在地址栏里敲一个 `[::1]:5173` 就会撞上白名单的 403。
 */
test('dev server 只监听 [::1] 时，管道照样接通（缺省 host 与显式 [::1] 都算环回）', async (t) => {
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
    for (const query of ['', `host=${encodeURIComponent('[::1]')}`]) {
      const { text } = await pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`), settleMs: 1500, query })
      assert.ok(text.includes('<h1>dev ok</h1>'),
        `只监听 [::1] 的 dev server 接不上（query=${query || '缺省'}）；dev server 收到 ${dev.seen.length} 个请求，回程：${JSON.stringify(text.slice(0, 80))}`)
    }
    assert.equal(dev.seen.length, 2, '请求没送到那个只监听 [::1] 的 dev server 上')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('host 指到私网地址时，拨的就是那台主机（不是环回）', async (t) => {
  const host = privateIpv4()
  if (!host) {
    t.skip('本机没有私网 IPv4 网卡')
    return
  }
  // dev server **只**听那个私网地址：实现若偷偷拨回环，127.0.0.1 上没有服务，回程只会是 502。
  const dev = startDevServer()
  const devPort = await new Promise((resolve) => dev.server.listen(0, host, () => resolve(dev.server.address().port)))

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    const { text } = await pipe(frontPort, devPort, { request: httpGet(`${host}:${devPort}`), query: `host=${host}`, settleMs: 2000 })
    assert.ok(text.includes('<h1>dev ok</h1>'),
      `Host 参数指向的私网地址没被拨到（dev server 收到 ${dev.seen.length} 个请求，回程：${JSON.stringify(text.slice(0, 80))}）`)
    assert.equal(dev.seen.length, 1, '请求没送到那台只监听私网地址的 dev server 上')
    assert.equal(dev.seen[0].host, `${host}:${devPort}`, 'Host 被改写了，dev server 生成的绝对地址会指向别处')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('scheme=https：宿主这侧完成 TLS 握手，自签证书也连得上', async () => {
  const dev = startTlsDevServer()
  const devPort = await listen(dev.server)

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    // IP 字面量：TLS 照发，SNI 不能带（拿 IP 当 servername 会被 Node 判成非法参数）。
    const viaIp = await pipe(frontPort, devPort, { request: httpGet(`127.0.0.1:${devPort}`), query: 'scheme=https&host=127.0.0.1', settleMs: 2000 })
    assert.match(viaIp.text, /^HTTP\/1\.1 200 OK/, `https 目标没连上：${JSON.stringify(viaIp.text.slice(0, 80))}`)
    assert.ok(viaIp.text.includes('<h1>dev ok</h1>'), 'TLS 通道上的正文没回来')
    assert.equal(dev.servernames[0], '', 'IP 字面量不该作为 SNI 发出去')

    // 主机名：servername 必须跟上，否则按域名签的证书对不上。
    const viaName = await pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`), query: 'scheme=https', settleMs: 2000 })
    assert.ok(viaName.text.includes('<h1>dev ok</h1>'), '主机名目标走 https 时没连上')
    assert.equal(dev.servernames[1], 'localhost', '主机名目标没把 servername 带上')
    assert.ok(dev.requests[1].includes(`Host: localhost:${devPort}`), `dev server 收到的明文 HTTP 字节里 Host 不对：${JSON.stringify(dev.requests[1] || '')}`)
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('公网目标在握手之前就被 403 拒（域名与公网 IP 各一条）', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev.server)

  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port

  try {
    for (const host of ['example.com', '8.8.8.8']) {
      const refused = await pipe(frontPort, devPort, { request: httpGet(`localhost:${devPort}`), query: `host=${host}`, settleMs: 800 })
      assert.match(String(refused.handshakeError), /403/, `${host} 不在白名单里，必须 403`)
      assert.equal(refused.text, '', '拒绝必须发生在握手之前：管道里不该有任何回程字节')
    }
    assert.equal(dev.seen.length, 0, '被拒的目标不该被拨到')
  } finally {
    await front.close()
    await new Promise((resolve) => dev.server.close(resolve))
    service.close()
  }
})

test('失败页写的是实际拨过的目标（含 https）', async () => {
  const dead = await freePort()
  const service = createPreviewService({ authorized: () => true, protectedPorts: () => new Set(), onLog: () => {} })
  const front = await startFront(service)
  const frontPort = front.port
  // 单目标那条挑一个「放行但只拨一个」的地址：私网网卡有就用真的，没有就退到 127.0.0.2
  // （它也是环回，但不在双栈那一组里，宿主只会拨它自己的一个）。
  const single = privateIpv4() || '127.0.0.2'

  try {
    const loopback = await pipe(frontPort, dead, { request: httpGet(`localhost:${dead}`), settleMs: 2000 })
    assert.ok(loopback.text.includes(`127.0.0.1:${dead}`) && loopback.text.includes(`[::1]:${dead}`),
      `双栈目标没在失败页里说清：${JSON.stringify(loopback.text.slice(0, 200))}`)

    const one = await pipe(frontPort, dead, { request: httpGet(`${single}:${dead}`), query: `host=${single}`, settleMs: 2000 })
    assert.ok(one.text.includes(`${single}:${dead}`), `单目标没在失败页里说清：${JSON.stringify(one.text.slice(0, 200))}`)
    assert.ok(!one.text.includes('[::1]'), '只拨了一个目标，失败页却说拨过 ::1')

    const https = await pipe(frontPort, dead, { request: httpGet(`127.0.0.1:${dead}`), query: 'scheme=https&host=127.0.0.1', settleMs: 2000 })
    assert.ok(https.text.includes(`https://127.0.0.1:${dead}`), `https 目标没在失败页里说清：${JSON.stringify(https.text.slice(0, 200))}`)
  } finally {
    await front.close()
    service.close()
  }
})

/**
 * 白名单与拨号计划是这条管道的能力边界，写成纯函数直接钉边界值——走真握手只能挑两三个
 * 地址验，段边界（100.63 / 100.128、172.15 / 172.32、fe80 / fec0）得靠这张表。
 */
test('目标白名单：只放本机、私网、链路本地、ULA 与保留域名', () => {
  const allowed = [
    'localhost', '127.0.0.1', '127.0.0.2', '0.0.0.0', '::1', '::',
    '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.31.69',
    '100.64.0.1', '100.127.255.255', '169.254.87.131',
    'fc00::1', 'fd12:3456::1', 'fe80::1%en0', 'febf::1',
    'dev.local', 'x.localhost', 'api.test', 'box.internal', 'nas.lan', 'printer.home.arpa',
  ]
  for (const host of allowed) assert.equal(isAllowedPreviewHost(host), true, `${host} 应该放行`)

  const refused = [
    'example.com', '8.8.8.8', '1.1.1.1',
    '172.15.0.1', '172.32.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.0', '198.18.0.1',
    '2001:db8::1', 'fec0::1', '240e::1',
    'local.example.com', 'example.local.com', '.local', 'home.arpa',
  ]
  for (const host of refused) assert.equal(isAllowedPreviewHost(host), false, `${host} 不该放行`)
})

test('拨号计划：环回双栈、别的目标只拨那一个', () => {
  for (const loopback of ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']) {
    assert.deepEqual(previewDialTargets(loopback), ['127.0.0.1', '::1'],
      `${loopback} 是环回，必须双栈拨号——只试 127.0.0.1 会漏掉只监听 ::1 的 dev server`)
  }
  assert.deepEqual(previewDialTargets('192.168.31.69'), ['192.168.31.69'],
    '指定了主机就只许拨它：换地址重试等于连到另一台机器上')
  assert.deepEqual(previewDialTargets('dev.local'), ['dev.local'], '域名目标也只拨它自己')
})

/**
 * 上面那条并发用例能把回归摁住，但它依赖时序窗口；下面这条源码契约是同一件事的
 * 确定性表述——顺序写反了就是丢字节，与并发规模无关。
 */
test('源码契约：message 监听必须先于 net.connect 挂上', () => {
  const open = SOURCE.indexOf('function openPipe(ws, ')
  assert.notEqual(open, -1, '缺少 openPipe')
  const message = SOURCE.indexOf("ws.on('message'", open)
  const connect = SOURCE.indexOf('net.connect(', open)
  assert.notEqual(message, -1, 'openPipe 里没有挂 ws 的 message 监听')
  assert.notEqual(connect, -1, 'openPipe 里没有 net.connect')
  assert.ok(message < connect, 'ws.on(\'message\') 挂在了 net.connect 之后：握手到上游连上之间的字节会被丢掉')
  assert.ok(SOURCE.includes('MAX_PREVIEW_PENDING_BYTES'), '上游连不上时的攒字节上限丢失，会无限吃内存')
})
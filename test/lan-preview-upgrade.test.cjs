'use strict'
/**
 * 局域网直连这条路上的 WebSocket 升级（内置浏览器真正的入口）。
 *
 * 手机同 Wi-Fi 时用的是 `<电脑IP>:<lanPort>` 这个代理，而不是中转：它自己校验完配对
 * 凭据之后，**必须**像 HTTP 路径那样把凭据（设备凭据对应的宿主 token）转发给宿主，
 * 否则宿主的预览管道会判「没有移动端凭据」直接 401。更隐蔽的是时序：手机侧的原生管道
 * 只在「握手根本没成」时才换下一条候选地址，所以局域网代理一旦先回 101 再默默把连接
 * 关掉，手机就认定这条连接可用，永远不回退到中转——表现就是内置浏览器一直白屏。
 *
 * 这两件事都是「代码看着很合理、真机上必然失败」的类型，所以在这里用真代理 + 真预览
 * 管道钉死。
 */
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { test } = require('node:test')

const WebSocket = require('ws')
const { createPreviewService } = require('../lib/relay/preview.js')
const { createLanProxy } = require('../lib/relay/lan-proxy.js')
const credentials = require('../dsh-mobile-credentials/lib/credentials.js')
const { signLanToken } = require('../lib/shared/dshtoken.js')

const INSTANCE_ID = 'testinst'
const LAN_SECRET = 'b'.repeat(64)
const HOST_TOKEN = 'host-token-for-device'
const DEVICE_CREDENTIAL = 'dshc_test_device_secret'

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

/** 假 dev server：回一段带标记的正文，用来确认字节真的走到了最里层。 */
function startDevServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<h1>dev ok</h1><p>host=${req.headers.host}</p>`)
  })
  return server
}

/**
 * 宿主侧的预览管道，挂法照抄宿主：升级 socket 先有 error 兜底，再交给 service。
 * `authorized` 记下实际看到的 Authorization，用例靠它断言凭据确实转发了。
 */
async function startHostPreview({ authorized }) {
  const seen = []
  const service = createPreviewService({
    authorized: (req) => {
      seen.push(req.headers.authorization)
      return authorized(req)
    },
    protectedPorts: () => new Set(),
    onLog: () => {},
  })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    service.handleUpgrade(req, socket, head)
  })
  const port = await listen(server)
  return {
    seen,
    port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      service.close()
    },
  }
}

/** 局域网代理：上游指向宿主那条管道。 */
async function startLanProxy(upstreamPort) {
  const proxy = createLanProxy({
    lanPort: 0,
    pairingCode: '000000',
    instanceId: INSTANCE_ID,
    lanSecret: LAN_SECRET,
    upstreamPort,
    onLog: () => {},
    onApprove: async () => ({ approved: false }),
  })
  await proxy.start()
  return { port: proxy.port(), close: () => proxy.stop() }
}

/** 手机侧：连局域网代理，握手成不成、收到什么字节都记下来。 */
function phone(proxyPort, targetPort, { headers = {}, request, settleMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/mobile/v1/preview?port=${targetPort}`, { headers })
    const chunks = []
    let opened = false
    let handshakeError = null
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* 已断开 */ } }, settleMs)
    const done = () => {
      clearTimeout(timer)
      resolve({ opened, handshakeError, text: Buffer.concat(chunks).toString('utf8') })
    }
    ws.on('open', () => {
      opened = true
      if (request) ws.send(request)
    })
    ws.on('message', (data) => chunks.push(Buffer.from(data)))
    ws.on('error', (error) => { handshakeError = error.message; clearTimeout(timer); done() })
    ws.on('close', () => setTimeout(done, 30))
  })
}

function httpGet(hostHeader) {
  return Buffer.from(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`)
}

/**
 * 只替换凭据库的查询结果。真实实现要落盘到 `~/.dsh/relay-device-credentials.json`，
 * 用例绝不能碰用户那台机器上的凭据。代理有两个入口：`lookup()` 判「这台设备还活着吗」，
 * `find()` 取「该设备对应的宿主 token」，两个都得替换。
 */
function withDeviceCredential(run) {
  const record = {
    credential: DEVICE_CREDENTIAL,
    instanceId: INSTANCE_ID,
    deviceId: 'device-test',
    hostToken: HOST_TOKEN,
    expiresAt: Date.now() + 3_600_000,
  }
  const match = (credential, instanceId) => (
    credential === DEVICE_CREDENTIAL && instanceId === INSTANCE_ID ? record : null
  )
  const originals = { find: credentials.find, lookup: credentials.lookup }
  credentials.find = match
  credentials.lookup = match
  return Promise.resolve()
    .then(run)
    .finally(() => {
      credentials.find = originals.find
      credentials.lookup = originals.lookup
    })
}

test('设备凭据换来的宿主 token 会转发给上游，字节端到端可通', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev)
  const hostPreview = await startHostPreview({
    authorized: (req) => req.headers.authorization === `Bearer ${HOST_TOKEN}`,
  })
  const lan = await startLanProxy(hostPreview.port)

  try {
    await withDeviceCredential(async () => {
      const result = await phone(lan.port, devPort, {
        headers: { 'x-dsh-device-credential': DEVICE_CREDENTIAL },
        request: httpGet(`localhost:${devPort}`),
      })
      assert.equal(result.opened, true, `局域网代理这跳就拒了：${result.handshakeError}`)
      assert.equal(result.handshakeError, null)
      assert.match(result.text, /^HTTP\/1\.1 200 OK/, `回程不是完整响应：${JSON.stringify(result.text.slice(0, 80))}`)
      assert.ok(result.text.includes('<h1>dev ok</h1>'), '字节没走到 dev server，局域网直连等于没接上')
      assert.deepEqual(hostPreview.seen, [`Bearer ${HOST_TOKEN}`],
        '宿主预览管道收到的 Authorization 不对：设备凭据没有被换成宿主 token')
    })
  } finally {
    lan.close()
    await hostPreview.close()
    await new Promise((resolve) => dev.close(resolve))
  }
})

test('上游拒绝时手机拿到的是握手失败（否则永远不会回退到下一个候选地址）', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev)
  // 上游一律拒绝：模拟宿主预览管道认不出凭据。
  const hostPreview = await startHostPreview({ authorized: () => false })
  const lan = await startLanProxy(hostPreview.port)

  try {
    // 有本机 lanToken（局域网代理这跳放行），但没有设备凭据可换宿主 token。
    const lanToken = signLanToken(LAN_SECRET, INSTANCE_ID, 3600)
    const result = await phone(lan.port, devPort, {
      headers: { authorization: `Bearer ${lanToken}` },
      request: httpGet(`localhost:${devPort}`),
      settleMs: 900,
    })
    assert.equal(result.opened, false, '先回了 101 再关连接：手机侧会卡在这条候选上，内置浏览器白屏')
    assert.match(String(result.handshakeError), /401/, `手机侧应看到上游的状态码，实际：${result.handshakeError}`)
  } finally {
    lan.close()
    await hostPreview.close()
    await new Promise((resolve) => dev.close(resolve))
  }
})

test('上游连不上时手机拿到 502，而不是一条假的已建立连接', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev)
  // 借一个空闲端口当「宿主的预览管道已经不在了」。
  const probe = net.createServer()
  const deadPort = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))

  const lan = await startLanProxy(deadPort)
  try {
    const lanToken = signLanToken(LAN_SECRET, INSTANCE_ID, 3600)
    const result = await phone(lan.port, devPort, {
      headers: { authorization: `Bearer ${lanToken}` },
      request: null,
      settleMs: 900,
    })
    assert.equal(result.opened, false, '上游都连不上却回了 101')
    assert.match(String(result.handshakeError), /502/, `应是 502 Bad Gateway，实际：${result.handshakeError}`)
  } finally {
    lan.close()
    await new Promise((resolve) => dev.close(resolve))
  }
})

test('局域网代理这跳的鉴权仍然在握手之前生效', async () => {
  const dev = startDevServer()
  const devPort = await listen(dev)
  const hostPreview = await startHostPreview({ authorized: () => true })
  const lan = await startLanProxy(hostPreview.port)

  try {
    const result = await phone(lan.port, devPort, { request: null, settleMs: 700 })
    assert.equal(result.opened, false, '没凭据也能连上局域网代理')
    assert.match(String(result.handshakeError), /401/)
    assert.equal(hostPreview.seen.length, 0, '鉴权没过就不该碰到上游')
  } finally {
    lan.close()
    await hostPreview.close()
    await new Promise((resolve) => dev.close(resolve))
  }
})

test('源码契约：升级路径必须转发头，并且连上上游之后才回 101', () => {
  const fs = require('node:fs')
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js'), 'utf8')
  const start = source.indexOf('function handleUpgrade(req, socket, head)')
  assert.notEqual(start, -1, '缺少 handleUpgrade')
  const body = source.slice(start, source.indexOf('function start()', start))
  const connect = body.indexOf('handshakeTimeout')
  const handshake = body.indexOf('wss.handleUpgrade(')
  assert.notEqual(connect, -1, 'WebSocket 上游没有带 headers/handshakeTimeout 参数')
  assert.notEqual(handshake, -1, '升级路径没有完成手机侧握手')
  assert.ok(connect < handshake, '先回 101 再连上游：上游拒绝时手机会卡在这条候选上')
  assert.ok(body.includes('HOP_BY_HOP'), '升级路径没有过滤逐跳头')
  assert.ok(body.includes('hostToken'), '升级路径没有转发宿主 token，宿主会回 401')
})

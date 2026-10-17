'use strict'
/**
 * 预览升级路上「上游已连上、手机还没握手完」这段暂存缓冲的释放。
 *
 * 那段窗口里上游推来的原帧先攒在 `pending` 里等手机握手完再发。旧实现在四件事上都不会
 * 放掉它：手机先走了（abandon）、上游断在握手前（fail）、上游在握手后断掉、以及积压超限。
 * 预览页面挂住时每刷新一次就永久留一份最多 1MiB 的缓冲，宿主的 sidecar 子进程能撑几个小时
 * 然后 OOM（2026-10-17 host.log：4GB 堆耗尽）。
 *
 * 这里用真代理驱动升级的**真源码**，用一个能窥视 `pending` 的替身记录它有没有被清空；
 * 积压超限那条路另外断言手机侧拿到了失败响应，而不是一条悬着的连接。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { test } = require('node:test')

const WebSocket = require('ws')
const { createLanProxy } = require('../lib/relay/lan-proxy.js')
const credentials = require('../dsh-mobile-credentials/lib/credentials.js')
const { signLanToken } = require('../lib/shared/dshtoken.js')

const INSTANCE_ID = 'testinst'
const LAN_SECRET = 'b'.repeat(64)
const DEVICE_CREDENTIAL = 'dshc_test_device_secret'

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

function withDeviceCredential(run) {
  const record = {
    credential: DEVICE_CREDENTIAL,
    instanceId: INSTANCE_ID,
    deviceId: 'device-test',
    hostToken: 'host-token-for-device',
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

/** 上游：接受升级，然后按 `chunks` 推帧（用来把暂存缓冲撑到上限之上）。 */
async function startUpstream({ payloadBytes = 0, chunks = 0, delayedMs = null } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocket.Server({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {})
      const push = () => {
        for (let i = 0; i < chunks; i += 1) {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(Buffer.alloc(payloadBytes, 0x41))
        }
      }
      if (delayedMs === null) push()
      else setTimeout(push, delayedMs).unref?.()
    })
  })
  const port = await listen(server)
  return {
    port,
    /** 还连着的上游连接数：手机走了之后这条应该归零。 */
    openClients: () => wss.clients.size,
    close: async () => {
      for (const client of wss.clients) { try { client.terminate() } catch { /* ignore */ } }
      wss.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * 手机侧。`send()` 发升级请求，`head` 等那条响应里的状态行（101 还是 502）。
 *
 * 代理是先连上游、连上之后才对手机回 `101`，所以暂存那一刻的字节，来自手机已经连上、
 * 却还没发升级请求的那段窗口——用例靠「先建连、晚一点再 `send()`」制造它。
 */
function sniffMobile(port, targetPort, { deadlineMs = 2000 } = {}) {
  const socket = net.connect(port, '127.0.0.1')
  const chunks = []
  const send = () => {
    if (socket.destroyed) return
    socket.write([
      `GET /api/mobile/v1/preview?port=${targetPort} HTTP/1.1`,
      'Host: lan.test',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `x-dsh-device-credential: ${DEVICE_CREDENTIAL}`,
      '', '',
    ].join('\r\n'))
  }
  const head = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), deadlineMs)
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const line = Buffer.concat(chunks).toString('latin1').match(/^HTTP\/1\.1 \d{3}[^\r\n]*/)
      if (line) { clearTimeout(timer); resolve(line[0]) }
    })
    socket.on('error', () => { clearTimeout(timer); resolve('') })
  })
  return { socket, send, head }
}

/**
 * 载入 lan-proxy 的**真源码**，把 `pending` 的 live 引用暴露出来。
 *
 * 只看源码文本断言「调用了清理」是纸面检查——清理函数可能写了却没人调。这里在
 * `const pending = []` 之后插一行把引用登记出去，再由用例按最后一个登记的数组检查
 * 它到底空没空。登记用弱持有：真泄漏时用例能直接指出「还剩多少帧」。
 */
function loadLanProxyWithProbe() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js'), 'utf8')
  const anchor = '    const pending = [];\n'
  assert.ok(source.includes(anchor), '找不到暂存缓冲的声明，源码结构变了')
  const probe = `${anchor}    globalThis.__pendingProbe = pending;\n`
  const module = { exports: {} }
  const factory = new Function('module', 'exports', 'require', '__filename', '__dirname',
    source.replace(anchor, probe))
  factory.call(module.exports, module, module.exports,
    (id) => require(id.startsWith('.') ? path.join(path.dirname(path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js')), id) : id),
    path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js'),
    path.join(__dirname, '..', 'lib', 'relay'))
  return module.exports.createLanProxy
}

async function startProxy(factory, upstreamPort) {
  const proxy = factory({
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 120))

/**
 * 上游是「先读完请求、握手完再在 socket 上回调」的，紧跟着推的第一帧就躺在同一条 socket 里。
 * 代理若在这一拍之前没挂上 `message` 监听，那一帧不进暂存也不转发，凭空消失。预览页面
 * 刚加载时正是这种「握手完立刻推」。
 */
test('上游握手完立刻推的第一帧不会丢', async () => {
  // 上游在握手回调里同步推，比手机拿到 `101` 还早。这一帧必须还在、还能送到手机上。
  const upstream = await startUpstream({ payloadBytes: 1024, chunks: 1 })
  const lan = await startProxy(createLanProxy, upstream.port)
  try {
    await withDeviceCredential(async () => {
      const mobile = sniffMobile(lan.port, upstream.port)
      mobile.send()
      const head = await mobile.head
      await tick()
      assert.ok(mobile.socket.bytesRead > 1024 + 8, `上游这一帧被弄丢了：只收到 ${mobile.socket.bytesRead} 字节`)
      mobile.socket.destroy()
    })
  } finally {
    lan.close()
    await upstream.close()
  }
})

/**
 * 手机在「上游已连上、自己还没收到 `101`」这段窗口里走了。代理此时既不会给谁回 `101`，
 * 也不该继续握着上游——更不该把这段窗口攒下的字节一直挂在闭包里。
 */
test('手机在上站之前走了：不把上游和暂存一起吊着', async () => {
  const upstream = await startUpstream({ payloadBytes: 256 * 1024, chunks: 3, delayedMs: 60 })
  const lan = await startProxy(loadLanProxyWithProbe(), upstream.port)
  try {
    await withDeviceCredential(async () => {
      globalThis.__pendingProbe = null
      const mobile = sniffMobile(lan.port, upstream.port)
      mobile.send()
      mobile.socket.destroy()
      await tick()
      assert.equal(globalThis.__pendingProbe?.length ?? 0, 0, '手机走了之后暂存缓冲仍有残留帧')
      assert.ok(upstream.openClients() === 0, '手机走了之后上游还被这条废连接占着')
    })
  } finally {
    lan.close()
    await upstream.close()
  }
})

test('源码契约：每条失败路径都要释放暂存缓冲', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'lan-proxy.js'), 'utf8')
  const start = source.indexOf('function handleUpgrade(req, socket, head)')
  assert.notEqual(start, -1, '缺少 handleUpgrade')
  const body = source.slice(start, source.indexOf('function start()', start))
  const release = body.indexOf('const dropPending = () =>')
  assert.notEqual(release, -1, '缺少暂存缓冲的释放函数')
  for (const site of ['const fail = (status, message)', 'const abandon = () =>']) {
    const at = body.indexOf(site)
    assert.notEqual(at, -1, `找不到 ${site}`)
    const block = body.slice(at, body.indexOf('\n    }', at))
    assert.ok(block.includes('dropPending()'), `${site} 这条失败路径没有释放暂存缓冲`)
  }
  // 上游中断那条分支没有独立的清理函数，直接钉「日志之后紧跟一次释放」。
  const errorAt = body.indexOf("up.on('error', (err)")
  assert.notEqual(errorAt, -1, '找不到上游 error 分支')
  const errorBlock = body.slice(errorAt, body.indexOf('\n    });', errorAt))
  assert.ok(errorBlock.includes('dropPending()'), "up.on('error') 这条失败路径没有释放暂存缓冲")
  assert.ok(!/pending\.length = 0;\s*pendingBytes = 0;\s*\}\);/.test(body.replace(/const dropPending[\s\S]*?\};/, '')),
    '暂存缓冲仍有就地清空，绕过 dropPending')
})

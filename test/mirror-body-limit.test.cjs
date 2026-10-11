'use strict'
// 「镜像推不上去」查了一个小时，最后发现是一行 1MB 上限。
//
// /api/relay/status 里的 mirror.ok 长期 false + 「sidecar facade request failed: 503」，
// 而隧道明明是 connected、手工打 /tunnel/send 永远 202。原因是 worker 的 readBody
// 把超过 1MB 的请求体拒了：桌面推给移动端的镜像带着整份会话列表 + 工作区 + 当前
// 会话的完整消息，实测一次就过 1MB（而中转清洗后真正留下的只有 ~114KB）。被拒的
// 请求掉进 handler 的 catch-all 变成 503，宿主侧再把 worker 返回的 error 原文丢掉，
// 于是「请求体太大」和「隧道没连上」在日志里长得一模一样。
//
// 这里把真 worker fork 起来、配一个会完成注册的假中转，钉三件事：
//   1. 旧上限会拒掉的体积（1MB~8MB）现在必须推得进去——这正是线上在推的量级；
//   2. 真的超过中转帧上限（8MB）时必须 413 且**说清多大**；
//   3. 推大了绝不能把隧道带走——中转遇到超帧是直接 1009 关隧道的，那比丢一次镜像
//      严重得多（手机端要等重连，期间全瞎）。这是设上限的唯一理由。
// 另外钉住 facade 必须把 worker 的 error 原文带出来，否则下一次同类问题还是无从下手。
const assert = require('node:assert/strict')
const http = require('node:http')
const { randomBytes } = require('node:crypto')
const { WebSocketServer } = require('ws')
const { SidecarFacade } = require('../lib/sidecar-facade.cjs')
const { T, jsonFrame } = require('../lib/relay/protocol.js')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 谓词可以是 async：这里 await 之后再判真假。直接 `if (predicate())` 的话 Promise
// 恒为真，会让第一次轮询就「通过」，等待就白写了。
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(message)
}

;(async () => {
  // 假父进程：本用例不触发配对审批，能应答即可。
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))

  // 假中转：完成握手、回 registered（让 tunnel.connected 为真），并统计收到的 sync 帧。
  let syncs = 0
  let lastSyncBytes = 0
  let socket = null
  const relay = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server: relay })
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (data) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
      // T.sync = 0x17（lib/relay/protocol.js），不是 0x04——0x04 是 httpRequest。
      if (raw.length >= 2 && raw[0] === T.sync) { syncs += 1; lastSyncBytes = raw.length }
    })
    // 真实中转在收到 register 后回 registered；这里照做，隧道才算连上。
    setTimeout(() => { try { ws.send(jsonFrame(T.registered, 0, {})) } catch { /* ignore */ } }, 30)
  })
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))

  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') })
  try {
    await facade.start()
    await facade.configure({
      enabled: true,
      relayUrl: `http://127.0.0.1:${relay.address().port}`,
      instanceId: 'i1',
      pairingCode: '123456',
      name: 'Test',
      upstreamPort: 12345,
      lanPort: 18787,
      lanEnabled: false,
      lanSecret: randomBytes(32).toString('hex'),
    })
    await waitFor(async () => (await facade.request('/status')).tunnel.state === 'connected', 5000, '隧道应注册成功')

    // 1) 旧上限（1MB）会拒掉的量级：2MB 的镜像必须推得进去
    const filler = 'x'.repeat(2 * 1024 * 1024)
    const before = syncs
    const ok = await facade.pushSync({ kind: 'sync', at: Date.now(), sessions: { filler } })
    assert.deepEqual(ok, { ok: true }, '2MB 的镜像推送应成功')
    assert.equal((await facade.request('/status')).tunnel.state, 'connected')
    await waitFor(() => syncs > before, 3000, '中转侧应收到这一帧 sync')
    assert.ok(lastSyncBytes > 1024 * 1024, `中转实收 ${lastSyncBytes} 字节，应超过旧的 1MB 上限`)

    // 2) 超过中转帧上限（8MB）时必须是 413，且说清多大
    let tooLarge = null
    try {
      await facade.pushSync({ kind: 'sync', filler: 'y'.repeat(9 * 1024 * 1024) })
    } catch (error) { tooLarge = error }
    assert.ok(tooLarge, '9MB 的推送应被拒')
    // 这条断言是本次排查的真正教训：没有它，错误只会是一句没头没尾的 503。
    assert.match(tooLarge.message, /413/, `错误里应带状态码，实际：${tooLarge.message}`)
    assert.match(tooLarge.message, /too large/i, `错误里应带 worker 的原文，实际：${tooLarge.message}`)
    assert.match(tooLarge.message, /\d+/, '错误里应带具体字节数，便于判断该缩镜像还是该改上限')

    // 3) 推大了不能把隧道带走：中转遇到超帧是直接 1009 关隧道的
    await delay(300)
    const after = await facade.request('/status')
    assert.equal(after.tunnel.state, 'connected', '一次被拒的推送不得影响隧道')
    assert.equal(after.tunnel.error, null)

    // 4) 被拒之后还得能继续正常推——上限不是把通道焊死
    const after2 = syncs
    const small = await facade.pushSync({ kind: 'sync', at: Date.now(), sessions: { items: [] } })
    assert.deepEqual(small, { ok: true })
    await waitFor(() => syncs > after2, 3000, '被拒之后仍应能继续推送')

    assert.ok(socket, '隧道 socket 应仍在')
    console.log('mirror body limit tests passed')
  } finally {
    await facade.stop()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => relay.close(resolve))
    await new Promise((resolve) => parent.close(resolve))
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })

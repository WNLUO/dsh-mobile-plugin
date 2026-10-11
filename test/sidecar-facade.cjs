'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const { randomBytes } = require('node:crypto')
const { WebSocketServer } = require('ws')
const { SidecarFacade } = require('../lib/sidecar-facade.cjs')

// worker 的重连间隔是固定的 5s（lib/sidecar-facade-worker.cjs 的 scheduleReconnect）。
const RECONNECT_MS = 5000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(100)
  }
  throw new Error(message)
}

;(async () => {
  // 假父进程：真实流量里只有 /api/relay/internal/approval 会被调用（配对审批），
  // 本用例不触发配对，所以只需要一个能应答的端口。
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))

  // 假中转：完成 WebSocket 握手后立刻用关闭帧踢掉连接，并且**不**回 registered。
  // 这样 RelayTunnel.start() 里 ws 的 close 分支会同时触发 worker 的两条失败路径
  // ——tunnel.onClose 与 start().catch——它们必须共用同一个幂等的 scheduleReconnect。
  let attempts = 0
  const relay = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server: relay })
  wss.on('connection', (socket) => { attempts += 1; socket.close(1008, 'test-close') })
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

    assert.equal((await facade.request('/health')).capabilities.includes('relay-tunnel'), true)
    assert.equal((await facade.request('/status')).instanceId, 'i1')

    // 端到端这里只断言「连接失败后确实会自动重连」；幂等性（每次失败只重连一次）
    // 由 test/reconnect-scheduler.test.cjs 用毫秒级延迟精确验证 —— 在本用例里数
    // 连接次数分不出幂等有没有被破坏：startTunnel 开头的 stopTunnel 会吸收
    // 重复定时器造成的大部分可见差异。
    await delay(2000)
    assert.equal(attempts, 1, `首次连接只应尝试一次，实际 ${attempts} 次`)
    await waitFor(() => attempts >= 2, RECONNECT_MS + 5000, 'worker 应自动重连一次')

    console.log('sidecar facade e2e passed')
  } finally {
    await facade.stop()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => relay.close(resolve))
    await new Promise((resolve) => parent.close(resolve))
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })

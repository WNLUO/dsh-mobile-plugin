'use strict'
// 局域网代理的「状态」与「可达性」。
//
// 背景：/api/relay/status 的 lan.state 曾经永远停在 'connecting'。worker 侧
// startLan() 的 start() 一 resolve 就会把 lanState 置为 'listening'，但插件侧
// 只在 configure() 的那一刻取一次快照——那时 start() 还没 resolve，于是快照里
// 恒为 'connecting'；10s 一次的健康轮询虽然拿到了权威 /status，却只用来判断隧道
// 连接跳变，结果被直接丢弃。用户据此会以为局域网直连根本没起来。
//
// 本用例分两部分：
//  1) 行为面：worker 真的在 lanPort 上监听、能应答，并且总开关关闭后必须停掉；
//  2) 契约面：插件必须把轮询到的权威状态回写快照，否则第 1 部分的正确状态永远
//     传不到 /api/relay/status。
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')
const { SidecarFacade } = require('../lib/sidecar-facade.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(message)
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

// 只关心「有没有人应答」，所以只取状态码。
// 局域网端口是否在监听：未认证时**任何**客户端（浏览器导航也一样）都只拿 JSON 401。
//
// 这里特意带上 `Accept: text/html` —— 网页版配对页 2026-10 已砍掉，浏览器导航
// 也必须是 401，而不是一张 200 的页面（否则 App 的 api.ts 会把 200+HTML
// 当成成功，把连接通道钉死在局域网上）。
const httpStatus = (port) => new Promise((resolve, reject) => {
  const req = http.get(
    { host: '127.0.0.1', port, path: '/', timeout: 4000, headers: { accept: 'text/html' } },
    (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    },
  )
  req.on('timeout', () => req.destroy(new Error('lan request timed out')))
  req.on('error', reject)
})

const refusesConnection = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.on('connect', () => { socket.destroy(); resolve(false) })
  socket.on('error', () => resolve(true))
  socket.setTimeout(2000, () => { socket.destroy(); resolve(false) })
})

;(async () => {
  // 假父进程：worker 只在配对审批时回调它，本用例不触发配对。
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}') })
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve))

  const lanPort = await freePort()
  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') })
  const baseConfig = {
    enabled: true,
    // 空 relayUrl：startTunnel() 会直接早退，所以本用例不需要假中转，
    // 局域网代理也只依赖 enabled/lanEnabled/upstreamPort。
    relayUrl: '',
    instanceId: 'lan1',
    pairingCode: '123456',
    name: 'LAN Test',
    upstreamPort: parent.address().port,
    lanPort,
    lanEnabled: true,
    lanSecret: randomBytes(32).toString('hex'),
  }

  try {
    await facade.start()
    await facade.configure(baseConfig)

    // --- 行为面 1：总开关打开时局域网代理必须真的监听并应答 ---
    await waitFor(
      async () => (await facade.request('/status'))?.lan?.state === 'listening',
      8000,
      `lan.state 应变为 listening，实际 ${JSON.stringify((await facade.request('/status'))?.lan)}`,
    )
    const status = await facade.request('/status')
    assert.equal(status.lan.enabled, true)
    assert.equal(status.lan.port, lanPort)
    assert.equal(await httpStatus(lanPort), 401, '局域网端口未认证时应答 401（不再有网页）')

    // --- 行为面 2：总开关关闭后不得继续监听 ---
    // 这是刻意的守卫（见 lib/sidecar-facade-worker.cjs startLan 的注释）：旧实现
    // 漏了 config.enabled，于是关掉远程连接后局域网代理仍在接受配对。
    await facade.configure({ ...baseConfig, enabled: false })
    assert.equal((await facade.request('/status')).lan.state, 'off')
    assert.equal(await refusesConnection(lanPort), true, '总开关关闭后局域网端口不应再接受连接')

    // --- 契约面：插件必须回写轮询到的权威状态 ---
    const source = readFileSync(join(__dirname, '..', 'lib', 'sidecar-lifecycle.cjs'), 'utf8')
    const poll = source.slice(source.indexOf("sidecar.request('/status')"))
    assert.match(
      poll.slice(0, 600),
      /if\s*\(\s*st\s*\)\s*sidecarSnapshot\s*=\s*st/,
      '健康轮询必须把权威 /status 回写 sidecarSnapshot，否则 /api/relay/status 的 lan.state 会永远停在 connecting',
    )
    assert.match(
      poll.slice(0, 600),
      /noteTunnelConnected\(/,
      '回写快照不应破坏原有的隧道连接跳变检测',
    )
    // 边沿判定现在只有一处实现（轮询兜底 + worker 的即时上报共用），所以「跳变检测还在」
    // 拆成两条：轮询必须调它，且它本身必须真的做跳变判定。断言没有放宽——原来只钉了
    // 一个局部变量名，现在钉的是共用实现本身。
    const helper = source.slice(source.indexOf('const noteTunnelConnected ='))
    assert.match(helper.slice(0, 400), /lastTunnelConnected/, '边沿判定实现里缺少跳变比较')

    console.log('lan status tests passed')
  } finally {
    await facade.stop()
    await new Promise((resolve) => parent.close(resolve))
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })

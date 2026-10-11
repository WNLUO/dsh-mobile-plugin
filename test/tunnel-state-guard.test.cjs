'use strict'
// 「状态不许由过期的隧道实例改写」。
//
// 背景：/status 报的 tunnel.state 和 /tunnel/send 的真值对不上，于是镜像推送
// 每一轮都撞 503。现场是 SHIYAN 上跑着的无头宿主 host.log 里
// 「bg queue: sidecar facade request failed: 503」持续刷屏，而同一条隧道其实在
// 正常转发会话（deliveredSeq 一路在涨）——推的通道和收的通道是同一条。
//
// 成因：worker 的 startTunnel() 里，onClose / onPairRequest / start().catch 都带
// 实例身份守卫（tunnel === current），只有 onRegistered 漏了。注册帧是在 ws 上异步
// 回来的，只要在这期间 configure() 或网络监视器重建了隧道，旧实例迟到的 registered
// 帧就会把 tunnelState 写成 'connected'——可此刻 tunnel 指向的是新实例，它的 ws 还
// 停在 CONNECTING，connected 是 false。
//
// 于是形成这个错位：/status 说「已连接」→ 宿主据此放行镜像推送 → worker 按真值回
// 503 tunnel not connected。状态越乐观，推送越是必然失败，而且没有任何补偿手段。
//
// 本用例把 startTunnel() 的**真源码**抠出来 eval，配上假的 RelayTunnel 驱动那条
// 时序——测的是真代码，不是照着真代码另写一遍（后者会在真代码坏掉时照样绿灯）。
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const worker = readFileSync(join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs'), 'utf8')

const START_TUNNEL_BODY = worker.slice(
  worker.indexOf('function startTunnel() {'),
  worker.indexOf('function startLan() {'),
)
assert.ok(START_TUNNEL_BODY.length > 0, '应能在 worker 源码里定位 startTunnel()')

// 把真源码连同它依赖的模块级状态一起装进一个闭包：tunnel / tunnelState /
// tunnelError 和 stopTunnel() 都按 worker 里的写法原样重建，这样 eval 出来的
// startTunnel 跑的就是生产逻辑。
function bootWorker() {
  const instances = []
  const log = { reconnects: 0, stopped: [], publishes: 0 }
  class StubRelayTunnel {
    constructor(opts) {
      this.opts = opts
      this.registered = false
      this.stopped = false
      instances.push(this)
    }
    // 真 start() 要等 registered 帧才 resolve；这里不 resolve——本用例要控制
    // 「哪一帧在什么时候回来」，让 resolve 自然发生会把时序锁死。
    start() { return new Promise(() => {}) }
    stop() { this.stopped = true; log.stopped.push(this) }
    sendPairConfirm() {}
    // 让这一帧「回来」
    deliverRegistered() { this.registered = true; this.opts.onRegistered() }
  }
  const api = new Function('deps', `
    const { config, core, RelayTunnel, upstream, lanUrls, lanUrlPort, snapshotRead, parentJson, log, publishState } = deps;
    let tunnel = null;
    let tunnelState = 'off';
    let tunnelError = null;
    // 与 lib/sidecar-facade-worker.cjs 的 stopTunnel() 逐行同义。
    const stopTunnel = () => {
      if (tunnel) tunnel.stop();
      tunnel = null; tunnelState = 'off'; tunnelError = null;
    };
    const scheduleReconnect = () => { log.reconnects++ };
    ${START_TUNNEL_BODY}
    return {
      startTunnel,
      snapshot: () => ({ state: tunnelState, error: tunnelError }),
      live: () => (tunnel && tunnel.registered ? 'open' : (tunnel ? 'connecting' : 'none')),
    };
  `)({
    config: {
      enabled: true, relayUrl: 'https://relay.invalid', instanceId: 'i1',
      pairingCode: '123456', name: 'LAN Test', upstreamPort: 19387,
      lanEnabled: true, lanSecret: 's',
    },
    core: { tunnelWsUrl: (u) => u, signLanToken: () => 'tok', MOBILE_BEARER_TTL_SEC: 60 },
    RelayTunnel: StubRelayTunnel,
    upstream: () => ({}),
    lanUrls: () => [],
    lanUrlPort: () => 18787,
    snapshotRead: async () => null,
    parentJson: async () => ({ approved: false }),
    log,
    // worker 的 publishState()：状态跳变要立刻经 IPC 推给宿主，别等 10s 健康轮询。
    // 这里只数调用次数；「推的是不是真状态」由下面的契约断言钉住。
    publishState: () => { log.publishes += 1 },
  })
  return { ...api, instances, log }
}

// ── 契约面：回调里凡是写状态的，往上都得有身份守卫 ──────────────────────────
// 只看 new RelayTunnel({ 之后：它之前那行 stopTunnel(); tunnelState = 'connecting'
// 本来就是新实例在宣告自己，没有「过期」可言，不该被要求带守卫。
{
  const lines = START_TUNNEL_BODY.split('\n')
  const fromCallbacks = lines.findIndex((l) => l.includes('new RelayTunnel('))
  assert.ok(fromCallbacks > 0, '应能定位到 new RelayTunnel(')
  const writers = []
  lines.forEach((line, i) => {
    if (i <= fromCallbacks) return
    if (!/\btunnelState\s*=|\btunnelError\s*=/.test(line)) return
    // 守卫可以就在同一行（`onRegistered: () => { if (tunnel !== current) return; …`），
    // 也可以是紧挨着的上一行。两处都算。
    const near = `${lines[i - 1] || ''}${line}`
    writers.push({ line: i + 1, text: line.trim().slice(0, 58), guarded: /tunnel (===|!==) current/.test(near) })
  })
  assert.ok(writers.length >= 3, `回调里应至少找到 3 处状态写入，实际 ${writers.length}`)
  for (const w of writers) {
    assert.ok(
      w.guarded,
      `第 ${w.line} 行在回调里写状态却没有实例身份守卫：${w.text}\n` +
      '过期实例的回调一旦改状态，/status 就会撒谎，宿主据此放行的推送必然撞 503。',
    )
  }
}

// ── 行为面：旧实例迟到的 registered 不许污染状态 ────────────────────────────
{
  const w = bootWorker()

  w.startTunnel()
  const first = w.instances[0]
  assert.equal(w.snapshot().state, 'connecting', '刚建实例时是 connecting')
  assert.equal(w.live(), 'connecting', '底层 ws 还没 OPEN')

  first.deliverRegistered()
  assert.equal(w.snapshot().state, 'connected', '当前实例注册成功 → connected')
  assert.equal(w.live(), 'open')

  // configure() 或网络监视器重建隧道；旧实例必须被停掉
  w.startTunnel()
  const second = w.instances[1]
  assert.equal(first.stopped, true, '重建时旧实例必须 stop()')
  assert.equal(w.snapshot().state, 'connecting')
  assert.equal(w.live(), 'connecting', '新实例的 ws 还没 OPEN，底层并未连上')

  // 旧实例迟到的注册帧此刻才回来
  first.deliverRegistered()
  assert.equal(
    w.snapshot().state,
    'connecting',
    '过期实例的注册帧不得把状态改成 connected：/status 一旦撒谎，宿主就会放行镜像推送并必然撞 503',
  )

  second.deliverRegistered()
  assert.equal(w.snapshot().state, 'connected', '新实例真正注册成功后才算 connected')
  assert.equal(w.snapshot().error, null)
}

// ── 行为面 2：断线必须由「当前」实例记账并安排重连 ──────────────────────────
{
  const w = bootWorker()
  w.startTunnel()
  const first = w.instances[0]
  first.deliverRegistered()

  w.startTunnel()
  const second = w.instances[1]
  second.deliverRegistered()

  // 旧实例的 close 迟到：不得把刚连好的状态打成 error，也不得触发重连
  first.opts.onClose(1006, 'stale')
  assert.equal(w.snapshot().state, 'connected', '过期实例的断线不得覆盖当前状态')
  assert.equal(w.log.reconnects, 0, '过期实例的断线不得安排重连，否则就是重连风暴')

  // 当前实例真的断了：必须记账并安排重连
  second.opts.onClose(1006, 'gone')
  assert.equal(w.snapshot().state, 'error')
  assert.equal(w.snapshot().error, '连接断开')
  assert.equal(w.log.reconnects, 1)
}

// ── 契约面 2 + 行为面 3：状态跳变必须立刻上报，不等 10s 健康轮询 ──────────────
// 轮询是权威但滞后：隧道真断之后宿主最多 10s 仍认为已连接，期间照常推镜像，每次撞
// sidecar-facade 的 5s 超时，该会话的单飞门被占住，事件只能合并成一次补推。所以
// worker 的每一个状态写入点都必须顺手 publishState()。
{
  const define = worker.slice(worker.indexOf('function publishState() {'), worker.indexOf('function send(res, code, value) {'))
  assert.ok(define.includes('type: \'state\''), 'publishState 必须发一条 type=state 的 IPC 消息')
  assert.match(define, /tunnel: \{ state: tunnelState, error: tunnelError \}/, '状态消息必须带真实 tunnel 状态')
  assert.match(define, /process\.send\?\.\(/, '必须走 IPC（没有父进程时要能静默跳过）')
  // 三处状态跳变（connecting / connected / error）都得上报，少一处就回到「滞后 10s」。
  const publishes = START_TUNNEL_BODY.match(/publishState\(\)/g) || []
  assert.ok(publishes.length >= 3, `startTunnel 里应至少 3 处 publishState()，实际 ${publishes.length}`)
}
{
  const w = bootWorker()
  w.startTunnel()
  assert.equal(w.log.publishes, 1, '建实例（connecting）就该上报一次')
  const first = w.instances[0]
  first.deliverRegistered()
  assert.equal(w.log.publishes, 2, '注册成功（connected）必须立刻上报')
  assert.equal(w.snapshot().state, 'connected')

  // 过期实例的帧不该上报：上报的是状态，状态本身没变，多报一次就是让宿主白补推一轮。
  w.startTunnel()
  assert.equal(w.log.publishes, 3, '重建（connecting）上报')
  first.deliverRegistered()
  assert.equal(w.log.publishes, 3, '过期实例的注册帧不得上报状态跳变')

  const second = w.instances[1]
  second.deliverRegistered()
  assert.equal(w.log.publishes, 4, '新实例真正连上才上报 connected')
  second.opts.onClose(1006, 'gone')
  assert.equal(w.log.publishes, 5, '断线必须立刻上报 error（宿主据此停止推镜像，而不是再撞 10s 超时）')
}

console.log('tunnel state guard tests passed')

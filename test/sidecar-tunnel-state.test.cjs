'use strict'

/**
 * 钉住「隧道状态跳变必须**立刻**回写宿主快照」这条链：
 * worker publishState() → IPC → SidecarFacade.onState → applyTunnelState → tunnelConnected()。
 *
 * 为什么需要：`tunnelConnected()` 是宿主决定「要不要推镜像」的唯一权威，而它原来只由
 * 10s 一次的健康轮询回写。于是隧道真断之后最多 10s 内宿主仍认为已连接，期间照常推镜像、
 * 每次撞 sidecar-facade 的 5s 超时，该会话的单飞门被占住，事件只能合并成一次补推；
 * 反过来，隧道「断又连」若整段落在两次轮询之间，宿主看不到跳变，onTunnelUp 那次全量
 * 补推会被漏掉。
 *
 * 这里用 require.cache 注入一个假 facade（lib/sidecar-lifecycle.cjs 真源码 require 的
 * 就是它），跑的是真生命周期代码，不是照着重写一遍。
 */
const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const FACADE = require.resolve(path.join(__dirname, '..', 'lib', 'sidecar-facade.cjs'))
const LIFECYCLE = require.resolve(path.join(__dirname, '..', 'lib', 'sidecar-lifecycle.cjs'))

function boot() {
  const state = {
    options: null,
    // 假 worker：configure()/status 都回这一份，测试随时改它。
    status: { tunnel: { state: 'off', error: null }, lan: { state: 'off', error: null } },
  }
  class FakeFacade {
    constructor(options) { this.options = options; state.options = options }
    async start() {}
    async stop() {}
    async configure() { return state.status }
    async request() { return state.status }
  }
  require.cache[FACADE] = { id: FACADE, filename: FACADE, loaded: true, exports: { SidecarFacade: FakeFacade } }
  delete require.cache[LIFECYCLE]
  const { createSidecarLifecycle } = require(LIFECYCLE)
  const lc = createSidecarLifecycle({
    ctx: { webServer: { port: 19387 } },
    lanPortInUse: () => 18787,
    resolveLanPort: async () => 18787,
    buildConfig: async () => ({ enabled: false }),
  })
  return { lc, state }
}

test('worker 报来的状态跳变立刻回写快照，且一次重连只补推一次全量镜像', () => {
  const { lc, state } = boot()
  assert.equal(typeof state.options.onState, 'function', 'facade 必须把 worker 的状态上报转给宿主')
  let ups = 0
  lc.onTunnelUp(() => { ups += 1 })
  assert.equal(lc.getSnapshot().tunnel.state, 'off')
  assert.equal(lc.tunnelConnected(), false)

  state.options.onState({ type: 'state', tunnel: { state: 'connecting', error: null } })
  assert.equal(lc.tunnelConnected(), false, 'connecting 不算已连接')
  assert.equal(ups, 0, '还没连上就不该补推')

  state.options.onState({ type: 'state', tunnel: { state: 'connected', error: null } })
  assert.equal(lc.getSnapshot().tunnel.state, 'connected', '状态必须立刻回写，不能等 10s 轮询')
  assert.equal(lc.tunnelConnected(), true)
  assert.equal(ups, 1, '隧道刚连上要触发一次全量补推')

  state.options.onState({ type: 'state', tunnel: { state: 'connected', error: null } })
  assert.equal(ups, 1, '重复上报 connected 不得再补推（边沿判定只能有一次）')

  state.options.onState({ type: 'state', tunnel: { state: 'error', error: '连接断开' } })
  assert.equal(lc.tunnelConnected(), false, '断线必须立刻变 false，宿主据此停止推镜像')
  assert.equal(lc.getSnapshot().tunnel.error, '连接断开')

  state.options.onState({ type: 'state', tunnel: { state: 'connected', error: null } })
  assert.equal(ups, 2, '重连后要再补推一次')
})

test('状态上报里的局域网字段一并回写，无关消息不得改状态', () => {
  const { lc, state } = boot()
  state.options.onState({
    type: 'state',
    tunnel: { state: 'connected', error: null },
    lan: { state: 'listening', port: 18787, requestedPort: 18787 },
  })
  assert.equal(lc.getSnapshot().lan.state, 'listening', '局域网状态也要跟着跳变回写')
  assert.equal(lc.getSnapshot().lan.port, 18787)
  assert.doesNotThrow(() => state.options.onState({ type: 'ready', port: 1234 }))
  assert.doesNotThrow(() => state.options.onState(null))
  assert.equal(lc.getSnapshot().tunnel.state, 'connected', '无关消息不得改状态')
})

test('对外报的局域网端口以 worker 实绑端口为准（不是宿主解析值）', () => {
  // 真机故障（2026-10-10）：宿主解析出 50933（写进 relay.json 与二维码），而 sidecar 自己
  // bind 到了 55583 —— 状态接口、connection-info、配对二维码全报一个没人监听的死端口，
  // 手机在家用 Wi-Fi 只能退回公网中转。两条端口自适应必须统一到 worker 报的那个。
  const { lc, state } = boot()
  // boot() 注入的宿主侧取值器是 18787；这一行就是「手机该拨哪个端口」的唯一正确答案。
  assert.equal(lc.getSnapshot().lan.port, undefined, '还没上报时快照里没有端口')
  assert.equal(lc.getAdvertisedLanPort(), 18787, 'worker 还没报端口时回落到宿主解析值')
  state.options.onState({
    type: 'state',
    tunnel: { state: 'connected', error: null },
    lan: { state: 'listening', port: 55583, requestedPort: 18787 },
  })
  assert.equal(lc.getAdvertisedLanPort(), 55583, 'worker 报了实绑端口就必须用它，否则对外全是死地址')
})

test('健康轮询与即时上报共用边沿判定：不重复补推，也不漏掉「断又连」', async () => {
  const { lc, state } = boot()
  let ups = 0
  lc.onTunnelUp(() => { ups += 1 })
  const timers = []
  const realSetInterval = global.setInterval
  global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
  try {
    lc.start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    state.options.onState({ type: 'state', tunnel: { state: 'connected', error: null } })
    assert.equal(ups, 1, '即时上报先到：补推一次')

    const poll = timers.find((t) => t.ms === 10000)
    assert.ok(poll, '健康轮询定时器必须存在（它是唯一能发现「worker 整个没了」的路径）')
    state.status = { tunnel: { state: 'connected', error: null }, lan: { state: 'off', error: null } }
    await poll.fn()
    assert.equal(ups, 1, '轮询看到同一个 connected 不得重复补推')

    // 隧道在两次轮询之间断又连：轮询看不到跳变，只有即时上报能抓住。
    state.options.onState({ type: 'state', tunnel: { state: 'error', error: '连接断开' } })
    assert.equal(lc.tunnelConnected(), false)
    state.options.onState({ type: 'state', tunnel: { state: 'connected', error: null } })
    assert.equal(ups, 2, '「断又连」必须补上那一次全量推送')
  } finally {
    global.setInterval = realSetInterval
  }
})

test('facade 只把 type=state 的消息转给宿主', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'sidecar-facade.cjs'), 'utf8')
  assert.match(src, /this\.onState = typeof options\.onState === 'function' \? options\.onState : null/, 'facade 必须接受 onState')
  // ready 用的是 child.once('message')，会把第一条消息吃掉——状态帧必须用常驻监听。
  assert.match(src, /child\.on\('message', message => \{\s*\n\s*if \(!this\.onState \|\| !message \|\| message\.type !== 'state'\) return/, '状态帧必须走 child.on(message) 且只认 type=state')
})

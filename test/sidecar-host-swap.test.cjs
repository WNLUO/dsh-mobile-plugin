'use strict'
// 更新不断：传输进程跨代存活。

/**
 * 钉住「换代不断传输」这条链：sidecar 由稳定外壳持有，换代只 `setProviders` + 补推配置，
 * **不得**重新 fork worker、**不得** stop，且下发的配置签名不变（worker 据此不重建隧道）。
 *
 * 用 require.cache 注入假 facade，跑的是真生命周期代码；真 worker 的「同签名不重建」由
 * `test/configure-diff.test.cjs` 单独钉住，这里钉外壳/换代这一侧。
 */
const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const FACADE = require.resolve(path.join(__dirname, '..', 'lib', 'sidecar-facade.cjs'))
const LIFECYCLE = require.resolve(path.join(__dirname, '..', 'lib', 'sidecar-lifecycle.cjs'))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const CONFIG_A = {
  enabled: true,
  relayUrl: 'https://relay.example.com',
  relayUrls: ['https://relay.example.com'],
  instanceId: 'inst-1',
  pairingCode: '123456',
  pairingTicket: '',
  pairingTier: 'full',
  name: 'host-1',
  upstreamPort: 19387,
  upstreamHost: '127.0.0.1',
  lanPort: 18787,
  lanEnabled: true,
  lanSecret: 's',
  registerSecret: 'r',
}

function boot() {
  const calls = { construct: 0, start: 0, stop: 0, configure: [] }
  class FakeFacade {
    constructor(options) { calls.construct += 1; this.options = options }
    async start() { calls.start += 1 }
    async stop() { calls.stop += 1 }
    async configure(config) {
      calls.configure.push(config)
      return { tunnel: { state: 'connected', error: null }, lan: { state: 'off', error: null } }
    }
    async request() { return { tunnel: { state: 'connected', error: null }, lan: { state: 'off', error: null } } }
  }
  require.cache[FACADE] = { id: FACADE, filename: FACADE, loaded: true, exports: { SidecarFacade: FakeFacade } }
  delete require.cache[LIFECYCLE]
  const { createSidecarLifecycle } = require(LIFECYCLE)
  let config = CONFIG_A
  const providers = {
    lanPortInUse: () => 18787,
    resolveLanPort: async () => 18787,
    buildConfig: () => config,
    onLanState: () => {},
    pluginLibDir: path.join(__dirname, '..', 'lib'),
  }
  const lc = createSidecarLifecycle({ ctx: { webServer: { port: 19387 } }, ...providers })
  return { lc, calls, setConfig: (next) => { config = next }, providers }
}

test('换代：换配置来源并补推配置，不重启 worker、不 stop、配置不变', async () => {
  const timers = []
  const realSetInterval = global.setInterval
  global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
  try {
    const { lc, calls } = boot()
    lc.start()
    await tick(); await tick()
    assert.equal(calls.start, 1, '首次启动应 fork 一次 worker')
    assert.ok(calls.configure.length >= 1, '首次启动应下发一次配置')

    const stopBefore = calls.stop
    const startBefore = calls.start
    const constructBefore = calls.construct

    // 模拟一代被换掉、新的一代接管同一个外壳持有的 sidecar。
    lc.setProviders({
      lanPortInUse: () => 18787,
      resolveLanPort: async () => 18787,
      buildConfig: () => CONFIG_A,
      onLanState: () => {},
      pluginLibDir: path.join(__dirname, '..', 'lib'),
    })
    assert.equal(lc.isStarted(), true, '换代时传输进程必须仍处于已启动状态')
    lc.start() // 新的一代也会调一次 start()：必须幂等、不重新 fork
    assert.equal(calls.start, startBefore, '换代再调 start 不得再次 fork worker')
    assert.equal(calls.construct, constructBefore, '换代不得新建 facade 实例')

    await lc.syncSidecar()
    assert.equal(calls.stop, stopBefore, '换代不得 stop 传输进程（那等于断隧道）')

    const last = calls.configure[calls.configure.length - 1]
    assert.deepEqual(last, CONFIG_A, '换代补推的配置必须与原来一致，worker 据此不重建隧道')

    lc.stop()
    await tick()
  } finally {
    global.setInterval = realSetInterval
  }
})

test('start 幂等：连续调用只 fork 一次', async () => {
  const timers = []
  const realSetInterval = global.setInterval
  global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
  try {
    const { lc, calls } = boot()
    lc.start()
    lc.start()
    await tick(); await tick()
    assert.equal(calls.start, 1, '两次 start 只能 fork 一次 worker')
    assert.equal(calls.construct, 1, '两次 start 只能建一个 facade')
    lc.stop()
    await tick()
  } finally {
    global.setInterval = realSetInterval
  }
})

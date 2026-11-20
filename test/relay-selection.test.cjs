// 用生产选路代码验证注册竞速、代次取消与墙钟跳变下的单调预算。
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRelayRegistrationLedger } = require('../lib/relay/relay-probe.js')
const source = fs.readFileSync(path.join(__dirname, '../lib/sidecar-facade-worker.cjs'), 'utf8')
const body = source.slice(source.indexOf('function openTunnel('), source.lastIndexOf('\n', source.indexOf('function startLan(')))
const stopBody = source.slice(source.indexOf('function stopTunnel('), source.indexOf('function startNetworkMonitor('))
const outdatedBody = source.slice(source.indexOf('function markOutdated('), source.indexOf('function send(res,'))

function clock() {
  let now = 1000000
  let wallOffset = 0
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    wallNow: () => now + wallOffset,
    jumpWall(ms) { wallOffset += ms },
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: now + ms, fn }); return key },
    clearTimeout(key) { timers.delete(key) },
    pendingCount: () => timers.size,
    async advance(ms) {
      const until = now + ms
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = entry[1].at; timers.delete(entry[0]); entry[1].fn()
        for (let i = 0; i < 8; i++) await Promise.resolve()
      }
      now = until
      for (let i = 0; i < 8; i++) await Promise.resolve()
    },
  }
}

function boot(urls = ['https://a', 'https://b', 'https://c', 'https://d']) {
  const time = clock()
  const instances = []
  const events = { failures: [], successes: [], reconnects: [], states: [], resets: 0 }
  const health = []
  const policy = createRelayRegistrationLedger({ now: time.now })
  const ledger = {
    order: policy.order,
    noteFailure(url) { events.failures.push(url); policy.noteFailure(url) },
    noteSuccess(url) { events.successes.push(url); policy.noteSuccess(url) },
  }
  class StubTunnel {
    constructor(opts) { this.opts = opts; this.stopped = false; this.relayMirror = true; instances.push(this) }
    start() {
      this.startedAt = time.now()
      return new Promise((resolve, reject) => {
        this.resolve = resolve; this.reject = reject
        this.timer = time.setTimeout(() => this.fail(new Error('注册超时')), 8000)
      })
    }
    open() { this.opened = true }
    registered() {
      time.clearTimeout(this.timer); this.connected = true
      this.opts.onRegistered(); this.resolve()
    }
    fail(error = new Error('注册失败')) {
      time.clearTimeout(this.timer); this.connected = false
      this.reject(error); this.opts.onClose()
    }
    stop() {
      if (this.stopped) return
      this.stopped = true; this.connected = false; time.clearTimeout(this.timer)
      const error = new Error('cancelled'); error.code = 'relay_cancelled'
      this.reject?.(error); this.opts.onClose()
    }
    sendPairConfirm() {}
  }
  const config = { enabled: true, upstreamPort: 1234, instanceId: 'instance', relayUrl: urls[0], relayUrls: [...urls] }
  const api = new Function('deps', `
    const { config, RelayTunnel, relayRegistrations, events, health, time } = deps;
    const Date = { now: time.wallNow };
    const performance = { now: time.now };
    const setTimeout = time.setTimeout;
    const clearTimeout = time.clearTimeout;
    const RELAY_RACE_CONCURRENCY = 3, RELAY_RACE_TIMEOUT_MS = 10000, OUTDATED_RETRY_MS = 1800000, PROBE_CONCURRENCY = 6;
    let tunnel = null, relayRace = null, tunnelRoute = null, connectedRelayUrl = null;
    let tunnelState = 'off', tunnelError = null, relayMirror = true, tunnelGeneration = 0;
    let relayLatencyAt = 0, relayLatencyCache = new Map();
    const reconnect = { cancel() {}, reset() { events.resets++ }, schedule(ms) { events.reconnects.push(ms) } };
    const scheduleReconnect = () => events.reconnects.push(5000);
    const relayFailureMessage = error => String(error?.message || error);
    const publishState = () => events.states.push({ state: tunnelState, url: connectedRelayUrl, route: tunnelRoute });
    const core = { normalizeRelayUrl: url => String(url || '').trim(), tunnelWsUrl: url => url, signLanToken: () => 'token' };
    const upstream = () => 'http://127.0.0.1:1234';
    const currentLanUrls = () => [];
    const snapshotRead = () => null;
    const parentJson = async () => ({ approved: false });
    const probeRelayHealth = url => new Promise(resolve => health.push({ url, resolve }));
    ${outdatedBody}
    ${stopBody}
    ${body}
    return { startTunnel, stopTunnel, raceTunnels, refreshRelayLatency, relayRoutePlan,
      snapshot: () => ({ state: tunnelState, error: tunnelError, url: connectedRelayUrl, current: tunnel, raceActive: Boolean(relayRace), tunnelGeneration }),
    };
  `)({ config, RelayTunnel: StubTunnel, relayRegistrations: ledger, events, health, time })
  return { ...api, config, instances, events, health, time }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('首连不等健康探测：最多三条，只有真实 registered 才赢，输家立即停且不记失败', async () => {
  const h = boot()
  h.startTunnel()
  assert.equal(h.instances.length, 3, '健康请求仍挂起时已经开始受控注册')
  h.instances[0].open()
  assert.equal(h.snapshot().state, 'connecting', '握手 open 不是注册成功')
  assert.equal(h.events.successes.length, 0)
  h.instances[1].registered()
  await flush()
  assert.equal(h.snapshot().state, 'connected')
  assert.equal(h.snapshot().url, 'https://b', '对外公布真实赢家而不是配置首项')
  assert.equal(h.snapshot().current, h.instances[1])
  assert.equal(h.instances[1].stopped, false)
  assert.ok(h.instances[0].stopped && h.instances[2].stopped)
  assert.deepEqual(h.events.failures, [])
  assert.deepEqual(h.events.successes, ['https://b'])
  h.instances[0].registered()
  assert.equal(h.snapshot().current, h.instances[1], '迟到回执不能夺走赢家')
  h.stopTunnel(); await flush()
})

test('同一中转的不同入口不能同时注册，其他中转仍可并发', async () => {
  const h = boot(['https://same.example/a', 'https://same.example/b', 'https://other.example', 'https://third.example'])
  h.startTunnel()
  assert.deepEqual(h.instances.map(current => current.opts.relayUrl), ['https://same.example/a', 'https://other.example', 'https://third.example'])
  h.instances[0].fail(); await flush()
  assert.equal(h.instances[3].opts.relayUrl, 'https://same.example/b')
  h.stopTunnel(); await flush()
})

test('真实失败只记一次并立即补一个候选；健康成功不能洗掉该失败账', async () => {
  const h = boot()
  h.startTunnel()
  h.instances[0].fail()
  await flush()
  assert.deepEqual(h.events.failures, ['https://a'])
  assert.equal(h.instances.length, 4)
  assert.ok(h.instances[0].stopped)
  assert.equal(h.events.reconnects.length, 0, '中间失败不排重连')
  for (const entry of h.health) entry.resolve(entry.url === 'https://a' ? 1 : 50)
  await flush()
  assert.notEqual(h.relayRoutePlan()[0], 'https://a', '最快健康响应压不过真实失败')
  h.instances[3].registered(); await flush()
  assert.equal(h.snapshot().url, 'https://d')
  assert.deepEqual(h.events.successes, ['https://d'])
  assert.equal(h.events.reconnects.length, 0)
  h.stopTunnel(); await flush()
})

test('整轮最多十秒，未获完整注册预算的后备不启动也不记失败，下轮仍能优先尝试', async () => {
  const h = boot()
  h.startTunnel()
  await h.time.advance(8000)
  assert.equal(h.instances.length, 3, '剩两秒不能给新候选一份残缺注册预算')
  assert.equal(h.snapshot().state, 'error')
  assert.equal(h.events.reconnects.length, 1, '全失败只安排一次退避')
  assert.deepEqual(h.events.failures.sort(), ['https://a', 'https://b', 'https://c'])
  h.startTunnel()
  assert.equal(h.instances[3].opts.relayUrl, 'https://d', '未尝试候选下轮保留并优先')
  await h.time.advance(7900)
  h.instances[3].registered(); await flush()
  assert.equal(h.snapshot().url, 'https://d', '高延迟但在真实注册预算内成功的候选仍可用')
  h.stopTunnel(); await flush()
})

test('墙钟回拨或前跳不改变轮内预算，后备不会在真实八秒后只获残余两秒', async () => {
  for (const jump of [-3600000, 3600000]) {
    const h = boot()
    h.startTunnel()
    await h.time.advance(1000)
    h.time.jumpWall(jump)
    await h.time.advance(7000)
    assert.equal(h.instances.length, 3, '后备不能借墙钟变化突破完整八秒注册预算')
    assert.equal(h.snapshot().state, 'error')
    assert.deepEqual(h.events.failures.sort(), ['https://a', 'https://b', 'https://c'], '未启动后备不受残余预算误罚')
    h.startTunnel()
    const next = h.instances[3]
    assert.equal(next.opts.relayUrl, 'https://d')
    assert.equal(next.startedAt, h.time.now())
    h.time.jumpWall(-jump * 2)
    await h.time.advance(7900)
    assert.equal(next.stopped, false, '下一轮真实注册预算不会被前跳提前耗尽')
    next.registered(); await flush()
    assert.equal(h.snapshot().url, 'https://d')
    assert.equal(h.events.failures.includes('https://d'), false)
    h.stopTunnel(); await flush()
  }
})

test('健康缓存五分钟年龄只跟经过时间，墙钟前跳不提前过期、回拨不延长', async () => {
  const h = boot(['https://a', 'https://b'])
  h.startTunnel()
  h.health.forEach(entry => entry.resolve(entry.url === 'https://a' ? 90 : 1))
  await flush()
  h.instances[0].registered(); await flush()
  assert.equal(h.relayRoutePlan()[0], 'https://b')
  h.time.jumpWall(86400000)
  assert.equal(h.relayRoutePlan()[0], 'https://b', '墙钟前跳不让新鲜健康证据过期')
  h.time.jumpWall(-172800000)
  await h.time.advance(300001)
  assert.equal(h.relayRoutePlan()[0], 'https://a', '真实五分钟后回到配置顺序，回拨不能延长缓存')
  h.stopTunnel(); await flush()
})

test('没有任何候选回调时整轮期限停止全部候选，只记真实在飞失败', async () => {
  const h = boot()
  h.startTunnel()
  for (const current of h.instances) h.time.clearTimeout(current.timer)
  await h.time.advance(10000)
  assert.equal(h.snapshot().state, 'error')
  assert.match(h.snapshot().error, /择路超时/)
  assert.ok(h.instances.every(current => current.stopped))
  assert.deepEqual(h.events.failures.sort(), ['https://a', 'https://b', 'https://c'])
  assert.equal(h.events.reconnects.length, 1)
})

test('重配换代停止全部旧候选，旧健康与迟到回执均不能覆盖新连接', async () => {
  const h = boot()
  h.startTunnel()
  const stale = h.instances.slice()
  const oldHealth = h.health.slice()
  h.startTunnel()
  assert.ok(stale.every(current => current.stopped))
  assert.equal(h.instances.length, 6)
  stale[0].registered()
  oldHealth.forEach(entry => entry.resolve(1))
  await flush()
  assert.equal(h.snapshot().state, 'connecting')
  assert.deepEqual(h.events.failures, [])
  h.instances[4].registered(); await flush()
  assert.equal(h.snapshot().current, h.instances[4])
  assert.equal(h.events.resets, 1)
  h.stopTunnel(); await flush()
})

test('禁用和主动stop都清空候选与pending，不产生失败或重连', async () => {
  const h = boot()
  h.startTunnel()
  h.config.enabled = false
  h.stopTunnel(); await flush()
  assert.ok(h.instances.every(current => current.stopped))
  assert.equal(h.snapshot().raceActive, false)
  assert.equal(h.snapshot().state, 'off')
  assert.deepEqual(h.events.failures, [])
  assert.deepEqual(h.events.reconnects, [])
  assert.equal(await h.raceTunnels(), false)
})

test('真实 RelayTunnel 主动取消立即终止握手、清注册timer并拒绝迟到回执', async () => {
  const vm = require('node:vm')
  const { EventEmitter } = require('node:events')
  const { createRequire } = require('node:module')
  const file = path.join(__dirname, '../lib/relay/tunnel.js')
  const requireReal = createRequire(file)
  const time = clock()
  const sockets = []
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this) }
    send(frame) { this.sent.push(frame) }
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006, '') }
  }
  const loaded = { exports: {} }
  let intervals = 0
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: loaded, exports: loaded.exports,
    require: name => name === 'ws' ? { WebSocket: FakeWebSocket } : requireReal(name),
    process, Buffer, URL, Date,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    setInterval() { intervals++; return intervals }, clearInterval() { intervals-- },
  })
  let registered = 0
  const tunnel = new loaded.exports.RelayTunnel({ relayUrl: 'wss://relay.example/tunnel', instanceId: 'cancel', upstream: 'http://127.0.0.1:1234', onRegistered: () => registered++ })
  const pending = tunnel.start()
  const rejected = assert.rejects(pending, error => error.code === 'relay_cancelled')
  tunnel.stop()
  await rejected
  assert.equal(sockets[0].terminated, true)
  assert.equal(tunnel.cancelRegistration, null)
  assert.equal(time.pendingCount(), 0, '取消后不遗留8秒注册timer')
  assert.equal(intervals, 0)
  sockets[0].readyState = 1
  sockets[0].emit('open')
  const { T, jsonFrame } = requireReal('./protocol.js')
  sockets[0].emit('message', jsonFrame(T.registered, 0, {}), true)
  await time.advance(8000)
  assert.equal(registered, 0)
  assert.equal(sockets[0].sent.length, 0)
  assert.equal(tunnel.ws, null)
})

test('plugin_too_old 停止整轮走原专用重试，保持版本门槛且不记网络失败', async () => {
  const h = boot()
  h.startTunnel()
  h.instances[1].lastControlError = { code: 'plugin_too_old', message: '请更新插件' }
  h.instances[1].fail()
  await flush()
  assert.equal(h.snapshot().state, 'outdated')
  assert.deepEqual(h.events.reconnects, [1800000])
  assert.deepEqual(h.events.failures, [])
  assert.ok(h.instances.every(current => current.stopped))
  h.stopTunnel(); await flush()
})

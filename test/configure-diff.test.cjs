'use strict'
// 「配置下发只重建真正变了的那一半」。
//
// 现场（2026-10-17）：真机上切一次网络，接下来几秒点什么都失败；宿主日志里除了一串
// 「隧道关闭」，就是反复刷屏的「局域网代理开始监听」（一份宿主日志里 69 次），跑七小时
// 内存堆到 3.87G、宿主直接 OOM 闪退。根因是 worker 的 configure() 无条件 stopServices()
// 把隧道和局域网代理一起拆了重建——哪怕这次下发的配置一个字没变。
//
// 本用例把 configure() 与它的三个签名函数的**真源码**抠出来 eval，配上假的
// start/stop，测的是真代码而不是照抄一遍（照抄的用例在真代码坏掉时照样绿灯）。
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')

const workerSource = readFileSync(join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs'), 'utf8')
// 只抠两段真源码：三个签名函数（连 currentLanUrls / reannounceRegistration）与 configure
// 本体。中间的 start/stop 与网络监视器由用例注入桩——它们各自有别的守卫钉着。
const SIGNATURES_BODY = workerSource.slice(
  workerSource.indexOf('function tunnelSignature('),
  workerSource.indexOf('function stopNetworkMonitor() {'),
)
const CONFIGURE_BODY = workerSource.slice(
  workerSource.indexOf('async function configure(next) {'),
  workerSource.indexOf('function status() {'),
)
assert.ok(SIGNATURES_BODY.length > 0, '应能在 worker 源码里定位三个签名函数')
assert.ok(CONFIGURE_BODY.length > 0, '应能在 worker 源码里定位 configure()')

function baseConfig() {
  return {
    enabled: true,
    relayUrl: 'https://relay.invalid',
    instanceId: 'inst1',
    pairingCode: '123456',
    name: 'Mac',
    upstreamPort: 19387,
    lanPort: 18787,
    lanEnabled: true,
    lanSecret: 'secret',
    registerSecret: '',
  }
}

const { switchRelay: realSwitchRelay } = require(join(__dirname, '..', 'lib', 'relay', 'migrate.js'))

function bootWorker(options = {}) {
  const calls = { stopTunnel: 0, startTunnel: 0, stopLan: 0, startLan: 0, stopMonitor: 0, startMonitor: 0, switchRelay: 0, reconnectCancel: 0 }
  const registrations = []
  // 换地址那条路的实现（`lib/relay/migrate.js`）有自己的守卫：这里只钉 configure 有没有
  // 把它叫上、给它的东西对不对 —— 顺序与撤销在 relay-migrate.test.cjs 里逐帧验。
  const switches = []
  const fakeTunnel = { updateRegistration: (patch) => registrations.push(patch) }
  const api = new Function('deps', `
    const { status, stopLan, startLan, stopTunnel, startTunnel, stopNetworkMonitor, startNetworkMonitor, lanUrls, lanUrlPort, core, publishState, switchRelay, openTunnel, reconnect } = deps;
    let config = deps.initialConfig;
    let tunnel = deps.tunnel;
    ${SIGNATURES_BODY}
    ${CONFIGURE_BODY}
    return {
      configure,
      currentConfig: () => config,
      setTunnel: (next) => { tunnel = next },
    };
  `)({
    status: () => ({ ok: true }),
    stopLan: () => { calls.stopLan += 1 },
    startLan: () => { calls.startLan += 1 },
    stopTunnel: () => { calls.stopTunnel += 1 },
    startTunnel: () => { calls.startTunnel += 1 },
    stopNetworkMonitor: () => { calls.stopMonitor += 1 },
    startNetworkMonitor: () => { calls.startMonitor += 1 },
    lanUrls: () => ['http://192.168.1.2:18787'],
    lanUrlPort: () => 18787,
    reconnect: { cancel: () => { calls.reconnectCancel += 1 } },
    // 地址规范化用真实现：尾斜杠那条边界就是它管的，桩一份就等于没测。
    core: require(join(__dirname, '..', 'lib', 'relay', 'core.js')),
    publishState: () => {},
    switchRelay: options.switchRelay || ((opts) => { calls.switchRelay += 1; switches.push(opts); return options.switchResult ? options.switchResult(opts) : Promise.resolve(true) }),
    openTunnel: options.openTunnel || (() => Promise.resolve()),
    initialConfig: {},
    tunnel: fakeTunnel,
  })
  return { ...api, calls, registrations, switches, fakeTunnel }
}

test('配置一个字没变：不重建隧道、不重建局域网代理、重报也不发', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  // 首次下发（旧配置是空的）本来就要建起来。
  assert.equal(w.calls.startTunnel, 1, '首次下发要建隧道')
  assert.equal(w.calls.startLan, 1, '首次下发要建局域网代理')

  const before = { ...w.calls }
  await w.configure(baseConfig())
  assert.deepEqual(w.calls, before, '同样的配置再下发一次，隧道与局域网代理都不许动')
  assert.equal(w.registrations.length, 0, '没有需要重报的元信息')
})

test('只改名：不重建，只在现有连接上重报一次', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), name: 'Mac 2' })
  assert.deepEqual(w.calls, before, '改名字不该重建任何服务')
  assert.equal(w.registrations.length, 1)
  assert.equal(w.registrations[0].name, 'Mac 2')
  assert.equal(w.registrations[0].pairingCode, undefined, '没变的字段不该跟着重报')
})

test('中转地址变了：走「先登记迁移、再重建」那条路，旧隧道不许先停', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), relayUrl: 'https://relay2.invalid' })
  assert.equal(w.calls.switchRelay, before.switchRelay + 1, '换地址必须交给 switchRelay（登记 → 重建 → 失败撤销）')
  assert.equal(w.calls.stopTunnel, before.stopTunnel, '旧隧道要留着发 MIGRATE / 撤销，不许先停掉再重建')
  assert.equal(w.calls.startTunnel, before.startTunnel, '新隧道由那条路自己起，不走普通的 stop+start')
  const opts = w.switches[0]
  assert.equal(opts.oldTunnel, w.fakeTunnel, '登记必须发生在旧隧道上')
  assert.equal(opts.relayUrl, 'https://relay2.invalid', '登记的目标就是新地址')
  assert.equal(typeof opts.open, 'function', '那条路要能自己起新隧道')
  assert.equal(typeof opts.drop, 'function', '收旧隧道也交给它，否则没人发撤销')
  assert.equal(w.calls.startLan, before.startLan, '局域网代理与中转地址无关，不该动')
  assert.equal(w.registrations.length, 0, '隧道都重建了，不需要再补一次注册')
  assert.equal(w.currentConfig().relayUrl, 'https://relay2.invalid')
})

test('同时关掉总开关并换地址：走老路（停下就完了），不许把隧道又建起来', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), enabled: false, relayUrl: 'https://relay2.invalid' })
  assert.equal(w.calls.switchRelay, before.switchRelay, '关掉远程时没有「搬去新地址」这回事')
  assert.equal(w.calls.startTunnel, before.startTunnel + 1, '照老路走一遍 startTunnel（它自己会按 enabled 判掉）')
  assert.equal(w.currentConfig().enabled, false)
})

test('换地址走的是真实现：MIGRATE 落在旧隧道上，之后才建新隧道', async () => {
  const order = [];
  const oldTunnel = {
    connected: true,
    updateRegistration: () => {},
    sendJson: (type, id, body) => { order.push(`frame:${type}:${body.to}`); return true; },
    stop: () => { order.push('stop-old'); },
  };
  const w = bootWorker({
    switchRelay: realSwitchRelay,
    // 真实现会先发帧、等帧出去，再叫这个 —— 顺序就是这里断言的。
    openTunnel: () => { order.push('open-tunnel'); return Promise.resolve(); },
  })
  w.setTunnel(oldTunnel)
  await w.configure(baseConfig())
  order.length = 0
  await w.configure({ ...baseConfig(), relayUrl: 'https://relay2.invalid' })

  assert.deepEqual(order.slice(0, 2), ['frame:28:https://relay2.invalid', 'open-tunnel'],
    'MIGRATE（0x1C=28）必须先发在旧隧道上，新隧道在那之后才建')
  assert.equal(order.includes('stop-old'), false, '旧隧道要留到最后（撤销与响应都靠它）')
})

test('只差一个尾斜杠：还是同一台中转，不白跑一次迁移登记', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), relayUrl: 'https://relay.invalid/' })
  assert.equal(w.calls.switchRelay, before.switchRelay, '规范化之后没变，就不是「换地址」')
  assert.equal(w.calls.startTunnel, before.startTunnel + 1, '签名不同仍按老路重建一次隧道')
})

test('新地址注册失败：错误从 configure 抛回调用方（手机 / 面板看到的那一句）', async () => {
  // 撤销与收旧隧道归那条路自己（relay-migrate.test.cjs 验），configure 只把错误原样往上抛。
  const w = bootWorker({ switchResult: () => Promise.reject(new Error('隧道关闭: 1008 bad registration secret')) })
  await w.configure(baseConfig())
  await assert.rejects(
    () => w.configure({ ...baseConfig(), relayUrl: 'https://relay2.invalid' }),
    /bad registration secret/,
    '失败原因必须原样回到调用方，不能吞成一句「配置下发失败」',
  )
})

test('局域网端口变了：只重建局域网代理，隧道保持不动并重报候选地址', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), lanPort: 18788 })
  assert.equal(w.calls.stopLan, before.stopLan + 1, '端口变了要重建局域网代理')
  assert.equal(w.calls.startLan, before.startLan + 1)
  assert.equal(w.calls.stopTunnel, before.stopTunnel, '隧道与局域网端口无关，不许断')
  assert.deepEqual(w.registrations, [{ lanUrls: ['http://192.168.1.2:18787'] }], '新地址要在现有连接上重报')
})

test('配对码变了：局域网代理按取值器现读，既不重建监听也不告诉中转', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), pairingCode: '654321' })
  // 配对成功就要换一次码（§5.1）。如果这里重建局域网代理，那次配对刚握上的连接会被掐掉。
  // 所以代理拿的是取值器（`currentPairing`），换值不动监听。
  assert.equal(w.calls.stopLan, before.stopLan, '换码不该重建局域网监听')
  assert.equal(w.calls.stopTunnel, before.stopTunnel, '配对码不影响隧道连到哪台，不许断')
  // 中转从来没读过配对码（`ws.rs` 原文），这一轮彻底不发（§5.2）。
  assert.equal(w.registrations.length, 0, '换码不该向中转重报任何东西')
  assert.equal(w.currentConfig().pairingCode, '654321', '值本身要落到 worker 的配置里')
})

test('总开关关掉：隧道和局域网代理都要停，监视器重排', async () => {
  const w = bootWorker()
  await w.configure(baseConfig())
  const before = { ...w.calls }
  await w.configure({ ...baseConfig(), enabled: false })
  assert.equal(w.calls.stopTunnel, before.stopTunnel + 1)
  assert.equal(w.calls.stopLan, before.stopLan + 1)
  assert.equal(w.calls.startMonitor, before.startMonitor + 1, '监视器要按新开关重排')
  assert.equal(w.currentConfig().enabled, false)
})

test('契约面：configure 里不许再出现无条件 stopServices()', () => {
  assert.ok(
    !/await stopServices\(\)/.test(CONFIGURE_BODY),
    'configure 里无条件拆掉整组服务就是「每隔几分钟断一次 + 内存一直涨」的根因，别改回去',
  )
})

/**
 * 配置字段三处同步：worker 的 `allowed` 白名单、worker 现读的那些字段、以及宿主
 * 装配层的 `buildConfig`。
 *
 * 现场（2026-10-24）：协议 v2 的配对票加了 `pairingTicket`，worker 侧（白名单与
 * `currentPairing` 的读取）都补上了，唯独 `buildConfig` 没带 —— 旁路拿到的票据是空串，
 * 局域网配对解不开任何一份加密请求，一律回「配对码错误或桌面端已拒绝」；主进程那条
 * `/pair` 一切正常，所以症状是「同一个二维码，走中转能配、同一个 Wi-Fi 直连不能」。
 * 这类漏项不会抛 `unknown configuration field`（少发字段是合法的），只能靠对账发现。
 */
test('契约面：buildConfig 必须带上 worker 认识的每一个字段', () => {
  const implSource = readFileSync(join(__dirname, '..', 'lib', 'impl.js'), 'utf8')
  const at = implSource.indexOf('buildConfig: (lanPort) => ({')
  assert.ok(at > 0, '应能在 impl.js 的装配层里定位 buildConfig')
  // 对象字面量只占一行；多取一些余量，缩进与换行变了也不至于误判。
  const body = implSource.slice(at, at + 800)
  const allowed = /const allowed = \[([^\]]*)\]/.exec(workerSource)
  assert.ok(allowed, '应能在 worker 源码里找到 allowed 白名单')
  const fields = allowed[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
  assert.ok(fields.includes('pairingTicket'), '协议 v2 的票据必须在 worker 白名单里')
  for (const field of fields) {
    // 简写（`lanPort`）与显式键值（`pairingCode: …`）两种写法都算发下去了。
    const present = new RegExp(`(^|[\\s,{])${field}\\s*[:,]`).test(body)
    assert.ok(present, `buildConfig 漏了 ${field}：worker 认得它，宿主却不发`)
  }
})

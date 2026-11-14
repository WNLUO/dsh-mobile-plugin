'use strict'

// 直连隧道宿主侧守卫：配对等待逐次回收，重复取码仍能完成；身份落盘与吊销保持一致。
//
// 这些断言守的是三件「错了不会报错、只会悄悄不生效」的事：
//   1. 助手的身份（私钥 / 预共享密钥 / 区域）必须真的写进 relay.json —— 不写，电脑一重启
//      地址就换，手机那边表现为「昨天还能连，今天连不上」。
//   2. 写不进去必须回执 false —— 助手会回滚白名单；谎报 true 就成了「界面上已吊销、实际
//      还连着」。
//   3. 配对窗口只交还一次：窗口关掉之后，路由不能再拿到一把能用的钥匙。

const test = require('node:test')
const assert = require('node:assert/strict')

const { createTailcatSession } = require('../lib/tailcat/session.cjs')

/** 假助手：只记调用；事件由 session._event 直接喂（真路径是子进程 stdout）。 */
function fakeHost() {
  const calls = { start: 0, pair: [], ack: [], setAllowed: [], closed: 0 }
  return {
    calls,
    start() { calls.start += 1 },
    pair(ttl) { calls.pair.push(ttl) },
    ack(id, ok) { calls.ack.push([id, ok]) },
    setAllowed(keys) { calls.setAllowed.push(keys) },
    status() { return { running: true, ready: true, address: 'tcpTEST' } },
    close() { calls.closed += 1; return Promise.resolve() },
  }
}

function makeSession(overrides = {}) {
  const disk = { tailcatEnabled: true, tailcatState: null, tailcatAllowedClients: [] }
  const host = fakeHost()
  let failWrite = false
  const writes = []
  const session = createTailcatSession({
    readState: () => ({ ...disk }),
    writeState: patch => {
      if (failWrite) throw new Error('disk full')
      writes.push(patch)
      Object.assign(disk, patch)
    },
    localPort: 19000,
    hostName: () => 'test-mac',
    host,
    ...overrides,
  })
  const emit = event => session._event(event)
  return { session, host, disk, writes, emit, fail: () => { failWrite = true } }
}

test('persist 事件把助手身份与白名单落进配置，并回执 true', () => {
  const { session, host, disk, writes, emit } = makeSession()
  session.start()
  emit({ event: 'persist', id: '1', state: '{"v":1}', allowedClients: ['nodekey:aa'] })
  assert.equal(writes.length, 1)
  assert.equal(disk.tailcatState, '{"v":1}')
  assert.deepEqual(disk.tailcatAllowedClients, ['nodekey:aa'])
  assert.deepEqual(host.calls.ack, [['1', true]])
})

test('写盘失败必须回执 false（助手据此回滚白名单）', () => {
  const { session, host, emit, fail } = makeSession()
  session.start()
  fail()
  emit({ event: 'persist', id: '2', state: null, allowedClients: ['nodekey:bb'] })
  assert.deepEqual(host.calls.ack, [['2', false]])
})

test('配对窗口：pairing 事件交出地址、一次性私钥、证明串', async () => {
  const { session, host, emit } = makeSession()
  session.start()
  const pending = session.openPairingWindow(120)
  assert.deepEqual(host.calls.pair, [120])
  emit({ event: 'pairing', address: 'tcpADDR', port: 48942, key: 'privkey:' + 'a'.repeat(64), proof: 'p'.repeat(43), expiresAt: 1 })
  const window = await pending
  assert.equal(window.address, 'tcpADDR')
  assert.equal(window.port, 48942)
  assert.ok(window.key.startsWith('privkey:'))
  assert.equal(window.proof.length, 43)
})

test('窗口关掉之后再问，拿到的是 null（不能再拿一把能用的钥匙）', async () => {
  const { session, host, emit } = makeSession()
  session.start()
  const pending = session.openPairingWindow(120)
  emit({ event: 'pairingClosed' })
  assert.equal(await pending, null)
})

test('短时间再次取码：上一发的超时不能吞掉新请求，新请求到期正常返回', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { session, emit } = makeSession()
  const first = session.openPairingWindow(120)
  t.mock.timers.tick(1000)
  emit({ event: 'pairing', address: 'first', key: 'key', proof: 'proof', expiresAt: 120 })
  assert.equal((await first).address, 'first')
  t.mock.timers.tick(1000)
  let settled = false
  const second = session.openPairingWindow(120).then((value) => { settled = true; return value })
  t.mock.timers.tick(18000)
  await Promise.resolve()
  assert.equal(settled, false, '第二次请求不能提前超时')
  t.mock.timers.tick(2000)
  await Promise.resolve()
  assert.equal(settled, true, '第二次请求必须在自己的超时点返回，不能一直显示没取到二维码')
  assert.equal(await second, null)
  await session.stop()
})

test('成功、失败、窗口关闭或停止之后，旧定时器不会影响下一次取码', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const event of ['pairing', 'error', 'pairingClosed', 'paired', 'stop']) {
    const { session, emit } = makeSession()
    const first = session.openPairingWindow(120)
    t.mock.timers.tick(1000)
    if (event === 'stop') await session.stop()
    else emit({ event, address: 'first', key: 'key', proof: 'proof', expiresAt: 120, client: 'nodekey:a' })
    await first
    const second = session.openPairingWindow(120)
    assert.equal(session.openPairingWindow(120), second, '并发取码复用同一个等待')
    t.mock.timers.tick(19500)
    emit({ event: 'pairing', address: 'second', key: 'key', proof: 'proof', expiresAt: 120 })
    assert.equal((await second).address, 'second', event)
    await session.stop()
  }
})

test('助手发送配对请求时抛错仍结束等待，下次取码可以重新开始', async () => {
  const host = fakeHost()
  host.pair = () => { throw new Error('helper stopped') }
  const { session } = makeSession({ host })
  assert.equal(await session.openPairingWindow(120), null)
  assert.equal(await session.openPairingWindow(120), null)
  await session.stop()
})

test('paired 事件把手机公钥记进白名单，不重复记', () => {
  const { session, host, disk, emit } = makeSession()
  session.start()
  emit({ event: 'paired', address: 'tcpADDR', client: 'nodekey:cc' })
  emit({ event: 'paired', address: 'tcpADDR', client: 'nodekey:cc' })
  assert.deepEqual(disk.tailcatAllowedClients, ['nodekey:cc'])
})

test('吊销走 setAllowed：先落盘，再告诉助手', () => {
  const { session, host, disk, emit } = makeSession()
  session.start()
  assert.equal(session.setAllowed(['nodekey:dd']), true)
  assert.deepEqual(disk.tailcatAllowedClients, ['nodekey:dd'])
  assert.deepEqual(host.calls.setAllowed, [['nodekey:dd']])
})

test('总开关关掉时停进程，白名单留着（再打开不用重新配对）', () => {
  const { session, host, disk, emit } = makeSession()
  session.start()
  assert.equal(session.setEnabled(false), true)
  assert.equal(host.calls.closed, 1)
  assert.deepEqual(disk.tailcatAllowedClients, [])
  assert.equal(disk.tailcatEnabled, false)
})

test('status 报告这台机器上这条通道能不能用', () => {
  const { session, host, emit } = makeSession()
  session.start()
  const status = session.status()
  assert.equal(status.available, true)
  assert.equal(status.ready, true)
  assert.equal(status.address, 'tcpTEST')
})

test('老设备报名：加进白名单之后回它该拨的地址', async () => {
  const { session, host, disk } = makeSession()
  session.start()
  const entry = await session.enroll('nodekey:' + 'e'.repeat(64))
  assert.deepEqual(disk.tailcatAllowedClients, ['nodekey:' + 'e'.repeat(64)])
  assert.equal(entry.address, 'tcpTEST')
  assert.equal(entry.port, 48941)
  assert.deepEqual(host.calls.setAllowed, [['nodekey:' + 'e'.repeat(64)]])
})

test('老设备报名：公钥形状不对时什么都不做', async () => {
  const { session, host, disk } = makeSession()
  session.start()
  assert.equal(await session.enroll('not-a-key'), null)
  assert.deepEqual(disk.tailcatAllowedClients, [])
  assert.deepEqual(host.calls.setAllowed, [])
})

test('助手装晚了：第一次找不到，之后入口上重探到就能正常拉起', async () => {
  // 助手是可选依赖，插件加载那一刻可能还没装好（镜像跳过 optionalDependencies、装晚了）。
  // 早先的做法是加载时找不到就把这条通道永久判死，用户必须重开 DSH 才好。
  const disk = { tailcatEnabled: true, tailcatState: null, tailcatAllowedClients: [] }
  const host = fakeHost()
  let found = false
  const session = createTailcatSession({
    readState: () => ({ ...disk }),
    writeState: patch => Object.assign(disk, patch),
    localPort: 19000,
    host,
    resolveBinary: () => (found ? '/opt/helpers/dsh-tailcat-host' : null),
  })
  const emit = event => session._event(event)

  session.start()
  assert.equal(session.status().available, false, '还没装助手时该如实说没有')
  assert.equal(session.status().error, 'helper-missing')
  assert.equal(await session.openPairingWindow(120), null)
  assert.deepEqual(host.calls.pair, [])

  // 装上了：不需要重开插件，下一次开码就该起来。
  found = true
  const pending = session.openPairingWindow(120)
  assert.equal(host.calls.start, 1, '入口被调用时要重新探一次二进制并拉起')
  assert.deepEqual(host.calls.pair, [120])
  assert.equal(session.status().available, true)
  assert.equal(session.status().error, '', '找到助手之后不能再留着「没有助手」那条旧结论')

  emit({ event: 'pairing', address: 'tcpADDR', port: 48942, key: 'privkey:' + 'a'.repeat(64), proof: 'p'.repeat(43), expiresAt: 1 })
  assert.equal((await pending).address, 'tcpADDR')
})

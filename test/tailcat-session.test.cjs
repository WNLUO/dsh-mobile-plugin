'use strict'

// 直连隧道宿主侧的守卫：助手事件怎么落进配置、配对窗口怎么交还给路由、吊销怎么生效。
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

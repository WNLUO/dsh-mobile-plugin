// 后台停止必须等到退出，强杀超时不允许下一代占用同一入口。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const file = require.resolve('../lib/sidecar-facade.cjs')
const source = readFileSync(file, 'utf8')

function boot(text = source, running = true) {
  const realRequire = createRequire(file)
  const timers = []
  const loaded = { exports: {} }
  const child = new EventEmitter()
  Object.assign(child, { connected: true, exitCode: null, signalCode: null, sent: [], signals: [] })
  child.send = (message, callback) => { child.sent.push(message); callback?.(null) }
  child.kill = signal => { child.signals.push(signal); return true }
  new Function('require', 'module', 'exports', '__dirname', 'setTimeout', 'clearTimeout', text)(
    name => name === 'node:child_process' ? { fork: () => child } : realRequire(name),
    loaded, loaded.exports, require('node:path').dirname(file),
    fn => { const timer = { fn, active: true }; timers.push(timer); return timer },
    timer => { if (timer) timer.active = false },
  )
  const facade = new loaded.exports.SidecarFacade({ parentPort: 1234, token: 'test' })
  if (running) { facade.child = child; facade.port = 1235 }
  return {
    facade, child,
    fireTimer() {
      const timer = timers.find(t => t.active)
      assert.ok(timer, '应存在下一阶段退出期限')
      timer.active = false
      timer.fn()
    },
  }
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

async function assertWaitsForExit(text) {
  const h = boot(text)
  let stopped = false
  const stopping = h.facade.stop().then(() => { stopped = true })
  assert.deepEqual(h.child.sent, [{ type: 'shutdown' }], '先通过 IPC 释放通道')
  assert.deepEqual(h.child.signals, [], '正常关闭不直接强制终止')
  await flush()
  assert.equal(stopped, false)
  h.fireTimer()
  assert.deepEqual(h.child.signals, ['SIGKILL'])
  await flush()
  assert.equal(stopped, false, '发出强杀不等于进程已经退出，不能马上重启')
  h.child.exitCode = 0
  h.child.emit('exit', 0)
  await stopping
  assert.equal(stopped, true)
}

test('先请求正常关闭，强杀后仍等旧进程确认退出', async () => {
  await assertWaitsForExit(source)
})

test('退出卡住时报告失败并保留旧进程引用，后续 start 不会另起一份', async () => {
  const h = boot()
  const stopping = h.facade.stop()
  const rejected = assert.rejects(stopping, /did not exit/)
  h.fireTimer()
  h.fireTimer()
  await rejected
  assert.equal(h.facade.child, h.child)
  assert.equal(h.facade.port, null)
  await h.facade.start()
  assert.equal(h.facade.child, h.child)
})

test('并发 stop 共用退出确认，已经退出的进程不再等待', async () => {
  const h = boot()
  const first = h.facade.stop()
  const second = h.facade.stop()
  assert.equal(h.child.sent.length, 1)
  h.child.signalCode = 'SIGTERM'
  h.child.emit('exit', null, 'SIGTERM')
  await Promise.all([first, second])
  assert.equal(h.facade.stopping, null)
  h.facade.child = h.child
  await h.facade.stop()
  assert.equal(h.child.sent.length, 1)
})

test('IPC 断开时沿用信号关闭，仍必须等待退出', async () => {
  const h = boot()
  h.child.connected = false
  const stopped = h.facade.stop()
  assert.deepEqual(h.child.signals, ['SIGTERM'])
  h.child.emit('exit', 0)
  await stopped
})

test('启动等待忽略状态帧，超时后迟到 ready 不会复活旧端口', async () => {
  const h = boot(source, false)
  const starting = h.facade.start()
  const rejected = assert.rejects(starting, /startup timeout/)
  h.child.emit('message', { type: 'state', tunnel: { state: 'off' } })
  assert.equal(h.facade.port, null)
  h.fireTimer()
  await flush()
  assert.deepEqual(h.child.sent, [{ type: 'shutdown' }])
  h.child.emit('message', { type: 'ready', port: 18787 })
  assert.equal(h.facade.port, null)
  h.child.emit('exit', 0)
  await rejected
  assert.equal(h.facade.child, null)
})

test('变异：强杀后直接宣布停止，会被同一退出断言拒绝', async () => {
  const before = "        kill('SIGKILL')"
  assert.ok(source.includes(before))
  await assert.rejects(assertWaitsForExit(source.replace(before, `${before}; finish()`)), { name: 'AssertionError' })
})

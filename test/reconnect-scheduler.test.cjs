'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createReconnectScheduler } = require('../lib/reconnect-scheduler.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('同一窗口内并发请求只排一个重连定时器', async () => {
  let fires = 0
  const scheduler = createReconnectScheduler({ delayMs: 20, onFire: () => { fires += 1 } })
  assert.equal(scheduler.schedule(), true)
  // worker 的 onClose 与 start().catch 会在同一轮失败里各请求一次重连。
  assert.equal(scheduler.schedule(), false, '第二次请求必须被幂等吸收')
  assert.equal(scheduler.schedule(), false, '第三次请求必须被幂等吸收')
  assert.equal(fires, 0, '定时器触发前不得重连')
  await delay(60)
  assert.equal(fires, 1, '一个窗口内只能重连一次')
})

test('触发之后可以再次排程', async () => {
  let fires = 0
  const scheduler = createReconnectScheduler({ delayMs: 10, onFire: () => { fires += 1 } })
  assert.equal(scheduler.schedule(), true)
  await delay(40)
  assert.equal(fires, 1)
  assert.equal(scheduler.pending(), false)
  assert.equal(scheduler.schedule(), true)
  await delay(40)
  assert.equal(fires, 2)
})

test('cancel 取消待触发的重连且不再触发', async () => {
  let fires = 0
  const scheduler = createReconnectScheduler({ delayMs: 20, onFire: () => { fires += 1 } })
  assert.equal(scheduler.schedule(), true)
  assert.equal(scheduler.pending(), true)
  scheduler.cancel()
  assert.equal(scheduler.pending(), false)
  assert.equal(scheduler.cancel(), undefined, '重复 cancel 必须安全')
  await delay(60)
  assert.equal(fires, 0)
})

test('cancel 之后可以重新排程', async () => {
  let fires = 0
  const scheduler = createReconnectScheduler({ delayMs: 10, onFire: () => { fires += 1 } })
  scheduler.schedule()
  scheduler.cancel()
  assert.equal(scheduler.schedule(), true)
  await delay(40)
  assert.equal(fires, 1)
})

test('拒绝非法参数', () => {
  assert.throws(() => createReconnectScheduler({ delayMs: -1, onFire: () => {} }), /invalid delayMs/)
  assert.throws(() => createReconnectScheduler({ delayMs: Number.NaN, onFire: () => {} }), /invalid delayMs/)
  assert.throws(() => createReconnectScheduler({ delayMs: 10 }), /invalid onFire/)
  assert.throws(() => createReconnectScheduler(), /invalid delayMs/)
})

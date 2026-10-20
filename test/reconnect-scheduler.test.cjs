// 隧道重连调度器的行为：同一窗口只排一个定时器（防重连风暴）、延迟带抖动与指数退避、
// 注册成功要清掉失败账。生产接线在 lib/sidecar-facade-worker.cjs 的 startTunnel。
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

/**
 * 抖动与退避。
 *
 * 中转重启（或宿主机休眠醒来）之后所有宿主在同一刻掉线，固定间隔会让它们踩着同一个点
 * 回来；连续失败（中转没起来、注册密钥不对）时也不该每 5 秒敲一次。
 */
function manualTimer() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, ms) { scheduled.push({ fn, ms }); return { fn }; },
    clearTimer() {},
    fireLast() { scheduled[scheduled.length - 1].fn(); },
  };
}

test('调度延迟带抖动，且抖动不越过窗口上限', () => {
  const timer = manualTimer();
  const scheduler = createReconnectScheduler({
    delayMs: 5000, jitterMs: 2000, random: () => 0.5, onFire: () => {}, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  })
  scheduler.schedule()
  assert.equal(timer.scheduled[0].ms, 6000, '抖动必须落在 [0, jitterMs) 里而且加在基准值上')
})

test('连续失败逐次翻倍并封顶，注册成功后回到基准值', () => {
  const timer = manualTimer();
  const scheduler = createReconnectScheduler({
    delayMs: 1000, maxDelayMs: 8000, random: () => 0, onFire: () => {}, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  })
  const delays = []
  for (let i = 0; i < 5; i += 1) {
    assert.equal(scheduler.schedule(), true)
    delays.push(timer.scheduled[timer.scheduled.length - 1].ms)
    timer.fireLast()
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000], '退避要翻倍并停在 maxDelayMs')
  scheduler.reset()
  scheduler.schedule()
  assert.equal(timer.scheduled[timer.scheduled.length - 1].ms, 1000, '连上之后失败账必须清零')
})

test('非法抖动参数直接拒', () => {
  assert.throws(() => createReconnectScheduler({ delayMs: 10, jitterMs: -1, onFire: () => {} }), /invalid jitterMs/)
  assert.throws(() => createReconnectScheduler({ delayMs: 10, maxDelayMs: 0, onFire: () => {} }), /invalid maxDelayMs/)
})

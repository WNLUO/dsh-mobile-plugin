// 超时后保留本机关闭原因，正常重连不沿用上次原因。
// 隧道心跳只跟经过时间；墙钟变化不改变既有阈值、pong刷新与停止清理。
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const file = require.resolve('../lib/relay/tunnel.js')
const requireReal = createRequire(file)
const source = fs.readFileSync(file, 'utf8')
const { T } = requireReal('./protocol.js')

function boot(text) {
  let elapsed = 1000
  let wall = 1700000000000
  let id = 0
  const intervals = new Map()
  const loaded = { exports: {} }
  vm.runInNewContext(text, {
    module: loaded, exports: loaded.exports, Buffer, process, URL,
    Date: { now: () => wall },
    require: name => name === 'node:perf_hooks'
      ? { performance: { now: () => elapsed } }
      : requireReal(name),
    setTimeout, clearTimeout,
    setInterval(fn, ms) { const key = ++id; intervals.set(key, { fn, ms, at: elapsed + ms }); return key },
    clearInterval(key) { intervals.delete(key) },
  })
  let terminated = 0
  const sent = []
  const socket = {
    readyState: 1, bufferedAmount: 0,
    send(frame) { sent.push(frame) },
    terminate() { terminated++; this.readyState = 3 },
  }
  const tunnel = new loaded.exports.RelayTunnel({
    relayUrl: 'wss://relay.example/tunnel', instanceId: 'heartbeat', upstream: 'http://127.0.0.1:1234',
  })
  tunnel.ws = socket
  return {
    tunnel, sent, terminated: () => terminated, timerCount: () => intervals.size,
    jumpWall(ms) { wall += ms },
    advance(ms) {
      const until = elapsed + ms
      while (true) {
        const entry = [...intervals].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        wall += entry[1].at - elapsed; elapsed = entry[1].at
        entry[1].at += entry[1].ms
        entry[1].fn()
      }
      wall += until - elapsed; elapsed = until
    },
  }
}

function exercise(text) {
  for (const jump of [-3600000, 3600000]) {
    const silent = boot(text)
    silent.tunnel.startHeartbeat()
    silent.advance(15000)
    assert.equal(silent.terminated(), 0, '首次正常间隔不能因墙钟基准而提前失活')
    silent.jumpWall(jump)
    silent.advance(30000)
    assert.equal(silent.terminated(), 0, '维持既有大于45秒阈值，墙钟变化不提前断开')
    silent.advance(15000)
    assert.equal(silent.terminated(), 1, '真实无pong超过45秒后下一拍必须断开，回拨不能延长')
    assert.equal(silent.tunnel.lastCloseReason, '心跳超时，未收到中转回应', '超时原因不能只留在日志里')
    silent.tunnel.stop()
    assert.equal(silent.timerCount(), 0)

    const healthy = boot(text)
    healthy.tunnel.startHeartbeat()
    healthy.advance(31000)
    healthy.jumpWall(jump)
    healthy.tunnel.handleFrame({ type: T.pong, id: 0, payload: Buffer.alloc(0) })
    healthy.advance(44000)
    assert.equal(healthy.terminated(), 0, 'pong刷新到单调时刻，前跳和回拨都不改变有效期')
    healthy.advance(15000)
    assert.equal(healthy.terminated(), 1, '刷新后真实超过45秒仍会按原心跳拍失活')
    healthy.tunnel.stop()
    assert.equal(healthy.timerCount(), 0)

    const stopped = boot(text)
    stopped.tunnel.startHeartbeat()
    stopped.advance(15000)
    stopped.tunnel.stop()
    const sentBefore = stopped.sent.length
    const terminatedBefore = stopped.terminated()
    assert.equal(stopped.timerCount(), 0)
    stopped.jumpWall(jump)
    stopped.advance(120000)
    assert.equal(stopped.sent.length, sentBefore, '停止后没有额外ping')
    assert.equal(stopped.terminated(), terminatedBefore, '停止后没有遗留心跳回调')
  }
}

test('真实 RelayTunnel 心跳：墙钟±1h不改变真实失活阈值、pong刷新与stop清理', () => {
  exercise(source)
})

test('三处心跳计时任一退回墙钟，同一行为断言都会拒绝', () => {
  const mutations = [
    ['初始化', '    this.lastPong = performance.now();', '    this.lastPong = Date.now();'],
    ['年龄比较', 'if (performance.now() - this.lastPong > PONG_TIMEOUT_MS)', 'if (Date.now() - this.lastPong > PONG_TIMEOUT_MS)'],
    ['pong刷新', '      case T.pong:\n        this.lastPong = performance.now();', '      case T.pong:\n        this.lastPong = Date.now();'],
  ]
  for (const [label, before, after] of mutations) {
    assert.ok(source.includes(before), `${label}变异必须命中生产计时点`)
    const mutant = source.replace(before, after)
    assert.throws(() => exercise(mutant), { name: 'AssertionError' }, `${label}退回墙钟必须让行为断言失败`)
  }
})

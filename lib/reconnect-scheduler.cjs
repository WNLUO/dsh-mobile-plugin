'use strict'

/**
 * 幂等重连调度器。
 *
 * worker 的隧道有两条失败路径：RelayTunnel 的 `onClose` 与 `start()` 的 reject
 * （见 lib/sidecar-facade-worker.cjs 的 startTunnel）。两条路径都会请求重连，
 * 如果各自排一个定时器，每次失败就会重连两次，形成重连风暴。
 *
 * 这里把「同一个待触发窗口内只保留一个定时器」这一不变量收敛成一个模块，
 * 以便用毫秒级延迟做真实的行为测试。端到端数连接次数是分不出来的：
 * 生产里延迟固定 5s，且 startTunnel 开头的 stopTunnel 会吸收重复定时器
 * 造成的大部分可见差异。
 */
function createReconnectScheduler({ delayMs, onFire, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof delayMs !== 'number' || !(delayMs >= 0)) throw new Error('invalid delayMs')
  if (typeof onFire !== 'function') throw new Error('invalid onFire')
  let timer = null
  return {
    /** 排程一次重连；已有待触发的定时器时返回 false，表示被幂等吸收。 */
    schedule() {
      if (timer !== null) return false
      timer = setTimer(() => { timer = null; onFire() }, delayMs)
      return true
    },
    /** 取消待触发的重连（显式停止隧道时调用）。 */
    cancel() {
      if (timer === null) return
      clearTimer(timer)
      timer = null
    },
    /** 是否已有待触发的重连。 */
    pending() { return timer !== null },
  }
}

module.exports = { createReconnectScheduler }

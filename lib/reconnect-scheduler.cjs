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
 * startTunnel 开头的 stopTunnel 会吸收重复定时器造成的大部分可见差异。
 *
 * 延迟本身带**抖动**与**退避**：
 *  - 抖动：中转重启（或宿主机休眠醒来）之后，所有宿主都会在同一刻掉线，固定 5s 会让
 *    它们踩着同一个点回来；上下抖两千毫秒就把这一波摊开。
 *  - 退避：连续失败（中转没起来、注册密钥不对）时不该每 5 秒敲一次，逐次翻倍到上限；
 *    一次成功的注册由调用方 `reset()` 清账。
 */

/** 连续失败最多翻到 delayMs 的 2^BACKOFF_EXP_CAP 倍（再被 maxDelayMs 压住）。 */
const BACKOFF_EXP_CAP = 5

function createReconnectScheduler({
  delayMs,
  jitterMs = 0,
  maxDelayMs = Number.POSITIVE_INFINITY,
  random = Math.random,
  onFire,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof delayMs !== 'number' || !(delayMs >= 0)) throw new Error('invalid delayMs')
  if (typeof jitterMs !== 'number' || !(jitterMs >= 0)) throw new Error('invalid jitterMs')
  if (typeof maxDelayMs !== 'number' || !(maxDelayMs > 0)) throw new Error('invalid maxDelayMs')
  if (typeof random !== 'function') throw new Error('invalid random')
  if (typeof onFire !== 'function') throw new Error('invalid onFire')
  let timer = null
  let misses = 0
  return {
    /** 排程一次重连；已有待触发的定时器时返回 false，表示被幂等吸收。 */
    schedule() {
      if (timer !== null) return false
      const backoff = misses === 0 ? 1 : 2 ** Math.min(misses, BACKOFF_EXP_CAP)
      const base = Math.min(delayMs * backoff, maxDelayMs)
      const wait = base + (jitterMs > 0 ? Math.floor(random() * jitterMs) : 0)
      misses += 1
      timer = setTimer(() => { timer = null; onFire() }, wait)
      return true
    },
    /** 连上之后清掉连续失败计数（下一次掉线重新从 delayMs 起算）。 */
    reset() { misses = 0 },
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

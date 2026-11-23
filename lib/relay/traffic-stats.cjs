'use strict';

/**
 * 手机与本机之间这条连接的流量累计计数（本进程起算）。
 *
 * 口径从**本机**看：
 *   - `sentBytes`：本机发往手机（上行 / 总发送）；
 *   - `receivedBytes`：手机发来本机（下行 / 总接收）。
 *
 * 计数点在移动路由（`lib/routes/mobile-api.js` 的 `withTraffic`）：中转 / 局域网 / 直连隧道 /
 * 点对点不管走哪条传输，最后都落到同一批移动路由，记一处口径就统一了。
 *
 * 生命周期：
 *   - 计数与历史挂在 `globalThis` 上，**同一个 DSH 进程内**插件被重载（自动更新那种）时沿用
 *     同一份状态，用户无感、数字不跳回 0；
 *   - 整个 DSH 完全退出再启动 = 新进程 = `globalThis` 是新的，从头统计（用户主动重启应当清零）。
 *
 * 历史：后台每秒记一个累计快照，面板拿整段历史直接画曲线——这样刷新页面时曲线不会清空
 * （历史在宿主内存里，不在页面里）。面板只负责把最新的那段画出来并做过渡动画。
 */

const HISTORY_POINTS = 60
const SAMPLE_INTERVAL_MS = 1000
const GLOBAL_KEY = '__dshMobileTrafficStats'

function freshState() {
  const now = Date.now()
  return {
    since: now,
    sentBytes: 0,
    receivedBytes: 0,
    samples: [{ at: now, sentBytes: 0, receivedBytes: 0 }],
    timer: null,
  }
}

const state = globalThis[GLOBAL_KEY] || (globalThis[GLOBAL_KEY] = freshState())
if (!Array.isArray(state.samples) || state.samples.length === 0) state.samples = [{ at: state.since || Date.now(), sentBytes: 0, receivedBytes: 0 }]

function noteSent(bytes) {
  const n = Number(bytes)
  if (Number.isFinite(n) && n > 0) state.sentBytes += n
}

function noteReceived(bytes) {
  const n = Number(bytes)
  if (Number.isFinite(n) && n > 0) state.receivedBytes += n
}

function record() {
  const now = Date.now()
  state.samples.push({ at: now, sentBytes: state.sentBytes, receivedBytes: state.receivedBytes })
  if (state.samples.length > HISTORY_POINTS) state.samples.splice(0, state.samples.length - HISTORY_POINTS)
}

/** 每秒记一拍；重载后旧定时器还在就复用它，不重复起。 */
function ensureSampler() {
  if (state.timer) return
  state.timer = setInterval(record, SAMPLE_INTERVAL_MS)
  if (typeof state.timer.unref === 'function') state.timer.unref()
}
ensureSampler()

/** 给一条「正要被 pipe 出去」的可读流挂个旁观计数：只读不改，与 pipe 共用同一批 chunk。 */
function countReadable(stream, direction) {
  if (!stream || typeof stream.on !== 'function') return stream
  const note = direction === 'sent' ? noteSent : noteReceived
  stream.on('data', (chunk) => {
    if (chunk && typeof chunk.length === 'number') note(chunk.length)
  })
  return stream
}

/** 只报累计值（状态接口用，体积小）。 */
function snapshot() {
  return { since: state.since, sentBytes: state.sentBytes, receivedBytes: state.receivedBytes }
}

/** 累计快照序列（面板画曲线用，最多 HISTORY_POINTS 个点）。 */
function series() {
  return state.samples.map((item) => ({ at: item.at, sentBytes: item.sentBytes, receivedBytes: item.receivedBytes }))
}

module.exports = { noteSent, noteReceived, countReadable, snapshot, series, HISTORY_POINTS, SAMPLE_INTERVAL_MS }

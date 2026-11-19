// 提供读请求标记、连接取消与响应结束后的收尾调度。
'use strict'

// 「读己所写」标记：写操作之后紧接着的那次列表刷新必须反映这次写入，不能被任何代读副本顶掉。
//
// 读请求会经过两层代读副本：sidecar 的镜像快照（桌面侧 500ms 推一次）与宿主插件自己的 10s
// 会话列表缓存。轮询撞上它们无所谓，写后第一次刷新撞上就会把刚做完的事显示成没生效。
//
// 所以约定 `?fresh=1`：带这个标记的读跳过所有代读副本、直接回源；轮询 / 首屏 / 下拉刷新不带。
// 权威实现在本文件；中转（Rust relay）也认这个标记，否则 App 就失去了唯一的自救手段。

const FRESH_QUERY_RE = /(?:^|[?&])fresh=1(?:&|$)/

/** 判断一次请求（完整 url 或 path，可带 query）是否要求「必须读出最新状态」。 */
function isFreshRequest(target) {
  return FRESH_QUERY_RE.test(String(target || ''))
}

const REQUEST_SIGNALS = new WeakMap()

/** 同一响应共用取消信号；客户端断开后宿主读任务也停止。 */
function requestSignal(res) {
  let signal = REQUEST_SIGNALS.get(res)
  if (signal) return signal
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal = controller.signal
  REQUEST_SIGNALS.set(res, signal)
  res.once?.('close', abort)
  res.once?.('error', abort)
  if (res.destroyed || res.writableEnded) abort()
  return signal
}

/** 响应完成后收尾；mux承载请求等待自身有界排空，不用固定延迟猜测。 */
function afterResponse(res, action) {
  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    Promise.resolve(res.__dshMuxDrained).then(() => action()).catch(() => {})
  }
  if (typeof res.once === 'function' && !res.writableFinished) {
    res.once('finish', schedule)
    res.once('close', schedule)
  } else schedule()
}

module.exports = { FRESH_QUERY_RE, isFreshRequest, requestSignal, afterResponse }

'use strict'

// 「读己所写」(read-your-writes) 标记：移动端做完一次写操作之后紧接着的那次列表刷新，
// 必须反映出这次写入，不能被任何「代读副本」顶掉。
//
// 背景（真机缺陷，探针实测）：移动端的读请求会经过两层代读副本——
//   1. sidecar 的镜像快照（mirror-snapshot.cjs 判定新鲜度）直接把 /sessions、
//      /workspaces 回给手机，根本不连宿主插件；桌面侧 500ms 推一次，所以正常最多
//      旧 500ms；
//   2. 宿主插件自己的 10s 会话列表缓存（lib/mobile/sessions.js 的
//      SESSION_LIST_CACHE_MS）。
// 两层对「每 15s 一次的轮询」都无所谓，但写操作之后的第一次刷新撞上任何一层，就会把
// 用户刚做完的事显示成没生效。
//
// 实测（Mac 宿主 + MI 9，时间戳相对点击「归档」按钮）：
//   + 311ms  HOST archive-session session-63acd828-…      ← 宿主侧已经改对了
//   + 375ms  SNAPSHOT /api/mobile/v1/sessions fresh        ← App 的刷新读到 +286ms 推来的旧镜像
//   +17233ms SNAPSHOT /api/mobile/v1/sessions fresh        ← 直到 15s 轮询才拿到新列表
//
// 于是约定 `?fresh=1`：带这个标记的读跳过所有代读副本，直接回源宿主插件。
// 轮询、首屏、下拉刷新不带，快路径照旧。
//
// 权威实现在本文件；`dsh-mobile-server/lib/fresh-request.js` 是它的手工同步副本，
// 两侧由 `test/shared-helpers-parity.test.cjs` 钉住。**改一边必须改另一边。**
// 中转侧同样必须认这个标记：中转自己也持有镜像与响应缓存，它若把带 fresh 的读
// 当普通读缓存掉，App 的下拉刷新就失去了唯一的自救手段。

const FRESH_QUERY_RE = /(?:^|[?&])fresh=1(?:&|$)/

/** 判断一次请求（完整 url 或 path，可带 query）是否要求「必须读出最新状态」。 */
function isFreshRequest(target) {
  return FRESH_QUERY_RE.test(String(target || ''))
}

module.exports = { FRESH_QUERY_RE, isFreshRequest }

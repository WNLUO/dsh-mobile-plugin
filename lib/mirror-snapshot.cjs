'use strict'

// 桌面推送的「移动端镜像快照」新鲜度判定。这一个小模块独立存在，是为了能被 test/ 直接驱动
// （与 reconnect-scheduler.cjs 同样的做法），而不是把判定散在 sidecar 的读取函数里。
//
// 背景（真机缺陷）：sidecar 把 /sessions、/workspaces 两个高频读请求直接从这份镜像回，
// 不去打扰主进程。但镜像**只能靠隧道推来**：
//   - host 侧 pushMirrorPayload 在 `!tunnelConnected()` 时直接短路（lib/index.js:132）；
//   - 它依赖的 sidecar `/tunnel/send` 自己也要求 `tunnel && tunnel.connected`，否则 503
//     （sidecar-facade-worker.cjs:186-190）。
// 于是「中转断掉、局域网仍然健康」时快照被永久冻结在最后一个版本，而 snapshotRead 依旧把
// 它当权威读：新建的会话/工作区在 App 里**永远不出现**。实测证据（Mac 宿主，kill 掉中转后
// 走局域网新建并发送）：
//   POST /session/new → session-1c9b048a-…，POST /session/send → {"ok":true,"accepted":true}
//   GET /sessions    → count 9（与 kill 之前一模一样），新会话 absent，+70s 仍 absent
//   GET /app         → 设备侧同样看不到
//   GET /session/messages?sessionId=<新的> → 能读到 user 'SNAPSHOT-STALE-1'
// 最后一条说明回源主进程的通道是好的（快照里没有这个 sessionId 就自然回源），坏的只是
// 「列表类读被冻结的镜像顶掉」。
//
// 修法：把镜像当**短时代读缓存**，不是权威存储——超过 TTL 就当作缺失，让调用方回源主进程。
// 隧道连着时快照每几百毫秒就被重推一次（processBgQueue 的 500ms tick），所以 15s 足够长，
// 快路径照常生效；一旦中转断开，最多 15s 后所有读都回源，数据重新变准。

const MIRROR_SNAPSHOT_TTL_MS = 15_000

// 只有带可信时间戳 `at` 且在 TTL 内的快照才可用。
// 缺 `at` 的载荷一律按陈旧处理：host 的三个推送点（lib/index.js:212 / :267 / :302）都会写
// `at: Date.now()`，没有 `at` 说明这不是预期的镜像载荷，宁可回源也不要拿它当权威。
// 时间戳来自同一台机器，不存在跨机时钟偏移，所以未来时间戳按不可信处理。
function isMirrorSnapshotFresh(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return false
  const at = snapshot.at
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
  const age = now - at
  return age >= 0 && age <= MIRROR_SNAPSHOT_TTL_MS
}

module.exports = { MIRROR_SNAPSHOT_TTL_MS, isMirrorSnapshotFresh }

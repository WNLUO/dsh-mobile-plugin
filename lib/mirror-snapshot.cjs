'use strict'

// 桌面推送的「移动端镜像快照」新鲜度判定。独立成模块是为了能被 test/ 直接驱动。
//
// 镜像只是**短时代读缓存**，不是权威存储：快照只能靠隧道推来，中转断开而局域网仍健康时
// 它会冻在最后一个版本，列表读于是把新建的会话/工作区一直藏住。超过 TTL 就当作缺失，
// 让调用方回源主进程。隧道连着时快照每几百毫秒重推一次，15s 足够长，快路径照常生效。

const MIRROR_SNAPSHOT_TTL_MS = 15_000

// 只有带可信时间戳 `at` 且在 TTL 内的快照才可用。缺 `at` 的载荷按陈旧处理：预期的镜像载荷
// 一定写了 `at`，没有就说明来路不对，宁可回源。时间戳来自同一台机器，未来时间戳按不可信处理。
function isMirrorSnapshotFresh(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return false
  const at = snapshot.at
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
  const age = now - at
  return age >= 0 && age <= MIRROR_SNAPSHOT_TTL_MS
}

module.exports = { MIRROR_SNAPSHOT_TTL_MS, isMirrorSnapshotFresh }

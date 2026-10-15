'use strict'

// 真机回归守卫：中转断掉时，sidecar 不得把冻结的镜像快照当作权威读。
//
// 现象（Mac 宿主 + MI 9，kill 掉本地中转、局域网仍健康）：
//   走局域网 POST /session/new + /session/send 都成功（{"ok":true,"accepted":true}），
//   但 GET /sessions 始终返回旧列表（9 条，新会话 absent，+70s 仍 absent），
//   设备侧 App 同样看不到新会话；
//   而 GET /session/messages?sessionId=<新会话> 能读到 user 'SNAPSHOT-STALE-1'。
// 最后一条说明「回源主进程」的通道是好的，坏的只是列表类读被冻结的镜像顶掉。
//
// 根因：镜像只能靠隧道推来（host 侧 pushMirrorPayload 在 !tunnelConnected() 时短路，
// sidecar 的 /tunnel/send 自己也要求 tunnel.connected，否则 503），而 snapshotRead 只判断
// 快照「在不在」，不判断「新不新」。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { MIRROR_SNAPSHOT_TTL_MS, isMirrorSnapshotFresh } = require('../lib/mirror-snapshot.cjs')

const WORKER = path.join(__dirname, '..', 'lib', 'sidecar-facade-worker.cjs')
const workerSrc = fs.readFileSync(WORKER, 'utf8')

const NOW = 1_700_000_000_000
const fresh = (age) => ({ kind: 'sync', at: NOW - age, sessions: { ok: true, items: [] } })

test('§1 TTL 内的快照可用', () => {
  assert.equal(isMirrorSnapshotFresh(fresh(0), NOW), true, '刚推来')
  assert.equal(isMirrorSnapshotFresh(fresh(500), NOW), true, '半秒前')
  assert.equal(isMirrorSnapshotFresh(fresh(MIRROR_SNAPSHOT_TTL_MS), NOW), true, '恰好 TTL 边界')
})

test('§1 真机根因：超过 TTL 的冻结快照不得再被当作权威', () => {
  assert.equal(isMirrorSnapshotFresh(fresh(MIRROR_SNAPSHOT_TTL_MS + 1), NOW), false, 'TTL 外一毫秒')
  assert.equal(isMirrorSnapshotFresh(fresh(60_000), NOW), false, '中转断了一分钟')
  assert.equal(isMirrorSnapshotFresh(fresh(10 * MIRROR_SNAPSHOT_TTL_MS), NOW), false, '彻底冻结')
})

test('§1 没有可信时间戳的一律按陈旧处理', () => {
  assert.equal(isMirrorSnapshotFresh({ kind: 'sync', sessions: {} }, NOW), false, '缺 at')
  assert.equal(isMirrorSnapshotFresh({ at: '1700000000000' }, NOW), false, 'at 是字符串')
  assert.equal(isMirrorSnapshotFresh({ at: NaN }, NOW), false, 'at 是 NaN')
  assert.equal(isMirrorSnapshotFresh({ at: Infinity }, NOW), false, 'at 是 Infinity')
  assert.equal(isMirrorSnapshotFresh({ at: 0 }, NOW), false, 'at 为 0')
  assert.equal(isMirrorSnapshotFresh({ at: -1 }, NOW), false, 'at 为负')
  assert.equal(isMirrorSnapshotFresh({ at: NOW + 1 }, NOW), false, '未来时间戳不可信（同机，无时钟偏移）')
})

test('§1 非对象载荷一律不可用', () => {
  for (const bad of [null, undefined, 'sync', 42, true]) {
    assert.equal(isMirrorSnapshotFresh(bad, NOW), false, String(bad))
  }
})

test('§2 行为：冻结快照回源、新鲜快照走快路径', () => {
  // 与 worker 的 snapshotRead 同形的最小接收器，判定用的是真实实现。
  const readThrough = (snapshot, now) => (isMirrorSnapshotFresh(snapshot, now) ? snapshot.sessions : null)
  const body = { ok: true, items: [{ sessionId: 'session-live' }] }

  const frozen = { kind: 'sync', at: NOW - 10 * MIRROR_SNAPSHOT_TTL_MS, sessions: { ok: true, items: [] } }
  assert.equal(readThrough(frozen, NOW), null, '快照冻结时必须回源主进程，否则新会话永远不出现')
  assert.equal(readThrough({ kind: 'sync', at: NOW - 100, sessions: body }, NOW), body, '新鲜快照仍走快路径')
})

test('§3 worker 真的接上了这个判定', () => {
  assert.match(workerSrc, /require\('\.\/mirror-snapshot\.cjs'\)/, 'worker 必须引入镜像新鲜度判定')
  assert.match(
    workerSrc,
    /function snapshotRead\(info\) \{[\s\S]{0,600}?if \(!isMirrorSnapshotFresh\(localSnapshot\)\) return null/,
    'snapshotRead 的第一道门必须是新鲜度判定，而不是只判断快照在不在',
  )
  assert.doesNotMatch(
    workerSrc,
    /if \(!localSnapshot \|\| typeof localSnapshot !== 'object'\) return null/,
    '旧的「只判断存在」写法必须已被替换',
  )
})

test('§3 TTL 是有限的正数（避免「永不过期」重新引入本次缺陷）', () => {
  assert.equal(Number.isInteger(MIRROR_SNAPSHOT_TTL_MS), true)
  assert.equal(MIRROR_SNAPSHOT_TTL_MS > 0, true)
  assert.equal(MIRROR_SNAPSHOT_TTL_MS <= 60_000, true, 'TTL 过大等于没修')
})

test('§4 快照原样回主线：不许重写内容字段', () => {
  // App 侧靠响应自带的 generatedAt 判「这份比我手上的旧」（app 的 session-store
  // 两份清单各一条内容水位）。局域网这条快路径是**原样**把桌面推来的 body 回给手机的
  // ——它连 stale/derived 都不标，App 没有第二个字段可依据。所以这里一旦「顺手」把
  // generatedAt 改成服务时刻，App 就再也分不出新旧，「刚删掉的工作区又回来」重现。
  assert.match(workerSrc, /^  return body$/m, '快照 body 必须原样返回')
  assert.doesNotMatch(workerSrc, /generatedAt/, 'worker 不许自己造/改写 generatedAt')
})

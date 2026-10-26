'use strict'

// 空清单守卫（工作区 / 会话列表共用）。
//
// 「没取到」与「真的什么都没有」在单份快照上长得一模一样：都是 `{ ok: true, items: [] }`。
// 读取侧必须如实报错（见 workspaces.js / sessions.js 的 `*-list-degraded`），守卫负责兜住
// 「宿主确实回了合法空列表」——单看一份快照区分不了它和真实删除，所以按时间兜底。
//
// 一份空快照若被当成权威清单推给中转，下一次 15s 轮询就会把好数据覆盖成空：侧边栏工作区
// 整行消失、会话塌进「未分组」，而且全程零错误提示。所以距上一次确认过的非空清单不到
// graceMs 时拒绝空清单、保留上一份镜像；超过 graceMs 则放行，让真实删除也能收敛。
//
// 抽成独立模块是为了能被真正单测。

const fs = require('node:fs')

/** 空清单宽限：距上一次非空清单不到这么久，就不承认「被清空」。 */
const EMPTY_LIST_GRACE_MS = 15000
const EMPTY_WORKSPACE_GRACE_MS = EMPTY_LIST_GRACE_MS
const EMPTY_SESSION_LIST_GRACE_MS = EMPTY_LIST_GRACE_MS

/** 读回上次进程留下的非空基准；文件不存在/损坏都按「没有基准」处理。 */
function readPersistedBaseline(persistPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8'))
    const value = Number(raw && raw.lastNonEmptyAt)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** 持久化非空基准。插件会随桌面 harness 频繁重启，基准只存在内存里的话，
 *  重启后的第一份空快照（往往正好撞上桌面刚起来的忙乱期）会畅通无阻。 */
function persistBaseline(persistPath, lastNonEmptyAt) {
  if (!persistPath) return
  try {
    fs.writeFileSync(persistPath, JSON.stringify({ lastNonEmptyAt }), 'utf8')
  } catch {
    // 落盘只是加固，失败不影响本次判定。
  }
}

/**
 * 造一个空清单守卫（`{ ok:true, items:[...] }` 形状的快照）。
 *
 * @param {object} [options]
 * @param {string} [options.label] 阻断理由里的清单名称，默认「列表」
 * @param {string} [options.persistPath] 基准落盘路径（可选，单槽位一个文件）
 * @param {number} [options.graceMs] 宽限窗口，默认 EMPTY_LIST_GRACE_MS
 * @param {() => number} [options.now] 时钟，测试可注入
 * @returns {{ check: (body: unknown) => string|null, peek: () => { lastNonEmptyAt: number } }}
 *   `check` 返回 null 表示这份快照可用；否则返回阻断理由（可直接喂给 recordMirrorPush）。
 */
function createEmptyListGuard(options) {
  const label = (options && typeof options.label === 'string' && options.label) ? options.label : '列表'
  const graceMs = options && Number.isFinite(options.graceMs)
    ? Number(options.graceMs)
    : EMPTY_LIST_GRACE_MS
  const now = (options && typeof options.now === 'function') ? options.now : Date.now
  const persistPath = (options && typeof options.persistPath === 'string') ? options.persistPath : ''
  let lastNonEmptyAt = persistPath ? readPersistedBaseline(persistPath) : 0

  return {
    check(body) {
      if (!body || typeof body !== 'object' || body.ok !== true) {
        return `${label} 快照不可用，本次未推送`
      }
      const count = Array.isArray(body.items) ? body.items.length : 0
      if (count > 0) {
        lastNonEmptyAt = now()
        persistBaseline(persistPath, lastNonEmptyAt)
        return null
      }
      // 显式空态（`emptyConfirmed: true`）：读取侧已经断言「上游回了一份合法且为空的
      // 清单」——形状异常会走错误通道（见 sessions/workspaces 的 build*Body），能带上这个
      // 标记就说明这不是「没取到」。此时不该再被时间窗挡住：用户真的把侧栏清空时，时间
      // 窗正好是「手机侧永远看不到清空」的来源。时间兜底只留给没有这个标记的旧快照。
      if (body.emptyConfirmed === true) {
        if (lastNonEmptyAt) {
          lastNonEmptyAt = 0
          persistBaseline(persistPath, 0)
        }
        return null
      }
      if (lastNonEmptyAt && now() - lastNonEmptyAt < graceMs) {
        return `${label}快照为空且距上次非空清单不足 ${graceMs / 1000}s，本次未推送`
          + `（防止把「没取到」广播成「你没有${label}」）`
      }
      // 从来没有过非空清单（本来就没有），或已经空过整个宽限窗口（真的删光了）：
      // 两种都认下来。放行后清基准，否则后续空快照会被同一基准一直挡着。
      if (lastNonEmptyAt) {
        lastNonEmptyAt = 0
        persistBaseline(persistPath, 0)
      }
      return null
    },
    peek() {
      return { lastNonEmptyAt }
    },
  }
}

function createWorkspaceGuard(options) {
  return createEmptyListGuard({ ...(options || {}), label: '工作区' })
}

function createSessionListGuard(options) {
  return createEmptyListGuard({ ...(options || {}), label: '会话' })
}

module.exports = {
  EMPTY_LIST_GRACE_MS,
  EMPTY_WORKSPACE_GRACE_MS,
  EMPTY_SESSION_LIST_GRACE_MS,
  createEmptyListGuard,
  createWorkspaceGuard,
  createSessionListGuard,
}

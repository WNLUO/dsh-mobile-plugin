/**
 * 会话数据清理：按 sessionId 删除 dshHome 下的 sessions/** 目录与 project cache。
 *
 * 两个入口共用 deleteSessionData：DSH agent 工具 registerSessionCleanupTool（action=delete
 * 必须 confirm:true 且只针对已归档）与移动 API /workspace/clear-archived（archive-clean.js）。
 *
 * 认哪份文件、怎么读 id 都以宿主自己的规则为准，不按目录名猜：
 *  - 文件名 = `session[.vN].jsonl[.zstd]`（宿主 `dsh-session-format` 的
 *    CANONICAL_LOG_FILENAME + compressionSuffix：0 代不带 vN，压缩时才带 .zstd）。
 *    曾经只认 `session.jsonl.zstd`，于是 0.2.0 真在用的 `session.v4.jsonl.zstd`
 *    一个都认不到 —— 表现是「清理已归档」恒回 `deleted: 0`，静默不删。
 *  - 删之前先从宿主归档集合里摘掉这些 id：宿主不会自己修剪，删完还留着就是「已归档」
 *    里一排点不开的死行，且每清一次只增不减。
 *  - 解压用 Node 自带的 zstd（DSH 自己就是这么读写日志的，宿主并不需要系统 zstd
 *    命令），不再 shell 出去：没装 zstd 命令的机器上它一缺就是 readHeader 静默返回
 *    undefined，整条删除路径空转。id 仍然取自日志第一行那条 header。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const DEFAULT_OLDER_THAN_MINUTES = 30
const MINUTES = 60 * 1000

// 宿主认可的会话日志名。非规范名（迁移中途的临时文件、大写、前导零、带 v0）宿主自己
// 也不认，这里同样不认 —— 认多了会把没提交的代次当会话删掉。
const CANONICAL_LOG_FILENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
// 只需要第一行那条 header；给个上限，别为了读一行把整份日志解进内存。
const HEADER_MAX_BYTES = 64 * 1024

const { envelopeValue, unwrap } = require('./mobile/envelope.js')

function asItems(response) {
  const value = envelopeValue(response)
  return (value && Array.isArray(value.items) ? value.items : [])
}

function asWorkspaceState(response) {
  const value = envelopeValue(response)
  return value && typeof value === 'object' ? value : {}
}

function projectItems(items, cwd) {
  return items.filter(item => item?.cwd === cwd)
}

function candidates(items, archivedSessionIds, args, now = Date.now()) {
  const ids = new Set(Array.isArray(args.sessionIds) ? args.sessionIds.filter(id => typeof id === 'string' && id) : [])
  const cutoff = now - (Number.isFinite(args.olderThanMinutes) ? args.olderThanMinutes : DEFAULT_OLDER_THAN_MINUTES) * MINUTES
  return items.filter(item => {
    if (item?.blank || item?.running || typeof item?.sessionId !== 'string') return false
    if (ids.size > 0) return ids.has(item.sessionId)
    if (typeof args.cwd === 'string' && args.cwd && item.cwd !== args.cwd) return false
    if (!Number.isFinite(item.updatedAt) || item.updatedAt >= cutoff) return false
    if (args.action === 'delete' && !archivedSessionIds.has(item.sessionId)) return false
    return true
  })
}

function projectCount(items, cwd) {
  return projectItems(items, cwd).filter(item => !item?.blank).length
}

const { dshHome } = require('./shared/paths')

/** 读日志第一行那条 header（id 的真源）。压缩件用 Node 自带的 zstd 流式解，读到换行就停。 */
async function readHeader(file) {
  const source = fs.createReadStream(file)
  const stream = file.endsWith('.zstd') ? source.pipe(zlib.createZstdDecompress()) : source
  const chunks = []
  let size = 0
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      size += chunk.length
      const joined = Buffer.concat(chunks, size)
      const end = joined.indexOf(0x0a)
      if (end >= 0) return JSON.parse(joined.subarray(0, end).toString('utf8'))
      if (size >= HEADER_MAX_BYTES) return undefined
    }
  } catch {
    return undefined
  } finally {
    stream.destroy()
    source.destroy()
  }
  return undefined
}

function sessionFiles(root) {
  const result = []
  const visit = directory => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (CANONICAL_LOG_FILENAME.test(entry.name)) result.push(file)
    }
  }
  visit(root)
  return result
}

async function deleteSessionData(sessionIds) {
  const ids = new Set(sessionIds)
  const removed = []
  const root = path.join(dshHome(), 'sessions')
  for (const file of sessionFiles(root)) {
    const header = await readHeader(file)
    if (!header || !ids.has(header.id)) continue
    try {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
      removed.push(header.id)
    } catch (error) {
      throw new Error(`删除会话 ${header.id} 失败：${error.message}`)
    }
  }
  const cacheRoot = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  for (const id of ids) {
    for (const name of [`${id}.json`, `session-${id}.json`]) {
      try { fs.rmSync(path.join(cacheRoot, name), { force: true }) } catch { /* cache cleanup is best effort */ }
    }
  }
  return removed
}

/**
 * 把已经从磁盘删掉的 id 从宿主归档集合里擦掉（删除路径的最后一步，best-effort）。
 *
 * 宿主不会自己修剪这份集合：日志删了它照样留着那些 id，于是「已归档」里是一排点不开的
 * 死行，而且每清一次就多几条、只增不减。它排在 `deleteSessionData` **之后**：日志没删成
 * 前先擦集合，中途失败就会留下「已取消归档、日志还在」的会话——用户看到的是清理只把会话
 * 移出了归档，还要重启宿主才恢复。先删后擦则日志一没就是真的删掉了，立刻生效；擦失败最多
 * 留一行死行，重试即可。宿主对本来就未归档的 id 是 no-op。
 *
 * 只传**真删掉**的 id：没匹配到日志的还留着日志，擦掉它的名字只会让那一行消失而没有东西被删。
 *
 * 返回擦失败的 id（`failed`），**不抛异常**：日志已经删成功，擦集合坏了不该让整条清理
 * 报错——那等于告诉用户「没删掉」，而事实上已经删掉了。
 */
async function forgetArchivedSessions(ctx, sessionIds, rpcId) {
  const failed = []
  const unarchive = ctx && ctx.apiProxy && ctx.apiProxy.workspace ? ctx.apiProxy.workspace.unarchiveSession : undefined
  if (typeof unarchive !== 'function') return failed
  for (const sessionId of sessionIds) {
    try {
      const { error } = unwrap(await unarchive({ rpcId, method: 'workspace.unarchiveSession', payload: { sessionId } }))
      if (error) failed.push(sessionId)
    } catch { failed.push(sessionId) }
  }
  return failed
}

async function cleanupSessions(ctx, args) {
  const list = ctx.apiProxy?.sessions?.list
  const workspaceList = ctx.apiProxy?.workspace?.list
  const archive = ctx.apiProxy?.workspace?.archiveSession
  if (typeof list !== 'function' || typeof workspaceList !== 'function' || typeof archive !== 'function') throw new Error('会话清理能力不可用')
  // 兼容桥总是提供这三个方法（它就是 apiProxy 的实现），所以「方法在不在」不再是宿主
  // 能力探针 —— 真正要看的是调用结果：宿主没这个能力时会回 host-unavailable。
  const listResponse = await list({ rpcId: 'dsh-mobile-plugin-session-cleanup', method: 'session.list', payload: {} })
  const workspaceResponse = await workspaceList({ rpcId: 'dsh-mobile-plugin-session-cleanup', method: 'workspace.list', payload: {} })
  for (const [name, response] of [['session.list', listResponse], ['workspace.list', workspaceResponse]]) {
    const failure = response && response.result && response.result.ok === false ? response.result.error : null
    if (failure) throw new Error(`${name} 失败：${failure.message || failure.code || '未知错误'}`)
  }
  const items = asItems(listResponse)
  const workspace = asWorkspaceState(workspaceResponse)
  const archived = new Set(Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds : [])
  const selected = candidates(items, archived, args)
  const cwd = args.cwd || selected.find(item => item.cwd)?.cwd || ''
  if (args.minProjectSessions && cwd && projectCount(items, cwd) < args.minProjectSessions) return { action: args.action, cwd, selected: 0, archived: 0, deleted: 0, failed: 0, sessionIds: [] }
  if (args.action === 'archive') {
    let count = 0
    const failures = []
    for (const item of selected) {
      try {
        const result = await archive({ rpcId: 'dsh-mobile-plugin-session-cleanup', method: 'workspace.archiveSession', payload: { sessionId: item.sessionId } })
        const failure = result && result.result && result.result.ok === false ? result.result.error : null
        if (failure) throw new Error(failure.message || '归档被拒绝')
        count += 1
      } catch (error) { failures.push({ sessionId: item.sessionId, error: error.message }) }
    }
    return { action: args.action, cwd, selected: selected.length, archived: count, deleted: 0, failed: failures.length, failures, sessionIds: selected.map(item => item.sessionId) }
  }
  if (args.confirm !== true) throw new Error('永久删除需要 confirm: true')
  const ids = selected.map(item => item.sessionId)
  // 与移动端那条路由同一口径：**先删日志、再擦归档集合**。反过来会在链路中途失败时
  // 留下「名字已从归档集合消失、日志还在」的会话（看着像只是被移出了归档，得重启宿主
  // 才恢复）；先删则日志一没就是真的删掉了，立刻生效。擦集合是收尾，失败不改变结果。
  const deletedIds = await deleteSessionData(ids)
  await forgetArchivedSessions(ctx, deletedIds, 'dsh-mobile-plugin-session-cleanup')
  return { action: args.action, cwd, selected: ids.length, archived: 0, deleted: deletedIds.length, failed: ids.length - deletedIds.length, sessionIds: deletedIds }
}

function registerSessionCleanupTool(ctx) {
  const { defineTool } = require('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: 'session_cleanup',
    description: 'Archive or permanently delete old DSH sessions. Delete only targets already archived sessions and requires confirm=true.',
    parameters: {
      action: { type: 'string', required: true, enum: ['archive', 'delete'], description: 'archive hides sessions; delete permanently removes their logs and local projection cache.' },
      cwd: { type: 'string', description: 'Project directory to target. Required when selecting by age across multiple projects.' },
      olderThanMinutes: { type: 'number', description: 'Only target sessions not updated within this many minutes. Defaults to 30.' },
      minProjectSessions: { type: 'integer', description: 'Skip the operation when the selected project has fewer sessions than this number.' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'Explicit session IDs. When provided, age and project filters are ignored.' },
      confirm: { type: 'boolean', description: 'Must be true for permanent deletion.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string' }, cwd: { type: 'string' }, selected: { type: 'integer' }, archived: { type: 'integer' }, deleted: { type: 'integer' }, failed: { type: 'integer' }, sessionIds: { type: 'array', items: { type: 'string' } }, failures: { type: 'array', items: { type: 'object' } },
      } },
      render: (_args, value) => [{ type: 'text', text: `${value.action === 'archive' ? 'Archived' : 'Deleted'} ${value.action === 'archive' ? value.archived : value.deleted} sessions.` }],
    },
    execute: (args) => cleanupSessions(ctx, args),
  }))
}

module.exports = { cleanupSessions, registerSessionCleanupTool, deleteSessionData, forgetArchivedSessions }

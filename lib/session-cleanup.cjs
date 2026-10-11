'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DEFAULT_OLDER_THAN_MINUTES = 30
const MINUTES = 60 * 1000

const { envelopeValue } = require('./mobile/envelope.js')

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

function readHeader(file) {
  try {
    const firstLine = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 16384 }).split('\n', 1)[0]
    return JSON.parse(firstLine)
  } catch {
    return undefined
  }
}

function sessionFiles(root) {
  const result = []
  const visit = directory => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name === 'session.jsonl.zstd') result.push(file)
    }
  }
  visit(root)
  return result
}

function deleteSessionData(sessionIds) {
  const ids = new Set(sessionIds)
  const removed = []
  const root = path.join(dshHome(), 'sessions')
  for (const file of sessionFiles(root)) {
    const header = readHeader(file)
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
  const deletedIds = deleteSessionData(ids)
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

module.exports = { cleanupSessions, registerSessionCleanupTool }

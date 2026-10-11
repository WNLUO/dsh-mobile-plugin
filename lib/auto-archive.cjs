'use strict'

const { unwrap } = require('./mobile/envelope.js')

const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000
const SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000

function projectCounts(items) {
  const counts = new Map()
  for (const item of items) {
    const cwd = typeof item?.cwd === 'string' ? item.cwd.trim() : ''
    if (cwd) counts.set(cwd, (counts.get(cwd) || 0) + 1)
  }
  return counts
}

function archiveCandidates(items, now = Date.now()) {
  const counts = projectCounts(items)
  const cutoff = now - ARCHIVE_AFTER_MS
  return items.filter(item => {
    const cwd = typeof item?.cwd === 'string' ? item.cwd.trim() : ''
    if (!cwd || (counts.get(cwd) || 0) <= 10) return false
    if (item?.blank || item?.running || item?.sessionId === undefined) return false
    return Number.isFinite(item.updatedAt) && item.updatedAt < cutoff
  })
}

function loggerOf(ctx) {
  return ctx?.logger && typeof ctx.logger === 'object' ? ctx.logger : undefined
}

function logFailure(ctx, sessionId, error) {
  const logger = loggerOf(ctx)
  const message = `automatic session archive failed for ${sessionId}: ${String(error?.message || error)}`
  if (typeof logger?.warn === 'function') logger.warn(message)
  else if (typeof logger?.error === 'function') logger.error(message)
}

async function scanAndArchive(ctx, now = Date.now()) {
  const api = ctx?.apiProxy
  const list = api?.sessions?.list
  const archive = api?.workspace?.archiveSession
  if (typeof list !== 'function' || typeof archive !== 'function') return { scanned: 0, archived: 0, failed: 0 }

  const response = await list({ rpcId: 'dsh-mobile-plugin-auto-archive', method: 'session.list', payload: {} })
  // 回执是 { result: { ok, value } } 信封：早先这里直接读 response.value，
  // 而 list() 的回执根本不在那一层——这个定时任务从来没真正扫到过会话。
  const listed = unwrap(response)
  const items = (listed.value && listed.value.items) || []
  const candidates = archiveCandidates(items, now)
  let archived = 0
  let failed = 0
  for (const item of candidates) {
    try {
      const result = await archive({
        rpcId: 'dsh-mobile-plugin-auto-archive',
        method: 'workspace.archiveSession',
        payload: { sessionId: item.sessionId },
      })
      if (result?.ok === false) throw new Error(result.error?.message || 'archive rejected')
      archived += 1
    } catch (error) {
      failed += 1
      logFailure(ctx, item.sessionId, error)
    }
  }
  return { scanned: items.length, archived, failed }
}

function installAutoArchive(ctx) {
  let disposed = false
  let inFlight
  const scan = () => {
    if (disposed || inFlight) return inFlight
    inFlight = Promise.resolve().then(() => scanAndArchive(ctx)).catch(error => {
      logFailure(ctx, 'scan', error)
      return { scanned: 0, archived: 0, failed: 1 }
    }).finally(() => { inFlight = undefined })
    return inFlight
  }

  void scan()
  const timer = setInterval(() => { void scan() }, SCAN_INTERVAL_MS)
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
  }
}

module.exports = {
  ARCHIVE_AFTER_MS,
  SCAN_INTERVAL_MS,
  archiveCandidates,
  installAutoArchive,
  projectCounts,
  scanAndArchive,
}

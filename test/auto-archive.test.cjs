'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  ARCHIVE_AFTER_MS,
  archiveCandidates,
  scanAndArchive,
} = require('../lib/auto-archive.cjs')

const now = 2_000_000_000_000
const session = (id, patch = {}) => ({
  sessionId: id,
  cwd: '/tmp/project',
  updatedAt: now - ARCHIVE_AFTER_MS - 1,
  running: false,
  blank: false,
  ...patch,
})

test('archives stale sessions only in projects with more than ten sessions', () => {
  const items = Array.from({ length: 11 }, (_, i) => session(`old-${i}`))
  items.push(session('recent', { updatedAt: now - ARCHIVE_AFTER_MS + 1 }))
  items.push(session('running', { running: true }))
  items.push(session('blank', { blank: true }))
  assert.deepEqual(archiveCandidates(items, now).map(item => item.sessionId), Array.from({ length: 11 }, (_, i) => `old-${i}`))
  assert.deepEqual(archiveCandidates([...items.slice(0, 10)], now), [])
})

test('scans once and continues after an individual archive failure', async () => {
  const calls = []
  const items = [session('one'), session('two'), ...Array.from({ length: 9 }, (_, i) => session(`extra-${i}`))]
  const ctx = {
    apiProxy: {
      // 回执是 { result: { ok, value } } 信封——与本仓库其余全部 list() 测试一致。
      // 原先这里写的是裸 { value: { items } }，生产代码为了迁就它去读 response.value，
      // 于是这个定时任务实际一次会话都没扫到过。
      sessions: { list: async request => { calls.push(['list', request]); return { result: { ok: true, value: { items } } } } },
      workspace: { archiveSession: async request => {
        calls.push(['archive', request])
        if (request.payload.sessionId === 'one') throw new Error('temporary')
        return { ok: true, value: { archivedSessionIds: [request.payload.sessionId] } }
      } },
    },
    logger: { warn: message => calls.push(['warn', message]) },
  }
  const result = await scanAndArchive(ctx, now)
  assert.deepEqual(result, { scanned: 11, archived: 10, failed: 1 })
  assert.equal(calls.filter(([kind]) => kind === 'list').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'archive').length, 11)
  assert.deepEqual(calls[1][1].payload, { sessionId: 'one' })
})

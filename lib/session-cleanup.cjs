/**
 * 会话数据清理：按 sessionId 删除 dshHome 下的 sessions/** 目录与 project cache。
 *
 * 两个入口共用同一套落地代码：DSH agent 工具 `registerSessionCleanupTool`（action=delete 必须
 * confirm 且只针对已归档）与移动 API `/workspace/clear-archived`。
 *
 * 两个入口都不在进程里删磁盘：只把 id 排进待删队列（dshHome 下的
 * `mobile-archived-clear.json`），真正的删除放在宿主下次启动时做。宿主没有「删除会话」接口，
 * 进程活着时那些会话随时可能被读或写，文件不在就是一次未捕获的 ENOENT，整个进程退出。
 *
 * 认哪份文件、怎么读 id 以宿主规则为准，不按目录名猜：
 *  - 文件名是 `session[.vN].jsonl[.zstd]`（0 代不带 vN，压缩时才带 .zstd）；
 *  - 解压用 Node 自带的 zstd，不 shell 出去，id 取自日志第一行的 header；
 *  - 进程活着时不删日志、也不擦宿主的归档集合，两件事都放到宿主启动时；
 *  - Windows 上目录删不掉不等于会话没删掉：宿主握着 `session.lock` 时名字要等句柄关闭才
 *    消失，所以判据是「目录里还有没有规范名日志」。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const DEFAULT_OLDER_THAN_MINUTES = 30
const MINUTES = 60 * 1000

/** 认为「宿主刚起来」的上限：装载插件只在这段时间里算启动，之后出现的调用只能是热替换。 */
const BOOT_PRUNE_WINDOW_SECONDS = 60

// 宿主认可的会话日志名。非规范名（迁移中途的临时文件、大写、前导零、带 v0）宿主自己
// 也不认，这里同样不认 —— 认多了会把没提交的代次当会话删掉。
const CANONICAL_LOG_FILENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
// 只需要第一行那条 header；给个上限，别为了读一行把整份日志解进内存。
const HEADER_MAX_BYTES = 64 * 1024

const { envelopeValue, unwrap } = require('./mobile/envelope.js')
const { rememberDeletedSessionIds } = require('./mobile/session-cache.js')
// 删之前那一刀统计补采：与手机那个「清理已归档」按钮共用同一份预算（见 mobile/stats-collect.cjs）。
const { collectStats, DELETING_COLLECT_BUDGET_MS } = require('./mobile/stats-collect.cjs')
// 收件目录的启动清理与这里共用同一个「宿主刚起来」的窗口，实现见 mobile/inbox-clean.js。
const { clearInboxOnce } = require('./mobile/inbox-clean.js')

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
    // Windows 上句柄没真的关掉之前，这个目录项删不掉（delete-pending → rmdir 报 ENOTEMPTY）。
    // 删会话目录就紧跟在读 header 之后，所以先等 close 再往下走。
    if (!source.closed) await new Promise(resolve => source.once('close', resolve))
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
    const directory = path.dirname(file)
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      // Windows：宿主握着 session.lock，日志 unlink 成功了但名字还在（delete-pending），
      // rmdir 报 ENOTEMPTY。日志都没了，这条会话对宿主就等于已经删掉，按删成记账、继续清
      // 下一条；日志还在才算真失败（别把没删掉的说成删掉了）。
      if (sessionFiles(directory).length > 0) throw new Error(`删除会话 ${header.id} 失败：${error.message}`)
    }
    removed.push(header.id)
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
 * 把一批 id 从宿主归档集合里擦掉（宿主对本来就未归档的 id 是 no-op）。
 *
 * 唯一的调用方是宿主启动时的孤儿修剪：进程活着的时候擦集合会把桌面端快照里那些已经
 * 删掉的行放回正常列表，理由见 pruneOrphanedArchivedSessionsOnce。
 *
 * 返回擦失败的 id（`failed`），**不抛异常**：修剪是收尾，一条擦不动不该让整轮修剪停摆。
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

/**
 * 归档集合里那些日志确实已经不在磁盘上的 id。
 *
 * 判据是磁盘而不是宿主的会话列表：`sessions.list` 会不会漏一条（比如没有 cwd 的会话、
 * 宿主服务还没装好）不是这里能判断的，而「归档集合里挂着、磁盘上已经没有日志」正是
 * 清理真正删掉的那个状态。宿主把会话 id 原样当目录名（`encodeSegment` 对正常 id 恒等），
 * 所以先用目录名筛掉绝大多数，只对候选读一遍 header 复核 —— 别为了修剪把整库日志解一遍。
 */
async function archivedIdsWithoutLogs(archivedSessionIds) {
  const orphans = new Set(archivedSessionIds)
  if (orphans.size === 0) return []
  for (const file of sessionFiles(path.join(dshHome(), 'sessions'))) {
    const name = path.basename(path.dirname(file))
    if (!orphans.has(name)) continue
    const header = await readHeader(file)
    // 日志读不出来也算「还在」：宁可这一轮不修剪，也不能把一条还有日志的会话移出归档。
    orphans.delete(name)
    if (header && typeof header.id === 'string') orphans.delete(header.id)
    if (orphans.size === 0) break
  }
  return [...orphans]
}

/**
 * 盘上已经不剩任何会话数据的 id：目录没了，或者目录里只剩宿主锁着的 `session.lock`。
 *
 * 只给移动端的「清理所有已归档」补账用：更早一次删除如果删到一半抛错（Windows 上目录非空
 * 时就是这样），已经删掉的那批 id 没能记进本进程的删除集，而宿主的进程内清单还挂着它们 ——
 * 再点清理只会回 `deleted: 0`，手机上永远清不掉。
 *
 * 判据比 archivedIdsWithoutLogs 更宽（那个只认规范名日志），但**不许宽到把迁移中途的
 * 临时文件当成没有数据**：目录里只要还有任何非锁文件（含子目录）就算「还在」，读不出来
 * 也按「还在」算。
 */
function sessionIdsWithoutAnyData(sessionIds) {
  const candidates = new Set(sessionIds)
  const withoutData = new Set()
  if (candidates.size === 0) return []
  const visit = (directory) => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = path.join(directory, entry.name)
      if (!candidates.has(entry.name)) { visit(child); continue }
      candidates.delete(entry.name)
      let files
      try { files = fs.readdirSync(child, { withFileTypes: true }) } catch { continue }
      if (!files.some((file) => !file.name.endsWith('.lock'))) withoutData.add(entry.name)
    }
  }
  visit(path.join(dshHome(), 'sessions'))
  return [...candidates, ...withoutData]
}

/**
 * 「清理所有已归档」的待删队列：dshHome 下的一份小 JSON（`mobile-archived-clear.json`）。
 *
 * 用户点清理的那一刻**不动磁盘**，只把 id 记进这里；真正的删除在宿主下次启动时做，见
 * deleteQueuedArchivedSessions。原因是宿主没有「删除会话」这个接口：进程活着的时候，
 * 它内存里那些会话随时可能被读或写（列一遍会话、续写一条事件、开一条还没落盘的空白会话），
 * 文件不在就是一次没人接的 ENOENT —— 宿主对未捕获异常零容忍，进程直接退出，桌面端窗口
 * 跟着消失（清理删到一条 0 轮次的空白归档会话就会这样）。
 *
 * 队列是**并集**语义：同一批 id 点两次、两次清理之间换了批次，都只是往同一张表里加。
 */
const PENDING_ARCHIVED_CLEAR_FILE = 'mobile-archived-clear.json'

function pendingArchivedClearFile() {
  return path.join(dshHome(), PENDING_ARCHIVED_CLEAR_FILE)
}

/** 队列里的 id。文件不在 / 读坏了都当空：下一次点清理会把该排的重新排一遍。 */
function readPendingArchivedClearIds() {
  let text
  try { text = fs.readFileSync(pendingArchivedClearFile(), 'utf8') } catch { return [] }
  try {
    const parsed = JSON.parse(text)
    const list = parsed && Array.isArray(parsed.sessionIds) ? parsed.sessionIds : []
    return [...new Set(list.filter((id) => typeof id === 'string' && id))]
  } catch {
    return []
  }
}

/**
 * 整份覆写队列；空队列就删文件。
 *
 * 写失败**向上抛**：排不上队就不能回「已清理」——那等于告诉用户删掉了，重启之后它们
 * 原样回来。调用方（清理路由 / agent 工具）自带失败通道，不需要在这里兜。
 */
function writePendingArchivedClearIds(sessionIds) {
  const file = pendingArchivedClearFile()
  const unique = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string' && id))]
  if (unique.length === 0) {
    fs.rmSync(file, { force: true })
    return []
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 先写临时文件再改名：宿主随时可能被杀，半截 JSON 会让下一次启动整队读不出来。
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ sessionIds: unique }, null, 2)}\n`)
  fs.renameSync(temp, file)
  return unique
}

/** 把一批 id 排进队列（并集、幂等），返回排完之后的整队。 */
function queueArchivedClearIds(sessionIds) {
  const incoming = Array.isArray(sessionIds) ? sessionIds : []
  return writePendingArchivedClearIds([...readPendingArchivedClearIds(), ...incoming])
}

/**
 * 宿主刚启动时把队里排着的日志真正删掉，删成的从队列里摘掉。
 *
 * 只在这个时刻删：桌面端还没连上（或正要重连，快照本来就从磁盘重新拉），宿主手上也没有
 * 任何热会话，不存在「正读着 / 正写着被删掉的那条」。某一条删不掉（日志还在盘上）不算整轮
 * 失败 —— 它的 id 留在队里等下次启动，其余照删。deleteSessionData 中途抛错时已经删掉的
 * 那批靠 sessionIdsWithoutAnyData 补账（返回值随异常丢了）。
 *
 * @returns {Promise<{deleted: string[], kept: string[]}>}
 */
async function deleteQueuedArchivedSessions(log, ctx) {
  const queued = readPendingArchivedClearIds()
  if (queued.length === 0) return { deleted: [], kept: [] }
  let removed = []
  try {
    removed = await deleteSessionData(queued)
  } catch (error) {
    log?.(`archived clear queue: ${error && error.message ? error.message : String(error)}`)
  }
  const done = new Set([...removed, ...sessionIdsWithoutAnyData(queued)])
  const deleted = queued.filter((id) => done.has(id))
  const kept = queued.filter((id) => !done.has(id))
  writePendingArchivedClearIds(kept)
  // 出队之后还得在本进程继续压住：宿主那份会话清单可能是清理之前建好的，行还在里面。
  // 没有这一步，手机上会冒出一条点进去什么都没有的归档行（修剪成功时它甚至会被当成
  // 未归档的普通行露出来）。
  if (ctx && deleted.length > 0) rememberDeletedSessionIds(ctx, deleted)
  return { deleted, kept }
}

/**
 * 队列里的 id 在手机上必须继续看不到：插件的删除集是**进程内**的，宿主重启、代际热替换
 * 都会丢，而队列里的会话在宿主那边还活着（归档列表照样列得出它们）。每次装载都从队列
 * 里补一遍，两次启动之间也不会复活。
 */
function restoreQueuedArchivedClearIds(ctx) {
  const queued = readPendingArchivedClearIds()
  if (queued.length > 0) rememberDeletedSessionIds(ctx, queued)
  return queued
}

async function pruneOrphanedArchivedSessions(ctx) {
  const workspaceList = ctx && ctx.apiProxy && ctx.apiProxy.workspace ? ctx.apiProxy.workspace.list : undefined
  if (typeof workspaceList !== 'function') return 0
  const rpcId = 'dsh-mobile-plugin-archive-prune'
  const { value, error } = unwrap(await workspaceList({ rpcId, method: 'workspace.list', payload: {} }))
  if (error) throw new Error(`workspace.list 失败：${error.message || error.code || '未知错误'}`)
  const archived = value && Array.isArray(value.archivedSessionIds)
    ? value.archivedSessionIds.filter((id) => typeof id === 'string' && id)
    : []
  const orphans = await archivedIdsWithoutLogs(archived)
  if (orphans.length === 0) return 0
  const failed = await forgetArchivedSessions(ctx, orphans, rpcId)
  return orphans.length - failed.length
}

/**
 * 宿主进程启动时做一次收尾，然后整个进程不再碰：先删队里排着的日志，再修剪归档集合。
 *
 * 这两件事都只能在启动这一刻做：
 *  - **删日志**：宿主没有「删除会话」接口，进程活着时它随时可能去开那些文件；文件不在
 *    就是一次未捕获的 ENOENT，宿主直接退出。
 *  - **擦归档集合**：桌面端的会话列表是「连上宿主时拉的一份快照 + 之后的事件增量」，
 *    进程活着的时候擦集合，宿主会把「归档集合变了」广播给桌面端，桌面端就把它快照里
 *    那些其实已经没有日志、本来被归档藏着的行放回正常列表 —— 用户报的正是「清理后
 *    它们又回来了，重启 DSH 才真的消失」。启动时快照本来就从磁盘重新拉，擦掉不会放出
 *    任何行。留在集合里的死 id 不显示在任何地方：「已归档」取的是会话列表与归档集合
 *    的交集，没有日志就没有那一行。
 *
 * 用进程级标记而不是模块变量：代际热替换会重跑 apply，而桌面端那条快照挂在同一个进程上。
 */
const PRUNE_ONCE = Symbol.for('dsh-mobile-plugin.archived-prune')
const PRUNE_ATTEMPTS = 3
const PRUNE_RETRY_MS = 500
async function pruneOrphanedArchivedSessionsOnce(ctx, log) {
  if (globalThis[PRUNE_ONCE]) return
  globalThis[PRUNE_ONCE] = true
  // 删日志不碰宿主，先做：越早越好，别等宿主把 workspace 服务挂齐（那时桌面端可能已经连上）。
  try {
    const { deleted, kept } = await deleteQueuedArchivedSessions(log, ctx)
    if (deleted.length > 0) log?.(`archived clear queue: deleted ${deleted.length} session logs`)
    if (kept.length > 0) log?.(`archived clear queue: ${kept.length} session logs kept for the next start`)
  } catch (error) {
    log?.(`archived clear queue failed: ${error && error.message ? error.message : String(error)}`)
  }
  // 修剪要等宿主的 workspace 服务就绪：0.2.x 的 workspace.list 就是 workspace.follow 的
  // 首帧，刚启动那一下常常还没开出来。以前一次失败就把整轮收尾丢掉，结果是归档集合里
  // 的死 id 一直没人清（实测宿主重启过一次，315 个没有日志的 id 原样挂着）。
  for (let attempt = 1; attempt <= PRUNE_ATTEMPTS; attempt += 1) {
    try {
      const pruned = await pruneOrphanedArchivedSessions(ctx)
      if (pruned > 0) log?.(`archived session prune: dropped ${pruned} deleted session ids`)
      return
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      if (attempt === PRUNE_ATTEMPTS) log?.(`archived session prune failed: ${message}`)
      else await new Promise((resolve) => setTimeout(resolve, PRUNE_RETRY_MS * attempt))
    }
  }
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
  // 删之前先把这批会话的用量采进统计账本：日志一没，那部分用量就再也读不出来了。手机那个
  // 「清理已归档」按钮一直有这一刀，这条工具路以前没有 —— 走它删掉的会话，上次采集之后的
  // 那一截增量就白丢。采不上不挡删除：统计偏旧好过会话删不掉。
  try {
    await collectStats(ctx, { sessionIds: ids, force: true, skipPreview: true, budgetMs: DELETING_COLLECT_BUDGET_MS })
  } catch {
    /* 统计是旁路 */
  }
  // 与移动端那条路由同一口径：进程里只排队，**日志留到宿主下次启动时删**。进程活着时
  // 删日志，宿主随时可能去开一条已经不存在的文件，那是未捕获异常（会带走整个宿主）。
  queueArchivedClearIds(ids)
  rememberDeletedSessionIds(ctx, ids)
  return { action: args.action, cwd, selected: ids.length, archived: 0, deleted: ids.length, failed: 0, sessionIds: ids }
}

function registerSessionCleanupTool(ctx) {
  const { defineTool } = require('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: 'session_cleanup',
    description: 'Archive or permanently delete old DSH sessions. Delete only targets already archived sessions, requires confirm=true, and drops their logs when the host next starts.',
    parameters: {
      action: { type: 'string', required: true, enum: ['archive', 'delete'], description: 'archive hides sessions; delete schedules permanent removal of their logs and local projection cache at the next host start.' },
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
      render: (_args, value) => [{ type: 'text', text: value.action === 'archive' ? `Archived ${value.archived} sessions.` : `Scheduled ${value.deleted} sessions for removal; their logs are deleted the next time the host starts.` }],
    },
    execute: (args) => cleanupSessions(ctx, args),
  }))
}

/**
 * 装配层的入口：注册 agent 的清理工具，同时在「宿主刚起来」时删掉待删队列里的日志、
 * 修剪一遍归档集合。
 *
 * 三件事都是会话清理的一部分，所以共用装配层那一处 effect；impl.js 有行数兜底守卫，
 * 别把实现搬回去。
 */
function installSessionCleanup(ctx) {
  // 队列里的 id 每次装载都要补回删除集：宿主重启、代际热替换都会丢掉进程内那份，
  // 而它们在宿主那边还活着（归档列表照样列得出），漏一次手机上就「又回来了」。
  try {
    restoreQueuedArchivedClearIds(ctx)
  } catch { /* 读不出来就当没有：用户再点一次清理会重新排队 */ }
  // 「宿主启动时」不能只看进程级标记：升级到这份实现那次是**热替换**进来的（进程早就在跑），
  // 标记还没被谁设过。那一刻桌面端的会话列表快照里可能正挂着之前删掉的行，擦集合就会把它们
  // 放回列表。所以只在进程刚起的这点窗口里修剪；晚于它就留给下次启动。
  if (process.uptime() <= BOOT_PRUNE_WINDOW_SECONDS) {
    // 收尾先挂：没有 tools 注入的 profile 注册不了工具（外层会吞掉这条错），但队列里的日志
    // 与归档集合照样要收尾。
    void pruneOrphanedArchivedSessionsOnce(ctx, (message) => {
      try { ctx.logger?.info?.(message) } catch { /* 日志失败不影响修剪 */ }
    })
    // 收件目录（手机分享进来的文件）也在这里顺手清一次：它只进不出，不点按钮就没人管。
    // 与上面那条同一个「宿主刚起来」的窗口，但两者互不依赖 —— 收件目录的口径只看 mtime，
    // 碰不到任何会话日志（见 mobile/inbox-clean.js 的文件头）。
    void clearInboxOnce((message) => {
      try { ctx.logger?.info?.(message) } catch { /* 日志失败不影响清理 */ }
    })
  }
  registerSessionCleanupTool(ctx)
}

module.exports = { cleanupSessions, registerSessionCleanupTool, installSessionCleanup, deleteSessionData, sessionIdsWithoutAnyData, forgetArchivedSessions, pruneOrphanedArchivedSessions, pruneOrphanedArchivedSessionsOnce, deleteQueuedArchivedSessions, queueArchivedClearIds, readPendingArchivedClearIds, restoreQueuedArchivedClearIds }

// 会话统计与永久清理只认持久化服务快照和当前根的官方 SQLite 路由。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('./paths');

const CLEANUP_UNSUPPORTED = '当前会话存储不支持永久清理（包括 SQLite）：宿主未提供删除会话 API，已保留会话与归档状态。';

/** 只观察已挂载的服务；不打开句柄，以免观察本身导入旧 JSONL。 */
function sessionPersistenceOf(ctx) {
  if (!ctx) return null;
  if (typeof ctx.get === 'function') return ctx.get('sessionPersistence') || null;
  return ctx.sessionPersistence || null;
}

async function readSessionStorage(ctx) {
  const service = sessionPersistenceOf(ctx);
  if (!service) return null;
  const entries = await service.list();
  if (!Array.isArray(entries)) throw new Error('会话持久化列表形状异常');
  return { service, identity: service.identity || service, snapshots: new Map(entries.map((entry) => [entry.header.id, entry])) };
}

/** 没有服务的旧宿主也可能留下 SQLite 路由；数据库文件本身不代表当前根使用 SQLite。 */
function sqliteRoutedSessionIds() {
  const directory = path.resolve(dshHome(), 'sessions', '.segments');
  let names;
  try { names = fs.readdirSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
  const ids = new Set();
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const route = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (typeof route?.id !== 'string' || !route.id || route.database !== path.join(directory, 'sessions.sqlite')) {
      throw new Error('会话存储路由与当前根不一致，未执行永久清理');
    }
    ids.add(route.id);
  }
  return ids;
}

function unsupportedCleanup(message = CLEANUP_UNSUPPORTED) {
  return Object.assign(new Error(message), { code: 'session-cleanup-unsupported' });
}

function assertJsonlSnapshots(snapshots, sessionIds) {
  // SQLite 已物化快照没有逐会话 location，但有精确 eventCount；pending JSONL 两者都没有。
  if ([...snapshots.values()].some((snapshot) => snapshot.location?.kind !== 'jsonl'
    && (snapshot.location || Number.isSafeInteger(snapshot.eventCount)))) throw unsupportedCleanup();
  const root = path.resolve(dshHome(), 'sessions');
  for (const id of sessionIds) {
    const snapshot = snapshots.get(id);
    if (!snapshot) continue;
    if (snapshot.location?.kind !== 'jsonl' || typeof snapshot.location.path !== 'string') {
      throw unsupportedCleanup('无法确认会话的 JSONL 存储位置，未执行永久清理；会话与归档状态保持不变。');
    }
    const relative = path.relative(root, snapshot.location.path);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw unsupportedCleanup('会话不在默认 JSONL 存储目录，未执行永久清理；会话与归档状态保持不变。');
    }
  }
}

/** 开始清理前确认当前实际持久化路由；共享数据库不由插件直接修改。 */
async function assertSessionCleanupSupported(ctx, sessionIds = []) {
  const storage = await readSessionStorage(ctx);
  if (storage) assertJsonlSnapshots(storage.snapshots, sessionIds);
  else if (sqliteRoutedSessionIds().size > 0) throw unsupportedCleanup();
}

/** 补采会首次打开历史，可能刚把旧 JSONL 导入 SQLite；删除或入队前重新观察选中会话。 */
async function assertSessionCleanupStillJsonl(ctx, sessionIds) {
  const service = sessionPersistenceOf(ctx);
  if (!service) return assertSessionCleanupSupported(ctx, sessionIds);
  const snapshots = await Promise.all(sessionIds.map((id) => service.stat(id)));
  assertJsonlSnapshots(new Map(snapshots.filter(Boolean).map((snapshot) => [snapshot.header.id, snapshot])), sessionIds);
}

module.exports = { readSessionStorage, sqliteRoutedSessionIds, assertSessionCleanupSupported, assertSessionCleanupStillJsonl };

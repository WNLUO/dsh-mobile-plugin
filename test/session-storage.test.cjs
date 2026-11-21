// 持久化探针按官方快照与当前根路由判断，不用构造名或任意数据库文件猜后端。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readSessionStorage, sqliteRoutedSessionIds, assertSessionCleanupSupported, assertSessionCleanupStillJsonl } = require('../lib/shared/session-storage.cjs');

function withHome(run) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-storage-'));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try { await run(home); } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function jsonl(home, id = 's1') {
  return { header: { id }, revision: 'log:1', location: { kind: 'jsonl', path: path.join(home, 'sessions', '--project--', id, 'session.v4.jsonl.zstd') } };
}
function ctxWith(entries) {
  return { sessionPersistence: { identity: Symbol('sessionPersistence'), list: async () => entries, stat: async (id) => entries.find((entry) => entry.header.id === id) } };
}
function writeRoute(home, id, root = path.join(home, 'sessions')) {
  const directory = path.join(root, '.segments');
  fs.mkdirSync(directory, { recursive: true });
  const name = `${createHash('sha256').update(id).digest('hex')}.json`;
  fs.writeFileSync(path.join(directory, name), JSON.stringify({ id, database: path.join(directory, 'sessions.sqlite') }));
}

test('无service：任意db文件和其他root路由不改变默认JSONL行为', withHome(async (home) => {
  const segments = path.join(home, 'sessions', '.segments');
  fs.mkdirSync(segments, { recursive: true });
  fs.writeFileSync(path.join(segments, 'sessions.sqlite'), 'unrelated database');
  writeRoute(home, 'other', path.join(home, 'another-root'));
  assert.deepEqual([...sqliteRoutedSessionIds()], []);
  await assertSessionCleanupSupported({}, ['s1']);
}));

test('无service：当前根官方路由即使DB缺失也保留，不退回删除旧JSONL', withHome(async (home) => {
  writeRoute(home, 's1');
  assert.deepEqual([...sqliteRoutedSessionIds()], ['s1']);
  await assert.rejects(() => assertSessionCleanupSupported({}, ['s1']), /SQLite/);
}));

test('service：JSONL位置是权威，外部SQLite根不会影响当前默认JSONL', withHome(async (home) => {
  writeRoute(home, 'other', path.join(home, 'another-root'));
  const ctx = ctxWith([jsonl(home)]);
  const service = ctx.sessionPersistence;
  ctx.get = (name) => name === 'sessionPersistence' ? service : undefined;
  const storage = await readSessionStorage(ctx);
  assert.equal(storage.snapshots.get('s1').location.kind, 'jsonl');
  await assertSessionCleanupSupported(ctx, ['s1', 'gone']);
  await assertSessionCleanupStillJsonl(ctx, ['gone']);
}));

test('service：SQLite物化快照拒绝清理，不把JSONL pending错称为SQLite', withHome(async (home) => {
  const sqlite = ctxWith([{ header: { id: 's1' }, formatStatus: 'current', revision: 'segment:5', eventCount: 5 }]);
  await assert.rejects(() => assertSessionCleanupSupported(sqlite, ['s1']), /SQLite/);
  const pending = ctxWith([{ header: { id: 's1' }, revision: 'pending:s1' }, jsonl(home, 's2')]);
  await assertSessionCleanupSupported(pending, ['s2']);
  await assert.rejects(() => assertSessionCleanupSupported(pending, ['s1']), /无法确认会话的 JSONL/);
}));

test('service：非默认根JSONL不删且不解档；持久化读取故障必须上抛', withHome(async (home) => {
  await assert.rejects(() => assertSessionCleanupSupported(ctxWith([jsonl(path.join(home, 'other'))]), ['s1']), /默认 JSONL/);
  const failure = Object.assign(new Error('routing record missing row'), { name: 'SessionPersistenceNotFoundError' });
  const ctx = ctxWith([]);
  ctx.sessionPersistence.stat = async () => { throw failure; };
  await assert.rejects(() => assertSessionCleanupStillJsonl(ctx, ['s1']), (error) => error === failure);
}));

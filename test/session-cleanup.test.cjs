'use strict';

/**
 * 会话清理的两半：agent 工具 `session_cleanup` 的删除分支只删日志、不碰宿主归档集合；
 * 归档集合里那些日志已经没了的老 id 只在宿主启动时修剪一次。
 *
 * 移动端那条路由（/workspace/clear-archived）另有 test/archive-clean.test.cjs，两边共用
 * lib/session-cleanup.cjs 的同一份落地代码，所以两边都得钉住同一套口径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const {
  cleanupSessions,
  pruneOrphanedArchivedSessions,
  pruneOrphanedArchivedSessionsOnce,
} = require('../lib/session-cleanup.cjs');

/** 造一份宿主真会写出来的会话日志（0 代以外都带 `.vN`，压缩件带 `.zstd`）。 */
function writeSession(home, sessionId) {
  const directory = path.join(home, 'sessions', '--home-node--', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const header = Buffer.from(`${JSON.stringify({ id: sessionId, cwd: '/home/node' })}\n`);
  fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(header));
  return directory;
}

function withHome(run) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-cleanup-'));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      await run(home);
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function envelope(value) {
  return { result: { ok: true, value } };
}

/** cleanupSessions 的最小假 ctx：列表里有什么就选什么。 */
function cleanupCtx(sessionIds) {
  return {
    apiProxy: {
      sessions: { list: async () => envelope({ items: sessionIds.map((sessionId) => ({ sessionId })) }) },
      workspace: {
        list: async () => envelope({ archivedSessionIds: sessionIds }),
        archiveSession: async () => envelope({}),
        unarchiveSession: async () => envelope({}),
      },
    },
  };
}

test('delete：只删日志，不在进程里擦宿主归档集合', withHome(async (home) => {
  const doomed = ['session-a', 'session-b'].map((id) => writeSession(home, id));
  const unarchived = [];
  const ctx = {
    apiProxy: {
      sessions: { list: async () => envelope({ items: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] }) },
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-a', 'session-b'] }),
        archiveSession: async () => envelope({}),
        // 进程里擦归档集合 = 把桌面端快照里已经删掉的行放回正常列表。这里一次都不许调。
        unarchiveSession: async (request) => {
          unarchived.push(request.payload.sessionId);
          return envelope({});
        },
      },
    },
  };

  const outcome = await cleanupSessions(ctx, { action: 'delete', confirm: true, sessionIds: ['session-a', 'session-b'] });

  assert.equal(outcome.deleted, 2);
  assert.deepEqual(unarchived, [], '删日志就够；归档集合留到宿主启动时修剪');
  for (const directory of doomed) assert.equal(fs.existsSync(directory), false);
}));

test('delete：Windows 上目录被宿主的锁文件占住（ENOTEMPTY）时，日志已删就算删成', withHome(async (home) => {
  const locked = writeSession(home, 'session-locked');
  const next = writeSession(home, 'session-next');
  const realRmSync = fs.rmSync;
  let injected = false;
  // 模拟 Windows：日志已经被 unlink 掉，目录里只剩宿主握着句柄的 session.lock
  // （delete-pending），rmdir 于是报 ENOTEMPTY —— 真机报错就是这个。
  fs.rmSync = (target, options) => {
    if (!injected && target === locked) {
      injected = true;
      fs.writeFileSync(path.join(locked, 'session.lock'), '');
      fs.unlinkSync(path.join(locked, 'session.v4.jsonl.zstd'));
      const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}'`);
      error.code = 'ENOTEMPTY';
      throw error;
    }
    return realRmSync(target, options);
  };
  try {
    const outcome = await cleanupSessions(cleanupCtx(['session-locked', 'session-next']), {
      action: 'delete', confirm: true, sessionIds: ['session-locked', 'session-next'],
    });
    assert.equal(outcome.deleted, 2);
    assert.equal(injected, true, '这条用例必须真的走到 ENOTEMPTY 分支');
    assert.equal(fs.existsSync(path.join(locked, 'session.v4.jsonl.zstd')), false, '日志已经删掉');
    assert.equal(fs.existsSync(next), false, '前一条的 ENOTEMPTY 不许连累后面的会话');
  } finally {
    fs.rmSync = realRmSync;
  }
}));

test('delete：目录删不掉且日志还在时必须报错，不能吞成删成', withHome(async (home) => {
  const kept = writeSession(home, 'session-kept');
  const realRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === kept) {
      const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}'`);
      error.code = 'ENOTEMPTY';
      throw error;
    }
    return realRmSync(target, options);
  };
  try {
    await assert.rejects(
      cleanupSessions(cleanupCtx(['session-kept']), { action: 'delete', confirm: true, sessionIds: ['session-kept'] }),
      /删除会话 session-kept 失败：ENOTEMPTY/,
    );
    assert.equal(fs.existsSync(path.join(kept, 'session.v4.jsonl.zstd')), true, '日志没删掉就是真失败');
  } finally {
    fs.rmSync = realRmSync;
  }
}));

test('启动修剪：只擦日志已经不在磁盘上的 id，还在盘上的一个都不动', withHome(async (home) => {
  const alive = writeSession(home, 'session-alive');
  const unarchived = [];
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-alive', 'session-gone', 'session-never-logged'] }),
        unarchiveSession: async (request) => {
          unarchived.push(request.payload.sessionId);
          return envelope({});
        },
      },
    },
  };

  const pruned = await pruneOrphanedArchivedSessions(ctx);

  assert.equal(pruned, 2);
  assert.deepEqual([...unarchived].sort(), ['session-gone', 'session-never-logged'], '日志还在的归档会话不许被移出归档');
  assert.equal(fs.existsSync(alive), true);
}));

test('启动修剪：日志读不出来也算还在，不许把一条还有日志的会话移出归档', withHome(async (home) => {
  // 压缩件坏了、header 解析不出来时，删除路径会跳过它（日志还在），修剪也必须一样保守。
  const directory = path.join(home, 'sessions', '--home-node--', 'session-corrupt');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'));
  const unarchived = [];
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-corrupt'] }),
        unarchiveSession: async (request) => {
          unarchived.push(request.payload.sessionId);
          return envelope({});
        },
      },
    },
  };

  assert.equal(await pruneOrphanedArchivedSessions(ctx), 0);
  assert.deepEqual(unarchived, []);
}));

test('启动修剪：擦不动的不算修剪成功', withHome(async () => {
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-gone'] }),
        unarchiveSession: async () => ({ result: { ok: false, error: { code: 'gateway/unavailable', message: '宿主不在' } } }),
      },
    },
  };

  assert.equal(await pruneOrphanedArchivedSessions(ctx), 0);
}));

test('启动修剪失败只落一行日志，且每个宿主进程只跑一次', withHome(async () => {
  // 代际热替换会重跑 apply，但桌面端那份会话列表快照挂在同一个宿主进程上：这份「进程里
  // 不许擦归档集合」的约束必须按进程而不是按代来守。
  let listCalls = 0;
  const logs = [];
  const ctx = {
    apiProxy: {
      workspace: {
        list: async () => {
          listCalls += 1;
          throw new Error('宿主不在');
        },
      },
    },
  };

  await pruneOrphanedArchivedSessionsOnce(ctx, (message) => logs.push(message));
  await pruneOrphanedArchivedSessionsOnce(ctx, (message) => logs.push(message));

  assert.equal(listCalls, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /宿主不在/);
}));

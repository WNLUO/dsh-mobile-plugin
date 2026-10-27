'use strict';

/**
 * 会话清理的两半：agent 工具 `session_cleanup` 的删除分支只排队、不碰宿主归档集合；
 * 队里的日志与归档集合里那些日志已经没了的老 id 都只在宿主启动时处理一次。
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
  deleteQueuedArchivedSessions,
  queueArchivedClearIds,
  readPendingArchivedClearIds,
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

test('archive 分支不受影响：归档仍然当场写回宿主', withHome(async (home) => {  writeSession(home, 'session-old');
  const ctx = cleanupCtx(['session-old']);
  const archived = [];
  ctx.apiProxy.workspace.archiveSession = async (request) => {
    archived.push(request.payload.sessionId);
    return envelope({});
  };

  const outcome = await cleanupSessions(ctx, { action: 'archive', olderThanMinutes: 0, sessionIds: ['session-old'] });

  assert.equal(outcome.archived, 1);
  assert.deepEqual(archived, ['session-old'], '归档是一次宿主写，与删磁盘无关，不许跟着改成排队');
}));

test('delete：只排队，进程里一条日志都不删、也不擦宿主归档集合', withHome(async (home) => {
  // 进程活着时删日志，宿主随时可能去打开一条已经不存在的文件 —— 那是未捕获的 ENOENT，
  // 宿主对未捕获异常零容忍，整个进程退出（2026-10-20 桌面端闪退就是这么来的）。
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

  assert.equal(outcome.deleted, 2, '排进队列即视为这次要清掉的条数');
  assert.deepEqual(unarchived, [], '删日志就够；归档集合留到宿主启动时修剪');
  for (const directory of doomed) assert.equal(fs.existsSync(directory), true, '进程里不许删磁盘');
  assert.deepEqual(readPendingArchivedClearIds().sort(), ['session-a', 'session-b'], '两条都排进了待删队列');
}));

test('delete：删之前先把这批会话的用量采进统计账本', withHome(async () => {
  // 日志一没，那部分用量就永远读不出来了；手机那个「清理已归档」按钮一直有这一刀，
  // agent 这条删除路以前没有 —— 走它删掉的会话，上次采集之后的那一截增量就白丢。
  const statsLedger = require('../lib/mobile/stats-ledger.cjs');
  statsLedger.forgetLedger();
  try {
    const ctx = {
      apiProxy: {
        sessions: {
          list: async () => envelope({ items: [{ sessionId: 'session-a', cwd: '/home/node', updatedAt: Date.now() }] }),
          projections: async (request) => envelope({
            values: request.payload.sessionId === 'session-a'
              ? {
                tokenUsage: { uncachedInputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 },
                sessionStats: { turns: 2, steps: 3, llmMs: 100, toolMs: 0 },
              }
              : {},
          }),
        },
        workspace: {
          list: async () => envelope({ archivedSessionIds: ['session-a'] }),
          archiveSession: async () => envelope({}),
        },
      },
    };

    const outcome = await cleanupSessions(ctx, { action: 'delete', confirm: true, sessionIds: ['session-a'] });
    assert.equal(outcome.deleted, 1);

    const book = statsLedger.readLedger();
    assert.equal(book.sessions['session-a'].billed.uncachedInputTokens, 120, '删除前的用量进了账本');
    assert.equal(book.sessions['session-a'].billed.turns, 2);
    const dayOutput = Object.values(book.days).reduce((sum, day) => sum + day.outputTokens, 0);
    assert.equal(dayOutput, 30, '按天的账也记上了');
  } finally {
    statsLedger.forgetLedger();
  }
}));

test('启动删队列：Windows 上目录被宿主的锁文件占住（ENOTEMPTY）时，日志已删就算删成', withHome(async (home) => {
  const locked = writeSession(home, 'session-locked');
  const next = writeSession(home, 'session-next');
  queueArchivedClearIds(['session-locked', 'session-next']);
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
    const sweep = await deleteQueuedArchivedSessions();
    assert.deepEqual(sweep.deleted.sort(), ['session-locked', 'session-next']);
    assert.deepEqual(sweep.kept, []);
    assert.equal(injected, true, '这条用例必须真的走到 ENOTEMPTY 分支');
    assert.equal(fs.existsSync(path.join(locked, 'session.v4.jsonl.zstd')), false, '日志已经删掉');
    assert.equal(fs.existsSync(next), false, '前一条的 ENOTEMPTY 不许连累后面的会话');
    assert.deepEqual(readPendingArchivedClearIds(), [], '删成的都出队');
  } finally {
    fs.rmSync = realRmSync;
  }
}));

test('启动删队列：目录删不掉且日志还在时，那个 id 留在队里等下次启动', withHome(async (home) => {
  const kept = writeSession(home, 'session-kept');
  queueArchivedClearIds(['session-kept']);
  const realRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === kept) {
      const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}'`);
      error.code = 'ENOTEMPTY';
      throw error;
    }
    return realRmSync(target, options);
  };
  const logs = [];
  try {
    const sweep = await deleteQueuedArchivedSessions((message) => logs.push(message));
    assert.deepEqual(sweep.deleted, [], '日志还在就不算删成');
    assert.deepEqual(sweep.kept, ['session-kept'], '删不掉的必须留在队里，下次启动再试');
    assert.deepEqual(readPendingArchivedClearIds(), ['session-kept']);
    assert.equal(fs.existsSync(path.join(kept, 'session.v4.jsonl.zstd')), true, '日志没删掉就是真失败');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /删除会话 session-kept 失败/);
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

test('启动收尾：队里的日志先删掉，宿主的 workspace 还没就绪就重试，整轮只跑一次', withHome(async (home) => {
  // 代际热替换会重跑 apply，但桌面端那份会话列表快照挂在同一个宿主进程上：这份「进程里
  // 不许动磁盘、不许擦归档集合」的约束必须按进程而不是按代来守。
  const doomed = writeSession(home, 'session-doomed');
  queueArchivedClearIds(['session-doomed']);
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
  const callsAfterFirst = listCalls;
  await pruneOrphanedArchivedSessionsOnce(ctx, (message) => logs.push(message));

  // 日志先删掉了：这一步不依赖宿主，也不该被后面的失败连坐。
  assert.equal(fs.existsSync(doomed), false);
  assert.deepEqual(readPendingArchivedClearIds(), [], '删成的已经出队');
  // 0.2.x 的 workspace.list 是 workspace.follow 的首帧，刚启动时常常还没开出来：
  // 失败要重试几次，不能像以前那样一次失败就把这一轮收尾整个丢掉。
  assert.ok(callsAfterFirst > 1, `workspace.list 失败后应重试，实际只调了 ${callsAfterFirst} 次`);
  assert.equal(listCalls, callsAfterFirst, '第二次调用整轮不再跑（每进程一次）');
  assert.equal(logs.length, 2, '一行删队列、一行修剪最终失败');
  assert.match(logs[1], /宿主不在/);
}));

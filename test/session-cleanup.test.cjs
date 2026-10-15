'use strict';

/**
 * agent 工具 `session_cleanup` 的永久删除分支：宿主归档集合必须先摘干净再动磁盘。
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
const { cleanupSessions } = require('../lib/session-cleanup.cjs');

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

test('delete：先删日志，再把它从宿主归档集合里擦掉', withHome(async (home) => {
  const doomed = ['session-a', 'session-b'].map((id) => writeSession(home, id));
  const unarchived = [];
  const ctx = {
    apiProxy: {
      sessions: { list: async () => envelope({ items: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] }) },
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-a', 'session-b'] }),
        archiveSession: async () => envelope({}),
        unarchiveSession: async (request) => {
          unarchived.push(request.payload.sessionId);
          // 顺序反过来就是用户报过的毛病：名字先从归档集合消失、日志还在，看着像「只是移出了归档」，
          // 得重启宿主才恢复。所以擦集合必须发生在日志已经不在之后。
          assert.equal(fs.existsSync(path.join(home, 'sessions', '--home-node--', request.payload.sessionId)), false, '擦归档集合时日志必须已经删掉');
          return envelope({});
        },
      },
    },
  };

  const outcome = await cleanupSessions(ctx, { action: 'delete', confirm: true, sessionIds: ['session-a', 'session-b'] });

  assert.equal(outcome.deleted, 2);
  assert.deepEqual([...unarchived].sort(), ['session-a', 'session-b']);
  for (const directory of doomed) assert.equal(fs.existsSync(directory), false);
}));

test('delete：宿主擦不动归档集合，日志照样删掉', withHome(async (home) => {
  const directory = writeSession(home, 'session-a');
  const ctx = {
    apiProxy: {
      sessions: { list: async () => envelope({ items: [{ sessionId: 'session-a' }] }) },
      // 没有 unarchiveSession：日志已经删成功了，擦集合只是收尾。
      workspace: {
        list: async () => envelope({ archivedSessionIds: ['session-a'] }),
        archiveSession: async () => envelope({}),
      },
    },
  };

  const outcome = await cleanupSessions(ctx, { action: 'delete', confirm: true, sessionIds: ['session-a'] });

  assert.equal(outcome.deleted, 1, '擦集合失败不改变「日志已经删掉」这个结果');
  assert.equal(fs.existsSync(directory), false);
}));

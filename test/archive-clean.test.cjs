'use strict';

/**
 * 「清理所有已归档」必须按归档集合清理，不得被会话列表里的状态标记缩小范围；
 * 并且进程活着的时候一条日志都不许删 —— 只排队，日志留到宿主下次启动时删。
 *
 * 为什么是排队：宿主没有「删除会话」接口，进程活着时它随时可能去打开一条刚被删掉的日志，
 * 那是没人接的 ENOENT；宿主对未捕获异常零容忍，整个进程退出，桌面端跟着闪退
 * （2026-10-20 真机：清 315 条时踩到一条 0 轮次的空白归档会话）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { zstdCompressSync } = require('node:zlib');
const { handleClearArchived } = require('../lib/mobile/archive-clean.js');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');
const { sessionListResponseState, deletedSessionIdsOf } = require('../lib/mobile/session-cache.js');
const {
  queueArchivedClearIds,
  readPendingArchivedClearIds,
  restoreQueuedArchivedClearIds,
  deleteQueuedArchivedSessions,
} = require('../lib/session-cleanup.cjs');

function makeReq(body, { chunkSize = 0, delayMs = 0 } = {}) {
  return Readable.from(deferredJsonChunks(body, chunkSize, delayMs));
}

/**
 * 分片（可选每片延迟）吐出同一份 JSON body：真宿主经 HTTP 收 body 就是这样一段一段到的，
 * 一次 `Readable.from([整份])` 到不了那条路径。延迟用来复现「块之间空闲超过读 body 的超时」。
 */
async function* deferredJsonChunks(body, chunkSize, delayMs) {
  const payload = Buffer.from(JSON.stringify(body));
  if (!chunkSize) {
    yield payload;
    return;
  }
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    if (offset > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield payload.subarray(offset, offset + chunkSize);
  }
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

/**
 * 造一份真宿主会写出来的会话日志：目录是 `<项目目录名>/<会话 id>/`，文件名按宿主自己的
 * 代次规则（0.2.0 写出的是 `session.v4.jsonl.zstd`），压缩用 Node 自带的 zstd ——
 * 宿主自己就不依赖系统 `zstd` 命令。假体必须照抄这两点，否则「只认老文件名 + shell 出去
 * 解压」那种写法在测试里照样绿，而真机上恒回 deleted: 0。
 */
function writeSession(home, sessionId, { generation = 4, suffix = '.zstd' } = {}) {
  const directory = path.join(home, 'sessions', '--home-node--', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const header = Buffer.from(`${JSON.stringify({ id: sessionId, cwd: '/home/node' })}\n`);
  const name = `session${generation === 0 ? '' : `.v${generation}`}.jsonl${suffix}`;
  fs.writeFileSync(path.join(directory, name), suffix === '.zstd' ? zstdCompressSync(header) : header);
  return directory;
}

/** 只放一份非规范名日志（迁移中途的临时文件）：宿主自己不认它，清理也必须不认。 */
function writeSessionWithNonCanonicalLog(home, sessionId) {
  const directory = path.join(home, 'sessions', '--home-node--', sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.migration.deadbeef.jsonl.zstd.tmp'), Buffer.from('{}'));
  return directory;
}

test('清理会话集合中的所有归档 ID，不受 running / blank 摘要标记影响', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const running = writeSession(home, 'session-running');
    // 0 代 + 不压缩：宿主两种编码都要认，不能只认压缩件。
    const blank = writeSession(home, 'session-blank', { generation: 0, suffix: '' });
    const kept = writeSession(home, 'session-unarchived');
    const migrating = writeSessionWithNonCanonicalLog(home, 'session-migrating');
    const unarchived = [];
    const archivedSessionIds = ['session-running', 'session-blank', 'session-migrating', 42];
    let failWorkspaceList = false;
    const ctx = {
      state: {},
      apiProxy: {
        sessions: {
          list: async () => ({ result: { ok: true, value: { items: [
            { sessionId: 'session-running', running: true, blank: false },
            { sessionId: 'session-blank', running: false, blank: true },
            { sessionId: 'session-unarchived', running: false, blank: false },
          ] } } }),
        },
        workspace: {
          list: async () => {
            if (failWorkspaceList) throw new Error('workspace.list unavailable');
            return { result: { ok: true, value: { archivedSessionIds } } };
          },
          // 进程里擦归档集合 = 把桌面端快照里已经删掉的行放回正常列表（用户报的「清理完
          // 它们又回来了，重启 DSH 才真的消失」）。收尾只在宿主启动时做，这里一次都不许调。
          unarchiveSession: async (request) => {
            unarchived.push(request.payload.sessionId);
            return { result: { ok: true, value: { archivedSessionIds: [] } } };
          },
        },
      },
    };
    const cache = sessionListResponseState(ctx, 'legacy');
    cache.value = { items: ['stale'] };
    cache.updatedAt = Date.now();
    const req = makeReq({ confirm: true });
    req.headers = {};
    const res = makeRes();

    await handleClearArchived(ctx, req, res);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, deleted: 3 }, '回执报的是这次排进队列、手机上立刻消失的条数');
    // 进程活着时一条日志都不许删：宿主随时可能去打开它们，文件不在就是未捕获的 ENOENT。
    assert.equal(fs.existsSync(running), true, '清理请求不许在进程里删磁盘');
    assert.equal(fs.existsSync(blank), true);
    assert.equal(fs.existsSync(migrating), true);
    assert.equal(fs.existsSync(kept), true);
    assert.deepEqual(
      readPendingArchivedClearIds().sort(),
      ['session-blank', 'session-migrating', 'session-running'],
      '归档集合里的三条都排进了待删队列（42 不是字符串 id，不排）',
    );
    assert.deepEqual(unarchived, [], '清理只删日志：进程里擦归档集合会让桌面端把已删的行放回列表');
    assert.equal(cache.value, null);
    assert.deepEqual([...deletedSessionIdsOf(ctx)].sort(), ['session-blank', 'session-migrating', 'session-running']);
    failWorkspaceList = true;
    const refreshed = await buildSessionsResponse(ctx);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.items.map((item) => item.sessionId), ['session-unarchived'], '即使宿主 sessions.list 仍带着这些会话，清理后的移动列表也必须过滤掉它们');

    // 宿主下次启动：这时才真的删磁盘。非规范名日志不是已提交的代次，宿主自己不认，
    // 清理也不认 —— 它留在队里等下一次，不算删成。
    const sweep = await deleteQueuedArchivedSessions();
    assert.deepEqual(sweep.deleted.sort(), ['session-blank', 'session-running']);
    assert.deepEqual(sweep.kept, ['session-migrating']);
    assert.equal(fs.existsSync(running), false);
    assert.equal(fs.existsSync(blank), false);
    assert.equal(fs.existsSync(migrating), true, '非规范名日志不是已提交的代次，不许当成会话删掉');
    assert.equal(fs.existsSync(kept), true, '不在队列里的会话一条都不许动');
    assert.deepEqual(readPendingArchivedClearIds(), ['session-migrating'], '删成的不留在队里，没删成的留着等下次启动');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('更早一次删到一半留下的空归档：再清一次要按已删记账，宿主的旧清单也得被压住', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const alive = writeSession(home, 'session-alive');
    // 老版本删掉日志、抛错前没记进删除集：目录已经不在了。
    // Windows 上删不掉的目录：只剩宿主锁着的 session.lock。
    const lockedOnly = path.join(home, 'sessions', '--home-node--', 'session-locked-only');
    fs.mkdirSync(lockedOnly, { recursive: true });
    fs.writeFileSync(path.join(lockedOnly, 'session.lock'), '');
    const archivedSessionIds = ['session-alive', 'session-lost-log', 'session-locked-only'];
    let listFails = false;
    const ctx = {
      state: {},
      apiProxy: {
        sessions: {
          list: async () => ({ result: { ok: true, value: { items: archivedSessionIds.map((sessionId) => ({ sessionId, running: false, blank: false })) } } }),
        },
        workspace: {
          list: async () => {
            if (listFails) throw new Error('workspace.list unavailable');
            return { result: { ok: true, value: { archivedSessionIds } } };
          },
          unarchiveSession: async () => ({ result: { ok: true, value: {} } }),
        },
      },
    };
    const req = makeReq({ confirm: true });
    req.headers = {};
    const res = makeRes();

    await handleClearArchived(ctx, req, res);

    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 3, '盘上已经没数据的归档也要记账，否则用户看到删了 0 条、列表却还在');
    assert.deepEqual([...deletedSessionIdsOf(ctx)].sort(), [...archivedSessionIds].sort());
    assert.equal(fs.existsSync(alive), true, '清理请求不动磁盘');

    // 宿主下次启动：日志还在的那条真删掉，盘上已经没有数据的（目录没了 / 只剩锁文件）直接出队。
    const sweep = await deleteQueuedArchivedSessions();
    assert.deepEqual(sweep.deleted.sort(), [...archivedSessionIds].sort());
    assert.deepEqual(sweep.kept, []);
    assert.equal(fs.existsSync(alive), false);
    assert.equal(fs.existsSync(lockedOnly), true, '只剩锁文件的空目录删不掉，不影响记账');
    assert.deepEqual(readPendingArchivedClearIds(), [], '队里不留已经处理过的 id');
    listFails = true;
    const refreshed = await buildSessionsResponse(ctx);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.items, [], '宿主进程内清单还挂着这三条时，重建列表必须一条都不剩');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('body 分片且块之间空闲时仍能读到 confirm', async () => {
  // 读 body 有超时，而超时语义是「块之间的空闲」而不是「整份送达的总时长」：一次请求
  // 能不能读完只取决于请求方自己节奏慢不慢。App 在发送前要 await invokeNative 写一次
  // Keychain，真机上body 晚到是常态 —— 那时报「请求超时」是假报，一次永久删除都没发生。
  const req = makeReq({ confirm: true }, { chunkSize: 2, delayMs: 10 });
  req.headers = {};
  const res = makeRes();
  const calls = [];
  const ctx = {
    state: {},
    apiProxy: {
      workspace: {
        list: async () => {
          calls.push('list');
          return { result: { ok: true, value: { archivedSessionIds: [] } } };
        },
      },
    },
  };

  await handleClearArchived(ctx, req, res);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, deleted: 0 });
  assert.deepEqual(calls, ['list'], '读到 confirm 才继续往下走');
});

test('未确认时不读取归档集合也不执行清理', async () => {
  const ctx = { apiProxy: { workspace: { list: async () => { throw new Error('不应调用'); } } } };
  const req = makeReq({ confirm: false });
  req.headers = {};
  const res = makeRes();

  await handleClearArchived(ctx, req, res);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'confirm-required');
});

test('读日志头不走系统 zstd 命令', () => {
  // 系统没装 zstd 命令时，shell 出去那一版会静默返回 undefined，整条删除路径空转
  // （deleted 恒为 0，看不出任何错）。宿主自己用 Node 自带的 zstd 读写日志，这里也一样。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-cleanup.cjs'), 'utf8');
  assert.equal(source.includes('child_process'), false, '不允许再 shell 出外部解压命令');
  assert.match(source, /createZstdDecompress/, '压缩日志必须用 Node 自带的 zstd 解');
});

test('重复清理不会去擦归档集合：桌面端那份快照还挂在同一个进程上', async () => {
  // 用户报过：手机端清理完全部已归档的对话，桌面端列表里它们又全回来了，重启 DSH 才消失。
  // 根因是清理后插件把 id 从宿主归档集合里擦掉，宿主广播集合变化，桌面端就把自己快照里
  // 那些已经没有日志、本来被归档藏着的行放回正常列表。所以擦集合一律不在进程里做。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const doomed = writeSession(home, 'session-doomed');
    const stillArchived = ['session-doomed'];
    let unarchiveCalls = 0;
    const ctx = {
      state: {},
      apiProxy: {
        workspace: {
          list: async () => ({ result: { ok: true, value: { archivedSessionIds: [...stillArchived] } } }),
          unarchiveSession: async () => {
            unarchiveCalls += 1;
            return { result: { ok: true, value: { archivedSessionIds: [] } } };
          },
        },
      },
    };

    const firstReq = makeReq({ confirm: true });
    firstReq.headers = {};
    const first = makeRes();
    await handleClearArchived(ctx, firstReq, first);
    assert.equal(first.status, 200);
    assert.equal(first.body.deleted, 1);
    assert.equal(fs.existsSync(doomed), true, '点清理不删磁盘');

    const retryReq = makeReq({ confirm: true });
    retryReq.headers = {};
    const retryRes = makeRes();
    await handleClearArchived(ctx, retryReq, retryRes);

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.deleted, 1, '宿主还没删，再点一次它仍然是「这次要清掉的」那一条');
    assert.deepEqual(readPendingArchivedClearIds(), ['session-doomed'], '排队是并集：同一条点两次只占一个位置');
    assert.deepEqual([...stillArchived], ['session-doomed'], '归档集合里留着的死 id 不显示在任何地方，等宿主下次启动时修剪');
    assert.equal(unarchiveCalls, 0, '两次清理都不许动归档集合');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('插件重载 / 宿主重启之后，队列里的会话仍然不显示', async () => {
  // 删除集是进程内的；队列是磁盘上的。漏了这一步，用户会看到「清理过的会话在下次换插件
  // 版本（代际热替换）之后原样回来」—— 那时日志还在、宿主归档集合也还没修剪。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(home, 'session-queued');
    queueArchivedClearIds(['session-queued']);
    const ctx = {
      state: {},
      apiProxy: {
        sessions: {
          list: async () => ({ result: { ok: true, value: { items: [{ sessionId: 'session-queued', running: false, blank: false }] } } }),
        },
        workspace: { list: async () => { throw new Error('workspace.list unavailable'); } },
      },
    };

    assert.deepEqual(restoreQueuedArchivedClearIds(ctx), ['session-queued']);
    assert.deepEqual([...deletedSessionIdsOf(ctx)], ['session-queued'], '装载插件时要把队列补进删除集');
    const refreshed = await buildSessionsResponse(ctx);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.items, [], '队列里排着的会话在新进程里也必须被压住');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('队列写不进去时整次清理失败，不许回「已清理」', async () => {
  // 排不上队却说删掉了 = 重启之后它们原样回来。路由会把异常变成 500（guarded 的统一信封），
  // App 侧照旧弹错误、用户还能再点一次。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(home, 'session-doomed');
    // 队列文件的位置被一个目录占了，改名的最后一步必然失败。
    fs.mkdirSync(path.join(home, 'mobile-archived-clear.json'), { recursive: true });
    const ctx = {
      state: {},
      apiProxy: {
        workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: ['session-doomed'] } } }) },
      },
    };
    const req = makeReq({ confirm: true });
    req.headers = {};
    const res = makeRes();

    await assert.rejects(handleClearArchived(ctx, req, res), /ENOTDIR|EISDIR|EEXIST|ENOENT/);
    assert.equal(res.status, null, '没写成功就不许回任何成功回执');
    assert.deepEqual([...deletedSessionIdsOf(ctx)], [], '失败时不记账，用户再点一次还能重排');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('启动收尾先删队里的日志、再擦归档集合', () => {
  // 顺序是有意义的：归档集合的擦除要等宿主把 workspace 服务挂起来，而删日志越早越安全
  // （那时桌面端还没连上、宿主手上也没有热会话）。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-cleanup.cjs'), 'utf8');
  const once = source.slice(source.indexOf('async function pruneOrphanedArchivedSessionsOnce'));
  const sweepAt = once.indexOf('deleteQueuedArchivedSessions(log, ctx)');
  const pruneAt = once.indexOf('pruneOrphanedArchivedSessions(ctx)');
  assert.ok(sweepAt > 0, '启动收尾必须删掉队里排着的日志');
  assert.ok(pruneAt > sweepAt, '删日志要在擦归档集合之前');
  const install = source.slice(source.indexOf('function installSessionCleanup'));
  assert.match(install, /restoreQueuedArchivedClearIds\(ctx\)/, '装载时必须把队列补进删除集，否则插件一重载它们就复活');
});

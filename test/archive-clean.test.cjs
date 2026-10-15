'use strict';

/**
 * 「清理所有已归档」必须按归档集合清理，不得被会话列表里的状态标记缩小范围。
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
const {
  sessionListResponseState,
  deletedSessionIdsOf,
  pendingUnarchiveSessionIdsOf,
} = require('../lib/mobile/session-cache.js');

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
          // 擦归档集合必须发生在删目录之后：调用这一刻日志已经不在，否则这段窗口里
          // 会话「名字没了、日志还在」，看着就像清理只是把它移出了归档。
          unarchiveSession: async (request) => {
            unarchived.push(request.payload.sessionId);
            const index = archivedSessionIds.indexOf(request.payload.sessionId);
            if (index >= 0) archivedSessionIds.splice(index, 1);
            assert.equal(fs.existsSync(path.join(home, 'sessions', '--home-node--', request.payload.sessionId)), false, '擦归档集合时日志必须已经删掉');
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
    // running 与 blank 各删掉一个；migrating 只有非规范名日志（宿主也不认），unarchived 不在归档集里。
    assert.equal(res.body.deleted, 2);
    assert.equal(fs.existsSync(running), false);
    assert.equal(fs.existsSync(blank), false);
    assert.equal(fs.existsSync(kept), true);
    assert.equal(fs.existsSync(migrating), true, '非规范名日志不是已提交的代次，不许当成会话删掉');
    assert.deepEqual([...unarchived].sort(), ['session-blank', 'session-running'], '只擦真删掉的：没日志的 id 别从归档集合里抹掉，否则那一行凭空消失');
    // 真删掉的（running/blank）不许再挂在归档集合里；migrating 的日志没删成，名字也得留着，
    // 否则「已归档」里那一行会凭空消失而日志还在磁盘上。
    assert.deepEqual([...res.body.archivedSessionIds].sort(), [42, 'session-migrating'].sort(), '清掉的 id 不能继续挂在归档集合里，没删掉的也不许被抹掉');
    assert.deepEqual(res.body.unarchiveFailedSessionIds, [], '成功擦除集合时不报告失败项');
    assert.equal(cache.value, null);
    assert.deepEqual([...deletedSessionIdsOf(ctx)].sort(), ['session-blank', 'session-running']);
    failWorkspaceList = true;
    const refreshed = await buildSessionsResponse(ctx);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.items.map((item) => item.sessionId), ['session-unarchived'], '即使宿主 sessions.list 仍带着已删会话，清理后的移动列表也必须过滤掉它们');
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
  assert.deepEqual(res.body, { ok: true, deleted: 0, archivedSessionIds: [] });
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

test('擦归档集合失败不影响删除结果：日志删了、立刻生效', async () => {
  // 用户报过：点清理后会话只是被移出了归档、必须重启 DSH 才真的消失。根因是「先擦集合、
  // 后删日志」，中途失败就留下名字没了、日志还在的会话。改成先删后擦之后，日志一没就是
  // 真的清理掉了；擦集合是收尾，它失败不该把已经成功的删除判成失败。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const doomed = writeSession(home, 'session-doomed');
    let archivedSessionIds = ['session-doomed'];
    let failUnarchive = true;
    let unarchiveCalls = 0;
    const ctx = {
      state: {},
      apiProxy: {
        workspace: {
          list: async () => ({ result: { ok: true, value: { archivedSessionIds } } }),
          unarchiveSession: async () => {
            unarchiveCalls += 1;
            if (failUnarchive) return { result: { ok: false, error: { code: 'gateway/unavailable', message: '宿主不在' } } };
            archivedSessionIds = [];
            return { result: { ok: true, value: { archivedSessionIds } } };
          },
        },
      },
    };
    const req = makeReq({ confirm: true });
    req.headers = {};
    const res = makeRes();

    await handleClearArchived(ctx, req, res);

    assert.equal(fs.existsSync(doomed), false, '擦集合失败也不能让日志留下来：删了就是删了');
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.deepEqual(res.body.archivedSessionIds, ['session-doomed'], '宿主未确认取消归档时，集合快照仍须保留该 ID');
    assert.deepEqual(res.body.unarchiveFailedSessionIds, ['session-doomed'], '向 App 返回可重试失败项');
    assert.deepEqual([...pendingUnarchiveSessionIdsOf(ctx)], ['session-doomed']);

    failUnarchive = false;
    const retryReq = makeReq({ confirm: true });
    retryReq.headers = {};
    const retryRes = makeRes();
    await handleClearArchived(ctx, retryReq, retryRes);

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.deleted, 0, '已删日志不应再次计入删除数量');
    assert.deepEqual(retryRes.body.archivedSessionIds, []);
    assert.deepEqual(retryRes.body.unarchiveFailedSessionIds, []);
    assert.equal(unarchiveCalls, 2, '重试必须重新调用宿主取消归档');
    assert.deepEqual([...pendingUnarchiveSessionIdsOf(ctx)], []);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('删日志发生在擦归档集合之前：清理不必等宿主重启就生效', async () => {
  // 这条守住顺序本身。反过来（先擦后删）时，只要中途失败或链路超时，用户看到的就是
  // 「清理把会话移出了归档但没删」——正是这个 bug 的原始形态。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-clean-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const doomed = writeSession(home, 'session-doomed');
    const stillArchived = ['session-doomed'];
    const observedAtUnarchive = [];
    const ctx = {
      state: {},
      apiProxy: {
        workspace: {
          list: async () => ({ result: { ok: true, value: { archivedSessionIds: [...stillArchived] } } }),
          unarchiveSession: async (request) => {
            observedAtUnarchive.push(fs.existsSync(path.join(home, 'sessions', '--home-node--', request.payload.sessionId)));
            const index = stillArchived.indexOf(request.payload.sessionId);
            if (index >= 0) stillArchived.splice(index, 1);
            return { result: { ok: true, value: { archivedSessionIds: [...stillArchived] } } };
          },
        },
      },
    };
    const req = makeReq({ confirm: true });
    req.headers = {};
    const res = makeRes();

    await handleClearArchived(ctx, req, res);

    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.deepEqual(observedAtUnarchive, [false], '擦归档集合时日志必须已经不在：否则这段窗口里它只是被移出了归档');
    assert.equal(fs.existsSync(doomed), false);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

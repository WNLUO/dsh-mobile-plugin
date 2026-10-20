'use strict';

/**
 * 列表的条件刷新：`?rev=<上次的 revision>` 命中时只回一句 `unchanged`，不带 items。
 *
 * 场景：手机每次回前台 / 轮询都会拉一次会话列表与工作区列表，绝大多数时候内容一个字没变，
 * 却要把几十 KB 的 items 完整传一遍。带上上次拿到的 revision 就能把这一趟压成
 * `{ok, unchanged:true, revision, generatedAt}`。
 *
 * 三条不能走这条的路径，一条都不许漏：
 *   - `?fresh=1`：写后刷新必须拿到真数据；
 *   - `?archived=1`（含归档分页）：归档子集与默认视图不是同一份内容；
 *   - `rev` 缺失或为空。
 * 另外 unchanged 响应不许写进 `/sessions` 那层 10 秒缓存。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSessions, invalidateSessionList } = require('../lib/mobile/sessions.js');
const { handleWorkspaces } = require('../lib/mobile/workspaces.js');

function makeReq(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

/** 假宿主：会话清单与工作区清单都是活对象，改它就等于宿主那边变了。 */
function makeCtx() {
  const state = {
    items: [
      { sessionId: 's1', cwd: '/ws/a', updatedAt: 2000, running: false, blank: false, projections: { values: { title: '一' } } },
      { sessionId: 's2', cwd: '/ws/a', updatedAt: 1000, running: false, blank: false, projections: { values: { title: '二' } } },
    ],
    archivedSessionIds: [],
    workspaces: [{ workspaceId: 'w1', path: '/ws/a', title: 'a' }],
    listCalls: 0,
  };
  const ctx = {
    state,
    apiProxy: {
      sessions: {
        list: async () => {
          state.listCalls += 1;
          return { result: { ok: true, value: { items: state.items } } };
        },
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: {
        list: async () => ({
          result: {
            ok: true,
            value: { items: state.workspaces, archivedSessionIds: state.archivedSessionIds },
          },
        }),
      },
    },
  };
  return ctx;
}

async function get(handler, ctx, url) {
  const res = makeRes();
  await handler(ctx, makeReq(url), res);
  assert.equal(res.status, 200, `${url} 应返回 200，实际 ${res.status}`);
  return res.body;
}

const SESSIONS = '/api/mobile/v1/sessions';
const WORKSPACES = '/api/mobile/v1/workspaces';

test('sessions：rev 命中时回 unchanged 且不带 items', async () => {
  const ctx = makeCtx();
  const full = await get(handleSessions, ctx, SESSIONS);
  assert.ok(Array.isArray(full.items) && full.items.length === 2);
  assert.equal(typeof full.revision, 'string');

  const trimmed = await get(handleSessions, ctx, `${SESSIONS}?rev=${encodeURIComponent(full.revision)}`);
  assert.deepEqual(trimmed, {
    ok: true,
    unchanged: true,
    revision: full.revision,
    generatedAt: trimmed.generatedAt,
  });
  assert.equal(Object.hasOwn(trimmed, 'items'), false, 'unchanged 响应不带 items');
  assert.equal(typeof trimmed.generatedAt, 'number');
});

test('sessions：rev 不匹配时回完整清单', async () => {
  const ctx = makeCtx();
  const full = await get(handleSessions, ctx, SESSIONS);
  const other = await get(handleSessions, ctx, `${SESSIONS}?rev=deadbeefdeadbeef`);
  assert.equal(other.unchanged, undefined);
  assert.equal(other.items.length, 2);
  assert.equal(other.revision, full.revision);
});

test('sessions：rev 为空 / 缺失时回完整清单', async () => {
  const ctx = makeCtx();
  const full = await get(handleSessions, ctx, SESSIONS);
  for (const url of [`${SESSIONS}?rev=`, SESSIONS, `${SESSIONS}?rev`]) {
    const body = await get(handleSessions, ctx, url);
    assert.equal(body.unchanged, undefined, `${url} 不该走 unchanged`);
    assert.equal(body.items.length, 2);
  }
  assert.equal(full.items.length, 2);
});

test('sessions：fresh=1 时即便 rev 命中也要拿到真数据', async () => {
  const ctx = makeCtx();
  const full = await get(handleSessions, ctx, SESSIONS);
  const fresh = await get(handleSessions, ctx, `${SESSIONS}?fresh=1&rev=${encodeURIComponent(full.revision)}`);
  assert.equal(fresh.unchanged, undefined, '写后刷新必须拿到真数据');
  assert.equal(fresh.items.length, 2);
});

test('sessions：archived=1 时即便 rev 命中也不走 unchanged', async () => {
  const ctx = makeCtx();
  ctx.state.archivedSessionIds = ['s2'];
  const full = await get(handleSessions, ctx, SESSIONS);
  const archived = await get(handleSessions, ctx, `${SESSIONS}?archived=1&rev=${encodeURIComponent(full.revision)}`);
  assert.equal(archived.unchanged, undefined);
  assert.deepEqual(archived.items.map((item) => item.sessionId), ['s2']);
});

test('sessions：归档分页请求一律不走 unchanged', async () => {
  const ctx = makeCtx();
  ctx.state.archivedSessionIds = ['s2'];
  const body = await get(handleSessions, ctx, `${SESSIONS}?archived=1&offset=0&limit=50&rev=whatever`);
  assert.equal(body.unchanged, undefined);
  assert.deepEqual(body.items.map((item) => item.sessionId), ['s2']);
});

test('sessions：unchanged 响应不写进那层 10 秒缓存', async () => {
  const ctx = makeCtx();
  const full = await get(handleSessions, ctx, SESSIONS);
  const cached = await get(handleSessions, ctx, SESSIONS);
  assert.deepEqual(cached.items.map((item) => item.sessionId), ['s1', 's2'], '普通读命中 10 秒缓存');

  const trimmed = await get(handleSessions, ctx, `${SESSIONS}?rev=${encodeURIComponent(full.revision)}`);
  assert.equal(trimmed.unchanged, true);

  // 宿主那边真的变了：unchanged 那次没有把「一句话」塞进缓存，所以下一次普通读能立刻看到。
  ctx.state.items = [...ctx.state.items, { sessionId: 's3', cwd: '/ws/a', updatedAt: 3000, running: false, blank: false, projections: { values: { title: '三' } } }];
  invalidateSessionList(ctx);
  const after = await get(handleSessions, ctx, SESSIONS);
  assert.equal(after.items.length, 3, 'unchanged 不该污染缓存');
});

test('workspaces：rev 命中时回 unchanged 且不带 items；fresh=1 不走', async () => {
  const ctx = makeCtx();
  const full = await get(handleWorkspaces, ctx, WORKSPACES);
  assert.equal(full.items.length, 1);
  assert.equal(typeof full.revision, 'string');

  const trimmed = await get(handleWorkspaces, ctx, `${WORKSPACES}?rev=${encodeURIComponent(full.revision)}`);
  assert.deepEqual(trimmed, {
    ok: true,
    unchanged: true,
    revision: full.revision,
    generatedAt: trimmed.generatedAt,
  });
  assert.equal(Object.hasOwn(trimmed, 'items'), false);

  const fresh = await get(handleWorkspaces, ctx, `${WORKSPACES}?fresh=1&rev=${encodeURIComponent(full.revision)}`);
  assert.equal(fresh.unchanged, undefined, '写后刷新必须拿到真数据');
  assert.equal(fresh.items.length, 1);

  const other = await get(handleWorkspaces, ctx, `${WORKSPACES}?rev=nope`);
  assert.equal(other.unchanged, undefined);
  assert.equal(other.items.length, 1);
});

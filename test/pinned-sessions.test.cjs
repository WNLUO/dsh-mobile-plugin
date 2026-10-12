'use strict';

/**
 * 置顶（pin）/ 取消置顶 / 取消归档，以及「只看已归档」列表的行为守卫。
 *
 * 桌面端这三件事都有入口（会话菜单 + 行尾按钮），而移动端的 `workspace.list` 一直带着
 * 的 `pinnedSessionIds` 从来没被读过，取消归档也没有任何路由——归档错了只能在桌面端捞。
 * 这批用例驱动真实的 `buildSessionsResponse` / handler（不是转写实现），钉住三条：
 *
 *  1. 置顶标记只落在 `pinnedSessionIds` 里的那些行上（其余行不许凭空多出字段）；
 *  2. `?archived=1` 取的是**归档子集**，默认视图反过来藏它们——两个方向都要成立；
 *  3. 三条写路由打到宿主对应动词、作废列表缓存、并按 requestId 幂等重放。
 */

const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');
const { sessionListResponseState } = require('../lib/mobile/session-cache.js');
const {
  handleUnarchiveSession,
  handlePinSession,
  handleUnpinSession,
} = require('../lib/mobile/workspaces.js');

const ARCHIVED_ID = 'session-archived-1';
const PINNED_ID = 'session-pinned-2';
const PLAIN_ID = 'session-plain-3';

/** 与真实宿主同形的 ctx：sessions.list 返回全部（含已归档），workspace.list 带两个集合。 */
function makeCtx({ archivedSessionIds = [ARCHIVED_ID], pinnedSessionIds = [PINNED_ID], workspaceThrows = false, hostError = null } = {}) {
  const items = [
    { sessionId: ARCHIVED_ID, cwd: '/ws/a', updatedAt: 3000, running: false, blank: false },
    { sessionId: PINNED_ID, cwd: '/ws/a', updatedAt: 2000, running: false, blank: false },
    { sessionId: PLAIN_ID, cwd: '/ws/a', updatedAt: 1000, running: false, blank: false },
  ];
  const calls = [];
  const hostReply = (method, request) => {
    calls.push([method, request.payload]);
    if (hostError) return { result: { ok: false, error: hostError } };
    if (method === 'unarchiveSession') return { result: { ok: true, value: { archivedSessionIds: [] } } };
    if (method === 'pinSession') return { result: { ok: true, value: { pinnedSessionIds: [request.payload.sessionId] } } };
    return { result: { ok: true, value: { pinnedSessionIds: [] } } };
  };
  return {
    items,
    calls,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: {
        list: async () => {
          if (workspaceThrows) throw new Error('workspace.list exploded');
          return {
            result: {
              ok: true,
              value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds, pinnedSessionIds },
            },
          };
        },
        archiveSession: async request => hostReply('archiveSession', request),
        unarchiveSession: async request => hostReply('unarchiveSession', request),
        pinSession: async request => hostReply('pinSession', request),
        unpinSession: async request => hostReply('unpinSession', request),
      },
    },
  };
}

function makeReq(body, deviceHeader) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  if (deviceHeader) req.headers['x-dsh-device'] = deviceHeader;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

test('置顶标记只在 pinnedSessionIds 里的行上出现', async () => {
  const response = await buildSessionsResponse(makeCtx());
  assert.equal(response.status, 200);
  const byId = new Map(response.body.items.map(item => [item.sessionId, item]));
  assert.equal(byId.get(PINNED_ID).pinned, true);
  // 没置顶的行不许凭空多出字段（旧 App 靠「字段不存在」判断未置顶）。
  assert.equal(Object.prototype.hasOwnProperty.call(byId.get(PLAIN_ID), 'pinned'), false);
  // 归档行照旧从默认视图里剔除。
  assert.equal(byId.has(ARCHIVED_ID), false);
});

test('一次 workspace.list 同时读归档与置顶两个集合', async () => {
  const ctx = makeCtx();
  let listCalls = 0;
  const originalList = ctx.apiProxy.workspace.list;
  ctx.apiProxy.workspace.list = async () => { listCalls += 1; return originalList(); };
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  assert.equal(listCalls, 1);
});

test('archived=1 取归档子集，且置顶标记照旧带出来', async () => {
  const response = await buildSessionsResponse(makeCtx({ pinnedSessionIds: [ARCHIVED_ID] }), 'legacy', undefined, false, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.sessionId), [ARCHIVED_ID]);
  assert.equal(response.body.items[0].pinned, true);
});

test('读不到集合时失败放开：既不清空列表，也不凭空置顶', async () => {
  const response = await buildSessionsResponse(makeCtx({ workspaceThrows: true }));
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 3);
  assert.equal(response.body.items.some(item => item.pinned), false);
});

test('pinnedSessionIds 里的非字符串值被忽略', async () => {
  const response = await buildSessionsResponse(makeCtx({ pinnedSessionIds: [PINNED_ID, 42, null, { id: 'x' }] }));
  const pinned = response.body.items.filter(item => item.pinned).map(item => item.sessionId);
  assert.deepEqual(pinned, [PINNED_ID]);
});

test('三条写路由各自打到宿主对应动词，并作废会话列表缓存', async () => {
  const cases = [
    [handlePinSession, 'pinSession'],
    [handleUnpinSession, 'unpinSession'],
    [handleUnarchiveSession, 'unarchiveSession'],
  ];
  for (const [handler, method] of cases) {
    const ctx = makeCtx();
    // 先让缓存有值，才能观察「写完之后被作废」。
    const state = sessionListResponseState(ctx, 'legacy');
    state.value = { ok: true, items: [] };
    state.updatedAt = Date.now();

    const res = makeRes();
    await handler(ctx, makeReq({ sessionId: 'session-x' }, 'phone-a'), res);

    assert.equal(res.status, 200, `${method} 应当返回 200`);
    assert.deepEqual(ctx.calls.at(-1), [method, { sessionId: 'session-x' }]);
    assert.equal(state.value, null, `${method} 之后列表缓存必须作废`);
  }
});

test('缺少 sessionId 时三个写路由都直接 400，不打宿主', async () => {
  for (const handler of [handlePinSession, handleUnpinSession, handleUnarchiveSession]) {
    const ctx = makeCtx();
    const res = makeRes();
    await handler(ctx, makeReq({}), res);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad-request');
    assert.equal(ctx.calls.length, 0);
  }
});

test('同一个 requestId 重投只打一次宿主（幂等重放）', async () => {
  const ctx = makeCtx();
  const first = makeRes();
  const replay = makeRes();
  await handlePinSession(ctx, makeReq({ sessionId: 'session-x', requestId: 'rid-1' }, 'phone-a'), first);
  await handlePinSession(ctx, makeReq({ sessionId: 'session-x', requestId: 'rid-1' }, 'phone-a'), replay);
  assert.equal(ctx.calls.filter(([method]) => method === 'pinSession').length, 1);
  assert.deepEqual(replay.body, first.body);
});

test('宿主拒绝（例如给已归档会话置顶）时原样透传错误码', async () => {
  const ctx = makeCtx({ hostError: { code: 'gateway/bad-request', message: '会话已归档，不能置顶' } });
  const res = makeRes();
  await handlePinSession(ctx, makeReq({ sessionId: 'session-x' }), res);
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'gateway/bad-request');
});

test('源码契约：三条路由已注册，且列表侧读的是置顶集合', () => {
  const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'mobile-api.js'), 'utf8');
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'sessions.js'), 'utf8');
  assert.match(routesSrc, /workspace\/pin-session', workspaces\.handlePinSession/);
  assert.match(routesSrc, /workspace\/unpin-session', workspaces\.handleUnpinSession/);
  assert.match(routesSrc, /workspace\/unarchive-session', workspaces\.handleUnarchiveSession/);
  assert.match(sessionsSrc, /workspaceSessionFlags\(ctx\)/);
  assert.match(sessionsSrc, /pinnedSessionIds/);
});

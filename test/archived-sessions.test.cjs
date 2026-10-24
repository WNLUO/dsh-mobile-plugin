'use strict';

/**
 * 归档会话必须真的从会话列表里消失（真机回归）。
 *
 * 真机现象：App 侧边栏「归档会话」→ 确认框 → 点「归档」，那一行照旧留在侧边栏，
 * 没有任何归档标记。直接 POST /api/mobile/v1/workspace/archive-session 得到
 * `{"ok":true,"archivedSessionIds":["session-df678214-…"]}`，宿主
 * ~/.dsh-lan-host/storages/workspace.json 的 `global.archivedSessionIds` 也确实记下了它，
 * 但 GET /api/mobile/v1/sessions 仍然把这条会话发回手机。
 *
 * 根因有两处，都在透传层：
 *  1. 宿主 `sessions.list` **不按归档过滤**——「哪些会话已归档」只存在于
 *     `workspace.list` 的 `archivedSessionIds`（见 dsh-host-apiproxy workspace.list），
 *     移动端必须读这个集合过滤会话；
 *  2. 工作区 revision 只覆盖 `items`，归档集合变化时镜像判重会跳过新快照，桌面端仍显示旧归档状态。
 * 于是 App 的归档在移动端表现为一次毫无反馈的空操作。
 *
 * 本测试驱动真实的 `buildSessionsResponse` / `buildWorkspacesBody`（不是转写实现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSessionsResponse, handleSessions } = require('../lib/mobile/sessions.js');
const { buildWorkspacesBody } = require('../lib/mobile/workspaces.js');

const ARCHIVED_ID = 'session-archived-1';
const KEPT_ID = 'session-kept-2';

/** 造一个与真实宿主同形的 ctx：sessions.list 返回全部（含已归档），workspace.list 带 archivedSessionIds。 */
function makeCtx({ archivedSessionIds = [ARCHIVED_ID], workspaceThrows = false, workspaceItems = null } = {}) {
  const sessionItems = [
    { sessionId: ARCHIVED_ID, cwd: '/ws/a', updatedAt: 2000, running: false, blank: false },
    { sessionId: KEPT_ID, cwd: '/ws/a', updatedAt: 1000, running: false, blank: false },
  ];
  return {
    items: sessionItems,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: sessionItems } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: {
        list: async () => {
          if (workspaceThrows) throw new Error('workspace.list exploded');
          return {
            result: {
              ok: true,
              value: { items: workspaceItems || [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds },
            },
          };
        },
      },
    },
  };
}

test('归档会话不再出现在会话列表里（真机根因）', async () => {
  const response = await buildSessionsResponse(makeCtx());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.sessionId), [KEPT_ID]);
});

test('归档只剔除集合内的 id，其余会话一个都不能少', async () => {
  const response = await buildSessionsResponse(makeCtx({ archivedSessionIds: [] }));
  assert.equal(response.body.items.length, 2);
});

test('读不到归档集合时失败放开：列表照常返回全部会话', async () => {
  const response = await buildSessionsResponse(makeCtx({ workspaceThrows: true }));
  assert.equal(response.body.items.length, 2);
});

test('宿主没给 archivedSessionIds 时不得误删任何会话', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: true, value: { items: [] } } });
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.body.items.length, 2);
});

test('归档分页在过滤后切片并报告后续页', async () => {
  const ctx = makeCtx();
  const archivedIds = ['arch-1', 'arch-2', 'arch-3'];
  ctx.items.splice(0, ctx.items.length,
    ...archivedIds.map((sessionId, index) => ({ sessionId, updatedAt: 3000 - index, running: false })),
    { sessionId: KEPT_ID, updatedAt: 1000, running: false });
  ctx.apiProxy.workspace.list = async () => ({
    result: { ok: true, value: { items: [], archivedSessionIds: archivedIds } },
  });
  const first = await buildSessionsResponse(ctx, 'device', 0, false, true, { offset: 0, limit: 2 });
  assert.deepEqual(first.body.items.map(item => item.sessionId), archivedIds.slice(0, 2));
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.emptyConfirmed, false);

  const last = await buildSessionsResponse(ctx, 'device', 0, false, true, { offset: 2, limit: 2 });
  assert.deepEqual(last.body.items.map(item => item.sessionId), ['arch-3']);
  assert.equal(last.body.hasMore, false);
  assert.equal(last.body.emptyConfirmed, false);
});

test('未带分页参数的旧客户端仍收到完整归档列表', async () => {
  const ctx = makeCtx();
  const response = await buildSessionsResponse(ctx, 'device', 0, false, true);
  assert.deepEqual(response.body.items.map(item => item.sessionId), [ARCHIVED_ID]);
  assert.equal(response.body.hasMore, false);
});

test('请求只带 offset 时仍使用默认页长 50', async () => {
  const ctx = makeCtx();
  const archivedIds = Array.from({ length: 60 }, (_, index) => `arch-${index}`);
  ctx.items.splice(0, ctx.items.length,
    ...archivedIds.map((sessionId, index) => ({ sessionId, updatedAt: 3000 - index, running: false })));
  ctx.apiProxy.workspace.list = async () => ({
    result: { ok: true, value: { items: [], archivedSessionIds: archivedIds } },
  });
  let status;
  let body;
  await handleSessions(ctx, {
    url: '/api/mobile/v1/sessions?archived=1&offset=0',
    headers: {},
  }, {
    writeHead(value) { status = value; },
    end(value) { body = JSON.parse(value); },
  });
  assert.equal(status, 200);
  assert.equal(body.items.length, 50);
  assert.equal(body.hasMore, true);
  assert.equal(body.emptyConfirmed, false);
});

test('归档集合里的非字符串值被忽略', async () => {
  const ctx = makeCtx({ archivedSessionIds: [ARCHIVED_ID, 42, null, { id: 'x' }] });
  const response = await buildSessionsResponse(ctx);
  assert.deepEqual(response.body.items.map(item => item.sessionId), [KEPT_ID]);
});

test('工作区快照不再下发归档集合，但它仍参与 revision', async () => {
  // 归档集合是一份可能几十 KB 的纯字符串数组，App 从来不读它（归档会话由 /sessions 直接剔除、
  // 取消归档走单独的写接口），所以不下发；但仅它变化时镜像也必须推新版本，故留在 revision 里。
  const workspaceItems = [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }];
  const archived = await buildWorkspacesBody(makeCtx({ archivedSessionIds: [ARCHIVED_ID, 7], workspaceItems }));
  const unarchived = await buildWorkspacesBody(makeCtx({ archivedSessionIds: [], workspaceItems }));
  assert.equal(archived.ok, true);
  assert.equal(archived.items.length, 1);
  assert.equal('archivedSessionIds' in archived, false, '归档集合不再随清单下发');
  assert.deepEqual(unarchived.items, archived.items);
  assert.notEqual(archived.revision, unarchived.revision);
});

test('工作区快照在宿主报错时照旧返回错误体', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: false, error: { code: 'boom', message: 'x' } } });
  const body = await buildWorkspacesBody(ctx);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'boom');
});

test('源码契约：会话列表读归档集合、工作区快照只把它算进 revision', () => {
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'sessions.js'), 'utf8');
  const workspacesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'workspaces.js'), 'utf8');
  // 取归档 / 置顶集合的那次 RPC 住在 session-flags.js（会话列表与后台监控共用一份判定），
  // 「会话列表必须自己读归档集合」这条不变：sessions.js 仍要调那个助手。
  const flagsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'session-flags.js'), 'utf8');
  assert.match(flagsSrc, /ctx\.apiProxy\.workspace\.list\(/);
  assert.match(sessionsSrc, /workspaceSessionFlags\(ctx\)/);
  assert.doesNotMatch(sessionsSrc, /const allSummaries = value\.items \|\| \[\];/);
  // 2026-10-22 起 items 先过 attachGitMarkers 挂 Git 仓库标记（回的是那份 marked）。
  // 归档集合不再随 body 下发，但必须留在 revision 里 —— 删掉它等于「仅归档变化」判成没变化。
  assert.match(workspacesSrc, /const marked = await attachGitMarkers\(items,/);
  assert.match(workspacesSrc, /revision: stableRevision\(\{ items: marked, archivedSessionIds \}\)/);
  assert.doesNotMatch(workspacesSrc, /return \{\s*ok: true,\s*items: marked,\s*archivedSessionIds,/);
});

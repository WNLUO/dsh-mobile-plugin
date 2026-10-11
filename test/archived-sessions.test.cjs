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
 *     而移动端此前从不读这个集合；
 *  2. `workspaces.js` 的 `buildWorkspacesBody` 只保留 `items`，把
 *     `archivedSessionIds` 整个丢掉，所以将来要做「取消归档」也没有数据来源。
 * 于是 App 的归档在移动端表现为一次毫无反馈的空操作。
 *
 * 本测试驱动真实的 `buildSessionsResponse` / `buildWorkspacesBody`（不是转写实现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');
const { buildWorkspacesBody } = require('../lib/mobile/workspaces.js');

const ARCHIVED_ID = 'session-archived-1';
const KEPT_ID = 'session-kept-2';

/** 造一个与真实宿主同形的 ctx：sessions.list 返回全部（含已归档），workspace.list 带 archivedSessionIds。 */
function makeCtx({ archivedSessionIds = [ARCHIVED_ID], workspaceThrows = false } = {}) {
  const items = [
    { sessionId: ARCHIVED_ID, cwd: '/ws/a', updatedAt: 2000, running: false, blank: false },
    { sessionId: KEPT_ID, cwd: '/ws/a', updatedAt: 1000, running: false, blank: false },
  ];
  return {
    items,
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
              value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds },
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

test('归档集合里的非字符串值被忽略', async () => {
  const ctx = makeCtx({ archivedSessionIds: [ARCHIVED_ID, 42, null, { id: 'x' }] });
  const response = await buildSessionsResponse(ctx);
  assert.deepEqual(response.body.items.map(item => item.sessionId), [KEPT_ID]);
});

test('工作区快照原样透传 archivedSessionIds（此前被丢掉）', async () => {
  const body = await buildWorkspacesBody(makeCtx({ archivedSessionIds: [ARCHIVED_ID, 7] }));
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.archivedSessionIds, [ARCHIVED_ID]);
});

test('工作区快照在宿主报错时照旧返回错误体', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: false, error: { code: 'boom', message: 'x' } } });
  const body = await buildWorkspacesBody(ctx);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'boom');
});

test('源码契约：会话列表读归档集合、工作区快照不再丢弃该字段', () => {
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'sessions.js'), 'utf8');
  const workspacesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'workspaces.js'), 'utf8');
  assert.match(sessionsSrc, /ctx\.apiProxy\.workspace\.list\(/);
  assert.match(sessionsSrc, /archivedSessionIdSet\(ctx\)/);
  assert.doesNotMatch(sessionsSrc, /const allSummaries = value\.items \|\| \[\];/);
  // 6054bb2 起快照多带 generatedAt/revision/emptyConfirmed，返回也改成多行，
  // 但 archivedSessionIds 仍须紧跟 items 一起返回（不能被新鲜度字段挤掉）。
  assert.match(workspacesSrc, /return \{\s*ok: true,\s*items,\s*archivedSessionIds,/);
});

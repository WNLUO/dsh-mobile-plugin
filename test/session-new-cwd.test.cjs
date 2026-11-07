'use strict';

/**
 * 新建会话 `POST /api/mobile/v1/session/new` 的 cwd 边界。
 *
 * 为什么单列一份：会话的 cwd 是 allowed-zone 的第二个根（`allowedRoots` 会把这条会话的
 * 项目目录并进允许区），所以 `/session/new` 的 cwd 一旦不收，任何拿到 token 的手机都能
 * 用一发新建把「允许读写区」扩到整台机器 —— 之后再走 file/read、upload 的 destPath
 * 就都是合法路径了。这里钉住四件事：
 *
 *  1. `cwd` 必须落在**宿主已登记的工作区**里，否则 403 `outside-allowed`，且一次
 *     `session.create` 都不发（不能先把会话建出来再拒绝）。
 *  2. `cwd` 必须是绝对路径：相对路径没有可信基准，回 400 `bad-request`，同 file/read。
 *  3. `cwd` 按 `path.resolve` 之后的落点判：工作区里用 `..` 爬出去同样 403。
 *  4. `workspaceId` 那条路一个字不动：不去读工作区清单，直接交给宿主 attach。
 *
 * 驱动真实的 `handleNew`，只有宿主那一侧是假对象。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { handleNew } = require('../lib/mobile/sessions.js');

/** 与其它 handler 测试同形：把 JSON body 灌成一条请求流。 */
function makeReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = {};
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

const okValue = (value) => ({ result: { ok: true, value } });

/**
 * 假 ctx：工作区清单与 session.create 的入参都记下来，用例直接看「宿主到底收到了什么」。
 *
 * @param {object} options
 * @param {string[]} [options.workspaces] 宿主登记的工作区目录
 * @param {object} [options.workspaceError] workspace.list 回错误
 */
function makeCtx(options = {}) {
  const calls = { workspaceList: 0, create: [] };
  const ctx = {
    calls,
    apiProxy: {
      workspace: {
        list: async () => {
          calls.workspaceList += 1;
          if (options.workspaceError) return { result: { ok: false, error: options.workspaceError } };
          return okValue({ items: (options.workspaces || []).map((dir) => ({ workspaceId: 'w1', path: dir })) });
        },
      },
      sessions: {
        create: async (request) => {
          calls.create.push(request.payload);
          return okValue({ sessionId: 'session-new' });
        },
      },
    },
  };
  return ctx;
}

/** 跑一次 handleNew，返回 { status, body }。 */
async function post(ctx, body) {
  const res = makeRes();
  await handleNew(ctx, makeReq(body), res);
  return res;
}

// 工作区根刻意取临时目录下的一个**真实**路径：判的是 resolve 之后的落点，跟盘上有没有
// 无关，但用真实绝对路径能顺带证明它不是只在 `/ws/a` 这种字面量上凑巧成立。
const WS = path.join(os.homedir(), 'dsh-ws');

test('工作区里的 cwd：放行，宿主收到 resolve 后的绝对路径', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  const res = await post(ctx, { cwd: path.join(WS, 'projects', 'demo') });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sessionId, 'session-new');
  assert.equal(ctx.calls.create.length, 1);
  assert.equal(ctx.calls.create[0].cwd, path.join(WS, 'projects', 'demo'));
  assert.equal(ctx.calls.workspaceList, 1, '走 cwd 时要先读一次工作区清单');
});

test('工作区里的 cwd 带 `..`：按 resolve 之后的落点算，仍在里面就放行', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  const res = await post(ctx, { cwd: path.join(WS, 'projects', '..', 'demo') });

  assert.equal(res.status, 200);
  assert.equal(ctx.calls.create[0].cwd, path.join(WS, 'demo'));
});

test('cwd 在工作区外：403 outside-allowed，且不去建会话', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  for (const outside of ['/', path.join(os.homedir(), 'Desktop'), `${WS}-evil`]) {
    const res = await post(ctx, { cwd: outside });
    assert.equal(res.status, 403, `${outside} 应当被拒`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'outside-allowed');
    assert.match(res.body.error.message, /工作区/);
  }
  assert.equal(ctx.calls.create.length, 0, '被拒的 cwd 不能先建出会话');
  assert.equal(ctx.calls.workspaceList, 3);
});

test('从工作区里用 `..` 爬出去：403 且不发 create', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  const res = await post(ctx, { cwd: path.join(WS, '..', 'elsewhere') });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'outside-allowed');
  assert.equal(ctx.calls.create.length, 0);
});

test('相对路径的 cwd：400 bad-request，且不去问宿主', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  const res = await post(ctx, { cwd: 'projects/demo' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad-request');
  assert.equal(ctx.calls.workspaceList, 0);
  assert.equal(ctx.calls.create.length, 0);
});

test('workspaceId 那条路不受影响：只透传，不读工作区清单', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  // 同时给 cwd 也只有 workspaceId 生效（既有口径：workspaceId 优先）。
  const res = await post(ctx, { workspaceId: 'w-any', cwd: '/' });

  assert.equal(res.status, 200);
  assert.deepEqual(ctx.calls.create[0], { workspaceId: 'w-any' });
  assert.equal(ctx.calls.workspaceList, 0, 'workspaceId 的路子不该被新校验牵连');
});

test('cwd 与 workspaceId 都不传：照旧建在宿主默认工作区', async () => {
  const ctx = makeCtx({ workspaces: [WS] });
  const res = await post(ctx, {});

  assert.equal(res.status, 200);
  assert.deepEqual(ctx.calls.create[0], {});
  assert.equal(ctx.calls.workspaceList, 0);
});

test('工作区清单读不到：502 如实回，不当成「没有工作区」', async () => {
  const ctx = makeCtx({ workspaceError: { code: 'workspace-list-failed', message: '宿主工作区清单超时' } });
  const res = await post(ctx, { cwd: WS });

  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'workspace-list-failed');
  assert.equal(res.body.error.message, '宿主工作区清单超时');
  assert.equal(ctx.calls.create.length, 0);
});

'use strict';

/**
 * `dsh_workspace` 工具：模型侧的「这台电脑上有哪些工作区与对话」，以及读 / 发 / 停 / 新建。
 *
 * 这里驱动的是真实现（`buildWorkspacesBody` / `buildSessionsResponse` / `promptOnce` /
 * `cancel` / `create` 全走宿主 ctx），不是转写。所以它同时钉住两件事：工具的动作分发，
 * 以及这些动作**与手机那几张路由共用同一份底层调用**（不另写一套判据）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerWorkspaceTool,
  installWorkspaceTools,
  listWorkspaces,
  listSessions,
  readSession,
  sendToSession,
  stopSession,
  createSession,
} = require('../lib/mobile/workspace-tools.js');

const SESSION_ID = 'session-a';

/** 与真宿主同形的 ctx：会话列表、历史、工作区清单，外加记下发过什么。 */
function makeCtx(overrides = {}) {
  const calls = [];
  const sessionItems = [
    { sessionId: SESSION_ID, cwd: '/ws/a', updatedAt: 2000, running: false, blank: false, projections: { values: { title: '第一条' } } },
    { sessionId: 'session-b', cwd: '/ws/b', updatedAt: 1000, running: true, blank: false },
  ];
  const ctx = {
    calls,
    sessionItems,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: sessionItems } } }),
        history: async () => ({
          result: {
            ok: true,
            value: {
              events: [
                { seq: 1, type: 'user/message', data: { turn: 1, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
                { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '在的' }] } } },
              ],
            },
          },
        }),
        prompt: async (request) => { calls.push({ method: 'prompt', request }); return { result: { ok: true, value: {} } }; },
        cancel: async (request) => { calls.push({ method: 'cancel', request }); return { result: { ok: true, value: {} } }; },
        create: async (request) => { calls.push({ method: 'create', request }); return { result: { ok: true, value: { sessionId: 'session-new', cwd: '/ws/a' } } }; },
        rename: async (request) => { calls.push({ method: 'rename', request }); return { result: { ok: true, value: {} } }; },
        fork: async (request) => { calls.push({ method: 'fork', request }); return { result: { ok: true, value: { sessionId: 'session-forked' } } }; },
      },
      workspace: {
        list: async () => ({
          result: {
            ok: true,
            value: {
              items: [
                { workspaceId: 'w1', path: '/ws/a', title: '项目 A', sessionIds: [SESSION_ID] },
                { workspaceId: 'w2', path: '/ws/b', title: '项目 B', sessionIds: [] },
              ],
              archivedSessionIds: [],
            },
          },
        }),
        rename: async (request) => { calls.push({ method: 'workspace.rename', request }); return { result: { ok: true, value: { workspace: { workspaceId: request.payload.workspaceId, title: request.payload.title } } } }; },
        delete: async (request) => { calls.push({ method: 'workspace.delete', request }); return { result: { ok: true, value: { deleted: true } } }; },
        create: async (request) => { calls.push({ method: 'workspace.create', request }); return { result: { ok: true, value: { created: true, workspace: { workspaceId: 'w9', path: request.payload.path, title: '新项目' } } } }; },
        insertSessionBefore: async (request) => { calls.push({ method: 'workspace.insertSessionBefore', request }); return { result: { ok: true, value: { workspace: { workspaceId: request.payload.workspaceId } } } }; },
        archiveSession: async (request) => { calls.push({ method: 'workspace.archiveSession', request }); return { result: { ok: true, value: {} } }; },
        unarchiveSession: async (request) => { calls.push({ method: 'workspace.unarchiveSession', request }); return { result: { ok: true, value: {} } }; },
        pinSession: async (request) => { calls.push({ method: 'workspace.pinSession', request }); return { result: { ok: true, value: {} } }; },
        unpinSession: async (request) => { calls.push({ method: 'workspace.unpinSession', request }); return { result: { ok: true, value: {} } }; },
      },
    },
    ...overrides,
  };
  return ctx;
}

test('列工作区：只留 ID / 标题 / 路径三样', async () => {
  const listed = await listWorkspaces(makeCtx());
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.workspaces[0], { workspaceId: 'w1', title: '项目 A', path: '/ws/a' });
});

test('工作区清单读失败要抛，不许回空清单冒充「一个都没有」', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: false, error: { code: 'host-unavailable', message: '宿主没起来' } } });
  await assert.rejects(() => listWorkspaces(ctx), /宿主没起来/);
});

test('列会话：带上 running 与标题，并能按工作区路径筛', async () => {
  const all = await listSessions(makeCtx());
  assert.equal(all.total, 2);
  assert.equal(all.sessions[0].title, '第一条');
  assert.equal(all.sessions[1].running, true);

  const scoped = await listSessions(makeCtx(), { cwd: '/ws/b' });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.sessions[0].sessionId, 'session-b');
});

test('读会话：回的是消息行，不是原始事件', async () => {
  const read = await readSession(makeCtx(), SESSION_ID, 10);
  assert.equal(read.sessionId, SESSION_ID);
  assert.deepEqual(read.messages.map((m) => m.text), ['你好', '在的']);
});

test('读会话：压缩 / 重试这类结构化行没有正文，不许当成空消息塞回模型', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.sessions.history = async () => ({
    result: {
      ok: true,
      value: {
        events: [
          { seq: 1, type: 'user/message', data: { turn: 1, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始' }] } },
          { seq: 2, type: 'compaction/summary', data: { turn: 1, compactionId: 'c1', content: [{ type: 'text', text: '' }] } },
          { seq: 3, type: 'turn/error', data: { turn: 1, reason: { kind: 'aborted' } } },
        ],
      },
    },
  });
  const read = await readSession(ctx, SESSION_ID, 10);
  assert.deepEqual(read.messages.map((m) => m.text), ['开始'], '只有真说了话的那一条留下');
});

test('读会话：超长正文截断并标明', async () => {
  const ctx = makeCtx();
  const long = 'x'.repeat(5000);
  ctx.apiProxy.sessions.history = async () => ({
    result: { ok: true, value: { events: [{ seq: 1, type: 'user/message', data: { turn: 1, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] } }] } },
  });
  const read = await readSession(ctx, SESSION_ID, 10);
  assert.equal(read.messages[0].text.length, 4000);
  assert.equal(read.messages[0].truncated, true);
});

test('列会话：子代理会话不列（点开就失败的入口不该给模型）', async () => {
  const ctx = makeCtx();
  ctx.sessionItems.push({ sessionId: 'sub-1', cwd: '/ws/a', updatedAt: 3000, running: false, origin: 'subagent', parentSessionId: SESSION_ID });
  const listed = await listSessions(ctx);
  assert.deepEqual(listed.sessions.map((s) => s.sessionId), [SESSION_ID, 'session-b']);
  assert.equal(listed.total, 2);
});

test('发消息：走的是宿主 prompt，mode 原样透传，不传就交给宿主默认', async () => {
  const ctx = makeCtx();
  await sendToSession(ctx, SESSION_ID, '继续', 'queue');
  const sent = ctx.calls.find((c) => c.method === 'prompt');
  assert.ok(sent, '必须真的打到 session.prompt');
  assert.equal(sent.request.payload.sessionId, SESSION_ID);
  assert.equal(sent.request.payload.content[0].text, '继续');
  assert.equal(sent.request.payload.mode, 'queue');

  const plain = makeCtx();
  await sendToSession(plain, SESSION_ID, '别的');
  assert.equal(plain.calls.find((c) => c.method === 'prompt').request.payload.mode, undefined);
});

test('停会话走 session.cancel；新建走 session.create 并带 workspaceId', async () => {
  const ctx = makeCtx();
  await stopSession(ctx, SESSION_ID);
  assert.ok(ctx.calls.find((c) => c.method === 'cancel'));

  const created = await createSession(ctx, { workspaceId: 'w1' });
  assert.equal(created.sessionId, 'session-new');
  const createCall = ctx.calls.find((c) => c.method === 'create');
  assert.equal(createCall.request.payload.workspaceId, 'w1');
});

test('新建会话没回 sessionId 时算失败', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.sessions.create = async () => ({ result: { ok: true, value: {} } });
  await assert.rejects(() => createSession(ctx, { cwd: '/ws/a' }), /没有返回会话 ID/);
});

test('新建会话：按 cwd 建时，目录必须落在已登记的工作区里', async () => {
  const inside = makeCtx();
  const created = await createSession(inside, { cwd: '/ws/a' });
  assert.equal(created.sessionId, 'session-new');
  assert.equal(inside.calls.find((c) => c.method === 'create').request.payload.cwd, '/ws/a');

  // 爬出工作区、或干脆在别处，一律不放行 —— 会话的 cwd 就是手机侧按路径读写文件的根。
  const outside = makeCtx();
  await assert.rejects(() => createSession(outside, { cwd: '/etc' }), /不在已登记的工作区/);
  await assert.rejects(() => createSession(makeCtx(), { cwd: '/ws/a/../../etc' }), /不在已登记的工作区/);
  assert.equal(outside.calls.find((c) => c.method === 'create'), undefined, '拒绝时一个请求都不许发出去');

  await assert.rejects(() => createSession(makeCtx(), { cwd: 'relative/dir' }), /必须是绝对路径/);
});

test('新建会话：工作区清单读不到时照实抛，不按「没有工作区」处理', async () => {
  const ctx = makeCtx();
  ctx.apiProxy.workspace.list = async () => ({ result: { ok: false, error: { code: 'host-unavailable', message: '宿主没起来' } } });
  await assert.rejects(() => createSession(ctx, { cwd: '/ws/a' }), /宿主没起来/);
});

test('工具：动作清单就是 App 能做的那一套，缺参数要报清楚', async () => {
  let registered = null;
  const ctx = makeCtx();
  ctx.tools = { register: (tool) => { registered = tool; } };
  registerWorkspaceTool(ctx, () => {});
  assert.equal(registered.name, 'dsh_workspace');
  const required = registered.parameters.required || [];
  assert.deepEqual([...required], ['action']);
  assert.deepEqual([...registered.parameters.properties.action.enum].sort(), [
    'archive_session', 'create_workspace', 'fork_session', 'list_sessions', 'list_workspaces',
    'move_session', 'new_session', 'pin_session', 'read_session', 'remove_workspace',
    'rename_session', 'rename_workspace', 'send_message', 'stop_session',
    'unarchive_session', 'unpin_session',
  ]);

  const listed = await registered.execute({ action: 'list_workspaces' });
  assert.equal(listed.action, 'list_workspaces');
  assert.equal(listed.workspaces_total, 2);
  assert.match(registered.output.render({}, listed)[0].text, /工作区 2 个/);

  await assert.rejects(() => registered.execute({ action: 'read_session' }), /需要 sessionId/);
  await assert.rejects(() => registered.execute({ action: 'send_message', sessionId: SESSION_ID }), /需要 text/);
  await assert.rejects(() => registered.execute({ action: 'rename_session', sessionId: SESSION_ID }), /需要 title/);
  await assert.rejects(() => registered.execute({ action: 'rename_workspace', workspaceId: 'w1' }), /需要 title/);
  await assert.rejects(() => registered.execute({ action: 'create_workspace' }), /需要 path/);
});

test('整理动作：改名 / 分叉 / 归档置顶 / 换工作区都打宿主那一个动词', async () => {
  const ctx = makeCtx();
  let register = null;
  ctx.tools = { register: (tool) => { register = tool; } };
  registerWorkspaceTool(ctx, () => {});
  const run = (args) => register.execute(args);

  await run({ action: 'rename_session', sessionId: SESSION_ID, title: '新名字' });
  assert.equal(ctx.calls.find((c) => c.method === 'rename').request.payload.title, '新名字');

  const forked = await run({ action: 'fork_session', sessionId: SESSION_ID, atSeq: 3 });
  assert.equal(forked.sessionId, 'session-forked');
  const forkCall = ctx.calls.find((c) => c.method === 'fork');
  assert.equal(forkCall.request.payload.atSeq, 3);

  for (const [action, method] of [
    ['archive_session', 'workspace.archiveSession'],
    ['unarchive_session', 'workspace.unarchiveSession'],
    ['pin_session', 'workspace.pinSession'],
    ['unpin_session', 'workspace.unpinSession'],
  ]) {
    ctx.calls.length = 0;
    await run({ action, sessionId: SESSION_ID });
    assert.ok(ctx.calls.find((c) => c.method === method), `${action} 必须打到 ${method}`);
  }

  await run({ action: 'move_session', sessionId: SESSION_ID, workspaceId: 'w2', beforeSessionId: 'session-b' });
  const moveCall = ctx.calls.find((c) => c.method === 'workspace.insertSessionBefore');
  assert.equal(moveCall.request.payload.workspaceId, 'w2');
  assert.equal(moveCall.request.payload.beforeSessionId, 'session-b');
});

test('工作区三件事：添加 / 改名 / 删除，删除只说删登记不动目录', async () => {
  const ctx = makeCtx();
  let register = null;
  ctx.tools = { register: (tool) => { register = tool; } };
  registerWorkspaceTool(ctx, () => {});

  const created = await register.execute({ action: 'create_workspace', path: '/ws/new' });
  assert.equal(created.workspaceId, 'w9');
  assert.equal(ctx.calls.find((c) => c.method === 'workspace.create').request.payload.path, '/ws/new');

  await register.execute({ action: 'rename_workspace', workspaceId: 'w1', title: '改过名' });
  assert.equal(ctx.calls.find((c) => c.method === 'workspace.rename').request.payload.title, '改过名');

  const removed = await register.execute({ action: 'remove_workspace', workspaceId: 'w1' });
  assert.equal(removed.workspaceId, 'w1');
  const removeCall = ctx.calls.find((c) => c.method === 'workspace.delete');
  assert.deepEqual(removeCall.request.payload, { workspaceId: 'w1' }, '删除只交 workspaceId，不碰目录');
});

test('没有 tools 注入时静默跳过；别的注册失败照抛', () => {
  const missing = { get tools() { throw new Error('cannot get property "tools" without inject'); } };
  assert.doesNotThrow(() => installWorkspaceTools(missing));

  const broken = { tools: { register() { throw new Error('tool registry exploded'); } } };
  assert.throws(() => installWorkspaceTools(broken), /tool registry exploded/);
});

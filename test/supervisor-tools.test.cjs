'use strict';

/**
 * 总管工具组的宿主侧守卫。
 *
 * 这一组的错误几乎都不报错、只「静默少一条」：注册不走注入，八条工具一条都进不了模型的
 * 工具清单；把发起人身份交给参数，模型就能冒充别的会话；参数里留一个 shell 口子，边界就
 * 破了。所以这里钉四类：
 *   1. 注册必须走 `ctx.inject(['tools'], …)`，且工具名单是这一份；
 *   2. 参数表里没有 deviceId / 任何「谁发的」身份口子，也没有像命令的键；
 *   3. 发起人只从 `exec.agent.id` 取（给不到就整条不执行，绝不拿参数顶）；
 *   4. 参数清洗（去空白、空文本拒、cwd 必须在已登记工作区里、limit 夹紧）。
 *
 * 运行：node --test test/supervisor-tools.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountSupervisorTools } = require('../lib/mobile/supervisor-tools.js');

/**
 * 按注入形状给假 ctx：`tools` 只能从 `ctx.inject(['tools'], cb)` 的回调里拿到。
 * 别写成 `{ tools: { register } }` —— 那样「注册路径写错」在测试里照样绿。
 */
function fakeCtx({ register = () => {}, apiProxy = null } = {}) {
  const calls = [];
  return {
    calls,
    apiProxy,
    inject(names, callback) {
      calls.push(names);
      callback({ tools: { register } });
    },
  };
}

/** 收集这一次 mount 注册到的工具（用真 mount，只把 register 换成收集器）。 */
function mountCollect() {
  const registered = new Map();
  const ctx = fakeCtx({ register: (tool) => registered.set(tool.name, tool) });
  mountSupervisorTools(ctx);
  return { ctx, registered };
}

/** 一个够用的宿主假体：会话清单 + prompt/create/cancel/history 全记账。 */
function makeHost({ sessions = [], workspace = null, outcomes = {} } = {}) {
  const log = { prompt: [], create: [], cancel: [], history: [], list: 0 };
  const envelope = (value) => ({ rpcId: 'mobile', method: 'x', payload: {}, result: { ok: true, value } });
  const fail = (error) => ({ rpcId: 'mobile', method: 'x', payload: {}, result: { ok: false, error } });
  const apiProxy = {
    sessions: {
      list: async () => { log.list += 1; return envelope(sessions); },
      prompt: async (req) => { log.prompt.push(req); return (outcomes.prompt || (() => envelope({ accepted: true })))(req); },
      create: async (req) => {
        log.create.push(req);
        const echoPreset = req.payload && req.payload.agentPreset ? { agentPreset: req.payload.agentPreset } : {};
        return (outcomes.create || (() => envelope({ sessionId: 'new-1', ...echoPreset })))(req);
      },
      cancel: async (req) => { log.cancel.push(req); return (outcomes.cancel || (() => envelope({})))(req); },
      history: async (req) => { log.history.push(req); return (outcomes.history || (() => envelope({ events: [], hasMore: false })))(req); },
    },
    workspace: {
      list: async () => envelope(workspace || { items: [], archivedSessionIds: [], pinnedSessionIds: [] }),
    },
  };
  return { apiProxy, log };
}

/** mount 一把带宿主假体的工具表。 */
function mountWithHost(host) {
  const registered = new Map();
  const ctx = fakeCtx({ register: (tool) => registered.set(tool.name, tool), apiProxy: host.apiProxy });
  mountSupervisorTools(ctx);
  return registered;
}

// ── 一、注册形状 ───────────────────────────────────────────────────────────

test('工具走 ctx.inject([tools]) 注册，不是直接读 ctx.tools', () => {
  const registered = new Map();
  const ctx = fakeCtx({ register: (tool) => registered.set(tool.name, tool) });
  mountSupervisorTools(ctx);
  assert.deepEqual(ctx.calls, [['tools']], '没走 tools 注入，宿主里这份注册会静默丢掉');
  assert.equal(registered.size, 6, `工具没注册全（${registered.size} 条）`);
});

test('工具名单是这一份，少一条会红', () => {
  const { registered } = mountCollect();
  assert.deepEqual([...registered.keys()].sort(), [
    'supervisor_create_session',
    'supervisor_interrupt_session',
    'supervisor_list_sessions',
    'supervisor_read_session',
    'supervisor_send_message',
    'supervisor_session_status',
  ]);
});

// ── 二、参数面：没有设备口子、没有身份口子、没有 shell ─────────────────────

test('参数里没有 deviceId，也没有任何让模型指定「谁发的」的身份格', () => {
  const { registered } = mountCollect();
  const identityKeys = ['deviceId', 'from', 'fromSessionId', 'sender', 'senderId', 'actor', 'actorId', 'agentId', 'callerId', 'who'];
  for (const tool of registered.values()) {
    const keys = Object.keys(tool.parameters?.properties || {});
    for (const bad of identityKeys) {
      assert.ok(!keys.includes(bad), `${tool.name} 不该让模型自己指定身份 / 设备（${bad}）`);
    }
    const shape = JSON.stringify(tool.parameters || {});
    assert.doesNotMatch(shape, /shell|exec|command|cmd|bash/i, `${tool.name} 的参数里有像命令的口子`);
  }
});

test('目标会话只能通过 sessionId / text / workspaceId… 这几个结构化字段给', () => {
  const { registered } = mountCollect();
  const allowed = new Set(['sessionId', 'text', 'limit', 'workspaceId', 'cwd', 'agentPreset']);
  for (const tool of registered.values()) {
    for (const key of Object.keys(tool.parameters?.properties || {})) {
      assert.ok(allowed.has(key), `${tool.name} 多了一个没登记的参数：${key}`);
    }
  }
});

// ── 三、发起人身份只从 exec.agent.id 取 ────────────────────────────────────

test('拿不到 exec.agent.id 时写工具整条不执行，绝不拿参数顶', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_send_message').execute({ sessionId: 's1', text: 'hi' }, { agent: {} }),
    /拿不到当前会话 id/,
  );
  await assert.rejects(
    () => tools.get('supervisor_create_session').execute({}, { agent: {} }),
    /拿不到当前会话 id/,
  );
  await assert.rejects(
    () => tools.get('supervisor_interrupt_session').execute({ sessionId: 's1' }, { agent: {} }),
    /拿不到当前会话 id/,
  );
});

test('不能给总管自己发消息（说明目标与会话身份是两码事）', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_send_message').execute({ sessionId: 'sup', text: 'hi' }, { agent: { id: 'sup' } }),
    /不能给总管自己发消息/,
  );
});

test('发起人是 exec.agent.id，落进请求的目标会话是参数给的那条', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  const result = await tools.get('supervisor_send_message').execute(
    { sessionId: 's1', text: '  去做事  ' },
    { agent: { id: 'sup' } },
  );
  assert.deepEqual(result, { sessionId: 's1', text: '去做事', sent: true });
  assert.equal(host.log.prompt.length, 1);
  assert.equal(host.log.prompt[0].payload.sessionId, 's1', '目标会话来自参数 sessionId');
  assert.deepEqual(host.log.prompt[0].payload.content, [{ type: 'text', text: '去做事' }], '正文去空白后原样发出');
});

// ── 四、参数清洗与边界 ─────────────────────────────────────────────────────

test('列所有会话：状态、项目都带出来，且结果里没有 undefined 字段', async () => {
  const host = makeHost({
    sessions: [
      { sessionId: 'run', cwd: '/proj/a', running: true, updatedAt: 1 },
      { sessionId: 'idle', cwd: '/proj/b', running: false, updatedAt: 2 },
    ],
    workspace: { items: [{ path: '/proj/a' }, { path: '/proj/b' }], archivedSessionIds: [], pinnedSessionIds: [] },
  });
  const tools = mountWithHost(host);
  const result = await tools.get('supervisor_list_sessions').execute({}, { agent: { id: 'sup' } });
  assert.equal(result.sessions.length, 2);
  const run = result.sessions.find((s) => s.sessionId === 'run');
  assert.equal(run.running, true);
  assert.equal(run.state, 'running');
  assert.equal(run.cwd, '/proj/a');
  const idle = result.sessions.find((s) => s.sessionId === 'idle');
  assert.equal('lastTurnError' in idle, false, '没有值就不出键，别写 undefined 占位');
  // JSON 往返必须一致 —— 这就是宿主判「合法 JSON」那一步。
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('读某条会话正文：limit 夹到 200，只取有 role 的消息', async () => {
  const host = makeHost({
    sessions: [{ sessionId: 's1', cwd: '/p/a' }],
    outcomes: {
      history: () => ({
        rpcId: 'mobile', method: 'x', payload: {}, result: { ok: true, value: { events: [], hasMore: false } },
      }),
    },
  });
  const tools = mountWithHost(host);
  const result = await tools.get('supervisor_read_session').execute({ sessionId: 's1', limit: 9999 }, { agent: { id: 'sup' } });
  assert.equal(result.sessionId, 's1');
  assert.deepEqual(result.messages, []);
  assert.equal(host.log.history[0].payload.maxMessages, 200, 'limit 超上限要夹到 200');
});

test('发消息：空正文拒', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_send_message').execute({ sessionId: 's1', text: '   ' }, { agent: { id: 'sup' } }),
    /消息内容不能为空/,
  );
});

test('发消息：目标不存在就如实说，不去打宿主 prompt', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_send_message').execute({ sessionId: 'ghost', text: 'hi' }, { agent: { id: 'sup' } }),
    /找不到会话 ghost/,
  );
  assert.equal(host.log.prompt.length, 0);
});

test('新建会话：cwd 必须是已登记工作区里的绝对路径', async () => {
  const host = makeHost({ workspace: { items: [{ path: '/proj/a' }], archivedSessionIds: [], pinnedSessionIds: [] } });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_create_session').execute({ cwd: 'relative/path' }, { agent: { id: 'sup' } }),
    /必须是绝对路径/,
  );
  await assert.rejects(
    () => tools.get('supervisor_create_session').execute({ cwd: '/etc' }, { agent: { id: 'sup' } }),
    /不在能建会话的范围里/,
  );
});

test('新建会话：workspaceId 与 cwd 只能给一个', async () => {
  const host = makeHost({ workspace: { items: [{ path: '/proj/a' }], archivedSessionIds: [], pinnedSessionIds: [] } });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_create_session').execute({ workspaceId: 'w1', cwd: '/proj/a' }, { agent: { id: 'sup' } }),
    /只能给一个/,
  );
});

test('新建会话：成功时把 agentPreset 传给宿主并回 sessionId', async () => {
  const host = makeHost({ workspace: { items: [{ path: '/proj/a' }], archivedSessionIds: [], pinnedSessionIds: [] } });
  const tools = mountWithHost(host);
  const result = await tools.get('supervisor_create_session').execute(
    { cwd: '/proj/a/sub', agentPreset: 'manager' },
    { agent: { id: 'sup' } },
  );
  assert.equal(result.sessionId, 'new-1');
  assert.equal(result.agentPreset, 'manager');
  assert.deepEqual(host.log.create[0].payload, { cwd: '/proj/a/sub', agentPreset: 'manager' });
});

test('中断：目标不存在拒，存在就发 cancel', async () => {
  const host = makeHost({ sessions: [{ sessionId: 's1', cwd: '/p/a' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_interrupt_session').execute({ sessionId: 'ghost' }, { agent: { id: 'sup' } }),
    /找不到会话 ghost/,
  );
  const result = await tools.get('supervisor_interrupt_session').execute({ sessionId: 's1' }, { agent: { id: 'sup' } });
  assert.deepEqual(result, { sessionId: 's1', interrupted: true });
  assert.equal(host.log.cancel[0].payload.sessionId, 's1');
});

test('子代理不归总管直接使唤', async () => {
  const host = makeHost({ sessions: [{ sessionId: 'child', cwd: '/p/a', origin: 'subagent' }] });
  const tools = mountWithHost(host);
  await assert.rejects(
    () => tools.get('supervisor_interrupt_session').execute({ sessionId: 'child' }, { agent: { id: 'sup' } }),
    /子代理/,
  );
});

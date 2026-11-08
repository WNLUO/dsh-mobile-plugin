'use strict';

/**
 * 通话总管的运行期守卫：有活 / 没活的判断，以及每次开口把那几行账递进上下文。
 *
 * 这条功能的坏法都很安静：判据把「上一轮跑完」当成有活（每聊一句就翻一次旧事）、把注入
 * 挂到所有会话上（普通对话里凭空多出一段别人的任务账）、来源写成 `user`（手机上冒充成
 * 用户自己说的话）、或者把账注入到一条 `reject` 的 decision 上（用户这一轮直接没了）。
 * 所以这里两头都钉：判据真值表，和钩子用假 payload 真跑一遍。
 *
 * 运行：node --test test/supervisor-runtime.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-supervisor-runtime-'));

const runtime = require('../lib/mobile/supervisor-runtime/index.js');
const ledger = require('../lib/mobile/task-ledger.js');

/** 每条用例从空账开始，互不串味。 */
test.beforeEach(() => {
  ledger.resetForTest();
});

/**
 * 造一个宿主形状的 agent：钩子只读 `session.header`。
 *
 * 每造一个换一个新 id：注入记账（`injectedTurns`）按「会话 + 轮次」记，用例之间共用同一个 id
 * 会让后一条用例被前一条的账挡住，断言就空过了。
 */
let sessionSeq = 0;
function fakeAgent({ id = null, preset = 'supervisor', origin = null } = {}) {
  sessionSeq += 1;
  return { session: { header: { id: id || `session-supervisor-${sessionSeq}`, agentPreset: preset, origin } } };
}

/** 挂一把钩子并把它取出来。 */
function hookOf({ deps } = {}) {
  const handlers = [];
  const ctx = {
    on(event, fn) {
      if (event === 'agent/pre-step') handlers.push(fn);
      return () => {};
    },
  };
  const dispose = runtime.mountSupervisorRuntime(ctx, { deps });
  assert.equal(typeof dispose, 'function', 'mount 必须回清理函数');
  assert.equal(handlers.length, 1, '没挂上 agent/pre-step');
  return handlers[0];
}

/** 假读数：账上有几笔、某几条会话在跑 / 在等人。 */
function fakeDeps({ tasks = [], sessions = [] } = {}) {
  return {
    openItems: () => tasks,
    monitor: async () => ({ items: sessions }),
  };
}

// ── 一、判据真值表 ─────────────────────────────────────────────────────────

test('判据：两本账都空就是没活', () => {
  assert.equal(runtime.workDecision({ tasks: [], sessions: [] }).busy, false);
});

test('判据：输入缺席 / 形状不对一律当没活', () => {
  assert.equal(runtime.workDecision().busy, false);
  assert.equal(runtime.workDecision(null).busy, false);
  assert.equal(runtime.workDecision({ tasks: 'nope', sessions: 5 }).busy, false);
});

test('判据：账上挂着事就是有活', () => {
  const verdict = runtime.workDecision({ tasks: [{ status: 'open' }], sessions: [] });
  assert.equal(verdict.busy, true);
  assert.equal(verdict.tasks.length, 1);
});

test('判据：只有做完的事不算有活（上一轮跑完不是活）', () => {
  assert.equal(runtime.workDecision({ tasks: [{ status: 'done' }], sessions: [] }).busy, false);
});

test('判据：在等人答的那几条单独数一格', () => {
  const verdict = runtime.workDecision({
    tasks: [{ status: 'waiting' }, { status: 'open' }],
    sessions: [],
  });
  assert.equal(verdict.busy, true);
  assert.equal(verdict.waiting, 1);
});

test('判据：某条对话正在跑就是有活', () => {
  assert.equal(runtime.workDecision({ tasks: [], sessions: [{ running: true }] }).busy, true);
});

test('判据：某条对话停下来等人答也是活', () => {
  assert.equal(runtime.workDecision({ tasks: [], sessions: [{ pendingInteraction: 'question' }] }).busy, true);
});

test('判据：上一轮已完成 / 报错的会话不算活', () => {
  assert.equal(
    runtime.workDecision({
      tasks: [],
      sessions: [{ running: false, completed: true }, { running: false, lastTurnError: { code: 'x' } }],
    }).busy,
    false,
  );
});

test('判据：读账抛异常时按没活处理，不往外抛', async () => {
  const verdict = await runtime.judgeWork({}, {
    openItems: () => { throw new Error('盘坏了'); },
    monitor: async () => { throw new Error('宿主挂了'); },
  });
  assert.equal(verdict.busy, false);
});

test('判据：账本与监控各读一次，并发发出去', async () => {
  let tasks = 0;
  let sessions = 0;
  await runtime.judgeWork({}, {
    openItems: () => { tasks += 1; return [{ status: 'open' }]; },
    monitor: async () => { sessions += 1; return { items: [] }; },
  });
  assert.equal(tasks, 1);
  assert.equal(sessions, 1);
});

// ── 二、只认总管那条会话 ───────────────────────────────────────────────────

test('会话判据：预设是总管才算', () => {
  const agent = fakeAgent({ id: 'session-supervisor' });
  assert.equal(runtime.supervisorSessionOf(agent), 'session-supervisor');
});

test('会话判据：普通对话不认', () => {
  assert.equal(runtime.supervisorSessionOf(fakeAgent({ preset: 'standard' })), '');
  assert.equal(runtime.supervisorSessionOf(fakeAgent({ preset: null })), '');
});

test('会话判据：子代理一律跳过（哪怕是总管档）', () => {
  assert.equal(runtime.supervisorSessionOf(fakeAgent({ origin: 'subagent' })), '');
});

test('会话判据：拿不到 id 就整条不认，绝不默默用空串', () => {
  assert.equal(runtime.supervisorSessionOf({ session: { header: { agentPreset: 'supervisor' } } }), '');
  assert.equal(runtime.supervisorSessionOf(null), '');
  assert.equal(runtime.supervisorSessionOf({}), '');
});

test('钩子：普通会话有活也不注入', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏' }] }) });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler(
    { agent: fakeAgent({ preset: 'standard' }), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1, '普通会话不该被塞别人的任务账');
});

test('钩子：子代理会话注入不入', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏' }] }) });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler(
    { agent: fakeAgent({ origin: 'subagent' }), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1, '子代理的上下文更紧，不该再塞账');
});

// ── 三、有活才注入，来源不是 user ──────────────────────────────────────────

test('钩子：有活时追加一条，不是 user 来源', async () => {
  // 账走真账本：那几行账本来就由 `callMemory` 从盘上念出来，假账本只会把两处读数拆开。
  ledger.upsertTask({ title: '修侧栏绿点', step: '在改缓存' });
  const handler = hookOf();
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }];
  const decision = await handler(
    { agent: fakeAgent(), turn: 3 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 2, '这一轮应该多一段任务账');
  const hint = decision.messages[1];
  assert.notEqual(hint.source.kind, 'user', '来源不能是 user，否则手机上会冒充成用户气泡');
  assert.equal(hint.source.kind, runtime.SUPERVISOR_SOURCE_KIND);
  assert.equal(hint.role, 'user', '宿主契约里这一条替换的必须是 user 消息');
  const text = String(hint.content?.[0]?.text ?? '');
  assert.ok(text.includes('不是用户说的话'), '要说明这段话不是用户说的');
  assert.ok(text.includes('修侧栏绿点'), '要把账上的那一行念出来');
});

test('钩子：空账一个字都不加（闲聊不翻旧账）', async () => {
  const handler = hookOf({ deps: fakeDeps() });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler(
    { agent: fakeAgent(), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1);
});

test('钩子：只有做完的事也不注入', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'done', title: '早就完了' }] }) });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler(
    { agent: fakeAgent(), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1);
});

test('钩子：同一轮只注入一次，换轮才再注入', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏绿点' }] }) });
  const agent = fakeAgent({ id: 'session-once' });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const run = (turn) => handler({ agent, turn }, async () => ({ kind: 'enter', messages }));

  assert.equal((await run(1)).messages.length, 2, '这一轮的第一处该注入');
  assert.equal((await run(1)).messages.length, 1, '同一轮后面的步数不该再塞一遍');
  assert.equal((await run(2)).messages.length, 2, '换了一轮要重新带上账');
});

// ── 四、拒收档与失败 ───────────────────────────────────────────────────────

test('钩子：reject 档没有 messages 时原样放行，不误删用户这一轮', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏绿点' }] }) });
  const decision = await handler(
    { agent: fakeAgent(), turn: 1 },
    async () => ({ kind: 'reject', reason: 'busy' }),
  );
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(Object.keys(decision).sort(), ['kind', 'reason'], '拒收档不该被塞进 messages');
});

test('钩子：messages 不是数组时原样放行（不能拿别的形状去拼上下文）', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏绿点' }] }) });
  const decision = await handler(
    { agent: fakeAgent(), turn: 1 },
    async () => ({ kind: 'enter', messages: 'not-an-array' }),
  );
  assert.equal(decision.messages, 'not-an-array', '判据要用 Array.isArray(decision.messages)');
});

test('钩子：next() 抛出去的原样往上抛（用户那一轮的发不出去是它自己的事）', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: '修侧栏绿点' }] }) });
  await assert.rejects(
    () => handler({ agent: fakeAgent(), turn: 1 }, async () => { throw new Error('宿主拒了'); }),
    /宿主拒了/,
  );
});

test('钩子：读账抛异常时原样放行，不让这一轮发不出去', async () => {
  const handler = hookOf({
    deps: {
      openItems: () => { throw new Error('盘坏了'); },
      monitor: async () => { throw new Error('宿主挂了'); },
    },
  });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler(
    { agent: fakeAgent(), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 1);
});

test('钩子：decision 是 undefined 时原样返回', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: 'x' }] }) });
  const decision = await handler({ agent: fakeAgent(), turn: 1 }, async () => undefined);
  assert.equal(decision, undefined);
});

test('钩子：payload 里没有 agent 时原样放行', async () => {
  const handler = hookOf({ deps: fakeDeps({ tasks: [{ status: 'open', title: 'x' }] }) });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handler({ turn: 1 }, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 1);
});

// ── 五、正文口径 ───────────────────────────────────────────────────────────

test('正文：没活就是空串，一个字的账都不留', () => {
  assert.equal(runtime.supervisorNoticeText({ verdict: runtime.workDecision({ tasks: [], sessions: [] }), memory: '' }), '');
});

test('正文：有活时先报活、带上在跑与等人的条数', () => {
  const verdict = runtime.workDecision({
    tasks: [{ status: 'open', title: '修侧栏绿点' }, { status: 'waiting', title: '等你签个名' }],
    sessions: [{ running: true, title: '跑测试' }, { pendingInteraction: 'question', title: '问路' }],
  });
  const text = runtime.supervisorNoticeText({ verdict, memory: '' });
  assert.ok(text.includes('挂着 2 件事'), '要先交代手上几件');
  assert.ok(text.includes('1 件在等人答'), '等人答那格要单独说');
  assert.ok(text.includes('1 条对话正在跑'));
  assert.ok(text.includes('1 条在等人答'));
  assert.ok(text.includes('不是用户说的话'));
  assert.ok(text.includes('不要提这段账本身'), '别让模型把提醒念出来');
});

test('正文：连知识库来的回忆一起带上', () => {
  const verdict = runtime.workDecision({ tasks: [{ status: 'open', title: '修侧栏绿点' }], sessions: [] });
  const text = runtime.supervisorNoticeText({ verdict, memory: '【任务账】\n手上有 1 件事' });
  assert.ok(text.includes('【任务账】'));
});

test('正文：超长截断，别把一整本账塞进上下文', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ status: 'open', title: `第 ${index} 件很长的任务` }));
  const verdict = runtime.workDecision({ tasks: many, sessions: [] });
  const text = runtime.supervisorNoticeText({ verdict, memory: '' });
  assert.ok(text.length <= runtime.NOTICE_MAX_CHARS, `正文 ${text.length} 超过上限`);
});

test('线索：只认真用户消息，插件注入的提醒不当线索', () => {
  const messages = [
    { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '旧的一句' }] },
    { id: 'b', role: 'user', source: { kind: 'mobile-narration' }, content: [{ type: 'text', text: '进度提醒' }] },
  ];
  assert.equal(runtime.lastUserText(messages), '旧的一句');
});

test('线索：裸字符串与内容块两种正文形状都收', () => {
  assert.equal(runtime.lastUserText([{ role: 'user', content: '裸字符串' }]), '裸字符串');
  assert.equal(runtime.lastUserText([{ role: 'user', content: [{ type: 'tool_use' }] }]), '');
  assert.equal(runtime.lastUserText([]), '');
  assert.equal(runtime.lastUserText(undefined), '');
});

// ── 六、挂载与真账本 ───────────────────────────────────────────────────────

test('挂载：没有 on 的 ctx 回一个空清理函数，不抛', () => {
  const dispose = runtime.mountSupervisorRuntime({});
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('挂载：宿主不认这个事件时也不抛', () => {
  const dispose = runtime.mountSupervisorRuntime({ on() { throw new Error('no such event'); } });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('挂载：清理函数把钩子摘掉', () => {
  let removed = 0;
  const ctx = { on: () => () => { removed += 1; } };
  runtime.mountSupervisorRuntime(ctx)();
  assert.equal(removed, 1);
});

test('真账本：记一笔之后判据就报有活，做完之后又回到没活', async () => {
  ledger.upsertTask({ title: '修侧栏绿点', step: '在改缓存' });
  let verdict = await runtime.judgeWork({}, { monitor: async () => ({ items: [] }) });
  assert.equal(verdict.busy, true);
  assert.equal(verdict.tasks[0].title, '修侧栏绿点');

  const item = verdict.tasks[0];
  ledger.upsertTask({ id: item.id, status: 'done' });
  verdict = await runtime.judgeWork({}, { monitor: async () => ({ items: [] }) });
  assert.equal(verdict.busy, false, '做完的事不算活');
});

test('真账本：钩子在不注入 deps 时也读得动盘上的账', async () => {
  ledger.upsertTask({ title: '打电话前记的一件事' });
  const handlers = [];
  const ctx = {
    on(event, fn) { handlers.push(fn); return () => {}; },
    // monitor 那条走宿主；这里给一个读不到的形状，判据按「这一格没有」算，账照样生效。
    apiProxy: undefined,
  };
  runtime.mountSupervisorRuntime(ctx);
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' } }];
  const decision = await handlers[0](
    { agent: fakeAgent({ id: 'session-real-ledger' }), turn: 1 },
    async () => ({ kind: 'enter', messages }),
  );
  assert.equal(decision.messages.length, 2, '账上有事就该注入');
  assert.ok(String(decision.messages[1].content[0].text).includes('打电话前记的一件事'));
});

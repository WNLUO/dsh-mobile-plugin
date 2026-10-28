'use strict';

// 过程清单与「按需取详情」两侧的形状守卫：
//
//  1. 投影层：每一轮挂一份 `turnProcess.steps` —— 只有摘要、状态与位置，正文一个字节都不带；
//  2. 详情端点：思考回全文、工具回参数 / 输出 / diff，坏参数 400、找不到 404；
//  3. 跑着的那一轮：宿主历史里还没有这一份，由直播内存副本答（`live-steps`）。
//
// 这三条一起钉住的正是「省流量还能看见过程」的取舍：清单在线路上，正文点开才取。

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMessages, thinEntryMessages } = require('../lib/mobile/history-derive.js');
const { handleSessionStep } = require('../lib/mobile/session-step.js');
const { noteLiveEvent, liveStepOf } = require('../lib/mobile/live-steps.js');

function ev(type, data, seq) {
  return { type, seq, time: 1000 + seq, data };
}
const user = (seq, text) => ev('user/message', { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq);
const assistant = (seq, turn, step, content) => ev('assistant/message', { turn, step, message: { id: `a${seq}`, role: 'assistant', content } }, seq);
const result = (seq, turn, step, callId, text, extra) => ev('tool/result', {
  turn,
  step,
  message: { source: { callId }, content: [{ type: 'text', text }] },
  ...(extra || {}),
}, seq);

const THINK_TEXT = '先读一下这个文件\n第二行内容不该进清单';

function conversation() {
  return [
    user(1, '看看这个文件'),
    assistant(2, 1, 1, [
      { type: 'reasoning', text: THINK_TEXT },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"/tmp/a.md"}' },
    ]),
    result(3, 1, 1, 'call_1', '文件正文'),
    assistant(4, 1, 2, [
      { type: 'tool-call', id: 'call_2', name: 'edit', arguments: '{"file_path":"/tmp/a.md","old_string":"x"}' },
    ]),
    result(5, 1, 2, 'call_2', 'ok', { meta: { diffs: [{ path: '/tmp/a.md', oldText: 'x', newText: 'y' }] } }),
    assistant(6, 1, 3, [{ type: 'text', text: '改好了' }]),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
  ];
}

const openerOf = (items) => items.find((item) => item.role === 'user');

test('投影：清单挂在开启这一轮的那条消息上，一步一行摘要', () => {
  const items = deriveMessages(conversation());
  const opener = openerOf(items);
  assert.ok(opener && opener.turnProcess, '开场消息上要有 turnProcess');
  const steps = opener.turnProcess.steps;
  assert.equal(steps.length, 3, '思考 + 两次工具调用');
  assert.deepEqual(steps.map((step) => step.kind), ['think', 'tool', 'tool']);
  assert.equal(steps[0].summary, '先读一下这个文件', '思考摘要取首行');
  assert.equal(steps[1].summary, '/tmp/a.md', '读文件的摘要给路径');
  assert.equal(steps[1].state, 'ok');
  assert.equal(steps[1].callId, 'call_1');
  assert.equal(steps[1].seq, 2);
  assert.equal(steps[1].resultSeq, 3);
  assert.equal(steps[2].summary, '/tmp/a.md', '改文件的摘要也给路径');
});

test('投影：清单里不带正文（推理全文、参数、输出、diff 一个都不许混进去）', () => {
  const opener = openerOf(deriveMessages(conversation()));
  const serialized = JSON.stringify(opener.turnProcess);
  assert.equal(serialized.includes('第二行内容不该进清单'), false, '推理正文不进清单');
  assert.equal(serialized.includes('文件正文'), false, '工具输出不进清单');
  assert.equal(serialized.includes('old_string'), false, '工具参数不进清单');
  assert.equal(serialized.includes('diffs'), false, 'diff 不进清单');
});

test('投影：入口窗口（thin）也带着清单，摘要不被裁掉', () => {
  const thin = thinEntryMessages(deriveMessages(conversation()), { hasMore: false });
  const opener = openerOf(thin);
  assert.ok(opener && opener.turnProcess && Array.isArray(opener.turnProcess.steps));
  assert.equal(opener.turnProcess.steps.length, 3);
  assert.equal(opener.turnProcess.count, 3);
});

// ── 详情端点 ────────────────────────────────────────────────────────────────

/** 一个只认 history 的假宿主：按 beforeSeq 回最近一窗事件。 */
function fakeCtx(events) {
  return {
    apiProxy: {
      sessions: {
        history: async (request) => {
          const { beforeSeq, maxMessages } = request.payload;
          const list = beforeSeq == null ? events : events.filter((event) => event.seq < beforeSeq);
          const page = list.slice(-Math.min(maxMessages || 50, 200)).map((event) => ({ type: 'event', event }));
          return { result: { ok: true, value: { events: page, hasMore: false } } };
        },
      },
    },
  };
}

function call(ctx, query) {
  return new Promise((resolve) => {
    const res = {
      req: { headers: {} },
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    handleSessionStep(ctx, { url: `/api/mobile/v1/session/step?${new URLSearchParams(query)}` }, res);
  });
}

test('详情：思考回全文，清单里只有首行', async () => {
  const parsed = await call(fakeCtx(conversation()), { sessionId: 's1', kind: 'think', seq: '2', index: '0' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.step.kind, 'think');
  assert.equal(parsed.body.step.text, THINK_TEXT);
});

test('详情：工具回参数与输出', async () => {
  const parsed = await call(fakeCtx(conversation()), { sessionId: 's1', kind: 'tool', callId: 'call_1', seq: '2', resultSeq: '3' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.step.name, 'read');
  assert.equal(parsed.body.step.state, 'ok');
  assert.equal(parsed.body.step.argsRaw, '{"file_path":"/tmp/a.md"}');
  assert.equal(parsed.body.step.output, '文件正文');
});

test('详情：写文件类工具把 diff 带回来（清单里没有这一份）', async () => {
  const parsed = await call(fakeCtx(conversation()), { sessionId: 's1', kind: 'tool', callId: 'call_2', seq: '4', resultSeq: '5' });
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.body.step.diffs, [{ path: '/tmp/a.md', oldText: 'x', newText: 'y' }]);
});

test('详情：找不到那一步回 404 一句人话，缺参数回 400', async () => {
  const missing = await call(fakeCtx(conversation()), { sessionId: 's1', kind: 'tool', callId: 'nope', seq: '4' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'step-not-found');
  const bad = await call(fakeCtx(conversation()), { sessionId: 's1', kind: 'think' });
  assert.equal(bad.status, 400);
  const noSession = await call(fakeCtx(conversation()), { kind: 'think', seq: '2', index: '0' });
  assert.equal(noSession.status, 400);
});

// ── 跑着的那一轮：直播内存副本 ──────────────────────────────────────────────

test('直播副本：参数增量攒起来、结果补上输出与状态，按 callId 取得到', () => {
  const ctx = {};
  const session = 'live-1';
  noteLiveEvent(ctx, session, ev('turn/start', { turn: 1 }, 1));
  noteLiveEvent(ctx, session, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', id: 'call_live', name: 'bash', argumentsDelta: '{"command":"pnpm te' } }, 2));
  noteLiveEvent(ctx, session, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', argumentsDelta: 'st"}' } }, 3));
  const running = liveStepOf(ctx, session, { kind: 'tool', callId: 'call_live' });
  assert.equal(running.state, 'running');
  assert.equal(running.name, 'bash');
  assert.equal(running.argsRaw, '{"command":"pnpm test"}');
  assert.equal(running.live, true);
  noteLiveEvent(ctx, session, ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'call_live' }, content: [{ type: 'text', text: 'pass' }] } }, 4));
  const done = liveStepOf(ctx, session, { kind: 'tool', callId: 'call_live' });
  assert.equal(done.output, 'pass');
  assert.equal(done.state, 'ok');
});

test('直播副本：推理增量按块攒，正文点开才看得到', () => {
  const ctx = {};
  const session = 'live-2';
  noteLiveEvent(ctx, session, ev('turn/start', { turn: 1 }, 1));
  noteLiveEvent(ctx, session, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先看 ' } }, 2));
  noteLiveEvent(ctx, session, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '目录结构' } }, 3));
  const think = liveStepOf(ctx, session, { kind: 'think', index: 0 });
  assert.equal(think.text, '先看 目录结构');
  assert.equal(think.state, 'running');
  // 换一轮：上一轮的副本不能留着（否则点开旧的一步会拿到新内容）。
  noteLiveEvent(ctx, session, ev('turn/start', { turn: 2 }, 4));
  assert.equal(liveStepOf(ctx, session, { kind: 'think', index: 0 }), null);
});

test('详情端点优先用直播副本：宿主那一头一次都不用问', async () => {
  const ctx = fakeCtx(conversation());
  ctx.apiProxy.sessions.history = async () => { throw new Error('跑着的那一轮不该去问宿主'); };
  noteLiveEvent(ctx, 's-live', ev('turn/start', { turn: 1 }, 1));
  noteLiveEvent(ctx, 's-live', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', id: 'call_x', name: 'read', argumentsDelta: '{"file_path":"/tmp/b.md"}' } }, 2));
  const parsed = await call(ctx, { sessionId: 's-live', kind: 'tool', callId: 'call_x' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.step.argsRaw, '{"file_path":"/tmp/b.md"}');
  assert.equal(parsed.body.step.live, true);
});

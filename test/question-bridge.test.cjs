'use strict';

/**
 * 手机端提问桥的守卫（`lib/mobile/questions.js`）。
 *
 * 与审批桥同一组静默失效点，所以同样真跑一遍：
 *
 *   1. **卡片的形状**：App 的问题面板只认带**帧级 rpcId** 的 `question/requested`
 *      （`app/src/hooks/streamFrame.ts`，缺 rpcId 整帧丢弃），0.2.x 的宿主不再提供任何
 *      帧级 id，本桥铸的那个必须真进到帧里。
 *   2. **谁先答谁算数**：下游（桌面窗口）照旧拿到请求，手机答得早就用手机的；
 *      落定后另一边那张卡由 `question/resolved` 收掉。
 *   3. **注册姿势**：`prepend` 是功能前提（宿主的转发器在桌面开着时不调用 `next()`），
 *      且只许在 0.2.x 那一侧装。
 *
 * 「计划评审」不是另一条通道：`dsh-plan-mode` 也是走 `ctx.userQuestions.ask()`，
 * 问题带 `intent.kind='plan-review'` 与 `detail`（计划正文），所以这里一并钉住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const questions = require('../lib/mobile/questions.js');

/** 下游永远不给答案：模拟「桌面窗口开着、人还没点」。 */
const HOLD = () => new Promise(() => {});

function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    apiProxy: { respond: async () => ({ accepted: false }) },
    on(name, listener, options) {
      const list = listeners.get(name) || [];
      list.push({ listener, options });
      listeners.set(name, list);
      return () => {
        const index = list.findIndex((entry) => entry.listener === listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };
}

/** 按 cordis 的 waterfall 语义跑一遍 `user-questions/request`。 */
function runHook(ctx, request, downstream) {
  const chain = (ctx.listeners.get('user-questions/request') || []).map((entry) => entry.listener);
  const step = (index) => (index < chain.length
    ? chain[index](request, () => step(index + 1))
    : Promise.resolve(downstream()));
  return Promise.resolve(step(0));
}

function jsonRequest(body) {
  const req = new EventEmitter();
  req.url = '/api/mobile/v1/question/respond';
  req.method = 'POST';
  req.headers = {};
  setImmediate(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

function jsonResponse() {
  const res = { status: 0, body: null, headersSent: false, writableEnded: false };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.end = (chunk) => {
    res.writableEnded = true;
    res.body = chunk == null || chunk === '' ? null : JSON.parse(String(chunk));
  };
  res.on = () => res;
  res.once = () => res;
  return res;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  questions.resetForTest();
  const ctx = fakeCtx();
  questions.installQuestionBridge(ctx);
  const frames = [];
  const watch = (sessionId) => questions.attachSession(sessionId, (frame) => frames.push(frame));
  return { ctx, frames, watch };
}

const ask = (overrides = {}) => ({
  questions: [{
    id: 'q1',
    question: '用哪个端口？',
    options: [{ label: '8787' }, { label: '9000' }],
  }],
  agent: { session: { id: 's-1' } },
  ...overrides,
});

const planReview = () => ({
  questions: [{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# 计划\n\n1. 改插件',
    options: [{ label: '允许执行' }, { label: '继续规划' }],
    intent: { kind: 'plan-review', approve: '允许执行' },
  }],
  agent: { session: { id: 's-1' } },
});

// ── 注册姿势 ────────────────────────────────────────────────────────────────

test('钩子必须 prepend + global（否则桌面开着时永远轮不到手机）', () => {
  const { ctx } = setup();
  const [registration] = ctx.listeners.get('user-questions/request');
  assert.ok(registration, '没注册 user-questions/request 钩子');
  assert.equal(registration.options && registration.options.prepend, true, '少了 prepend：宿主的转发器会一直等桌面回答、不调用 next()');
  assert.equal(registration.options && registration.options.global, true, '少了 global：scoped 派出的事件收不到');
});

test('只在 0.2.x 那一侧装（与审批桥同判据，0.1.x 别多推一张卡）', () => {
  const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  assert.match(impl, /if \(!hasHostApiProxy\) ctx\.effect\(\(\) => installQuestionBridge\(ctx\)/);
});

// ── 卡片 ────────────────────────────────────────────────────────────────────

test('没人看这个会话时不推卡，但待处理账记着（列表页那颗黄点靠它）', () => {
  const { ctx, frames, watch } = setup();
  watch('s-2');
  void runHook(ctx, ask(), HOLD);
  assert.equal(questions.pendingKind('s-1'), 'question');
  assert.equal(questions.pendingKind('s-2'), undefined);
  assert.deepEqual(frames, [], '没有观众的会话不推卡');
});

test('手机接入时补发，卡里必须是帧级 rpcId 与完整问题', async () => {
  const { ctx, frames, watch } = setup();
  void runHook(ctx, ask(), HOLD);
  await flush();
  watch('s-1');
  const card = frames.find((frame) => frame.type === 'question/requested');
  assert.ok(card, '接入后必须补发那张卡，否则用户在列表页点进来是空的');
  assert.equal(card.sessionId, 's-1');
  assert.equal(typeof card.rpcId, 'string');
  assert.ok(card.rpcId.length > 0, '帧级 rpcId 不能缺');
  assert.deepEqual(card.questions, [{ id: 'q1', question: '用哪个端口？', options: [{ label: '8787' }, { label: '9000' }] }]);
});

test('计划评审走同一条桥：detail（计划正文）与两个选项都送到手机上', async () => {
  const { ctx, frames, watch } = setup();
  watch('s-1');
  void runHook(ctx, planReview(), HOLD);
  await flush();
  const card = frames.find((frame) => frame.type === 'question/requested');
  assert.ok(card);
  assert.equal(card.questions[0].detail, '# 计划\n\n1. 改插件');
  assert.equal(card.questions[0].header, 'Plan review');
  assert.equal(card.questions[0].options.length, 2);
  assert.equal(questions.pendingKind('s-1'), 'plan-review', '列表页该显示「计划评审」而不是「提问」');
});

// ── 回答 ────────────────────────────────────────────────────────────────────

test('手机答了：钩子拿到同一批回答，卡当场收掉，agent 才真的往下走', async () => {
  const { ctx, frames, watch } = setup();
  watch('s-1');
  const held = runHook(ctx, ask(), HOLD);
  await flush();
  const card = frames.find((frame) => frame.type === 'question/requested');
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['9000'] }] },
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.deepEqual(await held, { answers: [{ id: 'q1', selected: ['9000'] }] }, '回答必须交回宿主那个钩子，否则 agent 一直等');
  const resolved = frames.find((frame) => frame.type === 'question/resolved');
  assert.ok(resolved, '手机自己答完也要收卡');
  assert.equal(resolved.questionRpcId, card.rpcId, 'App 按 questionRpcId 清面板');
});

test('回答批次必须每题恰好一条（缺一题就 400，别把半个回答交给模型）', async () => {
  const { ctx, frames, watch } = setup();
  watch('s-1');
  void runHook(ctx, ask({
    questions: [{ id: 'q1', question: 'a' }, { id: 'q2', question: 'b' }],
  }), HOLD);
  await flush();
  const card = frames.find((frame) => frame.type === 'question/requested');
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), res);
  assert.equal(res.status, 400);
  assert.equal(questions.pendingKind('s-1'), 'question', '400 之后问题还得挂着');
});

test('下游先答：用下游的答案，手机后来再提交如实 409', async () => {
  const { ctx, frames, watch } = setup();
  watch('s-1');
  const answer = { answers: [{ id: 'q1', selected: ['8787'] }] };
  const held = runHook(ctx, ask(), () => Promise.resolve(answer));
  await flush();
  const card = frames.find((frame) => frame.type === 'question/requested');
  assert.deepEqual(await held, answer);
  assert.equal(questions.pendingKind('s-1'), undefined);
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['9000'] }] },
  }), res);
  assert.equal(res.status, 409);
});

test('请求被取消：卡收掉，钩子按 abort 抛出（别假装成空回答）', async () => {
  const { ctx, frames, watch } = setup();
  watch('s-1');
  const ac = new AbortController();
  const held = runHook(ctx, ask({ signal: ac.signal }), HOLD);
  await flush();
  ac.abort(new Error('turn cancelled'));
  await assert.rejects(held, /turn cancelled/);
  const resolved = frames.find((frame) => frame.type === 'question/resolved');
  assert.ok(resolved, '取消也要收卡，否则留一张点不动的卡');
});

test('未知 rpcId 走 0.1.x 的 apiProxy 兜底；两条都不认就 409', async () => {
  const ctx = fakeCtx();
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: 'r-unknown',
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), res);
  assert.equal(res.status, 409);

  const accepting = fakeCtx();
  accepting.apiProxy = { respond: async () => ({ accepted: true }) };
  const ok = jsonResponse();
  await questions.handleQuestionRespond(accepting, jsonRequest({
    rpcId: 'r-old',
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), ok);
  assert.equal(ok.status, 200, '0.1.x 的帧级 rpcId 必须还能走真 apiProxy');
});

test('提问卡在软水位上不许被丢（与审批卡同一豁免）', () => {
  const stream = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'stream.js'), 'utf8');
  assert.match(stream, /type === 'question\/requested'/, '提问卡没有 seq，按默认口径会在 4MB 软水位上被 shed');
  assert.match(stream, /type === 'question\/resolved'/);
  assert.match(stream, /const detachQuestions = questions\.attachSession/, '会话流必须把手机的 sink 接给提问桥');
});

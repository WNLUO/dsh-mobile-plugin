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

/**
 * 网关假体：宿主把提问转发给桌面窗口时，按「请求对象」在 `pendingRemoteEvents` 里登记一发；
 * 撤回就是把它从表里摘掉并给窗口推 cancel 帧（真实现见 `@deepseek-ai/dsh-api-gateway`）。
 */
function fakeGateway() {
  const cancelled = [];
  const gateway = {
    pendingRemoteEvents: new Map(),
    cancelRemoteEvent(item, reason) {
      cancelled.push({ item, reason });
      for (const [id, value] of this.pendingRemoteEvents) {
        if (value === item) this.pendingRemoteEvents.delete(id);
      }
    },
  };
  return { gateway, cancelled };
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
    // 宿主的真实 intent 还带一个内部句柄 callId；它绝不能被转到手机上。
    intent: { kind: 'plan-review', approve: '允许执行', callId: 'call-9f3c' },
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
  assert.match(impl, /if \(!hasHostApiProxy\) mount\('提问桥', \(\) => ctx\.effect\(\(\) => installQuestionBridge\(ctx\)/);
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
  assert.equal('intent' in card.questions[0], false, '普通提问不该凭空多一个空 intent');
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
  assert.equal(card.questions[0].intent.kind, 'plan-review', '手机靠它把卡渲染成「计划待审」');
  assert.equal(card.questions[0].intent.approve, '允许执行', '批准按钮用宿主给的标签');
  assert.deepEqual(Object.keys(card.questions[0].intent).sort(), ['approve', 'kind'], 'intent 只带这两格');
  assert.equal(JSON.stringify(card).includes('call-9f3c'), false, 'callId 是宿主内部句柄，绝不能进帧');
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

test('下游先答：用下游的答案，挂起项落定（此场景手机本就没在看）', async () => {
  // 竞速只发生在「没有观众」时：那时手机没有卡、也答不了，下游（桌面）是唯一答案方。
  const { ctx, frames, watch } = setup();
  const answer = { answers: [{ id: 'q1', selected: ['8787'] }] };
  const held = runHook(ctx, ask(), () => Promise.resolve(answer));
  await flush();
  assert.deepEqual(await held, answer);
  assert.equal(questions.pendingKind('s-1'), undefined);
  assert.deepEqual(frames, [], '全程没有观众，一张卡都不该推');
  watch();
});

test('手机在看这个会话也照转：桌面照常出卡，手机先答就用手机的', async () => {
  // 桌面那张卡只由「被转发的请求」长出来 —— 少转这一下，手机看着会话时桌面从源头就没有卡，
  // 之后切回去也补不回来（2026-10-24 用户报「APP 有卡、桌面什么都没有」）。
  const { ctx, frames, watch } = setup();
  watch('s-1');
  let forwarded = false;
  const held = runHook(ctx, ask(), () => { forwarded = true; return HOLD(); });
  await flush();
  assert.equal(forwarded, true, '有观众也要照转，否则桌面那张卡根本没有');
  const card = frames.find((frame) => frame.type === 'question/requested');
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['9000'] }] },
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(await held, { answers: [{ id: 'q1', selected: ['9000'] }] }, '手机先答就用手机的');
  assert.equal(questions.pendingKind('s-1'), undefined);
  watch();
});

test('手机答完之后把桌面那一发转发撤掉（桌面那张卡跟着消失）', async () => {
  // 桌面那张卡挂在「宿主转发给桌面窗口的那一发」上，只有桌面自己答 / 本轮取消 / 宿主撤回
  // 三种情况会消失。宿主只为「限时提问」做了落定后的收尾，阻塞式提问没人收 —— 手机先答
  // 之后桌面那张卡就一直悬着。这里按请求对象找回网关里挂着的那一发，主动撤掉。
  const { ctx, frames, watch } = setup();
  watch('s-1');
  const { gateway, cancelled } = fakeGateway();
  ctx.get = (name) => (name === 'typertGateway' ? gateway : undefined);
  const request = ask();
  const forwarded = { source: { request }, frame: { event: 'user-questions/request' } };
  const unrelated = { source: { request: ask() }, frame: { event: 'user-questions/request' } };
  gateway.pendingRemoteEvents.set('fwd', forwarded);
  gateway.pendingRemoteEvents.set('other', unrelated);
  const held = runHook(ctx, request, HOLD);
  await flush();
  const card = frames.find((frame) => frame.type === 'question/requested');
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['9000'] }] },
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(cancelled.map((entry) => entry.item), [forwarded], '只撤这一问那一发，别的挂起项不许动');
  assert.ok(cancelled[0].reason instanceof Error, '撤回要带一个原因（窗口按 abort 处理）');
  assert.equal(gateway.pendingRemoteEvents.has('fwd'), false, '撤掉的那发必须离开网关的挂起表');
  assert.equal(gateway.pendingRemoteEvents.has('other'), true);
  assert.deepEqual(await held, { answers: [{ id: 'q1', selected: ['9000'] }] }, '撤卡不影响回答交回宿主');
  watch();
});

test('桌面先答时不碰网关：那一发本来就没了，撤无可撤', async () => {
  const { ctx, watch } = setup();
  const { gateway, cancelled } = fakeGateway();
  ctx.get = (name) => (name === 'typertGateway' ? gateway : undefined);
  const answer = { answers: [{ id: 'q1', selected: ['8787'] }] };
  const held = runHook(ctx, ask(), () => Promise.resolve(answer));
  await flush();
  assert.deepEqual(await held, answer);
  assert.deepEqual(cancelled, []);
  watch();
});

test('桌面没开着（NO_PROVIDER）且手机在看：不把「没人答」当结论，继续等手机', async () => {
  // 桌面没开时宿主那趟转发直接以 NO_PROVIDER 失败，而手机那张卡还在等人点 ——
  // 这一下要是当成结论交回去，刚推出去的那张卡就成了死卡。
  const { ctx, frames, watch } = setup();
  watch('s-1');
  const noProvider = Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' });
  const held = runHook(ctx, ask(), () => Promise.reject(noProvider));
  await flush();
  assert.equal(questions.pendingKind('s-1'), 'question', '手机还看着，问题必须继续挂着');
  const card = frames.find((frame) => frame.type === 'question/requested');
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['8787'] }] },
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(await held, { answers: [{ id: 'q1', selected: ['8787'] }] });
  watch();
});

test('手机没在看这个会话时照旧转发：纯桌面的竞速一字不改', async () => {
  const { ctx, watch } = setup();
  watch('s-2'); // 观众在别的会话上，s-1 没人看
  let forwarded = false;
  const answer = { answers: [{ id: 'q1', selected: ['8787'] }] };
  const held = runHook(ctx, ask(), () => { forwarded = true; return Promise.resolve(answer); });
  await flush();
  assert.equal(forwarded, true, '没有观众还掐掉转发，纯桌面使用会直接报「没有人能回答」');
  assert.deepEqual(await held, answer);
  watch();
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

// ── 旧通道那一段的真实形态 ────────────────────────────────────────────────────

test('0.2.x 兼容桥的 respond 是同步对象，不是 Promise：不认识 rpcId 必须如实 409 而不是 500', async () => {
  // 真的兼容桥（mobile/host-bridge.js）返回的是同步的 {result:{ok:false,...}}，
  // 而上面 fakeCtx 里那个 `async` 假体回的是 Promise —— 正因如此，早先直接
  // `.catch()` 的写法在测试里永远绿、在真机上抛 TypeError 被兜成 500。
  // 这里改用真兼容桥的返回形态（同步对象），把那处形态差钉死。
  const ctx = fakeCtx();
  ctx.apiProxy = { respond: () => ({ result: { ok: false, error: { code: 'host-unsupported', message: 'unsupported' } } }) };
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: 'm-unknown',
    sessionId: 's-1',
    answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), res);
  assert.equal(res.status, 409, '通道说不认时只能是 409：500 会让手机看不到「已完成」这句人话');
  assert.equal(res.body.error.code, 'not-pending');
});

test('同步对象抛出也要落在 409，不许把异常抛给路由守卫', async () => {
  const ctx = fakeCtx();
  ctx.apiProxy = { respond: () => { throw new Error('boom'); } };
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: 'm-unknown-2', sessionId: 's-1', answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), res);
  assert.equal(res.status, 409);
});

test('挂起项没了（插件重载 / 宿主重启）时：如实 409 + 一句人话，卡留在原地好把原因写出来', async () => {
  const { ctx, frames } = setup();
  const watch = questions.attachSession('s-1', (frame) => frames.push(frame));
  // 桥里没有这条 rpcId（模拟重载后进程内状态已清空），旧通道也不认。
  const res = jsonResponse();
  await questions.handleQuestionRespond(ctx, jsonRequest({
    rpcId: 'm-from-before-reload', sessionId: 's-1', answer: { answers: [{ id: 'q1', selected: ['x'] }] },
  }), res);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /失效/, '要告诉用户这条提问已经作废，而不能只说「不可回答」');
  // 卡**不能**被收掉：App 靠这张卡把上面那句话显示出来（UserQuestionDock 的 error 行），
  // 一收卡就跟着卸载，用户又变成「点了没反应」。
  assert.equal(frames.filter((frame) => frame.type === 'question/resolved').length, 0, '失败时不许收卡，否则失败原因没地方显示');
  watch();
});

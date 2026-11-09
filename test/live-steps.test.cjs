'use strict';

// 跑着那一轮的过程清单：直播事件 → 一行一步（`session/live-steps` 的来源）。
//
// 这里钉的是「一步什么时候算开、摘要什么时候补、状态怎么收」，以及最要紧的一条：
// **思考也算一步，从第一段推理就开始算**（从前要等工具跑起来才有东西可看）。
//
// 位置口径也在这里定死：思考的 `index` 是**这一轮里的第几段**（不是内容块序号 —— 块序号
// 每步从 0 重数，两步都用 0 的话 App 的 key 与详情缓存会撞在一起）。工具仍用 `callId`。

const test = require('node:test');
const assert = require('node:assert/strict');

const { noteLiveEvent, liveStepsOf, drainLiveSteps, liveStepOf, clearLiveSteps } = require('../lib/mobile/live-steps.js');

const CTX = {};
const SESSION = 's-live';

function chunk(type, extra) {
  return { type: 'assistant/chunk', data: { chunk: { type, ...extra } } };
}
const reasoning = (index, text) => chunk('reasoning-delta', { index, text });
const toolDelta = (index, extra) => chunk('tool-call-delta', { index, ...extra });
const blockEnd = (index) => chunk('block-end', { index });
const message = (content) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } });
const toolResult = (callId, text, extra) => ({
  type: 'tool/result',
  data: { message: { source: { callId }, content: [{ type: 'text', text }] }, ...(extra || {}) },
});

function feed(events) {
  for (const event of events) noteLiveEvent(CTX, SESSION, event);
  return liveStepsOf(CTX, SESSION);
}

function fresh() {
  // 直播副本与「谁在写」都是按会话存的模块态：这里连同写入者一起清掉，用例之间不串。
  clearLiveSteps(CTX, SESSION);
  noteLiveEvent(CTX, SESSION, { type: 'turn/start', data: {} });
  drainLiveSteps(CTX, SESSION);
}

test('思考从第一段推理就算一步（不必等工具）', () => {
  fresh();
  const steps = feed([reasoning(0, '先看这个文件')]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.kind, 'think');
  assert.equal(steps[0].step.state, 'running');
  assert.equal(steps[0].step.summary, '');
  assert.equal(steps[0].step.index, 0);
  // 同一步里后面的增量不再新开一步
  feed([reasoning(0, '，再想想')]);
  assert.equal(liveStepsOf(CTX, SESSION).length, 1);
});

test('一段思考落定：摘要取首行、状态收成成功', () => {
  fresh();
  feed([reasoning(0, '**先看这个文件**\n第二行不该进摘要'), blockEnd(0)]);
  const step = liveStepsOf(CTX, SESSION)[0].step;
  assert.equal(step.state, 'ok');
  assert.equal(step.summary, '先看这个文件');
});

test('两步都用 0 号块：仍是两步，编号不撞（块序号每步从 0 重数）', () => {
  fresh();
  feed([
    reasoning(0, '第一步的思考'),
    message([{ type: 'reasoning', text: '第一步的思考' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/tmp/a.md"}' }]),
    reasoning(0, '第二步的思考'),
  ]);
  const steps = liveStepsOf(CTX, SESSION).map((entry) => entry.step);
  const thinks = steps.filter((step) => step.kind === 'think');
  assert.equal(thinks.length, 2);
  assert.deepEqual(thinks.map((step) => step.index), [0, 1]);
  assert.equal(thinks[0].state, 'ok');
  assert.equal(thinks[1].state, 'running');
  // key 也不撞，否则 App 侧按 key 替换会顶掉前一步
  assert.deepEqual(liveStepsOf(CTX, SESSION).map((entry) => entry.key), ['think:0', 'tool:c1', 'think:1']);
});

test('工具步：身份帧开一步，参数流完补摘要，结果收状态', () => {
  fresh();
  feed([toolDelta(1, { id: 'c1', name: 'read', argumentsDelta: '{"file_p' })]);
  let steps = liveStepsOf(CTX, SESSION);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.kind, 'tool');
  assert.equal(steps[0].step.callId, 'c1');
  assert.equal(steps[0].step.state, 'running');
  assert.equal(steps[0].step.summary, '', '参数还没流完就先空着');
  // 后续帧只带 index，要接到同一个调用上
  feed([toolDelta(1, { argumentsDelta: 'ath":"/tmp/a.md"}' })]);
  assert.equal(liveStepsOf(CTX, SESSION).length, 1);
  feed([blockEnd(1)]);
  steps = liveStepsOf(CTX, SESSION);
  assert.equal(steps[0].step.summary, '/tmp/a.md', '参数齐了才有值得点开的一行');
  feed([toolResult('c1', '文件正文')]);
  assert.equal(liveStepsOf(CTX, SESSION)[0].step.state, 'ok');
});

test('失败的工具收成 error / stopped', () => {
  fresh();
  feed([toolDelta(2, { id: 'c2', name: 'bash', argumentsDelta: '{"command":"ls"}' })]);
  feed([toolResult('c2', '权限不够', { error: { code: 'permission-denied' } })]);
  assert.equal(liveStepsOf(CTX, SESSION)[0].step.state, 'error');
  feed([toolDelta(3, { id: 'c3', name: 'bash', argumentsDelta: '{"command":"sleep 9"}' })]);
  feed([toolResult('c3', '', { error: { code: 'interrupted' } })]);
  assert.equal(liveStepsOf(CTX, SESSION)[1].step.state, 'stopped');
});

test('块边界不会把上一步的工具重新标成运行中（块序号会重数）', () => {
  fresh();
  feed([
    toolDelta(0, { id: 'c1', name: 'read', argumentsDelta: '{"file_path":"/a"}' }),
    blockEnd(0),
    toolResult('c1', '正文'),
    message([{ type: 'text', text: '好了' }]),
    // 下一步的正文块也是 0 号：不许把它当成 c1 的边界
    blockEnd(0),
  ]);
  assert.equal(liveStepsOf(CTX, SESSION)[0].step.state, 'ok');
});

test('drain 只给变化的那几条，取走就清空', () => {
  fresh();
  feed([reasoning(0, '看看')]);
  const first = drainLiveSteps(CTX, SESSION);
  assert.equal(first.length, 1);
  assert.equal(first[0].key, 'think:0');
  assert.equal(drainLiveSteps(CTX, SESSION).length, 0, '没有变化就什么都不发');
  feed([blockEnd(0)]);
  const second = drainLiveSteps(CTX, SESSION);
  assert.equal(second.length, 1);
  assert.equal(second[0].step.state, 'ok');
  assert.equal(second[0].step.summary, '看看');
});

test('同一件事不重复发（身份帧来好几发只推一次）', () => {
  fresh();
  feed([toolDelta(0, { id: 'c1', name: 'read', argumentsDelta: '' })]);
  assert.equal(drainLiveSteps(CTX, SESSION).length, 1);
  feed([toolDelta(0, { id: 'c1', name: 'read', argumentsDelta: '' })]);
  assert.equal(drainLiveSteps(CTX, SESSION).length, 0);
});

test('换一轮：上一轮的过程副本整份作废', () => {
  fresh();
  feed([reasoning(0, '第一轮')]);
  noteLiveEvent(CTX, SESSION, { type: 'turn/start', data: {} });
  assert.equal(liveStepsOf(CTX, SESSION).length, 0);
  assert.equal(drainLiveSteps(CTX, SESSION).length, 0);
});

test('思考的详情仍按编号取（直播副本答，不必等落盘）', () => {
  fresh();
  feed([reasoning(0, '这段是全文')]);
  feed([reasoning(1, '第二段')]);
  const detail = liveStepOf(CTX, SESSION, { kind: 'think', index: 1 });
  assert.equal(detail.live, true);
  assert.equal(detail.text, '第二段');
  assert.equal(liveStepOf(CTX, SESSION, { kind: 'think', index: 9 }), null);
});

test('空事件 / 没有位置的事件不会凭空造步', () => {
  fresh();
  feed([null, {}, { type: 'assistant/chunk', data: {} }, chunk('reasoning-delta', { text: '没有 index' })]);
  assert.equal(liveStepsOf(CTX, SESSION).length, 0);
});

// 模型推理里带的签名块（`<signature>…</signature>`）：宿主数据里存着，桌面在渲染层剥掉。
// 直播这一侧摘要与详情都要跟着剥，否则清单行是一串 base64、点开整段噪声。
const SIG = `<signature>${'QkJC'.repeat(40)}</signature>`;

test('签名块：只剩签名时不答详情，接上正文后从签名之后开始', () => {
  fresh();
  feed([reasoning(0, SIG)]);
  assert.equal(liveStepOf(CTX, SESSION, { kind: 'think', index: 0 }), null, '只剩签名时没有正文可给');
  feed([reasoning(0, '\n先看目录')]);
  const think = liveStepOf(CTX, SESSION, { kind: 'think', index: 0 });
  assert.equal(think.text, '先看目录');
});

test('签名块：落定后的摘要在签名之后', () => {
  fresh();
  feed([reasoning(0, SIG), reasoning(0, '\n**先看这个文件**\n第二行不该进摘要'), blockEnd(0)]);
  const step = liveStepsOf(CTX, SESSION)[0].step;
  assert.equal(step.state, 'ok');
  assert.equal(step.summary, '先看这个文件');
});

// 按轮隔离：重连之后新一轮的 turn/start 被当成重复丢掉，App 收不到「换轮」信号 —— 只能靠
// 每一帧自带的 data.turn 来判。换了轮就整份换掉，绝不把上一轮的步骤接着拼进来。
test('换轮（漏了 turn/start）不把上一轮拼进来', () => {
  fresh();
  const withTurn = (turn, event) => ({ ...event, data: { ...event.data, turn } });
  // 第一轮（turn 1）：思考一步 + 工具一步
  noteLiveEvent(CTX, SESSION, withTurn(1, reasoning(0, '第一轮')));
  noteLiveEvent(CTX, SESSION, withTurn(1, toolDelta(1, { id: 'c1', name: 'read' })));
  assert.equal(liveStepsOf(CTX, SESSION).length, 2);
  // 第二轮直接来（turn 2，中间没有 turn/start）：整份换掉，只剩第二轮这一步
  noteLiveEvent(CTX, SESSION, withTurn(2, reasoning(0, '第二轮')));
  const steps = liveStepsOf(CTX, SESSION);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step.kind, 'think');
});

// ── 同一会话的多条流：只认一个写入者 ─────────────────────────────────────────
// 直播副本是进程级、按会话共享的一份。同一个聊天页被开着两屏（屏栈下层保留挂载）、或重连
// 那一刻旧连接还没在电脑那头断干净时，同一条会话会同时有多条流；每条都往里写的话，每段推理
// 会被接两遍，用户点开「思考」看到逐 token 翻倍的正文（`TheThe proxy proxy …`）。
const { claimLiveWriter, releaseLiveWriter, attachLiveSteps, broadcastLiveSteps } = require('../lib/mobile/live-steps.js');

test('两条流同时喂：只有写入者累加，正文不翻倍', () => {
  fresh();
  const writer = 'stream-1';
  const reader = 'stream-2';
  assert.equal(claimLiveWriter(CTX, SESSION, writer), true);
  assert.equal(claimLiveWriter(CTX, SESSION, reader), false, '写入权已被占，第二条流当只读');
  // 两条流收到的是同一份增量（真实情形：各自一条 SSE，内容一样）
  const increments = ['The', ' proxy', ' should'];
  for (const text of increments) {
    noteLiveEvent(CTX, SESSION, reasoning(0, text), writer);
    noteLiveEvent(CTX, SESSION, reasoning(0, text), reader);
  }
  const think = liveStepOf(CTX, SESSION, { kind: 'think', index: 0 });
  assert.equal(think.text, 'The proxy should', '只读的流不许再累加一遍');
});

test('写入者走了之后，下一个连进来的流接棒', () => {
  fresh();
  const first = 'stream-1';
  const second = 'stream-2';
  claimLiveWriter(CTX, SESSION, first);
  noteLiveEvent(CTX, SESSION, reasoning(0, '第一段'), first);
  releaseLiveWriter(CTX, SESSION, first);
  assert.equal(claimLiveWriter(CTX, SESSION, second), true, '写入者走了就该让位');
  noteLiveEvent(CTX, SESSION, reasoning(0, '第二段'), second);
  assert.equal(liveStepOf(CTX, SESSION, { kind: 'think', index: 0 }).text, '第一段第二段');
});

test('晚到的旧流释放写入权不会把新写入者顶掉', () => {
  fresh();
  claimLiveWriter(CTX, SESSION, 'old');
  releaseLiveWriter(CTX, SESSION, 'old');
  claimLiveWriter(CTX, SESSION, 'new');
  // 旧流收尾比新流晚（重连时旧连接断得慢）
  releaseLiveWriter(CTX, SESSION, 'old');
  assert.equal(claimLiveWriter(CTX, SESSION, 'new'), true, '新写入者仍占着');
  assert.equal(claimLiveWriter(CTX, SESSION, 'other'), false);
});

test('只读的流照样收到清单增量（靠写入者广播）', () => {
  fresh();
  const writer = 'stream-1';
  const reader = 'stream-2';
  claimLiveWriter(CTX, SESSION, writer);
  const seen = [];
  const readerSink = (frame) => seen.push(frame);
  const writerSink = () => { throw new Error('写入者自己那份就地写，不该广播给自己'); };
  attachLiveSteps(CTX, SESSION, readerSink);
  attachLiveSteps(CTX, SESSION, writerSink);
  noteLiveEvent(CTX, SESSION, reasoning(0, '先看目录'), writer);
  const drained = drainLiveSteps(CTX, SESSION, writer);
  assert.equal(drained.length, 1);
  const frame = { type: 'session/live-steps', sessionId: SESSION, full: false, turn: null, steps: drained };
  broadcastLiveSteps(CTX, SESSION, frame, writerSink);
  assert.deepEqual(seen, [frame], '另一屏要跟着收到同一份增量');
  // 只读的流不许把写入者该发的那几步抢走
  assert.equal(drainLiveSteps(CTX, SESSION, reader).length, 0);
});


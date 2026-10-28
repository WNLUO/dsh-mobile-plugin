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

const { noteLiveEvent, liveStepsOf, drainLiveSteps, liveStepOf } = require('../lib/mobile/live-steps.js');

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

'use strict';

/**
 * `ask_user_question` 的「问 + 答」派生（question-reply.js）与历史折叠的回归。
 *
 * 对齐桌面 `answeredQuestionDefinition`：调用 + 结果成对时折成一条 `kind:'question-reply'`
 * 行；计划评审 / pending / 失败 / 题数对不上都不出；`ask_user_question` 也不再留一行空的
 * 工具过程步骤。
 *
 * 运行：node --test test/question-reply.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionReplyTracker, questionsOf, answersOf } = require('../lib/mobile/question-reply.js');
const { deriveMessages } = require('../lib/mobile/history-derive.js');

const QUESTIONS = [
  { id: 'direction', header: '先确认方向', question: '你想怎么办？', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'auth', question: '用哪种登录？', multiSelect: true, options: [{ label: '口令' }, { label: 'OAuth' }] },
];

const callEvent = (callId = 'call-1', questions = QUESTIONS) => ({
  type: 'tool/call',
  seq: 3,
  time: 1000,
  data: { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) },
});

const resultEvent = (callId = 'call-1', answers = [
  { id: 'direction', selected: ['B'] },
  { id: 'auth', selected: ['口令'], custom: '公司统一口令' },
]) => ({
  type: 'tool/result',
  seq: 4,
  time: 1200,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: JSON.stringify({ answers }) }],
      isError: false,
      id: `result-${callId}`,
    },
  },
});

test('questionsOf：正常题目；计划评审与畸形一律 null', () => {
  assert.equal(questionsOf(JSON.stringify({ questions: QUESTIONS })).length, 2);
  assert.equal(questionsOf({ questions: QUESTIONS }).length, 2);
  // 计划评审不是普通选择题。
  assert.equal(questionsOf(JSON.stringify({ questions: [{ id: 'p', question: '计划?', intent: { kind: 'plan-review', approve: '好' } }] })), null);
  assert.equal(questionsOf('not json'), null);
  assert.equal(questionsOf(JSON.stringify({ questions: [] })), null);
  assert.equal(questionsOf(JSON.stringify({ questions: [{ id: 'x' }] })), null);
});

test('answersOf：pending / 失败 / 题数不符 / 畸形一律 null', () => {
  const questions = questionsOf(JSON.stringify({ questions: QUESTIONS }));
  const ok = answersOf({ content: [{ type: 'text', text: JSON.stringify({ answers: [
    { id: 'direction', selected: ['A'] }, { id: 'auth', selected: [] },
  ] }) }] }, questions);
  assert.equal(ok.length, 2);
  assert.equal(answersOf({ content: [{ type: 'text', text: JSON.stringify({ pending: true, answers: [] }) }] }, questions), null);
  assert.equal(answersOf({ isError: true, content: [{ type: 'text', text: '{}' }] }, questions), null);
  assert.equal(answersOf({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'direction', selected: [] }] }) }] }, questions), null);
});

test('tracker：调用 + 结果成对才折出 question-reply 行', () => {
  const tracker = createQuestionReplyTracker();
  assert.equal(tracker.note(callEvent()), null);
  const item = tracker.note(resultEvent());
  assert.ok(item, '结果到达应折出问答行');
  assert.equal(item.kind, 'question-reply');
  assert.equal(item.id, 'question-reply-call-1');
  assert.equal(item.text, '');
  assert.deepEqual(item.questionReply.questions.map((q) => q.id), ['direction', 'auth']);
  assert.deepEqual(item.questionReply.answers, [
    { id: 'direction', selected: ['B'] },
    { id: 'auth', selected: ['口令'], custom: '公司统一口令' },
  ]);
  assert.equal(item.seq, 4);
  // 同一条结果再来一次没有题目可配，不再出（幂等）。
  assert.equal(tracker.note(resultEvent()), null);
});

test('tracker：pending 结果不出，之后同一 callId 到了正常结果再出', () => {
  const tracker = createQuestionReplyTracker();
  tracker.note(callEvent('c2'));
  const pending = resultEvent('c2', []);
  pending.data.message.content = [{ type: 'text', text: JSON.stringify({ pending: true }) }];
  assert.equal(tracker.note(pending), null);
  assert.ok(tracker.note(resultEvent('c2')));
});

test('tracker：只认 ask_user_question，别的工具结果忽略', () => {
  const tracker = createQuestionReplyTracker();
  tracker.note({ type: 'tool/call', seq: 1, time: 1, data: { callId: 'x', name: 'bash', arguments: '{}' } });
  assert.equal(tracker.note(resultEvent('x')), null);
});

test('history-derive：折出问答行，且不留空的 ask_user_question 工具步骤', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 900, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 950, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我看看' }] } },
    { type: 'tool/call', seq: 3, time: 1000, data: { turn: 1, step: 1, callId: 'call-9', name: 'ask_user_question', arguments: JSON.stringify({ questions: QUESTIONS }) } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-9', name: 'ask_user_question', arguments: JSON.stringify({ questions: QUESTIONS }) }],
        },
      },
    },
    resultEvent('call-9'),
    { type: 'turn/end', seq: 6, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const messages = deriveMessages(events, 'test-question-reply-history');
  const reply = messages.find((item) => item.kind === 'question-reply');
  assert.ok(reply, '历史里应有问答行');
  assert.equal(reply.questionReply.answers[0].selected[0], 'B');
  const opener = messages.find((item) => item.id === 'u1');
  const steps = (opener && opener.turnProcess && opener.turnProcess.steps) || [];
  assert.ok(!steps.some((step) => step.name === 'ask_user_question'), 'ask_user_question 不应留工具步骤');
});

test('history-derive：计划评审不生成问答行', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 900, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 950, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '计划' }] } },
    { type: 'tool/call', seq: 3, time: 1000, data: { turn: 1, step: 1, callId: 'plan-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'p', question: '批准?', intent: { kind: 'plan-review', approve: '好' } }] }) } },
    {
      type: 'tool/result', seq: 4, time: 1100, data: {
        turn: 1, step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId: 'plan-1' }, toolCallId: 'plan-1', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'p', selected: ['好'] }] }) }], isError: false, id: 'rp' },
      },
    },
  ];
  const messages = deriveMessages(events, 'test-question-reply-plan');
  assert.ok(!messages.some((item) => item.kind === 'question-reply'));
});

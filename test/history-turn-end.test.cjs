'use strict';

/**
 * 一轮怎么结束：`turn/end` 到历史结构行的折法（lib/mobile/history-derive.js 的真实实现）。
 *
 * 三种结局各有一条可见后果，且都必须能被 App 认出来：
 *   - error     → `turn-error` 行（红色结论条，带原文）；
 *   - max-tokens → `max-tokens` 行；
 *   - aborted   → `turn-aborted` 行，**不上屏**，只让 App 把那一轮标成「已停止」并摊开。
 *     桌面口径是 aborted / error 不折叠；少了这一条，被打断的那一轮只能当成正常结束，
 *     连中途跑出来的正文一起收进一行「已完成，用时 …」（真机现象：点进去只剩用户自己
 *     那句，AI 的过程和回复都看不到）。
 * completed 不产行（正常收口，由 App 自己的投影收尾）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMessages } = require('../lib/mobile/history-derive.js');

const end = (turn, seq, reason) => ({ type: 'turn/end', seq, time: seq, data: { turn, reason } });
const structural = (items) => items.filter((item) => item.kind === 'turn-error' || item.kind === 'max-tokens' || item.kind === 'turn-aborted');

test('aborted 落成 turn-aborted 行（不带正文、id 按 turn 走）', () => {
  const rows = structural(deriveMessages([end(4, 21, { kind: 'aborted', reason: { kind: 'user' } })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'turn-aborted');
  assert.equal(rows[0].id, 'turn-4');
  assert.equal(rows[0].seq, 21);
  assert.equal(rows[0].text, undefined, '结构行不带正文（与 turn-error / max-tokens 同形）');
});

test('error 仍是带原文的 turn-error（aborted 那条不许抢它）', () => {
  const rows = structural(deriveMessages([end(5, 30, { kind: 'error', error: { message: '上游 500', code: 'upstream' } })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'turn-error');
  assert.equal(rows[0].message, '上游 500');
  assert.equal(rows[0].code, 'upstream');
});

test('max-tokens 仍是 max-tokens', () => {
  const rows = structural(deriveMessages([end(6, 40, { kind: 'max-tokens' })]));
  assert.deepEqual(rows.map((row) => row.kind), ['max-tokens']);
});

test('completed 不产结构行（正常收口不靠这一条）', () => {
  assert.equal(structural(deriveMessages([end(7, 50, { kind: 'completed' })])).length, 0);
});

test('缺 turn 的 turn/end 不产行（老日志没这个字段）', () => {
  const bare = { type: 'turn/end', seq: 60, time: 60, data: { reason: { kind: 'aborted' } } };
  assert.equal(structural(deriveMessages([bare])).length, 0);
});

// ── 步骤边界：还停在「等待重试」的那条要作废 ─────────────────────────────────
// 重试链在 step/start 处就换了身份（新的 retryId），只认 turn/end 的话，上一步那条会永远
// 挂在「等待重试」上，与下一步新出现的那条并排（2026-11-01 App 侧现场）。桌面 `isClosed`
// 判的也是「这一步或这一轮结束」。
const retryRow = (retryId, turn, step, seq) => ({
  type: 'llm/retry',
  seq,
  time: seq,
  data: {
    retryId,
    turn,
    step,
    provider: 'deepseek',
    mode: 'normal',
    policyKey: 'k',
    retry: 1,
    maxRetries: 3,
    delayMs: 5000,
    failure: { code: 'QUOTA', message: '上游 429' },
  },
});
const stepEnd = (turn, step, seq) => ({ type: 'step/end', seq, time: seq, data: { turn, step } });
const retries = (items) => items.filter((item) => item.kind === 'retry');

test('这一步结束：本步还停在等待重试的那条标成 cancelled', () => {
  const rows = retries(deriveMessages([retryRow('r1', 3, 2, 10), stepEnd(3, 2, 12)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].turn, 3, '重试行要记着自己属于哪一步，App 侧靠它认');
  assert.equal(rows[0].step, 2);
});

test('别的步结束不碰这条', () => {
  const rows = retries(deriveMessages([retryRow('r1', 3, 2, 10), stepEnd(3, 3, 12)]));
  assert.equal(rows[0].status, 'scheduled');
});

test('已经发出去的那次（retry-started）不会被步骤收口改写作废', () => {
  const rows = retries(deriveMessages([
    retryRow('r1', 3, 2, 10),
    { type: 'llm/retry-started', seq: 11, time: 11, data: { retryId: 'r1', turn: 3, step: 2, retry: 1 } },
    stepEnd(3, 2, 12),
  ]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'started');
});

// ── 轮号随消息下发 ─────────────────────────────────────────────────────────
// 每一轮的消息自己带 `data.turn` 的只有 assistant / step / tool 那几类；**`user/message`
// 不带**（真实日志 1621 份里都是这样），而它正是开启这一轮的那一句。手机侧的轮次头条与
// 整条会话轴都按消息上的 `turn` 切轮，历史消息一个轮号都不带的话，重新打开老会话时
// 轴会是空的 —— 「整条会话」那一档等于不存在（只有刚跑过、靠实时帧拿轮号的会话有轴）。
// 所以轮号按事件自带的优先、`turn/start` 边界兜底，逐条写到消息上。
const start = (turn, seq) => ({ type: 'turn/start', seq, time: seq, data: { turn } });
const userSays = (id, text, seq) => ({
  type: 'user/message',
  seq,
  time: seq,
  // 刻意不带 data.turn：与真实日志同形。
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const assistantSays = (turn, text, seq, step = 1) => ({
  type: 'assistant/message',
  seq,
  time: seq,
  data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

test('两轮的历史消息每一条都带轮号（用户那一条靠 turn/start 边界兜）', () => {
  const items = deriveMessages([
    start(1, 1),
    userSays('u1', '第一句', 2),
    assistantSays(1, '答一', 3),
    end(1, 4, { kind: 'completed' }),
    start(2, 5),
    userSays('u2', '第二句', 6),
    assistantSays(2, '答二', 7),
    end(2, 8, { kind: 'completed' }),
  ]);
  assert.deepEqual(items.map((item) => item.turn), [1, 1, 2, 2], '每一条消息都要带上自己那一轮的轮号');
  assert.deepEqual(items.map((item) => item.role), ['user', 'assistant', 'user', 'assistant']);
  // 用户那一条是唯一不带 data.turn 的事件，必须靠边界落到正确的轮次上。
  assert.equal(items[0].turn, 1);
  assert.equal(items[2].turn, 2);
});

test('消息自带 data.turn 时以它为准（跨轮对不上不搅在一起）', () => {
  // turn/start 说这是第 9 轮，但这条 assistant 事件自称第 10 轮：真实日志里带 data.turn
  // 的事件更权威，不能被边界覆盖成 9，两轮就此别并成一条。
  const items = deriveMessages([
    start(9, 1),
    userSays('u1', '开场', 2),
    assistantSays(10, '它说它属于第 10 轮', 3),
  ]);
  assert.deepEqual(items.map((item) => item.turn), [9, 10]);
});

test('早于第一条 turn/start 的旧消息不带轮号（判不出来就不猜）', () => {
  const items = deriveMessages([userSays('u0', '窗口外的老消息', 1), start(3, 2), userSays('u3', '第三句', 3)]);
  assert.equal(items[0].turn, undefined);
  assert.equal(items[1].turn, 3);
});

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

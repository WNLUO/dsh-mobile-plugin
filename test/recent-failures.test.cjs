'use strict';

/**
 * 「最近失败过的那几轮」的守卫（lib/mobile/recent-failures.js）。
 *
 * 这张账存在的唯一理由：离线期间同一会话「先失败、后又跑成功」时，事实表只留最新一轮，
 * 那次失败在任何一端都收不到。所以这里钉三件事：
 *   1. 失败要进账，且同一轮重复折叠不会写两条（列表 / 监控 / 事件流各折一次）；
 *   2. 成功与 incomplete **不**清掉已有的失败账 —— 它们只说明「后来又跑了一轮」；
 *   3. 已经读过的失败轮次不算「还没补」的（与设备无关的已读水位是唯一判据）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FAILED_TURNS, mergeFailedTurn, pendingFailedTurns } = require('../lib/mobile/recent-failures.js');

const failed = (turn, endedAt, extra = {}) => ({ turn, endedAt, status: 'failed', ...extra });

test('失败进账，同一轮重复折叠不会写两条', () => {
  const once = mergeFailedTurn(null, failed(3, 1000, { code: 'E1', message: '炸了' }));
  assert.deepEqual(once, [{ turn: 3, endedAt: 1000, code: 'E1', message: '炸了' }]);
  // 同一轮再折一次（另一条路径也观察到这次收尾）：不能变成两条。
  assert.deepEqual(mergeFailedTurn(once, failed(3, 1000, { code: 'E1' })), [{ turn: 3, endedAt: 1000, code: 'E1' }]);
});

test('成功与 incomplete 不清掉已有的失败账', () => {
  const account = mergeFailedTurn(null, failed(1, 1000));
  assert.deepEqual(mergeFailedTurn(account, { turn: 2, endedAt: 2000, status: 'completed' }), account);
  assert.deepEqual(mergeFailedTurn(account, { turn: 2, endedAt: 2000, status: 'incomplete' }), account);
  // 但新的一次失败要继续收进去：离线期间跑坏两轮，两条都要在。
  const two = mergeFailedTurn(account, failed(2, 2000));
  assert.deepEqual(two.map((item) => item.turn), [1, 2]);
});

test('只留最近若干轮，按轮次递增', () => {
  let account = null;
  for (let turn = 1; turn <= MAX_FAILED_TURNS + 3; turn += 1) account = mergeFailedTurn(account, failed(turn, turn * 1000));
  assert.equal(account.length, MAX_FAILED_TURNS);
  assert.equal(account[account.length - 1].turn, MAX_FAILED_TURNS + 3, '最新那一轮必须在');
  assert.equal(account[0].turn, 4, '最早的那几轮被挤掉');
});

test('已读水位之前的失败不算「还没补」', () => {
  const account = mergeFailedTurn(mergeFailedTurn(null, failed(1, 1000)), failed(2, 3000));
  assert.deepEqual(pendingFailedTurns(account, 0).map((item) => item.turn), [1, 2]);
  assert.deepEqual(pendingFailedTurns(account, 2000).map((item) => item.turn), [2], '读过的那一轮不再补');
  assert.deepEqual(pendingFailedTurns(account, 5000), []);
});

test('账形状不对时按空账处理，不抛错', () => {
  assert.deepEqual(mergeFailedTurn(undefined, undefined), []);
  assert.deepEqual(mergeFailedTurn([{ bad: true }, null, 'x'], failed(1, 1000)), [{ turn: 1, endedAt: 1000 }]);
  assert.deepEqual(pendingFailedTurns(null, 0), []);
});

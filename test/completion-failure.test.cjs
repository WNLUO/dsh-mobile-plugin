'use strict';

/**
 * 守卫：一轮的结局由 `turn/end` 的 `reason.kind` 决定。
 *
 * 背景（真机复现）：宿主以 `reason.kind === 'error'`（例如 403 额度不足）收尾时，同一轮
 * **已经**追加过 assistant/message，于是旧的确认规则「assistant.seq <= turn/end.seq」成立
 * ——插件把一次失败折成了「已完成待读」，App 侧栏给这一行画绿点；更糟的是这一轮本来也
 * 没有完成通知，用户以为它还在跑。
 *
 * 这里钉住三件事：
 *   1. error 收尾的轮次不算完成，并把失败信息（turn / code / message）留在状态里；
 *   2. 失败标记跨列表快照、跨下一轮延续，直到同一会话有一轮真的 completed；
 *   3. max-tokens / aborted 既不算完成也不算失败（没有错误码，不该亮红点）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  observeCompletionEvent,
  updateCompletionStates,
  confirmCompletionFromHistory,
} = require('../lib/mobile/completion.js');
const { completionStateOf, markCompletionRead } = require('../lib/mobile/session-cache.js');

const AT = 1780000000000;

/** 一轮的最小事件序列：turn/start → assistant/message → turn/end(reason)。 */
function turnEvents(turn, reason, { assistantSeq = 10 } = {}) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    { type: 'assistant/message', seq: assistantSeq, data: { turn } },
    { type: 'turn/end', seq: 20, time: AT, data: { turn, reason } },
  ];
}

/**
 * 走一遍真实边沿：先看到 running，再看到 idle —— `wasRunning` 只有这样才置位
 * （插件侧先收到运行中的快照，下一份快照才是结束后的）。
 */
function observeIdleEdge(ctx, deviceKey, sessionId, events, reason) {
  updateCompletionStates(ctx, [{ sessionId, running: true }], deviceKey);
  updateCompletionStates(ctx, [{ sessionId, running: false }], deviceKey);
  const state = completionStateOf(ctx, deviceKey).get(sessionId);
  confirmCompletionFromHistory(state, events || turnEvents(7, reason), false);
  return state;
}

test('turn/end kind=error：不算完成，并留下失败信息', () => {
  const ctx = {};
  const state = observeIdleEdge(ctx, 'phone', 's-error', null, {
    kind: 'error',
    error: { code: 'AUTH', message: '403: 用户额度不足' },
  });
  assert.equal(state.completed, false, '失败的一轮不能被折成「已完成待读」');
  assert.deepEqual(state.failure, {
    turn: 7,
    code: 'AUTH',
    message: '403: 用户额度不足',
    at: AT,
  });
});

test('失败标记跨列表快照与下一轮延续，直到有一轮真正完成', () => {
  const ctx = {};
  const deviceKey = 'phone';
  const first = observeIdleEdge(ctx, deviceKey, 's-carry', null, {
    kind: 'error',
    error: { code: 'AUTH' },
  });
  assert.equal(first.completed, false);

  // 用户点「继续」：新一轮开始（running）——失败标记不能被这份快照抹掉。
  updateCompletionStates(ctx, [{ sessionId: 's-carry', running: true }], deviceKey);
  const carried = completionStateOf(ctx, deviceKey).get('s-carry');
  assert.equal(carried.completed, false);
  assert.equal(carried.failure && carried.failure.code, 'AUTH', '红点不能因为「又开了一轮」就消失');

  // 这一轮成功收尾：完成标记恢复，红点标记被清掉。
  updateCompletionStates(ctx, [{ sessionId: 's-carry', running: false }], deviceKey);
  const second = completionStateOf(ctx, deviceKey).get('s-carry');
  confirmCompletionFromHistory(second, turnEvents(8, { kind: 'completed' }), false);
  assert.equal(second.completed, true);
  assert.equal(second.failure, undefined);
  assert.equal(second.turn, 8);
});

test('max-tokens / aborted：不算完成，也不亮红点', () => {
  const ctx = {};
  const maxed = observeIdleEdge(ctx, 'phone', 's-maxtok', null, { kind: 'max-tokens' });
  assert.equal(maxed.completed, false);
  assert.equal(maxed.failure, undefined);

  const aborted = observeIdleEdge(ctx, 'phone', 's-abort', null, { kind: 'aborted' });
  assert.equal(aborted.completed, false);
  assert.equal(aborted.failure, undefined);
});

test('事件流直接确认短轮次，不依赖列表采到运行中或补读历史', () => {
  const ctx = {};
  updateCompletionStates(ctx, [{ sessionId: 's-fast', running: false }], 'phone');
  for (const event of turnEvents(11, { kind: 'completed' })) {
    observeCompletionEvent(ctx, 's-fast', event);
  }
  const state = completionStateOf(ctx, 'phone').get('s-fast');
  assert.equal(state.completed, true);
  assert.equal(state.turn, 11);
});

test('正常完成的轮次仍然报完成（回归）', () => {
  const ctx = {};
  const state = observeIdleEdge(ctx, 'phone', 's-ok', null, { kind: 'completed' });
  assert.equal(state.completed, true);
  assert.equal(state.failure, undefined);
});

test('失败之后又一轮没跑完（max-tokens）：旧红点要让位，且不报完成', () => {
  const ctx = {};
  const deviceKey = 'phone';
  observeIdleEdge(ctx, deviceKey, 's-mixed', null, { kind: 'error', error: { code: 'AUTH' } });

  updateCompletionStates(ctx, [{ sessionId: 's-mixed', running: true }], deviceKey);
  updateCompletionStates(ctx, [{ sessionId: 's-mixed', running: false }], deviceKey);
  const state = completionStateOf(ctx, deviceKey).get('s-mixed');
  confirmCompletionFromHistory(state, turnEvents(9, { kind: 'max-tokens' }), false);

  assert.equal(state.completed, false);
  assert.equal(state.failure, undefined, '已经没有错误码可显示，红点不该继续挂着旧失败');
});

test('设备作用域隔离：另一台设备的失败不串到本设备', () => {
  const ctx = {};
  observeIdleEdge(ctx, 'phone-a', 's-scope', null, { kind: 'error', error: { code: 'AUTH' } });
  const other = completionStateOf(ctx, 'phone-b').get('s-scope');
  assert.equal(other, undefined);
  assert.equal(completionStateOf(ctx, 'phone-a').get('s-scope').failure.code, 'AUTH');
});

test('interrupted 的 assistant 仍不算完成（既有铁律不被本次改动破坏）', () => {
  const ctx = {};
  updateCompletionStates(ctx, [{ sessionId: 's-int', running: true }], 'phone');
  updateCompletionStates(ctx, [{ sessionId: 's-int', running: false }], 'phone');
  const state = completionStateOf(ctx, 'phone').get('s-int');
  const events = turnEvents(3, { kind: 'completed' });
  events[1].data.interrupted = true;
  confirmCompletionFromHistory(state, events, false);
  assert.equal(state.completed, false);
});

// ── 提醒算不算数由时间水位决定，不再由「有没有亲眼看见它跑」决定 ─────────────
// 2026-10-17 真机：桌面上亮着绿点 / 红点，手机上什么都没有。根因就是旧判据要求
// `wasRunning`（先看见 running 再看见 idle）——宿主没采到那一瞬间，这一轮就永远不亮。

const NOW = Date.now();

/** 同上，但结束时刻可控：用来区分「本进程之前的老轮次」与「刚刚跑完的一轮」。 */
function turnEventsAt(turn, reason, endedAt) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    { type: 'assistant/message', seq: 10, data: { turn } },
    { type: 'turn/end', seq: 20, time: endedAt, data: { turn, reason } },
  ];
}

test('宿主没看见 running 的那一轮，只要结束在本进程之后，也要亮', () => {
  const ctx = {};
  // 只有空闲快照：从来没有一份快照采到 running，也没有实时 turn/start。
  updateCompletionStates(ctx, [{ sessionId: 's-missed', running: false }], 'phone');
  const state = completionStateOf(ctx, 'phone').get('s-missed');
  confirmCompletionFromHistory(state, turnEventsAt(7, { kind: 'completed' }, NOW + 5_000), false);
  assert.equal(state.completed, true, '没采到运行中不等于这一轮没发生');
});

test('冷启动不重播：本进程启动之前就结束的轮次不亮', () => {
  const ctx = {};
  updateCompletionStates(ctx, [{ sessionId: 's-old', running: false }], 'phone');
  const state = completionStateOf(ctx, 'phone').get('s-old');
  confirmCompletionFromHistory(state, turnEventsAt(7, { kind: 'completed' }, 1_000), false);
  assert.equal(state.completed, false);
  confirmCompletionFromHistory(state, turnEventsAt(8, { kind: 'error' }, 1_000), false);
  assert.equal(state.failure, undefined, '老失败也不能在冷启动时冒出来');
});

test('读过的那一轮不会再亮回来，之后新跑完的一轮照样亮', () => {
  const ctx = {};
  updateCompletionStates(ctx, [{ sessionId: 's-read', running: false }], 'phone');
  const state = completionStateOf(ctx, 'phone').get('s-read');
  confirmCompletionFromHistory(state, turnEventsAt(7, { kind: 'error', error: { code: 'AUTH' } }, NOW + 1_000), false);
  assert.equal(state.failure.code, 'AUTH');

  markCompletionRead(ctx, 'phone', 's-read', NOW + 2_000);
  assert.equal(state.completed, false);
  assert.equal(state.failure, undefined, '读过就该灭');

  // 同一份 history 再折一次（列表每 15s 一轮都会折）：不能又亮回来。
  confirmCompletionFromHistory(state, turnEventsAt(7, { kind: 'error', error: { code: 'AUTH' } }, NOW + 1_000), false);
  assert.equal(state.failure, undefined, '已读水位之前的轮次不许复活');

  // 新一轮真的跑完了：越过水位，必须重新亮。
  confirmCompletionFromHistory(state, turnEventsAt(9, { kind: 'completed' }, NOW + 3_000), false);
  assert.equal(state.completed, true);
});

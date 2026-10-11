'use strict';

/**
 * 完成提醒状态机：从宿主会话列表快照与 history 事件日志里确认「跑完了」。
 *
 * 三条铁律写在代码注释里，这里也复述一遍，因为它们各自都防过一次误报：
 *  1. **不**从 running→idle 的状态边沿推断完成。agent-loop 是先 append 最终
 *     assistant/message 再 append turn/end，所以必须由 history 折出同一轮的这两个事件
 *     才算完成；
 *  2. `wasRunning` 是进程内边沿标记，只有本次 Host 存活期间观察到的轮次才有资格报完成，
 *     否则冷启动的一份旧列表会把上次开机前的轮次当成新完成弹一遍通知；
 *  3. 一轮的结局由 `turn/end` 的 `reason.kind` 说了算：`error` 记失败（宿主会话列表里
 *     没有任何失败字段，App 侧栏的红点全靠这里折出来），`completed` 才算完成，其余
 *     kind（max-tokens / aborted）既不算完成也不算失败。
 */

const { completionStateOf } = require('./session-cache.js');

/** Update shared completion reminders from one Host session-list snapshot. */
function updateCompletionStates(ctx, items, deviceKey = 'legacy') {
  const states = completionStateOf(ctx, deviceKey);
  const seen = new Set();
  for (const summary of items || []) {
    if (!summary || typeof summary.sessionId !== 'string' || !summary.sessionId) continue;
    seen.add(summary.sessionId);
    const running = !!summary.running;
    const previous = states.get(summary.sessionId);
    // Do not infer completion from the status edge. The history fold below
    // must prove the matching turn/end plus its final assistant message.
    const completed = previous?.completed === true;
    // `wasRunning` is an internal edge marker.  A completed notification is
    // only eligible for a turn observed while this Host was alive; a cold
    // list snapshot must not replay an old turn as a new completion.
    states.set(summary.sessionId, {
      running,
      completed: running ? false : completed,
      turn: previous?.turn,
      wasRunning: previous?.running === true,
      // 「上一轮失败」是历史事实：宿主列表摘要里没有这个信息，唯一来源是下面的 history
      // 折叠。它必须跨快照、跨下一轮延续 —— 否则「失败之后用户又发一句话」会让
      // state.turn 前进，红点还没被看见就没了。
      failure: previous?.failure,
    });
  }
  // The Host list is canonical for this device scope; discard detached
  // sessions so completion state cannot leak across reused session IDs.
  for (const sessionId of states.keys()) {
    if (!seen.has(sessionId)) states.delete(sessionId);
  }
  return states;
}

/**
 * Confirm the running -> idle edge against the event log.  Agent status is a
 * coarse activity signal: the agent-loop appends the final assistant/message
 * and only then appends turn/end.  Keep the edge tied to that exact turn so a
 * late/stale list response cannot complete a newer (or an older) turn.
 */
function confirmCompletionFromHistory(state, events, running) {
  if (!state || !Array.isArray(events)) return;
  let latestTurn;
  const ends = new Map();
  const assistants = new Map();
  for (const entry of events) {
    const event = entry?.event || entry;
    if (!event || !event.data || typeof event.data !== 'object') continue;
    const turn = event.data.turn;
    if (typeof turn !== 'number') continue;
    if (event.type === 'turn/start') latestTurn = turn;
    else if (event.type === 'assistant/message') {
      assistants.set(turn, event);
      if (latestTurn === undefined) latestTurn = turn;
    } else if (event.type === 'turn/end') {
      ends.set(turn, event);
      if (latestTurn === undefined) latestTurn = turn;
    }
  }
  if (latestTurn !== undefined) state.turn = latestTurn;
  if (running || !state.wasRunning || state.turn === undefined) return;
  const end = ends.get(state.turn);
  const assistant = assistants.get(state.turn);
  const reason = end && end.data ? end.data.reason : undefined;
  const kind = reason && typeof reason.kind === 'string' ? reason.kind : undefined;
  // 本轮以错误收尾：宿主不会再补一条最终消息，但它刚刚追加过 turn/end —— 下面那条
  // 「assistant 早于 turn/end 就算完成」的规则会把这种轮次判成「已完成待读」，侧栏于是
  // 把一次失败显示成绿点。失败是宿主列表摘要里没有的信息，只能在这里折出来交给 App。
  if (end && kind === 'error') {
    const error = reason && reason.error && typeof reason.error === 'object' ? reason.error : {};
    state.completed = false;
    state.failure = {
      turn: state.turn,
      code: typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message : null,
      at: typeof end.time === 'number' ? end.time : Date.now(),
    };
    return;
  }
  // max-tokens / aborted 等：这一轮没跑完，同样不能报完成；但它没有错误码可显示，
  // 所以只清完成标记，不产生红点。
  if (end && kind !== undefined && kind !== 'completed') {
    state.completed = false;
    state.failure = undefined;
    return;
  }
  // The assistant message must be the settled message for this turn, not an
  // interrupted partial and not merely a preceding turn's message.
  if (end && assistant && assistant.seq <= end.seq && assistant.data.interrupted !== true) {
    state.completed = true;
    // 成功收尾的轮次覆盖旧失败：标记必须跟着最新一次运行走。
    state.failure = undefined;
  }
}

module.exports = { updateCompletionStates, confirmCompletionFromHistory };

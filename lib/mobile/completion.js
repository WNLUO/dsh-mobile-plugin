'use strict';

/**
 * 完成提醒状态机：一轮怎么结束以 history 为准（turn/end 的 reason.kind），实时 turn
 * 事件只是让结论早一步到达。提醒算不算数看两个水位：读过的时刻之前不算，本进程启动
 * 之前结束的轮次也不重播 —— 不再要求「先看见 running」。
 *
 * 旧要求的后果（2026-10-17 真机）：宿主没采到那一瞬间的轮次永远不亮，桌面亮着绿点 /
 * 红点，手机上什么都没有。
 */

const { completionStateOf, completionStateMapsOf } = require('./session-cache.js');

/** 本进程起点：比它更早结束的轮次不重播。 */
const PROCESS_STARTED_AT = Date.now();

/** 「不算数」水位：读过按读过时刻；没读过时，本进程见过它跑就放开（0）。 */
function baselineOf(state) {
  if (!state) return PROCESS_STARTED_AT;
  if (typeof state.clearedAt === 'number') return state.clearedAt;
  return state.wasRunning === true ? 0 : PROCESS_STARTED_AT;
}

/** Consume one live Host turn event for every device with an initialized completion state. */
function observeCompletionEvent(ctx, sessionId, event) {
  if (!sessionId || !event || !event.data || typeof event.data.turn !== 'number') return;
  const turn = event.data.turn;
  for (const states of completionStateMapsOf(ctx)) {
    const previous = states.get(sessionId);
    if (!previous) continue;
    if (event.type === 'turn/start') {
      states.set(sessionId, { ...previous, running: true, completed: false, wasRunning: true, turn, completionEvents: [event] });
      continue;
    }
    if ((event.type !== 'assistant/message' && event.type !== 'turn/end')
      || previous.turn !== turn || previous.wasRunning !== true) continue;
    const priorEvents = Array.isArray(previous.completionEvents) ? previous.completionEvents : [];
    const events = [...priorEvents.filter((item) => item.type !== event.type), event];
    const next = { ...previous, running: event.type === 'turn/end' ? false : previous.running, completionEvents: events };
    if (event.type === 'turn/end') confirmCompletionFromHistory(next, events, false);
    states.set(sessionId, next);
  }
}

function updateCompletionStates(ctx, items, deviceKey = 'legacy') {
  const states = completionStateOf(ctx, deviceKey);
  const seen = new Set();
  for (const summary of items || []) {
    if (!summary || typeof summary.sessionId !== 'string' || !summary.sessionId) continue;
    seen.add(summary.sessionId);
    const running = !!summary.running;
    const previous = states.get(summary.sessionId);
    // 不靠状态边沿猜完成：下面的 history 折叠必须自己找到同轮的 turn/end。
    const completed = previous?.completed === true;
    states.set(summary.sessionId, {
      running,
      completed: running ? false : completed,
      turn: previous?.turn,
      // 只决定「允许追到多久以前」（见 baselineOf），不再是确认完成的前提。
      wasRunning: previous?.running === true || previous?.wasRunning === true,
      completionEvents: previous?.completionEvents,
      clearedAt: previous?.clearedAt, // 已读水位跨快照延续，读过的轮次不许再亮回来
      // 「上一轮失败」只能由 history 折出，必须跨快照、跨下一轮延续：否则用户失败后
      // 又发一句话，state.turn 前进，红点还没被看见就没了。
      failure: previous?.failure,
    });
  }
  // 列表是本设备作用的权威：不在列表里的条目要丢（防止复用 id 串状态）。带已读水位的
  // 留着 —— 丢了水位，会话离开列表再回来时旧轮次会重新点亮。
  for (const sessionId of states.keys()) {
    if (!seen.has(sessionId) && typeof states.get(sessionId)?.clearedAt !== 'number') states.delete(sessionId);
  }
  return states;
}

/** 把 history 最后一轮的结局折到 state 上：结束时刻越过 baselineOf 才算提醒。 */
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
  if (running || state.turn === undefined) return;
  const end = ends.get(state.turn);
  if (!end) return;
  const baseline = baselineOf(state);
  const endedAt = typeof end.time === 'number' ? end.time : baseline + 1;
  if (endedAt <= baseline) return; // 读过的 / 冷启动之前结束的那一轮
  const assistant = assistants.get(state.turn);
  const reason = end.data ? end.data.reason : undefined;
  const kind = reason && typeof reason.kind === 'string' ? reason.kind : undefined;
  // 本轮以错误收尾：宿主不会再补一条最终消息，但它刚刚追加过 turn/end —— 下面那条
  // 「assistant 早于 turn/end 就算完成」的规则会把这种轮次判成「已完成待读」，侧栏于是
  // 把一次失败显示成绿点。失败是宿主列表摘要里没有的信息，只能在这里折出来交给 App。
  if (kind === 'error') {
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
  if (kind !== undefined && kind !== 'completed') {
    state.completed = false;
    state.failure = undefined;
    return;
  }
  // The assistant message must be the settled message for this turn, not an
  // interrupted partial and not merely a preceding turn's message.
  if (assistant && assistant.seq <= end.seq && assistant.data.interrupted !== true) {
    state.completed = true;
    // 成功收尾的轮次覆盖旧失败：标记必须跟着最新一次运行走。
    state.failure = undefined;
  }
}

module.exports = { observeCompletionEvent, updateCompletionStates, confirmCompletionFromHistory };

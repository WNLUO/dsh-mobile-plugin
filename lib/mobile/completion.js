'use strict';

/**
 * 完成提醒状态机：一轮怎么结束以 history 为准（turn/end 的 reason.kind），实时 turn
 * 事件只是让结论早一步到达。提醒算不算数看两个水位：读过的时刻之前不算，本进程启动
 * 之前结束的轮次也不重播 —— 不再要求「先看见 running」。
 *
 * 旧要求的后果（2026-10-17 真机）：宿主没采到那一瞬间的轮次永远不亮，桌面亮着绿点 /
 * 红点，手机上什么都没有。
 *
 * ⚠️ 这里有两笔**性质不同**的账，别混回去：
 *
 *   - `completionState*`（按设备）：**哪台手机还没看过这一轮**。它是提醒，只有 App 的
 *     `/session/read` 能清，天然属于「谁在问」。后台通知（/monitor）还靠它。
 *   - `lastTurnFactsOf`（不分设备）：**这一轮什么时候结束的、成没成**。它是事实，跟
 *     谁在问无关，所以列表行可以直接带它去镜像快照 —— 而快照是全局一份、给所有设备读的。
 *
 * 之前列表行只带前者，镜像又是用固定设备键构建的，于是快照里那份「未读」永远清不掉：
 * 手机上点开看过，侧栏的绿点/红点照样挂着，而绕过镜像的那种读又立刻变干净 —— 同一行
 * 一会儿一个状态。现在 App 侧自己拿事实 + 本机已读水位算「亮不亮」，两笔账各归各位。
 */

const { completionStateOf, completionStateMapsOf } = require('./session-cache.js');
const { settleOutcome, recordLastTurn } = require('./session-last-turn.js');

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
    if (event.type === 'turn/end') confirmCompletionFromHistory(next, events, false, ctx, sessionId);
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

/**
 * 把 history 最后一轮的结局折到 state 上：结束时刻越过 baselineOf 才算提醒。
 *
 * 事实那一半（这一轮什么时候结束、成没成）由 `session-last-turn.js` 记下来，与设备无关；
 * 这里只维护提醒。传了 `ctx` + `sessionId` 就顺手把事实记进去，**不受已读水位影响** ——
 * 它说的是「这一轮怎么结束的」，跟哪台手机看过没关系（见文件头）。
 */
function confirmCompletionFromHistory(state, events, running, ctx = null, sessionId = null) {
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
  const outcome = settleOutcome({ turn: state.turn, end, assistant: assistants.get(state.turn) });
  if (ctx && sessionId) recordLastTurn(ctx, sessionId, outcome);
  const baseline = baselineOf(state);
  if (outcome.endedAt <= baseline) return; // 读过的 / 冷启动之前结束的那一轮
  if (outcome.status === 'failed') {
    state.completed = false;
    state.failure = {
      turn: outcome.turn,
      code: outcome.code,
      message: outcome.message,
      at: outcome.endedAt,
    };
    return;
  }
  // max-tokens / aborted 等：这一轮没跑完，同样不能报完成；但它没有错误码可显示，
  // 所以只清完成标记，不产生红点。
  if (outcome.status === 'incomplete') {
    state.completed = false;
    state.failure = undefined;
    return;
  }
  state.completed = true;
  // 成功收尾的轮次覆盖旧失败：标记必须跟着最新一次运行走。
  state.failure = undefined;
}

module.exports = { observeCompletionEvent, updateCompletionStates, confirmCompletionFromHistory };

'use strict';

/**
 * 直播中的工作流运行：把这一轮收到的 `tool-workflow/*` 事件攒成一份，每次变化重算整棵树。
 *
 * 为什么不复用历史那条路：历史要等这一轮落盘、下一次拉才会带上；而「一条工作流正在跑、
 * 下面三个成员谁在跑谁完了」正是用户此刻最想看的。桌面也是直播的（`workflow-run` 节点
 * 跟着 `agent-start` / `agent-end` 就地长）。
 *
 * 形状与历史那条**同一份实现**（`workflow-runs.js` 的 `deriveWorkflowRuns`）：两处各写一遍，
 * 迟早漂成「直播里阶段是平的、重进会话又变成树」。
 *
 * 攒的是**整轮**的事件而不是单条：一条运行的成员会陆续来，只按最后一条事件折出来永远是
 * 孤零零一个成员。容量口径照 `live-steps.js`：只留当前这一轮（`turn/start` 清），进程里
 * 最多留几条会话。
 */

const MAX_SESSIONS = 4;

const { workflowLiveOf } = require('./session-cache.js');
const { deriveWorkflowRuns } = require('./workflow-runs.js');

/**
 * 收一条工作流事件，返回重算后的全部运行（没有变化时返回 null）。
 *
 * @param {object} ctx 插件上下文（按它分桶）。
 * @param {string} sessionId 会话 id。
 * @param {object} event 会话事件（`session/event` 里那一条）。
 * @returns {Array<object>|null} 变化了就是整份运行清单，否则 null（调用方据此决定发不发帧）。
 */
function noteWorkflowEvent(ctx, sessionId, event) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return null;
  if (!event || typeof event.type !== 'string') return null;
  // 新的一轮：上一轮的工作流记录作废（与直播过程副本同一时机，见 live-steps.js）。
  if (event.type === 'turn/start') {
    resetWorkflowLive(ctx, sessionId);
    return null;
  }
  if (!event.type.startsWith('tool-workflow/')) return null;
  const store = workflowLiveOf(ctx);
  let state = store.get(sessionId);
  if (!state) {
    // 会话数封顶：超了先丢最早进来的那条（Map 的插入序就是它）。
    if (store.size >= MAX_SESSIONS) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    state = { entries: [], runs: [] };
    store.set(sessionId, state);
  }
  state.entries.push({ event });
  // 整窗重折：一条事件就能改阶段划分（第一个带 phase 的成员进来时阶段才成形），增量改不干净。
  state.runs = deriveWorkflowRuns(state.entries);
  return state.runs;
}

/** 这一轮开始：上一轮的工作流作废（换轮了，别再让上面那条卡留在屏幕上）。 */
function resetWorkflowLive(ctx, sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return;
  workflowLiveOf(ctx).delete(sessionId);
}

/** 当前这份运行清单（没有就是空数组）。 */
function workflowRunsOf(ctx, sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return [];
  const state = workflowLiveOf(ctx).get(sessionId);
  return state ? state.runs : [];
}

module.exports = {
  noteWorkflowEvent,
  resetWorkflowLive,
  workflowRunsOf,
};

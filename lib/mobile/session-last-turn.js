'use strict';

/**
 * 「上一轮怎么结束的」——会话自己的**设备无关事实**。
 *
 * 与 completion.js 的分工：那边是「哪台手机还没看过」的提醒账（按设备），这里是「这一轮
 * 什么时候结束、成没成」。两者曾是一笔账，于是列表行只能带「未读」这个含义 —— 而列表还要
 * 喂镜像快照，快照是全局一份、给所有设备读，按设备算的结论在里面永远是同一台假设备的，
 * 手机上点开看过也不灭。现在 App 拿这份事实 + 本机已读水位自己算点（见
 * `app/src/services/viewmodels/session-status.ts`）。
 *
 * 抽成独立模块的理由与 completion.js 当初一样：它是**纯计算 + 一张表**，不碰 ctx 的其它
 * 状态，守卫要能单独驱动它（`test/session-last-turn.test.cjs`）。
 */

const { lastTurnFactsOf } = require('./session-cache.js');
const readReceipts = require('../read-receipt.cjs');

/**
 * 本进程的起点：只有它**之前**留下的已读水位才需要从盘上补回来（见 `lastTurnOf`）。
 * 本进程内的读一律由 `recordSessionRead` 当场写进内存那张表，不必再查盘。
 */
const PROCESS_STARTED_AT = Date.now();

/**
 * 一轮的结局：纯计算，不碰水位、不碰设备。
 *
 * 两条既有铁律照旧：error 收尾不算完成（并带失败信息）；成功那句 assistant 必须是本轮
 * 已落定的那条（`seq <= end.seq` 且没被打断），不能拿上一轮的冒充。
 */
function settleOutcome({ turn, end, assistant }) {
  const endedAt = typeof end.time === 'number' ? end.time : 0;
  const reason = end.data ? end.data.reason : undefined;
  const kind = reason && typeof reason.kind === 'string' ? reason.kind : undefined;
  // 本轮以错误收尾：宿主不会再补一条最终消息，但它刚刚追加过 turn/end —— 「assistant
  // 早于 turn/end 就算完成」那条规则会把这种轮次判成「已完成待读」，侧栏于是把一次失败
  // 显示成绿点。失败是宿主列表摘要里没有的信息，只能在这里折出来交给 App。
  if (kind === 'error') {
    const error = reason && reason.error && typeof reason.error === 'object' ? reason.error : {};
    return {
      turn,
      endedAt,
      status: 'failed',
      code: typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message : null,
    };
  }
  // max-tokens / aborted 等：这一轮没跑完，同样不能报完成；但它没有错误码可显示，
  // 所以只清完成标记，不产生红点。
  if (kind !== undefined && kind !== 'completed') return { turn, endedAt, status: 'incomplete' };
  const settled = Boolean(assistant) && assistant.seq <= end.seq && assistant.data.interrupted !== true;
  return { turn, endedAt, status: settled ? 'completed' : 'incomplete' };
}

/**
 * 记下「上一轮事实」：只前进不后退。
 *
 * 同一轮会被折叠多次（列表缓存命中、多台设备各自构建清单、事件流与 history 两条路），
 * 结束时刻往回拨会让 App 侧刚清掉的点重新亮起来，所以更旧的一律丢弃。
 */
function recordLastTurn(ctx, sessionId, outcome) {
  if (!ctx || !sessionId || !outcome) return;
  const facts = lastTurnFactsOf(ctx);
  const previous = facts.get(sessionId);
  if (previous && typeof previous.turn === 'number') {
    if (outcome.turn < previous.turn) return;
    if (outcome.turn === previous.turn && outcome.endedAt <= previous.endedAt) return;
  }
  facts.set(sessionId, {
    turn: outcome.turn,
    endedAt: outcome.endedAt,
    status: outcome.status,
    ...(outcome.status === 'failed' ? { code: outcome.code, message: outcome.message } : {}),
    // 已读水位是**另一件事**的产物（任何一端读过都会推进），换新的事实时必须原样带上，
    // 否则刚读过的一轮会因为「又折了一次 history」重新亮起来。
    ...(previous && typeof previous.readAt === 'number' ? { readAt: previous.readAt } : {}),
  });
}

/**
 * 记下「这条会话在某一刻被读过了」——**不分设备**。
 *
 * 两端的读都要走到这里：手机点开（`/session/read`，那条本来就只清本设备的提醒）与
 * 桌面点开（`/api/relay/desktop-read`，清所有设备的提醒）。列表要喂镜像快照，快照是
 * 全局一份，没法按设备算「你看过没有」，所以只有这个与设备无关的水位能进下行清单。
 *
 * 只前进不后退：两端各自报各自的时刻，回拨会让已经看过的点重新亮。返回值是「水位真的
 * 前进了没有」——调用方据此决定要不要作废列表缓存（重复上报不许每次都抬）。
 */
function recordSessionRead(ctx, sessionId, at = Date.now()) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return false;
  const value = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : Date.now();
  const facts = lastTurnFactsOf(ctx);
  const previous = facts.get(sessionId) || {};
  const current = typeof previous.readAt === 'number' ? previous.readAt : 0;
  // 同时落一份到盘上（lib/read-receipt.cjs）：内存这张表随进程消失，而 App 侧栏的绿点
  // 靠的正是这里的水位 —— 桌面读过之后宿主一重启，同一轮又被算成未读（2026-10-26 真机）。
  try { readReceipts.recordRead(sessionId, value); } catch { /* 台账是旁路 */ }
  if (current >= value) return false;
  facts.set(sessionId, { ...previous, readAt: value });
  return true;
}

/**
 * 某个会话的上一轮事实（没有就返回 undefined）。
 *
 * 只回带 `turn` 的那些：表里也可能只存着一个已读水位（读过、但插件重启后还没折过
 * 那一轮的结局），那不是「上一轮发生了什么」，不该下发给 App。
 *
 * 进程刚起来时那张表是空的，「桌面读过」只留在盘上那本台账里 —— 不补回来的话 App 会按
 * 「没人读过」重算，早就读过的一轮又亮成绿点。只补上一次进程留下的那些（本进程里的读
 * 已经在表里了），补到的值写回表里，让后面的折叠沿用。
 */
function lastTurnOf(ctx, sessionId) {
  const facts = lastTurnFactsOf(ctx);
  const fact = facts.get(sessionId);
  if (!fact || typeof fact.turn !== 'number') return undefined;
  const restored = readReceipts.readAtOf(sessionId);
  const current = typeof fact.readAt === 'number' ? fact.readAt : 0;
  if (!(restored > 0 && restored < PROCESS_STARTED_AT) || current >= restored) return fact;
  const next = { ...fact, readAt: restored };
  facts.set(sessionId, next);
  return next;
}

module.exports = { settleOutcome, recordLastTurn, recordSessionRead, lastTurnOf };

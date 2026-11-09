'use strict';

/**
 * 「最近失败过的那几轮」——补投用的失败账。
 *
 * 为什么需要单独一笔：`session-last-turn.js` 的事实表只留**最新一轮**（那是列表与镜像要的
 * 形状），而离线期间的补投要看的是「这一段时间里发生过什么」。于是一个会话先失败、随后又
 * 跑成功时，事实表只剩那条成功，中间那次失败在任何一端都收不到 —— 而失败的轮次恰恰是最该
 * 让人知道的那种。完成可以折叠成一条通知，失败不能。
 *
 * 只留最近若干轮、按轮次递增存放：这是补投要用的短账，不是历史档案。纯函数 + 数组，
 * 不碰 ctx，守卫可以单独驱动它（`test/recent-failures.test.cjs`）。
 */

/** 保留条数：够补一次离线积压（一小时里跑坏五六轮已属异常），又不会把账撑成档案。 */
const MAX_FAILED_TURNS = 5;

/** 账里的一条：轮次号 + 结束时刻，失败码与文案原样带上（横幅要显示）。 */
function entryOf(outcome) {
  const entry = { turn: outcome.turn, endedAt: outcome.endedAt };
  if (outcome.code != null) entry.code = outcome.code;
  if (outcome.message != null) entry.message = outcome.message;
  return entry;
}

/**
 * 收进一次结局，返回新的数组（不改入参）。
 *
 * 只认 `failed`；同一轮重复折叠（列表 / 监控 / 事件流三条路各折一次）不会产生两条。
 * 成功与 `incomplete` 不清掉已有的失败账：它们只是「后来又跑了一轮」，不改变「这一轮曾经
 * 失败过」这个事实 —— 清账是补投那侧的事（补过就该消掉），不是这里。
 */
function mergeFailedTurn(existing, outcome) {
  const kept = Array.isArray(existing)
    ? existing.filter((item) => item && typeof item.turn === 'number' && item.turn !== outcome?.turn)
    : [];
  if (!outcome || outcome.status !== 'failed' || typeof outcome.turn !== 'number') return kept;
  return kept.concat([entryOf(outcome)]).slice(-MAX_FAILED_TURNS);
}

/** 账里还没被补投过、且不算「已经被读过」的那些失败轮次。 */
function pendingFailedTurns(existing, readAt) {
  if (!Array.isArray(existing)) return [];
  const floor = typeof readAt === 'number' && readAt > 0 ? readAt : 0;
  return existing.filter((item) => item && typeof item.endedAt === 'number' && item.endedAt > floor);
}

module.exports = { MAX_FAILED_TURNS, mergeFailedTurn, pendingFailedTurns };

'use strict';

/**
 * 隔离工作树的自动回收：把「会话结束了」这件事翻译成「删掉它那棵树」。
 *
 * ## 为什么挂在会话列表刷新上
 *
 * 移动端没有一条「这条会话结束了」的端点 —— 归档（`workspace/archive-session`）、清理已归档
 * （`workspace/clear-archived`）、在桌面端删掉、宿主自己回收，四条路都会让会话从宿主清单里
 * 消失，但只有前两条经过插件。拿「某条会话这一轮还在不在宿主清单里」当唯一判据，四条路
 * 就都盖住了，而且判据只有一处，不会随生命周期钩子的增减漂。
 *
 * 判据因此是两条，任一成立就收：
 *  1. 它进了归档集合（`workspace.list` 的 `archivedSessionIds`）—— 归档是移动端唯一的「删除」语义；
 *  2. 它已经不在宿主会话清单里（桌面端删了 / 宿主回收了）。
 *
 * ## 为什么是「顺手」而不是「必须」
 *
 * 列表刷新很频繁（十几秒一次），回收跟着它跑，省掉一个定时器；但**回收失败绝不能把列表
 * 打坏**：整段是 fire-and-forget，错误吞掉只记日志。真正的兜底仍然是手工 `git worktree
 * prune` —— 这条只是让常态不需要人去点。
 *
 * 加一道节流与在途锁：同一时刻只跑一次，两次之间至少隔 `SWEEP_INTERVAL_MS`。列表那一发
 * 本来就是热点路径，不能每条会话都去碰盘。
 */

const { releaseForSessions, registeredIsolations } = require('./worktree-isolation.js');
// 节流状态按 ctx 隔离：这类模块级可变状态只许住在 session-cache.js（见 module-split 守卫）。
const { isolationSweepStateOf } = require('./session-cache.js');

/** 两次回收之间至少隔多久。太频繁就是在列表的热点路径上反复读盘。 */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * 按「这一轮还在的会话」收掉已经结束那些会话的树。
 *
 * @param {object} ctx 插件上下文
 * @param {{ liveSessionIds?: Iterable<string>, archivedSessionIds?: Iterable<string> }} alive
 *   `liveSessionIds`：宿主清单里还在的会话；`archivedSessionIds`：归档集合。
 *   两个都没给就什么都不做。
 * @param {{ force?: boolean, now?: number }} [options] `force` 跳过节流（测试用）。
 */
async function sweepIsolationWorktrees(ctx, alive = {}, options = {}) {
  const state = isolationSweepStateOf(ctx);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (state.running) return null;
  if (!options.force && now - state.lastAt < SWEEP_INTERVAL_MS) return null;

  const live = new Set(alive && alive.liveSessionIds ? alive.liveSessionIds : []);
  const archived = new Set(alive && alive.archivedSessionIds ? alive.archivedSessionIds : []);
  // 两组都空 = 这一轮没拿到清单（宿主回了一份形状不对的东西）。那时不能把登记表里的树
  // 全判成孤儿 —— 「读不到」不等于「全没了」。
  if (live.size === 0 && archived.size === 0) return null;

  const dead = [];
  for (const [key, entry] of Object.entries(registeredIsolations())) {
    if (!key.startsWith('session:')) continue;
    const sessionId = key.slice('session:'.length);
    if (entry && entry.keep === true) continue;
    if (archived.has(sessionId) || !live.has(sessionId)) dead.push(sessionId);
  }
  if (dead.length === 0) {
    state.lastAt = now;
    return { released: [], kept: [], failed: [] };
  }

  state.running = true;
  try {
    const result = await releaseForSessions(dead);
    state.lastAt = now;
    return result;
  } catch {
    return null;
  } finally {
    state.running = false;
  }
}

module.exports = { sweepIsolationWorktrees, SWEEP_INTERVAL_MS };

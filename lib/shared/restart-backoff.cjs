// 进程守护的重启节奏：先用一段指数退避扛过瞬时故障，退避表用尽后转固定长间隔无限重试，
// 不再像旧实现那样耗光几次机会就永久停机。固定档带抖动，避免一批宿主在同一刻齐步回来。
'use strict';

/** 退避表用尽后的固定重试间隔（毫秒）。对齐 tailcat 的「封顶但不放弃」。 */
const STEADY_INTERVAL_MS = 60_000;
/** 固定档的抖动幅度（正负比例）。 */
const STEADY_JITTER_RATIO = 0.2;

/**
 * 第 `retries` 次（从 0 起）重试该等多久。
 *
 * 退避表里还有档位就用表里的值（无抖动，行为与旧实现一致）；用尽后转固定长间隔，
 * 并在 `steadyMs ± steadyMs * jitterRatio` 之间抖动一次，把一批同时掉线的宿主摊开。
 *
 * @returns {{ ms: number, steady: boolean }} `steady` 为真表示已进入固定重试档。
 */
function nextRestartDelay(retries, {
  delays,
  steadyMs = STEADY_INTERVAL_MS,
  jitterRatio = STEADY_JITTER_RATIO,
  random = Math.random,
} = {}) {
  if (!Array.isArray(delays) || delays.length === 0) throw new Error('nextRestartDelay: delays 必须是非空数组');
  const index = Math.max(0, Math.floor(Number(retries) || 0));
  if (index < delays.length) return { ms: delays[index], steady: false };
  const spread = steadyMs * jitterRatio;
  const ms = Math.max(0, Math.round(steadyMs + (random() * 2 - 1) * spread));
  return { ms, steady: true };
}

module.exports = { nextRestartDelay, STEADY_INTERVAL_MS, STEADY_JITTER_RATIO };

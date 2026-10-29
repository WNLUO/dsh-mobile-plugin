'use strict';

/**
 * 会话统计投影：handleStats 与镜像推送共用的那一份取数口径。
 *
 * 0.2.0 把整帧投影从 history/page 的返回值里拆走了，「拉一条历史顺带取投影」这条路断了；
 * 改走 `apiProxy.sessions.projections({ request: { sessionId } })`，返回值是
 * `{ asOfSeq, values }`。顺带把 plan 归一化成 planMode（排队条与计划条读它）。
 * 历史轮询是每 15 秒一次的热路径，多背一次投影 RPC 划不来，所以统计单独走投影端点。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');

/**
 * 镜像快照用的统计投影（与 handleStats 尾部投影读取保持一致）：取整帧 projections，
 * 并把 plan 归一化为 planMode，供 pushMirror 为活跃会话生成统计快照。
 */
async function buildStatsSnapshot(ctx, sessionId) {
  return statsProjections(ctx, sessionId);
}

/**
 * 统计投影快照（handleStats 与 buildStatsSnapshot 共用）。
 */
async function statsProjections(ctx, sessionId) {
  // 显式给 signal：宿主部分方法内部直接读 signal.aborted，不做 undefined 兜底。
  const controller = new AbortController();
  let value;
  let error;
  try {
    ({ value, error } = unwrap(await callSessions(ctx, 'projections', { sessionId }, 'mobile', controller.signal)));
  } catch (thrown) {
    // 投影读不出来不该变成一个从路由层逃出去的 rejection：handleStats 要回 400，
    // pushMirror 那边更是一条都不能抛（抛了整帧快照就丢了）。收敛成正常错误态。
    error = thrown && typeof thrown === 'object' && typeof thrown.code === 'string'
      ? { code: thrown.code, message: typeof thrown.message === 'string' ? thrown.message : '读会话投影失败' }
      : { code: 'host-call-failed', message: thrown && thrown.message ? String(thrown.message) : '读会话投影失败' };
  }
  if (error) return { ok: false, error };
  const projections = value && value.values && typeof value.values === 'object' ? value.values : {};
  const plan = projections.plan;
  return {
    ok: true,
    projections: plan && typeof plan === 'object' && typeof plan.active === 'boolean'
      ? { ...projections, planMode: { active: plan.active, ...(typeof plan.pending === 'boolean' ? { pending: plan.pending } : {}) } }
      : projections,
  };
}

module.exports = { buildStatsSnapshot, statsProjections };

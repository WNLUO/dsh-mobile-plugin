'use strict';

/** 目标条动作透传：edit / pause / resume / clear。ref 来自 goal 会话投影，宿主以它做 CAS。 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');

/** 调宿主 apiProxy.goals.*（目标条的动作：edit/pause/resume/clear）。 */
function callGoals(ctx, method, payload) {
  return ctx.apiProxy.goals[method]({ rpcId: 'mobile', method: `goals.${method}`, payload });
}

/**
 * POST /api/mobile/v1/session/goal（token）{ action, ref, objective? }
 * 目标条动作透传：pause / resume / clear / edit（edit 需 objective）。
 * ref 来自 goal 会话投影（{id, revision}），宿主以 ref 做 CAS 守卫。
 */
async function handleGoalAction(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const action = body && typeof body.action === 'string' ? body.action : '';
  const ref = body && body.ref;
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!action || !sessionId || !ref || typeof ref !== 'object') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, action, ref }' } });
  }
  if (action === 'edit') {
    const objective = body.objective;
    if (typeof objective !== 'string' || !objective.trim()) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'edit 需要非空 objective' } });
    }
    const { value, error } = unwrap(await callGoals(ctx, 'edit', { sessionId, ref, objective: objective.trim() }));
    if (error) return sendJson(res, 400, { ok: false, error });
    return sendJson(res, 200, { ok: true, ...(value || {}) });
  }
  const allowed = new Set(['pause', 'resume', 'clear']);
  if (!allowed.has(action)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `不支持的目标动作: ${action}` } });
  }
  const { value, error } = unwrap(await callGoals(ctx, action, { sessionId, ref }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, ...(value || {}) });
}

module.exports = { callGoals, handleGoalAction };

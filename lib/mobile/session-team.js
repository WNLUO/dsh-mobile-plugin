'use strict';

/**
 * 会话级「启用智能体团队协作」的写路由。
 *
 * 这个开关不是模型目录里的附加选项：它落在**这条会话自己的日志**里（宿主
 * `agentTeams.setEnabled` 往根会话追加一条 `team/mode` 事件），新会话默认关。
 * 桌面端把它画在 composer 的模型菜单里，手机要跟着开同一件事，就不能只读投影。
 *
 * 三条口径写在下面，别顺手改成别的样子：
 *  1. **只有根会话能改**：宿主对子会话一律回 `TEAM_LEAD_REQUIRED`，这里不提前拦、
 *     让宿主自己判 —— 手机判断根不根依赖本地视图，判错了就是「界面上能点、点上没反应」。
 *  2. **读仍然是投影**：当前值从 `/session/stats` 的 `agentTeam.enabled` 来，这条路由只写。
 *     统计投影那条路本来就不带缓存（每次现读宿主 projections），所以写完立刻再读一次
 *     就能看到新状态，不需要在这里作废什么。
 *  3. **宿主没装团队插件是常态**：那种宿主没有 `agentTeams` 服务，网关会回
 *     `host-unavailable`；如实回报，界面据此说「这台电脑没开团队」，不要假装成功。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');

/** 调宿主 apiProxy.agentTeams.setEnabled（见 host-bridge/endpoints.js 里那一条）。 */
function callAgentTeams(ctx, payload) {
  return ctx.apiProxy.agentTeams.setEnabled({ rpcId: 'mobile', method: 'agentTeams.setEnabled', payload });
}

/**
 * 这台电脑装没装「智能体团队」：宿主有没有注册 `agentTeams` 服务。
 *
 * 挂在 `/status` 心跳上，是因为**新对话页没有会话号**：那一页读不到 `/session/stats` 的
 * `agentTeam` 投影，判断「那一行画不画」在真会话上靠投影、在临时页上只能靠这一格。
 * 不给这一格的话，用户新建对话时那一行会整个消失、进会话才冒出来（看着像坏了）。
 *
 * 同进程直查 `ctx.get`（与 schedule / jobController 那几条同一套）：服务不在时只让这一格
 * 变成 false，跑不进任何装配代码。拿不到 ctx 也按「没有」处理 —— 那是异常路径，不是能力。
 */
function hasAgentTeams(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return false;
    return Boolean(ctx.get('agentTeams'));
  } catch {
    return false;
  }
}

/** POST /api/mobile/v1/session/team-mode（token）{ sessionId, enabled } */
async function handleSessionTeam(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId ||
      typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, enabled }' } });
  }
  const { value, error } = unwrap(await callAgentTeams(ctx, { sessionId: body.sessionId, enabled: body.enabled }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, enabled: body.enabled, ...(value || {}) });
}

module.exports = { callAgentTeams, handleSessionTeam, hasAgentTeams };

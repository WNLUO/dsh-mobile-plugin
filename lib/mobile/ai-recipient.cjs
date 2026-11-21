/** 已知自建端点在接入 prompt 前核对当前模型与配置；不读取凭据，不承诺队列未来每步的路由。 */
'use strict';
const { unwrap } = require('./envelope.js');

function publicEndpoint(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}
function refusal(code) {
  return { code, message: code === 'ai-recipient-changed'
    ? '模型接收方已改变，请回到手机重新确认后发送。'
    : '这台电脑无法核实已确认的模型接收方，请更新插件或重新确认当前路由。' };
}

/** 缺省字段保留逐消息授权电脑当前路由的旧路径；显式字段不允许悄悄降级。 */
async function expectedAiRecipientError(ctx, { sessionId, expected, selection, child = false }) {
  if (expected === undefined) return null;
  if (!expected || typeof expected !== 'object' || typeof expected.provider !== 'string'
      || !expected.provider.trim() || !publicEndpoint(expected.endpoint)) {
    return { code: 'bad-request', message: 'expectedAiRecipient 需要 { provider, endpoint }。' };
  }
  const provider = expected.provider.trim();
  const endpoint = publicEndpoint(expected.endpoint);
  if (selection && selection.provider !== provider) return refusal('ai-recipient-changed');
  try {
    const llm = ctx.get && ctx.get('llm');
    if (!llm || typeof llm.resolveCallConfig !== 'function') return refusal('ai-recipient-unverifiable');
    const agents = ctx.get && ctx.get('agents');
    let agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null;
    if (!agent && !child) {
      const controller = ctx.get && ctx.get('sessionController');
      if (controller && typeof controller.resolveAgent === 'function') {
        const resolved = await controller.resolveAgent(sessionId);
        if (resolved && !resolved.error) agent = resolved.agent;
      }
    }
    const actual = agent && agent.model && typeof agent.model.current === 'function' ? agent.model.current() : null;
    if (!actual || !actual.provider || !actual.model) return refusal('ai-recipient-unverifiable');
    if (actual.provider !== provider) return refusal('ai-recipient-changed');
    // 这是宿主当前模型配置校验，不把客户端声称的 route 当成实际 route。
    const resolved = await llm.resolveCallConfig(actual);
    if (!resolved || resolved.provider !== actual.provider || resolved.model !== actual.model) return refusal('ai-recipient-unverifiable');
    const settings = unwrap(await ctx.apiProxy.settings.describe({ rpcId: 'mobile', method: 'settings.describe', payload: {} }));
    if (settings.error) return refusal('ai-recipient-unverifiable');
    const rows = Array.isArray(settings.value) ? settings.value : settings.value && settings.value.namespaces;
    const namespace = Array.isArray(rows) ? rows.find((row) => row && row.ns === 'llm-pi-ai') : null;
    const profiles = namespace && namespace.value && namespace.value.providers;
    const profile = profiles && Object.hasOwn(profiles, provider) ? profiles[provider] : null;
    // llm-pi-ai 的显式 baseURL 覆盖全部模型端点；无显式值时内置模型可能各用自己的端点。
    const actualEndpoint = publicEndpoint(profile && profile.baseURL);
    if (!actualEndpoint) return refusal('ai-recipient-unverifiable');
    if (actualEndpoint !== endpoint) return refusal('ai-recipient-changed');
    return null;
  } catch {
    return refusal('ai-recipient-unverifiable');
  }
}
module.exports = { publicEndpoint, expectedAiRecipientError };

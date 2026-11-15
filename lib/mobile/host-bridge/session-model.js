/** 手机模型选择只写当前会话，通过公开 Agent 能力保存，不改宿主默认配置。 */
'use strict';
const { ok, fail, unsupported } = require('./transport.js');

async function selectSessionModel(ctx, payload) {
  try {
    const controller = ctx.get && ctx.get('sessionController');
    const llm = ctx.get && ctx.get('llm');
    if (!controller || typeof controller.resolveAgent !== 'function' || !llm) {
      return unsupported('仅切换当前会话模型的能力');
    }
    const resolved = await controller.resolveAgent(payload.sessionId);
    if (resolved.error) return fail(resolved.error);
    const agent = resolved.agent;
    if (!agent || !agent.model || typeof agent.model.select !== 'function') {
      return unsupported('仅切换当前会话模型的能力');
    }
    const selected = { provider: payload.provider, model: payload.model,
      ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}) };
    const providers = llm.listProviders();
    const models = providers.some((provider) => provider.id === selected.provider)
      ? await llm.listModels(selected.provider) : [];
    if (!models.some((model) => model.id === selected.model)) {
      return fail({ code: 'session/model-unavailable', message: 'Select an available model before sending a message.',
        details: { provider: selected.provider, model: selected.model } });
    }
    await llm.resolveCallConfig(selected);
    agent.model.select(selected);
    return ok({ selected: { ...selected } });
  } catch (error) {
    return fail(error, 'session/model-unavailable');
  }
}

module.exports = { selectSessionModel };

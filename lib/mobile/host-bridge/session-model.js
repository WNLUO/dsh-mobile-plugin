/** 手机模型选择等待宿主服务就绪，只写当前会话，不改宿主默认配置。 */
'use strict';
const { ok, fail, unsupported } = require('./transport.js');

async function selectSessionModel(ctx, payload) {
  try {
    let controller = ctx.get && ctx.get('sessionController');
    let llm = ctx.get && ctx.get('llm');
    // 与网关流一致：启动或就地重载期间服务可能晚于移动路由出现，等待后重新读取。
    if (!controller || !llm) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      controller = ctx.get && ctx.get('sessionController');
      llm = ctx.get && ctx.get('llm');
    }
    if (!controller || !llm) {
      return fail({ code: 'host-unavailable', message: '宿主模型服务尚未就绪，请稍后重试' });
    }
    if (typeof controller.resolveAgent !== 'function') {
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

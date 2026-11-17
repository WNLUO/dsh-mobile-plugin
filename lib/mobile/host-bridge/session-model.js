/** 手机模型选择等待宿主服务就绪，只写当前会话；缺能力时区分「宿主太老」与「这条会话没有可切模型」。 */
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
    // 会话恢复出来了，但这类会话本身没有可切换的模型（特殊会话/子代理）：问题在会话，不在版本。
    if (!agent || !agent.model) {
      return fail({ code: 'host-unsupported', message: '这条会话当前没有可切换的模型' });
    }
    // 会话有模型对象却没有 select：是宿主 Agent.model 能力缺失，确实要更新宿主。
    if (typeof agent.model.select !== 'function') {
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

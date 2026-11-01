'use strict';

/**
 * 模型能力配置（移动端）：公开参数快照 + 把用户选的那份写回这台电脑的渠道。
 *
 * 两条路由：
 *   - `GET /api/mobile/v1/model-meta`（token）：整份公开参数快照（App 拉一次、落盘缓存，
 *     之后搜索与命中都在 App 端做，断网 / 连不上 GitHub 都不影响）。另带 `overrides`：
 *     `llm-pi-ai` 里每条自建路由**已经显式写下的**能力字段，弹窗用它把当前值填对。
 *   - `POST /api/mobile/v1/model-meta/apply`（token）：把一份配置写进那条自建渠道的模型。
 *
 * 为什么只在插件这一侧写：渠道真源是宿主的 `llm-pi-ai` 命名空间，手机没有直接读写宿主配置的
 * 通道，这一层做的与「渠道管理」保存时完全一样 —— `settings.describe` 读出那一条路由、
 * 合并这一份模型的能力字段、再按路径 `settings.mutate` 写回去（只写 `providers.<id>`，
 * 不碰别的路由）。内置渠道（别的插件注册的 provider）不在这份清单里，**一律 409 说明改不了**，
 * 不给一个点了必然失败的保存按钮留后路。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { dropSessionModelsForDevice } = require('./session-cache.js');
const modelMeta = require('./model-meta.js');

/** 自建渠道写在这个命名空间里；与 `channels.js` 的 PI_AI_NS 同一个。 */
const PI_AI_NS = 'llm-pi-ai';

const MAX_PROVIDER_CHARS = 64;
const MAX_MODEL_CHARS = 200;
/** 上下文 / 输出上限的合理上限：再大就不是 token 数了（1 千万已经远超人能用的窗口）。 */
const MAX_TOKENS = 10_000_000;

/** `llm-pi-ai` 的 providers 字典；形状不对就当空表。 */
function piAiProvidersOf(value) {
  const providers = value && typeof value === 'object' && !Array.isArray(value) ? value.providers : null;
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {};
}

async function readPiAiProviders(ctx) {
  const describe = unwrap(await ctx.apiProxy.settings.describe({
    rpcId: 'mobile',
    method: 'settings.describe',
    payload: {},
  }));
  if (describe.error) return { error: describe.error };
  const namespaces = Array.isArray(describe.value && describe.value.namespaces) ? describe.value.namespaces : [];
  const piAi = namespaces.find((entry) => entry && entry.ns === PI_AI_NS);
  return { providers: piAiProvidersOf(piAi && piAi.value) };
}

/** 一条模型上「已经显式写过」的能力字段（只有写过的才算，缺省值不算用户的选择）。 */
function capabilityOf(model) {
  if (!model || typeof model !== 'object') return undefined;
  const caps = {};
  if (Number(model.contextWindow) > 0) caps.contextWindow = Math.trunc(Number(model.contextWindow));
  if (Number(model.maxTokens) > 0) caps.maxTokens = Math.trunc(Number(model.maxTokens));
  if (Array.isArray(model.input) && model.input.includes('image')) caps.vision = true;
  if (Array.isArray(model.reasoningEfforts)) {
    const levels = model.reasoningEfforts.filter((level) => modelMeta.MODEL_LEVELS.includes(level));
    if (levels.length > 0) caps.reasoning = levels;
  } else if (model.reasoningEfforts && typeof model.reasoningEfforts === 'object') {
    const levels = modelMeta.MODEL_LEVELS.filter((level) => model.reasoningEfforts[level] !== undefined);
    if (levels.length === 0) caps.reasoning = [];
    else caps.reasoning = levels;
  } else if (model.reasoningEfforts === false) {
    caps.reasoning = [];
  }
  return Object.keys(caps).length === 0 ? undefined : caps;
}

/** 路由发下来的那份配置里，哪些渠道已经写了能力字段。 */
function overridesOf(providers) {
  const out = {};
  for (const providerId of Object.keys(providers)) {
    const profile = providers[providerId];
    const models = profile && Array.isArray(profile.models) ? profile.models : [];
    for (const model of models) {
      const id = model && typeof model.id === 'string' ? model.id : '';
      if (id === '') continue;
      const caps = capabilityOf(model);
      if (caps) out[`${providerId}\u0001${id}`] = caps;
    }
  }
  return out;
}

/**
 * GET /api/mobile/v1/model-meta[?q=关键词]
 *
 * 不带 `q` 回整份快照（App 缓存那一份，约 450KB）；带 `q` 只回这一搜的结果（给不缓存的一次性
 * 查询用）。两种情况都带 `revision`：内容没变时 App 不必把整份重新落盘。
 */
async function handleModelMeta(ctx, req, res) {
  const url = new URL(req.url, 'http://mobile.local');
  const query = url.searchParams.get('q') || '';
  const limit = Number(url.searchParams.get('limit'));
  const providers = await readPiAiProviders(ctx);
  if (providers.error) return sendJson(res, 400, { ok: false, error: providers.error });
  const overrides = overridesOf(providers.providers);
  const revision = modelMeta.revision;
  if (query.trim() !== '') {
    sendJson(res, 200, { ok: true, revision, items: modelMeta.searchModelMeta(query, limit), overrides });
    return;
  }
  const full = modelMeta.fullModelMeta();
  sendJson(res, 200, { ok: true, revision: full.revision, total: full.total, items: full.items, overrides });
}

/** 一次提交里哪些字段是「用户真的给了」—— 缺的沿用那台电脑原来的值，别拿缺省值覆盖。 */
function normalizeApply(body) {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (provider === '' || provider.length > MAX_PROVIDER_CHARS) {
    return { error: { code: 'bad-request', message: '渠道 id 不合法' } };
  }
  if (model === '' || model.length > MAX_MODEL_CHARS) {
    return { error: { code: 'bad-request', message: '模型 id 不合法' } };
  }
  const patch = {};
  if (body.contextWindow !== undefined) {
    const value = Number(body.contextWindow);
    if (!Number.isInteger(value) || value <= 0 || value > MAX_TOKENS) {
      return { error: { code: 'bad-request', message: '上下文窗口必须是正整数' } };
    }
    patch.contextWindow = value;
  }
  if (body.maxTokens !== undefined) {
    const value = Number(body.maxTokens);
    if (!Number.isInteger(value) || value <= 0 || value > MAX_TOKENS) {
      return { error: { code: 'bad-request', message: '输出上限必须是正整数' } };
    }
    patch.maxTokens = value;
  }
  if (body.vision !== undefined) {
    if (typeof body.vision !== 'boolean') return { error: { code: 'bad-request', message: '读图能力必须是布尔值' } };
    patch.vision = body.vision;
  }
  if (body.reasoning !== undefined) {
    if (!Array.isArray(body.reasoning)) return { error: { code: 'bad-request', message: '推理档位必须是数组' } };
    const levels = [];
    for (const level of body.reasoning) {
      if (!modelMeta.MODEL_LEVELS.includes(level)) {
        return { error: { code: 'bad-request', message: `推理档位不认识：${String(level)}` } };
      }
      if (!levels.includes(level)) levels.push(level);
    }
    patch.reasoning = modelMeta.MODEL_LEVELS.filter((level) => levels.includes(level));
  }
  if (Object.keys(patch).length === 0) {
    return { error: { code: 'bad-request', message: '没有要改的字段' } };
  }
  const context = patch.contextWindow;
  const output = patch.maxTokens;
  if (context !== undefined && output !== undefined && output >= context) {
    return { error: { code: 'bad-request', message: '输出上限必须小于上下文窗口' } };
  }
  return { provider, model, patch };
}

/** 把一份能力配置合进那条模型（其它字段原样保留）。 */
function mergeModel(model, patch) {
  const merged = { ...model };
  if (patch.contextWindow !== undefined) merged.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) merged.maxTokens = patch.maxTokens;
  if (patch.vision !== undefined) merged.input = patch.vision ? ['text', 'image'] : ['text'];
  if (patch.reasoning !== undefined) {
    merged.reasoningEfforts = patch.reasoning.length === 0
      ? false
      : Object.fromEntries(patch.reasoning.map((level) => [level, level]));
  }
  return merged;
}

/**
 * POST /api/mobile/v1/model-meta/apply（token）{ provider, model, contextWindow?, maxTokens?, vision?, reasoning? }
 *
 * 只写 `llm-pi-ai` 里真的存在的那条渠道的**那一个模型**：读出现有 profile、换掉这一条模型、
 * 按路径 `set` 回去。不认识的能力字段与渠道层字段（`api` / `baseURL` / `apiKeyEnv`）原样保留，
 * 所以改一次能力不会把桌面调好的地址或别人的路由冲掉。
 */
async function handleModelMetaApply(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要一份模型配置' } });
  }
  const normalized = normalizeApply(body);
  if (normalized.error) return sendJson(res, 400, { ok: false, error: normalized.error });

  const read = await readPiAiProviders(ctx);
  if (read.error) return sendJson(res, 400, { ok: false, error: read.error });
  const providers = read.providers;
  const profile = providers[normalized.provider];
  if (!profile) {
    // 不是自建渠道：别的插件注册的 provider，手机这一侧没有归它管的配置。
    return sendJson(res, 409, {
      ok: false,
      error: { code: 'model-meta-external', message: '这条渠道不归本机配置，改不了它的模型参数' },
    });
  }
  const models = Array.isArray(profile.models) ? profile.models : [];
  const index = models.findIndex((model) => model && model.id === normalized.model);
  if (index < 0) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条渠道里没有这个模型' } });
  }
  const current = models[index];
  const context = normalized.patch.contextWindow !== undefined ? normalized.patch.contextWindow : Number(current.contextWindow);
  const output = normalized.patch.maxTokens !== undefined ? normalized.patch.maxTokens : Number(current.maxTokens);
  if (Number(context) > 0 && Number(output) > 0 && output >= context) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '输出上限必须小于上下文窗口' } });
  }

  const nextModels = models.slice();
  nextModels[index] = mergeModel(current, normalized.patch);
  const write = unwrap(await ctx.apiProxy.settings.mutate({
    rpcId: 'mobile',
    method: 'settings.mutate',
    payload: { ns: PI_AI_NS, ops: [{ op: 'set', path: ['providers', normalized.provider], value: { ...profile, models: nextModels } }] },
  }));
  if (write.error) return sendJson(res, 400, { ok: false, error: write.error });

  // 模型目录（含能力字段投影）是设备级缓存、却按会话存：整批作废，别让别的会话继续吃旧值。
  dropSessionModelsForDevice(ctx, req);
  sendJson(res, 200, {
    ok: true,
    provider: normalized.provider,
    model: normalized.model,
    capability: capabilityOf(nextModels[index]) || {},
  });
}

module.exports = {
  handleModelMeta,
  handleModelMetaApply,
  normalizeApply,
  mergeModel,
  capabilityOf,
  overridesOf,
  PI_AI_NS,
  MAX_TOKENS,
};

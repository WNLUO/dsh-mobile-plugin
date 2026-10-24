'use strict';

/**
 * 模型目录：会话当前选择 + 可用模型分组 + 各档推理强度，外加「切模型」动作。
 *
 * 形状校验（safeModelsValue）与 TTL 缓存是这里的核心，两处都有非平凡的理由：
 *  1. safeModelsValue 不是防御性洁癖——宿主是另一个进程，它给的形状会随版本变，
 *     而这些字段会直接进 App 的模型选择面板；逐字段挑出来才不会把半截对象糊上去。
 *  2. 20 秒 TTL 是热路径取舍：模型目录几乎不变，而手机端在输入区每次展开面板都要读。
 *     stale-while-revalidate 让展开立刻拿到旧值，同时只发一个在途请求。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { canonicalDeviceKey, sessionModelsStateOf, invalidateSessionModels } = require('./session-cache.js');
const { readModelOptions, safeModelOptions } = require('./session-model-options.js');

const SESSION_MODELS_CACHE_MS = 20000; // 模型目录短 TTL；成功后 stale-while-revalidate

function modelText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * 模型 / 推理档位描述的下发上限。
 *
 * 选择器里这两处都是 `numberOfLines={1}`，按屏宽也就显示二三十个字；宿主那边的描述
 * 却有写到几千字的（能力说明、价格表都有）。整份目录每次启动、每次进对话都会传一遍，
 * 留着 8KB 的上限等于给每个模型背一段永远读不到的正文。
 */
const MODEL_DESCRIPTION_MAX = 200;
const EFFORT_DESCRIPTION_MAX = 200;
/** 失败原因只在诊断里看，同样不需要整篇。 */
const MODEL_FAILURE_MESSAGE_MAX = 512;

function safeModelsValue(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  if (value.current && typeof value.current === 'object') {
    result.current = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      const max = key === 'provider' ? 256 : key === 'model' ? 512 : 256;
      const text = modelText(value.current[key], max);
      if (text) result.current[key] = text;
    }
  }
  // 全局默认（新会话会用的那个）：App 拿它当「新对话」显示，provider/model 缺一个就不下发。
  if (value.defaultModel && typeof value.defaultModel === 'object') {
    const selection = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      const max = key === 'provider' ? 256 : key === 'model' ? 512 : 256;
      const text = modelText(value.defaultModel[key], max);
      if (text) selection[key] = text;
    }
    if (selection.provider && selection.model) result.defaultModel = selection;
  }
  if (typeof value.routable === 'boolean') result.routable = value.routable;
  if (Array.isArray(value.routableProviders)) {
    result.routableProviders = [...new Set(value.routableProviders
      .filter((provider) => typeof provider === 'string' && provider.length > 0)
      .slice(0, 128)
      .map((provider) => provider.slice(0, 256)))];
  }
  if (Array.isArray(value.groups)) {
    result.groups = value.groups
      .filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.models))
      .slice(0, 128)
      .map((group) => ({
        id: modelText(group.id, 256),
        name: modelText(group.name, 512),
        models: group.models
          .filter((model) => model && typeof model.id === 'string' && typeof model.name === 'string')
          .slice(0, 256)
          .map((model) => ({
            id: modelText(model.id, 512),
            name: modelText(model.name, 512),
            ...(typeof model.description === 'string' ? { description: model.description.slice(0, MODEL_DESCRIPTION_MAX) } : {}),
            ...(model.reasoning && typeof model.reasoning === 'object' && Array.isArray(model.reasoning.efforts)
              ? { reasoning: {
                efforts: model.reasoning.efforts
                  .filter((effort) => effort && typeof effort.id === 'string' && typeof effort.name === 'string')
                  .slice(0, 64)
                  .map((effort) => ({
                    id: modelText(effort.id, 256),
                    name: modelText(effort.name, 512),
                    ...(typeof effort.description === 'string' ? { description: effort.description.slice(0, EFFORT_DESCRIPTION_MAX) } : {}),
                  })),
                ...(typeof model.reasoning.defaultEffort === 'string' ? { defaultEffort: modelText(model.reasoning.defaultEffort, 256) } : {}),
              } }
              : {}),
          })),
      }));
  }
  // 模型之外的附加选项行（速度、输出详略……）：行数与内容都由 session-model-options.js
  // 那张描述表决定，App 只按收到的数组逐行画。空数组不下发（旧宿主没有这个字段）。
  if (Array.isArray(value.options)) {
    const options = safeModelOptions(value.options);
    if (options.length > 0) result.options = options;
  }
  if (Array.isArray(value.failures)) result.failures = value.failures.slice(0, 64).map((failure) => ({
    ...(typeof failure?.id === 'string' ? { id: modelText(failure.id, 256) } : {}),
    ...(typeof failure?.name === 'string' ? { name: modelText(failure.name, 512) } : {}),
    ...(typeof failure?.message === 'string' ? { message: modelText(failure.message, MODEL_FAILURE_MESSAGE_MAX) } : {}),
  }));
  if (Number.isSafeInteger(value.revision)) result.revision = value.revision;
  return result;
}

function modelsBody(value, fetchedAt) {
  const result = { ok: true, ...safeModelsValue(value) };
  const revision = result.revision;
  result.meta = {
    ...(result.meta && typeof result.meta === 'object' ? result.meta : {}),
    source: 'host',
    age: Math.max(0, Date.now() - fetchedAt),
    ...(Number.isSafeInteger(revision) ? { revision } : {}),
  };
  return result;
}

function startModelsRequest(ctx, entry, sessionId, fresh = false) {
  // 在途的强制读挂在 entry 自己身上，不另开模块级表：entry 已经按 ctx + 设备 + 会话
  // 隔离过（session-cache.js 的 sessionModelsStateOf），再建一张 WeakMap 只会多一份
  // 需要解释归属的状态（见 test/module-split.test.cjs：模块级 WeakMap 只许住在
  // session-cache.js 与 rpc.js）。
  if (fresh) {
    if (entry.freshPromise) return entry.freshPromise;
    // A forced read supersedes an older normal request. Its eventual result must not overwrite fresh data.
    entry.generation = (entry.generation || 0) + 1;
  } else if (entry.promise) {
    return entry.promise;
  }
  const generation = entry.generation || 0;
  const request = Promise.resolve(callSessions(ctx, 'models', { sessionId })).then(async (response) => {
    const { value, error } = unwrap(response);
    if (error) return { error };
    const safeValue = safeModelsValue(value);
    // 附加选项行按**当前模型所在渠道**取（宿主目录里没有这一层，见 session-model-options.js）。
    const options = await readModelOptions(ctx, safeValue.current && safeValue.current.provider);
    if (options.length > 0) safeValue.options = options;
    const fetchedAt = Date.now();
    if (generation === (entry.generation || 0)) {
      entry.value = safeValue;
      entry.fetchedAt = fetchedAt;
    }
    return { value: safeValue, fetchedAt };
  });
  const tracked = request.finally(() => { if (entry.promise === tracked) entry.promise = null; });
  entry.promise = tracked;
  if (!fresh) return tracked;
  const forced = tracked.finally(() => { if (entry.freshPromise === forced) entry.freshPromise = null; });
  entry.freshPromise = forced;
  return forced;
}

async function buildModelsSnapshot(ctx, sessionId) {
  if (!sessionId) return { ok: false };
  const entry = sessionModelsStateOf(ctx, 'legacy', sessionId); const now = Date.now();
  if (entry.value && now - entry.fetchedAt < SESSION_MODELS_CACHE_MS) return modelsBody(entry.value, entry.fetchedAt);
  const request = startModelsRequest(ctx, entry, sessionId);
  if (entry.value) { void request.catch(() => undefined); return modelsBody(entry.value, entry.fetchedAt); }
  const result = await request; return result.error ? { ok: false, error: result.error } : modelsBody(result.value, result.fetchedAt);
}

/** GET /api/mobile/v1/session/models?sessionId=…（token）
 * 返回会话当前模型选择与可用模型目录（透传宿主 session.models）。
 * 响应：{ ok, current:{provider,model,reasoningEffort?}, defaultModel:{provider,model,reasoningEffort?}, routable, groups:[{id,name,models:[{id,name,description?,reasoning?}]}], options?:[{id,title,value,choices:[{id,name,description?}]}], failures:[{id,name,message}] }
 * `current` 是**这个会话**实际会用的；`defaultModel` 是全局默认（宿主新建会话时的落点）。
 * `options` 是当前渠道的附加选项行（速度、输出详略……），没有就是没有这个字段。
 */
async function handleModels(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const entry = sessionModelsStateOf(ctx, canonicalDeviceKey(req), sessionId);
  const fresh = url.searchParams.get('fresh') === '1';
  if (fresh) {
    const result = await startModelsRequest(ctx, entry, sessionId, true);
    if (result.error) return sendJson(res, 400, { ok: false, error: result.error });
    return sendJson(res, 200, modelsBody(result.value, result.fetchedAt));
  }
  const now = Date.now();
  if (entry.value && now - entry.fetchedAt < SESSION_MODELS_CACHE_MS) {
    return sendJson(res, 200, modelsBody(entry.value, entry.fetchedAt));
  }
  const request = startModelsRequest(ctx, entry, sessionId);
  // Normal reads keep stale-while-revalidate. Explicit fresh reads above always await the host.
  if (entry.value) {
    void request.catch(() => undefined);
    return sendJson(res, 200, modelsBody(entry.value, entry.fetchedAt));
  }
  const result = await request;
  if (result.error) return sendJson(res, 400, { ok: false, error: result.error });
  sendJson(res, 200, modelsBody(result.value, result.fetchedAt));
}

/** POST /api/mobile/v1/session/select-model（token）{sessionId, provider, model, reasoningEffort?} */
async function handleSelectModel(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId ||
      typeof body.provider !== 'string' || !body.provider ||
      typeof body.model !== 'string' || !body.model) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, provider, model }' } });
  }
  const payload = { sessionId: body.sessionId, provider: body.provider, model: body.model };
  if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) payload.reasoningEffort = body.reasoningEffort;
  const { value, error } = unwrap(await callSessions(ctx, 'selectModel', payload));
  if (error) return sendJson(res, 400, { ok: false, error });
  invalidateSessionModels(ctx, req, body.sessionId);
  sendJson(res, 200, { ok: true, ...(value || {}) });
}

module.exports = { modelText, safeModelsValue, modelsBody, buildModelsSnapshot, handleModels, handleSelectModel };

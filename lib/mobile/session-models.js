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

const SESSION_MODELS_CACHE_MS = 20000; // 模型目录短 TTL；成功后 stale-while-revalidate

function modelText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

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
  if (typeof value.routable === 'boolean') result.routable = value.routable;
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
            ...(typeof model.description === 'string' ? { description: model.description.slice(0, 8192) } : {}),
            ...(model.reasoning && typeof model.reasoning === 'object' && Array.isArray(model.reasoning.efforts)
              ? { reasoning: {
                efforts: model.reasoning.efforts
                  .filter((effort) => effort && typeof effort.id === 'string' && typeof effort.name === 'string')
                  .slice(0, 64)
                  .map((effort) => ({
                    id: modelText(effort.id, 256),
                    name: modelText(effort.name, 512),
                    ...(typeof effort.description === 'string' ? { description: effort.description.slice(0, 4096) } : {}),
                  })),
                ...(typeof model.reasoning.defaultEffort === 'string' ? { defaultEffort: modelText(model.reasoning.defaultEffort, 256) } : {}),
              } }
              : {}),
          })),
      }));
  }
  if (Array.isArray(value.failures)) result.failures = value.failures.slice(0, 64).map((failure) => ({
    ...(typeof failure?.id === 'string' ? { id: modelText(failure.id, 256) } : {}),
    ...(typeof failure?.name === 'string' ? { name: modelText(failure.name, 512) } : {}),
    ...(typeof failure?.message === 'string' ? { message: modelText(failure.message, 8192) } : {}),
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
  const request = Promise.resolve(callSessions(ctx, 'models', { sessionId })).then((response) => {
    const { value, error } = unwrap(response);
    if (error) return { error };
    const safeValue = safeModelsValue(value);
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
 * 响应：{ ok, current:{provider,model,reasoningEffort?}, routable, groups:[{id,name,models:[{id,name,description?,reasoning?}]}], failures:[{id,name,message}] }
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

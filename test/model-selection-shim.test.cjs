'use strict';

/**
 * `sessions.models` 的会话级模型精修：会话自己选过的模型优先于全局默认。
 *
 * 真机缺陷：A 会话选了 A 模型、B 会话选了 B 模型，手机分别点进两个会话，模型标签却
 * 都显示同一个「默认模型」。根因是 `session.modelCatalog` 只回全局目录，`default` 是
 * 部署级默认，不是「这个会话实际用的模型」；会话自己的选择记在 `session/projections`
 * 的 `modelSelection` 投影里（`next` 优先于 `lastUsed`）。这里直接驱动 shims.modelCatalog
 * 验证叠加逻辑，不经过 session-models.js 的 20 秒缓存层。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelCatalog } = require('../lib/mobile/host-bridge/shims.js');

const CATALOG = {
  default: { provider: 'p', model: 'global-default', reasoningEffort: 'low' },
  routableProviders: ['p', 'q'],
  groups: [{
    id: 'p',
    name: 'Provider',
    models: [
      { id: 'global-default', name: 'Global' },
      { id: 'session-model', name: 'Session' },
    ],
  }],
};

function makeCtx({ modelCatalogValue, projectionValue, projectionError } = {}) {
  const calls = [];
  const gateway = {
    async invoke({ namespace, method, args }) {
      calls.push({ namespace, method, args });
      if (namespace === 'session' && method === 'modelCatalog') {
        if (modelCatalogValue instanceof Error) throw modelCatalogValue;
        return modelCatalogValue;
      }
      if (namespace === 'session' && method === 'projections') {
        if (projectionError) throw projectionError;
        return projectionValue;
      }
      throw Object.assign(new Error(`unexpected ${namespace}/${method}`), { code: 'gateway/invocation-unavailable' });
    },
  };
  return {
    calls,
    ctx: {
      get: (name) => (name === 'typertGateway' ? gateway : undefined),
      logger: { warn() {} },
    },
  };
}

function selectionOf(envelope) {
  return envelope.result.value.current;
}

test('会话投影有 next 时用它覆盖全局默认，且 projections 带 request 包层', async () => {
  const { ctx, calls } = makeCtx({
    modelCatalogValue: CATALOG,
    projectionValue: {
      asOfSeq: 1,
      values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'session-model', reasoningEffort: 'high' } } },
    },
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  assert.equal(out.result.ok, true);
  assert.deepEqual(selectionOf(out), { provider: 'p', model: 'session-model', reasoningEffort: 'high' });
  assert.equal(out.result.value.routable, true);
  assert.deepEqual(out.result.value.routableProviders, ['p', 'q']);
  assert.deepEqual(out.result.value.groups, CATALOG.groups, 'compatibility bridge leaves catalog filtering to the APP');
  assert.deepEqual(calls.find((c) => c.method === 'projections').args, { request: { sessionId: 's-1' } });
});

test('会话投影只有 lastUsed（还没派发下一轮）时用它', async () => {
  const { ctx } = makeCtx({
    modelCatalogValue: CATALOG,
    projectionValue: {
      asOfSeq: 1,
      values: { modelSelection: { lastUsed: { provider: 'q', model: 'last-model' }, next: null } },
    },
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  assert.deepEqual(selectionOf(out), { provider: 'q', model: 'last-model' });
});

test('会话从没选过模型时回落到全局默认', async () => {
  const { ctx } = makeCtx({
    modelCatalogValue: CATALOG,
    projectionValue: { asOfSeq: 1, values: {} },
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  assert.deepEqual(selectionOf(out), { provider: 'p', model: 'global-default', reasoningEffort: 'low' });
});

test('投影读不到时不升级成错误，照常回全局默认', async () => {
  const { ctx } = makeCtx({
    modelCatalogValue: CATALOG,
    projectionError: Object.assign(new Error('会话不存在'), { code: 'session/not-found' }),
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  assert.equal(out.result.ok, true);
  assert.deepEqual(selectionOf(out), { provider: 'p', model: 'global-default', reasoningEffort: 'low' });
});

test('不带 sessionId 时不发 projections 请求', async () => {
  const { ctx, calls } = makeCtx({ modelCatalogValue: CATALOG });
  const out = await modelCatalog(ctx, {});

  assert.equal(out.result.ok, true);
  assert.equal(calls.some((c) => c.method === 'projections'), false);
});

test('单独回一份全局默认：会话自己选过模型时 current 与 defaultModel 不同', async () => {
  const { ctx } = makeCtx({
    modelCatalogValue: CATALOG,
    projectionValue: { asOfSeq: 1, values: { modelSelection: { next: { provider: 'p', model: 'session-model' } } } },
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  // current 是这个会话实际会用的；defaultModel 是宿主给新会话的默认 —— App 不能拿前者顶后者。
  assert.deepEqual(out.result.value.current, { provider: 'p', model: 'session-model' });
  assert.deepEqual(out.result.value.defaultModel, { provider: 'p', model: 'global-default', reasoningEffort: 'low' });
});

test('宿主没给默认模型时不下发 defaultModel（App 宁可显示「选择模型」也不猜）', async () => {
  const { ctx } = makeCtx({
    modelCatalogValue: { routableProviders: ['p'], groups: [] },
    projectionValue: { asOfSeq: 1, values: { modelSelection: { next: { provider: 'p', model: 'session-model' } } } },
  });
  const out = await modelCatalog(ctx, { sessionId: 's-1' });

  assert.deepEqual(out.result.value.current, { provider: 'p', model: 'session-model' });
  assert.equal('defaultModel' in out.result.value, false);
});

/** Session model directory response and cache contract. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleModels } = require('../lib/mobile/sessions.js');

function request(instanceId = 'phone-1', fresh = false) {
  return {
    url: `/api/mobile/v1/session/models?sessionId=s-1${fresh ? '&fresh=1' : ''}`,
    headers: { 'x-dsh-device': instanceId },
  };
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(value) { this.body = JSON.parse(String(value)); },
  };
}

test('model catalog cache coalesces requests and keeps reasoning metadata safe', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const value = {
    current: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    defaultModel: { provider: 'q', model: 'global-default', reasoningEffort: 'low', secret: 'must not escape' },
    routable: true,
    routableProviders: ['p', 'q', '', 42],
    revision: 7,
    groups: [{
      id: 'p',
      name: 'Provider',
      models: [{
        id: 'm',
        name: 'Model',
        description: 'safe description',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [{ id: 'low', name: 'Low', description: 'fast' }, { id: 'high', name: 'High' }],
        },
        apiKey: 'must not escape',
      }],
    }],
    failures: [{ id: 'q', name: 'Other', message: 'unavailable', secret: 'must not escape' }],
    providerSecret: 'must not escape',
  };
  const ctx = { apiProxy: { sessions: { models: async () => { calls += 1; await pending; return { result: { ok: true, value } }; } } } };
  const first = response();
  const second = response();
  const p1 = handleModels(ctx, request(), first);
  const p2 = handleModels(ctx, request(), second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([p1, p2]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body.groups[0].models[0].reasoning, value.groups[0].models[0].reasoning);
  assert.equal(first.body.providerSecret, undefined);
  assert.equal(first.body.groups[0].models[0].apiKey, undefined);
  assert.equal(first.body.failures[0].secret, undefined);
  assert.equal(first.body.meta.source, 'host');
  assert.deepEqual(first.body.routableProviders, ['p', 'q']);
  // 全局默认是给「新对话」显示用的，必须与会话自己的 current 分开带出去，且只留白名单字段。
  assert.deepEqual(first.body.defaultModel, { provider: 'q', model: 'global-default', reasoningEffort: 'low' });
  assert.equal(first.body.current.model, 'm');

  const cached = response();
  await handleModels(ctx, request(), cached);
  assert.equal(calls, 1);
  assert.equal(cached.body.groups[0].models[0].name, 'Model');
  assert.deepEqual(cached.body.defaultModel, { provider: 'q', model: 'global-default', reasoningEffort: 'low' });
});

test('默认模型缺 provider 或 model 时整条丢掉，不留半截', async () => {
  const value = { current: { provider: 'p', model: 'm' }, defaultModel: { provider: 'q' }, routable: true, groups: [] };
  const ctx = { apiProxy: { sessions: { models: async () => ({ result: { ok: true, value } }) } } };
  const out = response();
  await handleModels(ctx, request(), out);
  assert.equal('defaultModel' in out.body, false);
  assert.equal(out.body.current.model, 'm');
});

test('fresh bypasses the 20s cache, coalesces concurrent fresh reads, and wins over older normal requests', async () => {
  let calls = 0;
  let releaseNormal;
  const normalGate = new Promise((resolve) => { releaseNormal = resolve; });
  const oldValue = { current: { provider: 'p', model: 'old' }, routable: true, groups: [] };
  const freshValue = { current: { provider: 'p', model: 'new' }, routable: true, groups: [] };
  const ctx = { apiProxy: { sessions: { models: async () => {
    calls += 1;
    if (calls === 1) { await normalGate; return { result: { ok: true, value: oldValue } }; }
    return { result: { ok: true, value: freshValue } };
  } } } };

  const oldResponse = response();
  const oldRequest = handleModels(ctx, request(), oldResponse);
  await Promise.resolve();
  assert.equal(calls, 1);

  const firstFresh = response();
  const secondFresh = response();
  const freshRequest = handleModels(ctx, request('phone-1', true), firstFresh);
  const joinedFreshRequest = handleModels(ctx, request('phone-1', true), secondFresh);
  await Promise.all([freshRequest, joinedFreshRequest]);
  assert.equal(calls, 2, '两个fresh请求应共用一次host RPC');
  assert.equal(firstFresh.body.current.model, 'new');
  assert.equal(secondFresh.body.current.model, 'new');

  releaseNormal();
  await oldRequest;
  const afterFresh = response();
  await handleModels(ctx, request(), afterFresh);
  assert.equal(afterFresh.body.current.model, 'new', '较早启动的普通请求不能覆盖fresh结果');
  assert.equal(calls, 2, 'fresh结果应成为普通缓存读的最新值');
});

test('model cache is isolated by device and session', async () => {
  const calls = [];
  const ctx = { apiProxy: { sessions: { models: async ({ payload }) => {
    calls.push(payload.sessionId);
    return { result: { ok: true, value: { current: { provider: 'p', model: payload.sessionId }, groups: [] } } };
  } } } };
  await handleModels(ctx, request('phone-a'), response());
  await handleModels(ctx, { url: '/api/mobile/v1/session/models?sessionId=s-2', headers: { 'x-dsh-device': 'phone-a' } }, response());
  await handleModels(ctx, request('phone-b'), response());
  assert.deepEqual(calls, ['s-1', 's-2', 's-1']);
});

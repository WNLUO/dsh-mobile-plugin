'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleModels } = require('../lib/mobile/sessions.js');

function request(instanceId = 'phone-1') {
  return {
    url: '/api/mobile/v1/session/models?sessionId=s-1',
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
    routable: true,
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

  const cached = response();
  await handleModels(ctx, request(), cached);
  assert.equal(calls, 1);
  assert.equal(cached.body.groups[0].models[0].name, 'Model');
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

/** 没有既有会话时直接读取宿主默认模型目录，不触发会话投影或创建。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleModels } = require('../lib/mobile/session-models.js');
function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(String(value)); } };
}
test('空会话号直接读取全局目录，新用户无需先发送消息', async () => {
  const calls = [];
  const value = { current: { provider: 'p', model: 'A' }, defaultModel: { provider: 'p', model: 'A' },
    groups: [{ id: 'p', name: 'Provider', models: [{ id: 'A', name: 'Model A' }] }], routable: true, routableProviders: ['p'] };
  const ctx = { apiProxy: { sessions: { models: async ({ payload }) => {
    calls.push(payload); return { result: { ok: true, value } };
  } } } };
  const out = response();
  await handleModels(ctx, { url: '/api/mobile/v1/session/models?sessionId=&fresh=1', headers: {} }, out);
  assert.equal(out.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: '' });
  assert.deepEqual(out.body.defaultModel, { provider: 'p', model: 'A' });
  assert.equal(out.body.groups[0].models[0].id, 'A');
});

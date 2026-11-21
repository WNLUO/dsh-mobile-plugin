/** 接收方校验驱动真实 helper 与 HTTP handler，确认离线换端点不进 prompt且旧路径保留。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { expectedAiRecipientError, publicEndpoint } = require('../lib/mobile/ai-recipient.cjs');
const { handleSend } = require('../lib/mobile/session-send.js');
const { handleSubagentPrompt } = require('../lib/mobile/subagents.js');
const { modelsBody } = require('../lib/mobile/session-models.js');
const expected = { provider: 'route', endpoint: 'https://models.example/v1' };
const ok = (value) => ({ result: { ok: true, value } });

function runtime({ endpoint = expected.endpoint, provider = 'route', live = true, child = false } = {}) {
  const calls = [];
  let current = { provider, model: 'model' };
  const agent = { model: { current: () => current, select: (next) => { current = next; } } };
  const services = {
    agents: { get: (id) => live && id === (child ? 'child' : 'session') ? agent : undefined },
    sessionController: { resolveAgent: async () => live ? { agent } : { error: { code: 'session/not-found' } } },
    llm: {
      listProviders: () => [{ id: 'route' }], listModels: async () => [{ id: 'model' }],
      resolveCallConfig: async (selection) => { calls.push(['resolve', selection]); return { ...selection }; },
    },
  };
  const ctx = {
    get: (key) => services[key],
    apiProxy: {
      settings: { describe: async () => { calls.push(['settings']); return ok({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: { route: { baseURL: endpoint } } } }] }); } },
      sessions: { prompt: async (request) => { calls.push(['prompt', request.payload]); return ok({ accepted: true }); } },
      subagents: { prompt: async (request) => { calls.push(['child-prompt', request.payload]); return ok({ messageId: 'm' }); } },
    },
  };
  return { ctx, calls, services };
}
function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {}; req.url = '/api/mobile/v1/session/send';
  return req;
}
function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(String(value)); } };
}
const sendBody = { sessionId: 'session', text: 'hello', clientMessageId: 'mobile-one', expectedAiRecipient: expected };
const childBody = { parentSessionId: 'parent', childSessionId: 'child', text: 'hello', clientMessageId: 'mobile-child', expectedAiRecipient: expected };

test('端点公开规范化与手机一致：只比较协议主机路径，不带凭据或查询', () => {
  assert.equal(publicEndpoint('https://name:ignored@MODELS.example/v1/?private=x#fragment'), expected.endpoint);
  assert.equal(publicEndpoint('file:///private'), '');
});
test('显式匹配的活跃模型和自建端点通过，读取真实模型并校验配置', async () => {
  const { ctx, calls } = runtime({ endpoint: expected.endpoint + '/' });
  assert.equal(await expectedAiRecipientError(ctx, { sessionId: 'session', expected }), null);
  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'settings']);
});
test('离线期间同一提供方改端点，恢复补发拒绝且不触发prompt', async () => {
  const { ctx, calls } = runtime({ endpoint: 'https://different.example/v1' });
  const res = response();
  await handleSend(ctx, request(sendBody), res);
  assert.equal(res.status, 400); assert.equal(res.body.error.code, 'ai-recipient-changed');
  assert(!calls.some(([name]) => name === 'prompt'));
});
test('当前提供方改变或请求选择与已同意提供方不同均拒绝', async () => {
  const { ctx } = runtime({ provider: 'other-route' });
  assert.equal((await expectedAiRecipientError(ctx, { sessionId: 'session', expected })).code, 'ai-recipient-changed');
  assert.equal((await expectedAiRecipientError(ctx, { sessionId: 'session', expected, selection: { provider: 'other-route', model: 'model' } })).code, 'ai-recipient-changed');
});
test('请求切模型后再核对真实会话选择，成功发送的模式和身份不变', async () => {
  const { ctx, calls } = runtime({ provider: 'other-route' });
  const res = response();
  await handleSend(ctx, request({ ...sendBody, mode: 'queue', modelSelection: { provider: 'route', model: 'model' } }), res);
  assert.equal(res.status, 200);
  const prompt = calls.find(([name]) => name === 'prompt')[1];
  assert.equal(prompt.mode, 'queue'); assert.equal(prompt.requestId, 'mobile:mobile-one');
});
test('显式端点但没有可核实profile、LLM服务或活跃模型时明确拒绝', async () => {
  for (const change of [
    (r) => { r.ctx.apiProxy.settings.describe = async () => ok({ namespaces: [] }); },
    (r) => { delete r.services.llm; },
    (r) => { r.services.agents.get = () => undefined; r.services.sessionController.resolveAgent = async () => ({}); },
    (r) => { r.services.llm.resolveCallConfig = async () => ({ provider: 'different', model: 'model' }); },
    (r) => { r.ctx.apiProxy.settings.describe = async () => { throw new Error('unavailable'); }; },
  ]) {
    const r = runtime(); change(r);
    assert.equal((await expectedAiRecipientError(r.ctx, { sessionId: 'session', expected })).code, 'ai-recipient-unverifiable');
  }
});
test('畸形显式字段不当成缺省放行', async () => {
  for (const value of [null, {}, { provider: 'route', endpoint: '' }]) {
    assert.equal((await expectedAiRecipientError({}, { sessionId: 'session', expected: value })).code, 'bad-request');
  }
});
test('无显式端点保持逐消息授权电脑当前路由路径，不要求额外宿主能力', async () => {
  assert.equal(await expectedAiRecipientError({}, { sessionId: 'session' }), null);
  const { ctx, calls } = runtime(); delete ctx.get;
  const res = response(); const { expectedAiRecipient: _expected, ...body } = sendBody;
  await handleSend(ctx, request(body), res);
  assert.equal(res.status, 200); assert.equal(calls.filter(([name]) => name === 'prompt').length, 1);
});
test('子代理按child自身当前模型核对，端点改变不进入子代理prompt', async () => {
  const { ctx, calls } = runtime({ endpoint: 'https://different.example/v1', child: true });
  const res = response(); await handleSubagentPrompt(ctx, request(childBody), res);
  assert.equal(res.status, 400); assert.equal(res.body.error.code, 'ai-recipient-changed');
  assert(!calls.some(([name]) => name === 'child-prompt'));
});
test('子代理活跃模型匹配可补投，不用普通会话resolve绕过子代理所有权', async () => {
  const { ctx, calls, services } = runtime({ child: true });
  services.sessionController.resolveAgent = () => { throw Error('must not resolve child through normal session'); };
  const res = response(); await handleSubagentPrompt(ctx, request(childBody), res);
  assert.equal(res.status, 200); assert.equal(calls.filter(([name]) => name === 'child-prompt').length, 1);
  const cold = runtime({ child: true, live: false });
  assert.equal((await expectedAiRecipientError(cold.ctx, { sessionId: 'child', expected, child: true })).code, 'ai-recipient-unverifiable');
});
test('新插件在模型响应明确宣布guard能力，非宿主模型元数据猜测', () => {
  assert.equal(modelsBody({}, Date.now()).capabilities.expectedAiRecipient, true);
});
test('变异：删端点比较会被真实换端点断言检出', async () => {
  const file = require.resolve('../lib/mobile/ai-recipient.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const marker = "if (actualEndpoint !== endpoint) return refusal('ai-recipient-changed');";
  assert(source.includes(marker));
  const module = { exports: {} };
  vm.runInNewContext(source.replace(marker, ''), { module, exports: module.exports, URL, require: createRequire(file) });
  const { ctx } = runtime({ endpoint: 'https://different.example/v1' });
  assert.equal(await module.exports.expectedAiRecipientError(ctx, { sessionId: 'session', expected }), null);
  assert.equal((await expectedAiRecipientError(ctx, { sessionId: 'session', expected })).code, 'ai-recipient-changed');
});

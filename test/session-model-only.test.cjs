/** 手机切模型只追加会话选择，不保存宿主默认，保留宿主校验与子会话限制。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiProxy } = require('../lib/mobile/host-bridge.js');
const { handleSelectModel } = require('../lib/mobile/session-models.js');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const choice = { sessionId: 's', provider: 'p', model: 'B', reasoningEffort: 'high' };
function runtime({ unavailable = false, resolveError, invalidConfig = false } = {}) {
  const events = [];
  const agent = { model: { select: (selection) => events.push(['selected', selection]) } };
  const services = {
    sessionController: { resolveAgent: async (id) => { events.push(['resolve', id]); return resolveError ? { error: resolveError } : { agent }; } },
    llm: { listProviders: () => [{ id: 'p' }], listModels: async () => unavailable ? [] : [{ id: 'B' }],
      resolveCallConfig: async (selection) => { events.push(['validated', selection]); if (invalidConfig) throw Error('invalid effort'); } },
    agentDefaultModel: { saveSelection: () => { throw Error('must not save desktop default'); } },
    typertGateway: { invoke: () => { throw Error('must not invoke desktop selectModel'); } },
  };
  const ctx = { get: (key) => services[key], apiProxy: { sessions: { selectModel: () => { throw Error('legacy default-saving path must not run'); } } } };
  return { api: createApiProxy(ctx), ctx, events };
}
test('手机成功换模型只写会话，不调用电脑默认保存或桌面选择接口', async () => {
  const { api, events } = runtime();
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.value.selected, { provider: 'p', model: 'B', reasoningEffort: 'high' });
  assert.deepEqual(events.map(([type]) => type), ['resolve', 'validated', 'selected']);
});
test('移动 HTTP 入口也不经过旧 apiProxy 的默认保存路径', async () => {
  const { ctx, events } = runtime();
  const req = Readable.from([Buffer.from(JSON.stringify(choice))]);
  req.headers = {};
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(String(body)); } };
  await handleSelectModel(ctx, req, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.selected.model, 'B');
  assert.equal(events.at(-1)[0], 'selected');
});
test('变异证明：增加电脑默认保存会被原断言抓住', async () => {
  const file = require.resolve('../lib/mobile/host-bridge/session-model.js');
  const source = fs.readFileSync(file, 'utf8');
  const marker = 'agent.model.select(selected);';
  assert.ok(source.includes(marker));
  const mod = { exports: {} };
  vm.runInNewContext(source.replace(marker, `${marker}\nctx.get('agentDefaultModel').saveSelection(selected);`), { exports: mod.exports, module: mod, require: createRequire(file) });
  const { ctx } = runtime();
  const out = await mod.exports.selectSessionModel(ctx, choice);
  assert.equal(out.result.ok, false);
});
test('省略推理强度清除显式值，不继承电脑默认', async () => {
  const { api, events } = runtime();
  const { reasoningEffort, ...payload } = choice;
  await api.sessions.selectModel({ payload });
  assert.deepEqual(events.at(-1)[1], { provider: 'p', model: 'B' });
});
test('目录不可用或配置无效时不改会话', async () => {
  for (const options of [{ unavailable: true }, { invalidConfig: true }]) {
    const { api, events } = runtime(options);
    const out = await api.sessions.selectModel({ payload: choice });
    assert.equal(out.result.ok, false);
    assert.equal(out.result.error.code, 'session/model-unavailable');
    assert.ok(!events.some(([type]) => type === 'selected'));
  }
});
test('沿用宿主的会话恢复和子代理限制，不旁路写日志', async () => {
  const error = { code: 'session/agent-busy', message: 'use subagent delivery for this child session' };
  const { api, events } = runtime({ resolveError: error });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.error.code, error.code);
  assert.equal(events.length, 1);
});
test('宿主不具备会话级选择能力时明确失败，不能退回会改默认的接口', async () => {
  const api = createApiProxy({ get: () => undefined });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'host-unsupported');
});

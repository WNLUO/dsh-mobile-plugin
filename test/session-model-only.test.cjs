/** 手机切模型等待服务就绪，只追加会话选择，保留默认隔离与宿主限制。 */
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
test('宿主服务晚于移动路由就绪时重取服务，成功切换会话', async () => {
  const { ctx, events } = runtime();
  const reads = new Map();
  const api = createApiProxy({ get(key) {
    const count = (reads.get(key) || 0) + 1;
    reads.set(key, count);
    return count === 1 ? undefined : ctx.get(key);
  } });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, true);
  assert.deepEqual(events.map(([type]) => type), ['resolve', 'validated', 'selected']);
});
test('服务始终未就绪时提示重试，不误报需要升级宿主', async () => {
  const api = createApiProxy({ get: () => undefined });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'host-unavailable');
  assert.ok(!out.result.error.message.includes('更新版本'));
});
test('宿主确实缺少会话选择接口时明确失败，不退回会改默认的接口', async () => {
  const { ctx } = runtime();
  const api = createApiProxy({ get: (key) => key === 'sessionController' ? {} : ctx.get(key) });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'host-unsupported');
});

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
function runtime({ unavailable = false, resolveError, invalidConfig = false, agent } = {}) {
  const events = [];
  const target = agent === undefined ? { model: { select: (selection) => events.push(['selected', selection]) } } : agent;
  const services = {
    sessionController: { resolveAgent: async (id) => { events.push(['resolve', id]); return resolveError ? { error: resolveError } : { agent: target }; } },
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
test('会话没有可切换模型时说清是这条会话，不误报需要升级宿主', async () => {
  const { api } = runtime({ agent: {} });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'host-unsupported');
  assert.ok(out.result.error.message.includes('没有可切换的模型'));
  assert.ok(!out.result.error.message.includes('更新版本'));
});
test('宿主模型对象缺少选择能力时明确提示需要更新版本', async () => {
  const { api } = runtime({ agent: { model: {} } });
  const out = await api.sessions.selectModel({ payload: choice });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'host-unsupported');
  assert.ok(out.result.error.message.includes('更新版本'));
});
test('HTTP 切模型入口对 host-unsupported 静默放过，不阻断新建会话', async () => {
  // 反馈 #70：App 新建会话时先单独请求一次切模型；老宿主上这条会话还没有模型对象，
  // 原来回 400 会让 App 直接归档空会话、第一条消息发不出去。这里必须和 `/session/send`
  // 一样放过（200 + ok），继续用会话当前模型。
  const contexts = [
    runtime({ agent: {} }).ctx, // 新建会话：agent 还没有 model
    (() => {
      const base = runtime();
      return { get: (key) => key === 'sessionController' ? {} : base.ctx.get(key) }; // 老宿主：没有 resolveAgent
    })(),
  ];
  for (const ctx of contexts) {
    const req = Readable.from([Buffer.from(JSON.stringify(choice))]);
    req.headers = {};
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(String(body)); } };
    await handleSelectModel(ctx, req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied, false);
  }
});

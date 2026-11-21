// 工具取消与真实失败在历史、补丁、实时、详情和来源中保持同一状态。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MOBILE = path.join(__dirname, '..', 'lib', 'mobile');
const MODULES = ['tool-result-state', 'step-index', 'history-derive', 'live-steps', 'session-step', 'answer-sources'];

/** 变异模块图只加载内存源码，各消费者绑定同一份 helper。 */
function loadModules(mutation) {
  const cache = new Map();
  function load(name) {
    const file = path.join(MOBILE, `${name}.js`);
    if (cache.has(file)) return cache.get(file).exports;
    let source = fs.readFileSync(file, 'utf8');
    if (mutation && mutation.name === name) {
      assert.ok(source.includes(mutation.from), `${name} 的变异锚点必须存在`);
      source = source.replace(mutation.from, mutation.to);
    }
    const instance = new Module(file, module);
    cache.set(file, instance);
    instance.filename = file;
    instance.paths = Module._nodeModulePaths(MOBILE);
    const anchored = Module.createRequire(file);
    instance.require = (id) => {
      const target = anchored.resolve(id);
      const basename = path.basename(target, '.js');
      return path.dirname(target) === MOBILE && MODULES.includes(basename) ? load(basename) : anchored(id);
    };
    instance._compile(source, file);
    return instance.exports;
  }
  return Object.assign({}, ...MODULES.map(load));
}

const runtime = Object.assign({}, ...MODULES.map((name) => require(path.join(MOBILE, `${name}.js`))));
const event = (type, seq, data) => ({ type, seq, time: 1000 + seq, data });

/** 与 session-step / tool-result-images 的测试同形：当前块数组和旧信封各跑一次。 */
function conversation(sample, envelope = false) {
  const content = [{ type: 'text', text: sample.text || '工具输出' }];
  const message = {
    role: 'tool', source: { kind: 'tool', callId: 'call_1' },
    ...(envelope ? { content: [{ ...(sample.isError === undefined ? {} : { isError: sample.isError }), content }] }
      : { ...(sample.isError === undefined ? {} : { isError: sample.isError }), content }),
  };
  const error = sample.error || (sample.code === undefined ? undefined : { name: 'ToolError', code: sample.code });
  return [
    event('user/message', 1, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读取文件' }] }),
    event('assistant/message', 2, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"/work/a.md"}' },
    ] } }),
    event('tool/result', 3, { turn: 1, step: 1, message, ...(error ? { error } : {}) }),
  ];
}

/** 与一步详情测试相同的假宿主：按 beforeSeq 返回真实事件窗口。 */
function historyContext(events) {
  return { apiProxy: { sessions: { history: async ({ payload }) => {
    const list = events.filter((item) => payload.beforeSeq == null || item.seq < payload.beforeSeq);
    return { result: { ok: true, value: { events: list.map((item) => ({ type: 'event', event: item })), hasMore: false } } };
  } } } };
}

function request(handler, ctx, route, query) {
  return new Promise((resolve, reject) => {
    const res = {
      req: { headers: {} },
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    handler(ctx, { url: `/api/mobile/v1/session/${route}?${new URLSearchParams(query)}` }, res).catch(reject);
  });
}

async function assertStates(api, sample, envelope = false) {
  const events = conversation(sample, envelope);
  const expected = sample.state;
  const result = api.buildToolResultMap(events).get('call_1');
  assert.equal(result.isError, sample.isError === true || sample.error != null || sample.code !== undefined, '历史结果表传播失败证据');
  assert.equal(api.toolStepState(result), expected, 'step-index 状态');
  const items = api.deriveMessages(events);
  const card = items.flatMap((item) => item.blocks || []).find((block) => block.type === 'tool-call');
  assert.equal(card.state, expected, '历史工具卡状态');
  const opener = items.find((item) => item.role === 'user');
  assert.equal(opener.turnProcess.steps[0].state, expected, '历史过程清单状态');
  for (const options of [{}, { bodies: false }]) {
    assert.equal(api.toolResultPatchesFor(events, [], options)[0].state, expected, '结果补丁状态');
    assert.equal(api.toolResultPatchesFor(events, items, options)[0].state, expected, '已下发卡片的结果补丁状态');
  }

  const ctx = {};
  api.noteLiveEvent(ctx, 'live', event('turn/start', 0, { turn: 1 }));
  for (const item of events.slice(1)) api.noteLiveEvent(ctx, 'live', item);
  assert.equal(api.liveStepsOf(ctx, 'live')[0].step.state, expected, '实时过程清单状态');
  assert.equal(api.drainLiveSteps(ctx, 'live').at(-1).step.state, expected, '实时增量补丁状态');
  assert.equal(api.liveStepOf(ctx, 'live', { kind: 'tool', callId: 'call_1' }).state, expected, '实时详情副本状态');
  const live = await request(api.handleSessionStep, ctx, 'step', { sessionId: 'live', kind: 'tool', callId: 'call_1' });
  assert.equal(live.status, 200);
  assert.equal(live.body.step.state, expected, '实时详情端点状态');
  const query = { sessionId: 'history', kind: 'tool', callId: 'call_1', seq: '2', resultSeq: '3' };
  const history = await request(api.handleSessionStep, historyContext(events), 'step', query);
  assert.equal(history.status, 200);
  assert.equal(history.body.step.state, expected, '历史详情端点状态');
  assert.equal(history.body.step.output, sample.text || '工具输出', '状态派生不改变结果正文');

  const sources = await request(api.handleAnswerSources, historyContext(events), 'answer-sources', { sessionId: 'history', turn: '1' });
  assert.equal(sources.status, 200);
  assert.deepEqual(sources.body.sources.map((source) => source.place), expected === 'ok' ? ['/work/a.md'] : [], '历史失败或取消不记为来源');
  const liveSources = await request(api.handleAnswerSources, ctx, 'answer-sources', { sessionId: 'live', turn: '1' });
  assert.equal(liveSources.status, 200);
  assert.deepEqual(liveSources.body.sources.map((source) => source.place), expected === 'ok' ? ['/work/a.md'] : [], '实时来源与历史一致');
  api.clearLiveSteps(ctx, 'live');
}

const samples = [
  { label: '旧取消码', code: 'interrupted', state: 'stopped' },
  { label: '执行中取消', code: 'ABORTED', state: 'stopped' },
  { label: '派发前取消', code: 'ABORTED_BEFORE_DISPATCH', state: 'stopped' },
  { label: '普通执行失败', code: 'CODE_RUN_FAILED', state: 'error', text: 'Error: code run failed (exception)' },
  { label: '运行时内部 abort 仍是失败', code: 'CODE_RUN_FAILED', state: 'error', text: 'Error: code run failed (abort): runtime stopped' },
  { label: '权限拒绝', code: 'permission-denied', state: 'error' },
  { label: '超时', code: 'TOOL_TIMEOUT', state: 'error' },
  { label: '仅错误对象没有错误码', error: { name: 'ToolError' }, state: 'error' },
  { label: '只有失败标记', isError: true, state: 'error' },
  { label: '成功', state: 'ok' },
];

for (const envelope of [false, true]) {
  for (const sample of samples) {
    test(`${envelope ? '旧信封' : '当前结果'}：${sample.label}在所有路径一致`, async () => {
      await assertStates(runtime, sample, envelope);
    });
  }
}

test('取消码与失败标记同时存在仍识别停止，未落定结果保持运行中', () => {
  for (const code of ['interrupted', 'ABORTED', 'ABORTED_BEFORE_DISPATCH']) {
    assert.equal(runtime.toolResultState({ isError: true, code }), 'stopped');
    assert.equal(runtime.toolStepState({ isError: true, code }), 'stopped');
  }
  assert.equal(runtime.toolResultState(), 'running');
  assert.equal(runtime.toolStepState(null), 'running');
  assert.equal(runtime.toolResultState({}), 'ok');
  assert.equal(runtime.toolResultState({ isError: true }), 'error');
});

const mutations = [
  { label: '漏掉执行中取消码', name: 'tool-result-state', from: "code === 'ABORTED'", to: 'false', sample: samples[1] },
  { label: '漏掉派发前取消码', name: 'tool-result-state', from: "code === 'ABORTED_BEFORE_DISPATCH'", to: 'false', sample: samples[2] },
  { label: '漏掉旧取消码', name: 'tool-result-state', from: "code === 'interrupted'", to: 'false', sample: samples[0] },
  { label: '把普通代码失败当停止', name: 'tool-result-state', from: "code === 'interrupted'", to: "code === 'CODE_RUN_FAILED' || code === 'interrupted'", sample: samples[3] },
  { label: 'step-index 绕过统一状态', name: 'step-index', from: 'return toolResultState(result);', to: "return result ? 'ok' : 'running';", sample: samples[1] },
  { label: '历史卡片绕过统一状态', name: 'history-derive', from: '          state = toolStepState(result);', to: "          state = 'ok';", sample: samples[1] },
  { label: '历史补丁绕过统一状态', name: 'history-derive', from: 'const state = toolStepState(result);', to: "const state = 'ok';", sample: samples[1] },
  { label: '实时路径绕过统一状态', name: 'live-steps', from: 'const state = toolResultState({ isError: isError || data.error != null, code });', to: "const state = 'ok';", sample: samples[1] },
  { label: '历史详情绕过统一状态', name: 'session-step', from: 'state = toolResultState({ isError: failed || result.data.error != null, code });', to: "state = 'ok';", sample: samples[1] },
  { label: '来源路径绕过统一状态', name: 'answer-sources', from: "toolResultState({ isError: !successfulResult(event), code: event.data?.error?.code })", to: "'ok'", sample: samples[1] },
];

for (const mutation of mutations) {
  test(`内存变异证明：${mutation.label}会被定向断言抓住`, async () => {
    const api = loadModules(mutation);
    await assert.rejects(() => assertStates(api, mutation.sample), { code: 'ERR_ASSERTION' });
  });
}

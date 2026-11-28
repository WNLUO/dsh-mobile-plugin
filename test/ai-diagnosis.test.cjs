// 2026-11-24：本机面板 AI 问诊按钮的取选项 / 发首句纯函数契约（假 ctx，不碰真宿主）。
// 2026-11-28：首句带包内 dsh-mobile-kb 正文，缺失时退回原首句。
'use strict';

/**
 * lib/ai-diagnosis.js 的契约：两条本机控制面路由只做转发，所有形状与错误都在这里定。
 * 假体只实现宿主 apiProxy 那几个动词，按真实信封回 { result: { ok, value | error } }。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildAiDiagnosisOptions, launchAiDiagnosis, withKnowledgeBase } = require('../lib/ai-diagnosis.js');

function ok(value) { return { result: { ok: true, value } }; }
function fail(code, message) { return { result: { ok: false, error: { code, message } } }; }

function ctxOf(overrides = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      workspace: {
        list: async (request) => {
          calls.push(['workspace.list', request]);
          return overrides.workspaceList ? overrides.workspaceList(request)
            : ok({ items: [{ workspaceId: 'w1', title: '项目', path: '/p' }] });
        },
        archiveSession: async (request) => {
          calls.push(['workspace.archiveSession', request]);
          return overrides.archiveSession ? overrides.archiveSession(request) : ok({ archived: true });
        },
      },
      llm: {
        models: async (request) => {
          calls.push(['llm.models', request]);
          return overrides.models ? overrides.models(request) : ok({ groups: [], defaultModel: null });
        },
      },
      sessions: {
        create: async (request, signal) => {
          calls.push(['session.create', request, signal]);
          return overrides.create ? overrides.create(request) : ok({ sessionId: 's-1' });
        },
        prompt: async (request, signal) => {
          calls.push(['session.prompt', request, signal]);
          return overrides.prompt ? overrides.prompt(request) : ok({ accepted: true });
        },
      },
    },
  };
  return { ctx, calls };
}

test('options：默认工作区排最前，只透四格，缺 workspaceId 的也留着', async () => {
  const { ctx, calls } = ctxOf({
    workspaceList: () => ok({ items: [
      { workspaceId: 'w-b', title: '项目 B', path: '/p/b' },
      { title: 'default-workspace', path: '/Users/me/default-workspace/' },
      { workspaceId: 'w-a', title: '项目 A', path: '/p/default-workspace' },
      { workspaceId: 'w-c', title: '项目 C', path: '/p/c' },
    ] }),
  });
  const result = await buildAiDiagnosisOptions(ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.workspaces.map((row) => row.workspaceId), ['', 'w-a', 'w-b', 'w-c']);
  assert.deepEqual(result.workspaces.map((row) => row.isDefault), [true, true, false, false]);
  assert.equal(result.workspaces[0].path, '/Users/me/default-workspace/');
  assert.deepEqual(Object.keys(result.workspaces[0]).sort(), ['isDefault', 'path', 'title', 'workspaceId']);
  assert.deepEqual(calls.find((call) => call[0] === 'workspace.list')[1], {
    rpcId: 'panel', method: 'workspace.list', payload: {},
  });
  assert.deepEqual(calls.find((call) => call[0] === 'llm.models')[1], {
    rpcId: 'panel', method: 'llm.models', payload: {},
  });

  // 宿主直接回数组也认（与移动端 workspace.list 的两种形状一致）。
  const bare = ctxOf({ workspaceList: () => ok([{ workspaceId: 'w1', title: 'T', path: '/p' }]) });
  assert.equal((await buildAiDiagnosisOptions(bare.ctx)).workspaces[0].workspaceId, 'w1');
});

test('options：模型按组精简、丢空组，限 40 个 / 16 组，默认模型两格齐全才给', async () => {
  const models = Array.from({ length: 41 }, (_, i) => ({
    id: `m${i}`, name: `模型 ${i}`, reasoningEfforts: { high: '高' },
  }));
  const { ctx } = ctxOf({
    models: () => ok({
      groups: [
        ...Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: `提供方 ${i}`, models })),
        { id: '', name: '没 id', models },
        { id: 'empty', name: '空组', models: [] },
      ],
      defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
      current: { provider: 'other', model: 'x' },
    }),
  });
  const result = await buildAiDiagnosisOptions(ctx);
  assert.equal(result.models.length, 16);
  assert.deepEqual(result.models[0], {
    provider: 'p0',
    displayName: '提供方 0',
    models: models.slice(0, 40).map((row) => ({ id: row.id, name: row.name })),
  });
  assert.deepEqual(result.defaultModel, { provider: 'deepseek', model: 'deepseek-chat' });

  const fallback = ctxOf({ models: () => ok({ groups: [], current: { provider: 'c', model: 'cm' } }) });
  assert.deepEqual((await buildAiDiagnosisOptions(fallback.ctx)).defaultModel, { provider: 'c', model: 'cm' });
  const partial = ctxOf({ models: () => ok({ groups: [], current: { provider: 'c' } }) });
  assert.equal((await buildAiDiagnosisOptions(partial.ctx)).defaultModel, null);
  const noName = ctxOf({ models: () => ok({ groups: [{ id: 'p', models: [{ id: 'm' }] }] }) });
  assert.deepEqual((await buildAiDiagnosisOptions(noName.ctx)).models, [
    { provider: 'p', displayName: 'p', models: [{ id: 'm', name: 'm' }] },
  ]);
});

test('options：任一路 RPC 失败或形状异常回 ok:false，不抛给路由层', async () => {
  const workspaceFailed = ctxOf({ workspaceList: () => fail('host-unavailable', '宿主没连上') });
  assert.deepEqual(await buildAiDiagnosisOptions(workspaceFailed.ctx), {
    ok: false, error: { code: 'host-unavailable', message: '宿主没连上' },
  });
  assert.equal(workspaceFailed.calls.filter((call) => call[0] === 'llm.models').length, 0);

  const workspaceShaped = ctxOf({ workspaceList: () => ok({ nope: true }) });
  assert.equal((await buildAiDiagnosisOptions(workspaceShaped.ctx)).error.code, 'host-workspace-list-degraded');

  const modelsFailed = ctxOf({ models: () => fail('llm-unavailable', '模型服务没起') });
  assert.deepEqual(await buildAiDiagnosisOptions(modelsFailed.ctx), {
    ok: false, error: { code: 'llm-unavailable', message: '模型服务没起' },
  });
  const modelsShaped = ctxOf({ models: () => ok({ groups: 'oops' }) });
  assert.equal((await buildAiDiagnosisOptions(modelsShaped.ctx)).error.code, 'host-model-list-degraded');

  const noProxy = await buildAiDiagnosisOptions({ apiProxy: {} });
  assert.equal(noProxy.ok, false);
  assert.equal(noProxy.error.code, 'internal');
});

test('launch：prompt 与可选字段校验，非法输入不碰宿主', async () => {
  for (const prompt of [undefined, '', '   ', 123, 'x'.repeat(20001)]) {
    const { ctx, calls } = ctxOf();
    const result = await launchAiDiagnosis(ctx, { prompt });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'bad-request');
    assert.equal(calls.length, 0);
  }
  for (const key of ['workspaceId', 'provider', 'model']) {
    const { ctx, calls } = ctxOf();
    const result = await launchAiDiagnosis(ctx, { prompt: 'hi', [key]: 'x'.repeat(201) });
    assert.equal(result.error.code, 'bad-request');
    assert.equal(calls.length, 0);
  }
});

test('launch：建会话并把首句与 modelSelection 一起发出去', async () => {
  const { ctx, calls } = ctxOf();
  const result = await launchAiDiagnosis(ctx, {
    prompt: '帮我看下网络', workspaceId: ' w1 ', provider: ' deepseek ', model: ' deepseek-chat ',
  });
  assert.deepEqual(result, { ok: true, sessionId: 's-1' });
  assert.deepEqual(calls.find((call) => call[0] === 'session.create')[1], {
    rpcId: 'mobile', method: 'session.create', payload: { workspaceId: 'w1' },
  });
  const promptCall = calls.find((call) => call[0] === 'session.prompt')[1];
  assert.equal(promptCall.rpcId, 'panel-ai-diagnosis');
  assert.equal(promptCall.method, 'session.prompt');
  assert.equal(promptCall.payload.sessionId, 's-1');
  assert.deepEqual(promptCall.payload.modelSelection, { provider: 'deepseek', model: 'deepseek-chat' });
  // 需求变了：桌面会话调不到 dsh-mobile-kb，首句要带正文，而不是只发面板那句话。
  const text = promptCall.payload.content[0].text;
  assert.ok(text.startsWith('帮我看下网络'));
  assert.ok(text.includes('dsh-mobile-kb 技能的正文'));
  assert.ok(text.includes('name: dsh-mobile-kb'));
  assert.ok(text.includes('references/network.md'));

  const partial = ctxOf();
  await launchAiDiagnosis(partial.ctx, { prompt: 'hi', provider: 'deepseek' });
  const prompt = partial.calls.find((call) => call[0] === 'session.prompt')[1];
  assert.equal(Object.hasOwn(prompt.payload, 'modelSelection'), false);
  assert.deepEqual(partial.calls.find((call) => call[0] === 'session.create')[1].payload, {});
});

test('launch：发首句失败时归档刚建的会话；建会话失败不归档，也不抛', async () => {
  const rejected = ctxOf({ prompt: () => fail('model-unavailable', '没有这个模型') });
  assert.deepEqual(await launchAiDiagnosis(rejected.ctx, { prompt: 'hi' }), {
    ok: false, error: { code: 'model-unavailable', message: '没有这个模型' },
  });
  const archived = rejected.calls.filter((call) => call[0] === 'workspace.archiveSession');
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0][1], {
    rpcId: 'panel', method: 'workspace.archiveSession', payload: { sessionId: 's-1' },
  });

  const thrown = ctxOf({ prompt: () => { throw new Error('boom'); } });
  const thrownResult = await launchAiDiagnosis(thrown.ctx, { prompt: 'hi' });
  assert.equal(thrownResult.ok, false);
  assert.equal(thrownResult.error.code, 'internal');
  assert.equal(thrown.calls.filter((call) => call[0] === 'workspace.archiveSession').length, 1);

  const createFailed = ctxOf({ create: () => fail('host-unavailable', 'down') });
  assert.deepEqual(await launchAiDiagnosis(createFailed.ctx, { prompt: 'hi' }), {
    ok: false, error: { code: 'host-unavailable', message: 'down' },
  });
  assert.equal(createFailed.calls.filter((call) => call[0] === 'workspace.archiveSession').length, 0);

  const noSessionId = ctxOf({ create: () => ok({}) });
  assert.equal((await launchAiDiagnosis(noSessionId.ctx, { prompt: 'hi' })).error.code, 'internal');
  assert.equal(noSessionId.calls.filter((call) => call[0] === 'session.prompt').length, 0);

  const noProxy = await launchAiDiagnosis({ apiProxy: {} }, { prompt: 'hi' });
  assert.equal(noProxy.ok, false);
  assert.equal(noProxy.error.code, 'internal');
});

test('知识库读不到时只发原首句，不让问诊整体失败', () => {
  const prompt = '帮我看下网络';
  assert.equal(withKnowledgeBase(prompt, path.join(__dirname, 'missing-kb')), prompt);
});

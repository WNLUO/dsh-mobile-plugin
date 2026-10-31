'use strict';

/**
 * 目录类接口的条件刷新：`?rev=<上次的 revision>` 命中时只回一句 `unchanged`。
 *
 * 场景与 `/sessions` 一样，只是换了一批数据：宿主设置页的模型提供方与模型目录、插件清单、
 * 渠道清单、Agent 预设名单。它们只在用户于电脑上动手之后才变，而手机每次进那几页都要读一遍，
 * 其中模型目录是最大的一份（每个提供方下面几十上百条模型）。
 *
 * 四条口径与列表那条完全一致（判据是同一个纯函数）：
 *   - 整份响应带 `revision`，客户端存下来下次带回来；
 *   - `rev` 恰好相等 → `{ok, unchanged:true, revision}`，**不带**业务字段；
 *   - `rev` 不匹配 / 缺失 / 为空 → 照常回整份；
 *   - 内容真的变了 → 指纹跟着变，下一发就不会被短路掉。
 *
 * 本测试驱动真实 handler（不是转写实现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { handleLlmProviders, handleLlmModels } = require('../lib/mobile/host-settings.js');
const { handlePlugins } = require('../lib/mobile/plugins.js');
const { handleChannels } = require('../lib/mobile/channels.js');
const { handleAgentPresets } = require('../lib/mobile/session-presets.js');

const REV16 = /^[0-9a-f]{16}$/;

function makeReq(url) {
  const req = Readable.from([Buffer.from('{}')]);
  req.headers = {};
  req.url = url;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

async function get(handler, ctx, url) {
  const res = makeRes();
  await handler(ctx, makeReq(url), res);
  assert.equal(res.status, 200, `${url} 应当 200`);
  return res.body;
}

/** 假宿主：`llm.providers` / `llm.models` 的读数会是活对象，改它就是「电脑上变了」。 */
function hostCtx(state) {
  return {
    apiProxy: {
      llm: {
        providers: async () => ({ result: { ok: true, value: { providers: state.providers } } }),
        models: async () => ({ result: { ok: true, value: { groups: state.groups } } }),
      },
      settings: {
        describe: async () => ({
          result: { ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: state.routes || {} } }] } },
        }),
      },
      credentials: {
        describe: async () => ({ result: { ok: true, value: {} } }),
      },
    },
  };
}

/** 插件清单走网关（`ctx.get('typertGateway')`），形状与 plugins.test.cjs 同一份。 */
function pluginCtx(state) {
  const gateway = {
    async invoke() { return { entries: state.entries }; },
  };
  return { get: (name) => (name === 'typertGateway' ? gateway : undefined) };
}

const CASES = [
  {
    name: 'llm/providers',
    url: '/api/mobile/v1/llm/providers',
    handler: handleLlmProviders,
    payloadKey: 'providers',
    state: () => ({ providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek', active: true }] }),
    mutate: (state) => { state.providers = [{ provider: 'deepseek-official', displayName: 'DeepSeek', active: false }]; },
  },
  {
    name: 'llm/models',
    url: '/api/mobile/v1/llm/models',
    handler: handleLlmModels,
    payloadKey: 'groups',
    state: () => ({ groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }] }),
    mutate: (state) => {
      state.groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'R1' }] }];
    },
  },
  {
    name: 'plugins',
    url: '/api/mobile/v1/plugins',
    handler: handlePlugins,
    payloadKey: 'items',
    state: () => ({ entries: [{ entryId: 'include:llm', moduleName: '@dsh/llm', enabled: true, fiberPhase: 'active' }] }),
    mutate: (state) => { state.entries = [{ entryId: 'include:llm', moduleName: '@dsh/llm', enabled: false, fiberPhase: null }]; },
    ctx: pluginCtx,
  },
  {
    name: 'channels',
    url: '/api/mobile/v1/channels',
    handler: handleChannels,
    payloadKey: 'channels',
    state: () => ({
      routes: {
        'my-gateway': { displayName: '我的网关', api: 'openai-completions', baseURL: 'https://gw.example.com', models: [{ id: 'gpt-x', name: 'GPT X' }] },
      },
      providers: [{ provider: 'my-gateway', displayName: '我的网关', active: true }],
      groups: [{ id: 'my-gateway', name: '我的网关', models: [{ id: 'gpt-x', name: 'GPT X' }] }],
    }),
    mutate: (state) => {
      state.routes['my-gateway'].models = [{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }];
    },
  },
  {
    name: 'agent-presets',
    url: '/api/mobile/v1/agent-presets',
    handler: handleAgentPresets,
    payloadKey: 'presets',
    state: () => ({ presets: [{ id: 'standard', trust: 'system', isDefault: true }], authorable: true, hasDocument: true }),
    mutate: (state) => { state.presets = [{ id: 'standard', trust: 'system', isDefault: false }]; },
    ctx: (state) => ({
      apiProxy: {
        agentPresets: {
          list: async () => ({ result: { ok: true, value: { presets: state.presets, authorable: state.authorable, hasDocument: state.hasDocument } } }),
        },
      },
    }),
  },
];

for (const item of CASES) {
  const buildCtx = item.ctx || hostCtx;

  test(`${item.name}：整份带内容指纹，rev 命中只回 unchanged`, async () => {
    const state = item.state();
    const ctx = buildCtx(state);

    const full = await get(item.handler, ctx, item.url);
    assert.ok(Array.isArray(full[item.payloadKey]), `${item.name} 整份要带 ${item.payloadKey}`);
    assert.match(full.revision, REV16, `${item.name} 整份要带内容指纹`);

    const trimmed = await get(item.handler, ctx, `${item.url}?rev=${encodeURIComponent(full.revision)}`);
    assert.deepEqual(trimmed, { ok: true, unchanged: true, revision: full.revision });
    assert.equal(Object.hasOwn(trimmed, item.payloadKey), false, 'unchanged 响应不带业务字段');
  });

  test(`${item.name}：rev 不匹配 / 缺失 / 为空时回整份`, async () => {
    const state = item.state();
    const ctx = buildCtx(state);
    const full = await get(item.handler, ctx, item.url);

    for (const url of [`${item.url}?rev=deadbeefdeadbeef`, `${item.url}?rev=`, item.url]) {
      const body = await get(item.handler, ctx, url);
      assert.equal(body.unchanged, undefined, `${url} 不该走 unchanged`);
      assert.ok(Array.isArray(body[item.payloadKey]));
      assert.equal(body.revision, full.revision);
    }
  });

  test(`${item.name}：内容变了指纹就变，旧指纹不再命中`, async () => {
    const state = item.state();
    const ctx = buildCtx(state);
    const before = await get(item.handler, ctx, item.url);

    item.mutate(state);
    const after = await get(item.handler, ctx, `${item.url}?rev=${encodeURIComponent(before.revision)}`);
    assert.equal(after.unchanged, undefined, '内容变了就必须回整份');
    assert.notEqual(after.revision, before.revision, '内容变了指纹必须跟着变');
  });
}

test('指纹只看内容，不含时间戳：同一份内容连问两次，指纹一致', async () => {
  const state = { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] };
  const ctx = hostCtx(state);
  const first = await get(handleLlmModels, ctx, '/api/mobile/v1/llm/models');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await get(handleLlmModels, ctx, '/api/mobile/v1/llm/models');
  assert.equal(second.revision, first.revision);
});

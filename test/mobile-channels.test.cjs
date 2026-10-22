'use strict';

/**
 * 渠道管理的移动端契约（GET /channels、/channels/discover、/channels/save、/channels/delete）。
 *
 * 这一组 handler 能破坏的是**宿主上的模型配置**，所以四条硬约束各自钉住：
 *
 *  1. **只动能动的那一段**：写 / 删都只提交 `['providers', <id>]` 的 set / unset。
 *     整段覆盖 `providers` 会把用户在 `cordis.patch.yml` 里手写的其它路由一起抹掉
 *     （桌面面板 2026-10-19 踩过一次），所以断言里连路径都逐字比对。
 *  2. **先 Key 后路由，路由失败要回滚 Key**：不让「有 Key 没路由」的孤儿凭据留在库里。
 *  3. **插件提供的那批不出现写操作**：清单里标成 external，App 不给入口，插件侧也不接
 *     它们的删除（删除接口只认 `llm-pi-ai` 里真的存在的那一条）。
 *  4. **获取模型由宿主代问**：协议与 Key 原样交给宿主 `llm.discoverModels`，地址不带
 *     路径时按 `/v1` 回退一次，并把问通的那个地址带回去（保存要写它）。
 *
 * 本测试驱动真实 handler（起真 http 服务、真 req/res），不是转写实现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { readRouteTable } = require('./lib/wiring.cjs');
const {
  handleChannels,
  handleChannelDiscover,
  handleChannelSave,
  handleChannelDelete,
  credentialRefOf,
  providerIdOf,
  profileOf,
  discoverCandidates,
} = require('../lib/mobile/channels.js');

/** 一份可复用的宿主读数：一条自建路由 + 一个插件提供方。 */
function fixture() {
  return {
    settings: {
      llm: {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'my-gateway': {
              displayName: '我的网关',
              api: 'openai-completions',
              baseURL: 'https://gw.example.com',
              apiKeyEnv: 'OFM_MY_GATEWAY_KEY',
              models: [{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }],
            },
          },
        },
      },
    },
    providers: [
      { provider: 'my-gateway', displayName: '我的网关', active: false },
      { provider: 'buddy', displayName: 'Buddy', active: true },
    ],
    groups: [
      { id: 'my-gateway', name: '我的网关', models: [{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y', name: 'GPT Y' }] },
      { id: 'buddy', name: 'Buddy', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    ],
    credentials: { OFM_MY_GATEWAY_KEY: { configured: true, writable: true } },
  };
}

/** 起一个只挂四个 handler 的真 http 服务，并记下每次宿主调用。 */
async function serve(options = {}) {
  const calls = [];
  const state = options.state || fixture();
  const ctx = {
    get(name) {
      return name === 'llm' ? options.llm : undefined;
    },
    apiProxy: {
      settings: {
        describe: async (request) => {
          calls.push({ method: 'settings.describe', request });
          if (options.describeError) return { result: { ok: false, error: { code: 'settings-unavailable', message: 'no' } } };
          return { result: { ok: true, value: { namespaces: [state.settings.llm] } } };
        },
        mutate: async (request) => {
          calls.push({ method: 'settings.mutate', request });
          if (options.mutateError) return { result: { ok: false, error: { code: 'settings-rejected', message: '拒绝写入' } } };
          return { result: { ok: true, value: state.settings.llm } };
        },
      },
      llm: {
        providers: async (request) => {
          calls.push({ method: 'llm.providers', request });
          return { result: { ok: true, value: { providers: state.providers } } };
        },
        models: async (request) => {
          calls.push({ method: 'llm.models', request });
          return { result: { ok: true, value: { groups: state.groups } } };
        },
      },
      credentials: {
        describe: async (request) => {
          calls.push({ method: 'credentials.describe', request });
          return { result: { ok: true, value: state.credentials } };
        },
        set: async (request) => {
          calls.push({ method: 'credentials.set', request });
          return { result: { ok: true, value: {} } };
        },
        unset: async (request) => {
          calls.push({ method: 'credentials.unset', request });
          return { result: { ok: true, value: {} } };
        },
      },
    },
  };

  const paths = {
    '/channels': handleChannels,
    '/channels/discover': handleChannelDiscover,
    '/channels/save': handleChannelSave,
    '/channels/delete': handleChannelDelete,
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api\/mobile\/v1/, '');
    const handler = paths[path];
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error && error.message) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/mobile/v1`;
  return {
    calls,
    get: async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json() };
    },
    post: async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('路由接线：四条端点挂在移动端路由表上，且引入了 channels 模块', () => {
  const table = readRouteTable();
  for (const path of ['/channels', '/channels/discover', '/channels/save', '/channels/delete']) {
    assert.ok(table.includes(`route('/api/mobile/v1${path}'`), `路由表缺 ${path}`);
  }
  assert.match(table, /require\(['"]\.\.\/mobile\/channels/);
});

test('清单：自建与插件提供分开列，自建带 Key 状态、插件那批不进写路径', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.get('/channels');
    assert.equal(status, 200);
    const custom = body.channels.find((row) => row.id === 'my-gateway');
    assert.equal(custom.source, 'custom');
    assert.equal(custom.keySet, true);
    assert.equal(custom.baseUrl, 'https://gw.example.com');
    assert.deepEqual(custom.models.map((row) => row.id), ['gpt-x', 'gpt-y']);
    // 同一条 provider 在 llm.providers 里也出现，但只能以「自建」身份列一次。
    assert.equal(body.channels.filter((row) => row.id === 'my-gateway').length, 1);
    const plugin = body.channels.find((row) => row.id === 'buddy');
    assert.equal(plugin.source, 'external');
    assert.equal(plugin.active, true);
    assert.equal(plugin.keySet, undefined);
  } finally {
    await server.close();
  }
});

test('新增：先写 Key、再按路径写 providers.<id>，id 由名字生成并避开已占用的', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.post('/channels/save', {
      name: 'my gateway 2',
      protocol: 'openai-completions',
      baseUrl: 'https://gw2.example.com/',
      apiKey: 'sk-test',
      models: [{ id: 'm-1' }, { id: 'm-2', name: 'M 2', contextWindow: 1000 }],
    });
    assert.equal(status, 200);
    assert.equal(body.channel.id, 'my-gateway-2');

    const set = server.calls.find((call) => call.method === 'credentials.set');
    assert.deepEqual(set.request.payload, { ref: 'OFM_MY_GATEWAY_2_KEY', value: 'sk-test' });
    const mutate = server.calls.find((call) => call.method === 'settings.mutate');
    assert.equal(mutate.request.payload.ns, 'llm-pi-ai');
    assert.equal(mutate.request.payload.ops.length, 1);
    assert.equal(mutate.request.payload.ops[0].op, 'set');
    assert.deepEqual(mutate.request.payload.ops[0].path, ['providers', 'my-gateway-2']);
    const profile = mutate.request.payload.ops[0].value;
    assert.equal(profile.api, 'openai-completions');
    assert.equal(profile.baseURL, 'https://gw2.example.com');       // 末尾斜杠已去掉
    assert.equal(profile.apiKeyEnv, 'OFM_MY_GATEWAY_2_KEY');
    assert.equal(profile.models[0].contextWindow, 262144);          // 缺省与 pi-ai 同值
    assert.equal(profile.models[1].contextWindow, 1000);
    assert.deepEqual(profile.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', max: 'max' });
    // 顺序：Key 必须在路由之前写进去，否则聊天会在中间那一小段时间里拿不到鉴权。
    const order = server.calls.filter((call) => call.method === 'credentials.set' || call.method === 'settings.mutate').map((call) => call.method);
    assert.deepEqual(order, ['credentials.set', 'settings.mutate']);
  } finally {
    await server.close();
  }
});

test('编辑：id 不变、Key 留空不碰凭据库、能力字段沿用原路由（手机没有那几格）', async () => {
  const state = fixture();
  // 桌面面板里精细调过的那条：上下文 111、能看图、明确不思考。
  state.settings.llm.value.providers['my-gateway'].models = [
    { id: 'gpt-x', name: 'GPT X', contextWindow: 111, maxTokens: 222, input: ['text', 'image'], reasoningEfforts: false },
  ];
  const server = await serve({ state });
  try {
    const { status, body } = await server.post('/channels/save', {
      id: 'my-gateway',
      name: '我的网关改名',
      protocol: 'anthropic-messages',
      baseUrl: 'https://gw3.example.com',
      apiKey: '',
      models: [{ id: 'gpt-x' }, { id: 'gpt-z' }],
    });
    assert.equal(status, 200);
    assert.equal(body.channel.id, 'my-gateway');
    assert.equal(body.channel.source, 'custom');

    // Key 留空 = 沿用原来的：一个写凭据的调用都不该出现。
    assert.equal(server.calls.filter((call) => call.method === 'credentials.set').length, 0);

    const mutate = server.calls.find((call) => call.method === 'settings.mutate');
    assert.deepEqual(mutate.request.payload.ops[0].path, ['providers', 'my-gateway']);
    const profile = mutate.request.payload.ops[0].value;
    assert.equal(profile.displayName, '我的网关改名');
    assert.equal(profile.api, 'anthropic-messages');
    assert.equal(profile.baseURL, 'https://gw3.example.com');
    // 老模型：名字与清单跟着表单走，能力字段原样保留。
    assert.equal(profile.models[0].name, 'GPT X');
    assert.equal(profile.models[0].contextWindow, 111);
    assert.equal(profile.models[0].maxTokens, 222);
    assert.deepEqual(profile.models[0].input, ['text', 'image']);
    assert.equal(profile.models[0].reasoningEfforts, false);
    // 新模型：按缺省值落。
    assert.equal(profile.models[1].id, 'gpt-z');
    assert.equal(profile.models[1].contextWindow, 262144);
    assert.deepEqual(profile.models[1].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', max: 'max' });
  } finally {
    await server.close();
  }
});

test('编辑：重填了 Key 就写进同一个凭据位；id 不在自建清单里回 404 且不写', async () => {
  const server = await serve();
  try {
    const ok = await server.post('/channels/save', {
      id: 'my-gateway',
      name: '我的网关',
      protocol: 'openai-completions',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-new',
      models: [{ id: 'gpt-x' }],
    });
    assert.equal(ok.status, 200);
    const set = server.calls.find((call) => call.method === 'credentials.set');
    assert.deepEqual(set.request.payload, { ref: 'OFM_MY_GATEWAY_KEY', value: 'sk-new' });

    server.calls.length = 0;
    const missing = await server.post('/channels/save', {
      id: 'buddy',
      name: 'Buddy',
      protocol: 'openai-completions',
      baseUrl: 'https://a.example.com',
      apiKey: '',
      models: [{ id: 'm' }],
    });
    assert.equal(missing.status, 404);
    assert.equal(server.calls.filter((call) => call.method === 'settings.mutate').length, 0);
  } finally {
    await server.close();
  }
});

test('新增失败回滚：路由被拒时清掉刚写的 Key，且报宿主的原话', async () => {
  const server = await serve({ mutateError: true });
  try {
    const { status, body } = await server.post('/channels/save', {
      name: 'bad-route',
      protocol: 'openai-completions',
      baseUrl: 'https://bad.example.com',
      apiKey: 'sk-bad',
      models: [{ id: 'm-1' }],
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'settings-rejected');
    const unset = server.calls.find((call) => call.method === 'credentials.unset');
    assert.deepEqual(unset.request.payload, { ref: 'OFM_BAD_ROUTE_KEY' });
  } finally {
    await server.close();
  }
});

test('新增校验：名称 / 地址 / Key / 模型清单各自缺一不可，畸形地址与未知协议一律 400', async () => {
  const server = await serve();
  try {
    const base = { name: 'x', protocol: 'openai-completions', baseUrl: 'https://a.example.com', apiKey: 'k', models: [{ id: 'm' }] };
    for (const broken of [
      { ...base, name: ' ' },
      { ...base, baseUrl: '' },
      { ...base, baseUrl: 'ftp://a.example.com' },
      { ...base, baseUrl: 'not a url' },
      { ...base, apiKey: '' },
      { ...base, protocol: 'whatever' },
      { ...base, models: [] },
      { ...base, models: [{ id: 'a' }, { id: 'a' }] },
    ]) {
      const { status } = await server.post('/channels/save', broken);
      assert.equal(status, 400, JSON.stringify(broken));
    }
    // 校验不过时不该碰宿主的任何写接口。
    assert.equal(server.calls.filter((call) => call.method === 'credentials.set').length, 0);
    assert.equal(server.calls.filter((call) => call.method === 'settings.mutate').length, 0);
  } finally {
    await server.close();
  }
});

test('删除：只 unset providers.<id> 与那把 Key；不在自建清单里的 id 回 404 且不写', async () => {
  const server = await serve();
  try {
    const ok = await server.post('/channels/delete', { id: 'my-gateway' });
    assert.equal(ok.status, 200);
    const mutate = server.calls.find((call) => call.method === 'settings.mutate');
    assert.deepEqual(mutate.request.payload.ops, [{ op: 'unset', path: ['providers', 'my-gateway'] }]);
    const unset = server.calls.find((call) => call.method === 'credentials.unset');
    assert.deepEqual(unset.request.payload, { ref: 'OFM_MY_GATEWAY_KEY' });

    server.calls.length = 0;
    const missing = await server.post('/channels/delete', { id: 'buddy' });
    assert.equal(missing.status, 404);
    assert.equal(server.calls.filter((call) => call.method === 'settings.mutate').length, 0);

    const bad = await server.post('/channels/delete', { id: 'Bad Id!' });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('获取模型：宿主代问，地址不带路径时按 /v1 回退，并把问通的地址带回去', async () => {
  const seen = [];
  const llm = {
    discoverModels: async (ns, input) => {
      seen.push({ ns, input });
      if (seen.length === 1) throw new Error('answered 404');
      return [{ id: 'm-1', name: 'M1' }, { id: 'm-2' }];
    },
  };
  const server = await serve({ llm });
  try {
    const { status, body } = await server.post('/channels/discover', {
      protocol: 'openai-completions',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-q',
    });
    assert.equal(status, 200);
    assert.deepEqual(seen.map((row) => row.input.baseURL), ['https://api.example.com', 'https://api.example.com/v1']);
    assert.ok(seen.every((row) => row.ns === 'llm-pi-ai'));
    assert.ok(seen.every((row) => row.input.api === 'openai-completions' && row.input.apiKey === 'sk-q'));
    assert.equal(body.baseUrl, 'https://api.example.com/v1');
    assert.deepEqual(body.models.map((row) => row.id), ['m-1', 'm-2']);
  } finally {
    await server.close();
  }
});

test('获取模型：宿主没有 llm 服务时回 503，不假装成功', async () => {
  const server = await serve();
  try {
    const { status, body } = await server.post('/channels/discover', { protocol: 'openai-completions', baseUrl: 'https://a.example.com' });
    assert.equal(status, 503);
    assert.equal(body.error.code, 'unsupported');
  } finally {
    await server.close();
  }
});

test('纯函数：id 生成 / 凭据引用 / 回退候选与桌面端同一口径', () => {
  assert.equal(providerIdOf('我的 网关 / A', new Set()), 'a');
  assert.equal(providerIdOf('gw', new Set(['gw'])), 'gw-2');
  assert.equal(providerIdOf('2024 gw', new Set()), 'route-2024-gw');
  assert.equal(credentialRefOf('my-gw'), 'OFM_MY_GW_KEY');
  assert.deepEqual(discoverCandidates('https://a.example.com', 'openai-completions'), ['https://a.example.com', 'https://a.example.com/v1']);
  assert.deepEqual(discoverCandidates('https://a.example.com/custom/v1', 'openai-completions'), ['https://a.example.com/custom/v1']);
  assert.deepEqual(discoverCandidates('https://a.example.com', 'anthropic-messages'), ['https://a.example.com']);
  assert.equal(profileOf({ id: 'x', name: 'X', protocol: 'anthropic-messages', baseUrl: 'https://a', models: [{ id: 'm', name: 'm', contextWindow: 1, maxTokens: 2, vision: true }] }).models[0].input[1], 'image');
  // 编辑基底：同一条模型的能力字段不会被缺省值覆盖，不认识的字段原样带回。
  const merged = profileOf(
    { id: 'x', name: 'X', protocol: 'openai-completions', baseUrl: 'https://a', models: [{ id: 'm', name: 'm' }] },
    { displayName: 'old', api: 'openai-completions', baseURL: 'https://old', headers: { a: 'b' }, models: [{ id: 'm', name: 'old', contextWindow: 7, reasoningEfforts: false }] },
  );
  assert.equal(merged.models[0].contextWindow, 7);
  assert.equal(merged.models[0].reasoningEfforts, false);
  assert.deepEqual(merged.headers, { a: 'b' });
});

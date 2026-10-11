'use strict';

/**
 * 宿主设置 / 模型提供方代理（GET /api/mobile/v1/host-settings、/api/mobile/v1/llm/providers）
 * 的透传契约。
 *
 * 桌面端「设置」面板读的是宿主的 settings.describe 与 llm.providers；手机端此前完全没有
 * 这一块。这两个 handler 的职责很窄，但每一条都容易写错：
 *
 *  1. 宿主的 settings.describe 里 `schema` 是序列化后的 zod 树（几百个 uid/refs），对手机
 *     毫无用处，必须丢掉 —— 漏出去就是几百 KB 的无效负载；
 *  2. 凭据槽只能给 { path, set }。宿主自己就是这么脱敏的（settingsSecretViewSchema），
 *     代理绝不能把值补回来，也不能把 path 数组原样塞给 UI；
 *  3. settings.describe / llm.providers 的 invoke 都不传 signal（只有 settings.openDocument
 *     传），所以代理必须只传一个信封参数 —— 宿主 `isAborted(signal)` 直接
 *     `return signal.aborted`，多传 / 少传都会在真机上变成 500；
 *  4. writable / hasDocument / active 都是严格布尔。宿主回 `'yes'` / `1` 时不能读成 true，
 *     否则界面会显示「可以改」，而实际写入会被拒。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个只挂它们的真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { readWiring } = require('./lib/wiring.cjs')
const {
  handleHostSettings,
  handleLlmProviders,
  boundValue,
  normalizeNamespace,
  normalizeProvider,
} = require('../lib/mobile/host-settings.js');

const ROUTES = ['/host-settings', '/llm/providers'];

/**
 * 起一个只挂两个 handler 的真 http 服务，并记下宿主收到的每一次调用与第二个参数。
 * 第二个参数必须是 undefined —— 宿主的 settings.describe / llm.providers 都不接受 signal。
 */
async function serve(impls) {
  const calls = [];
  const signals = [];
  const ctx = {
    apiProxy: {
      settings: {
        describe: async (request, signal) => {
          calls.push(request);
          signals.push(signal);
          return impls.describe(request, signal);
        },
      },
      llm: {
        providers: async (request, signal) => {
          calls.push(request);
          signals.push(signal);
          return impls.providers(request, signal);
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON —— 真机上那个
    // 「Cannot read properties of undefined (reading 'aborted')」500 就是从这里出去的。
    const handler = req.url.startsWith(ROUTES[0]) ? handleHostSettings : handleLlmProviders;
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'internal', message: String((error && error.message) || error) },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    signals,
    settings: `http://127.0.0.1:${port}${ROUTES[0]}`,
    providers: `http://127.0.0.1:${port}${ROUTES[1]}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

test('宿主设置：真实形状透传，schema 被丢掉', async () => {
  const host = await serve({
    describe: () => okValue({
      writable: true,
      hasDocument: true,
      namespaces: [
        {
          ns: 'agent-default-model',
          schema: { uid: 'zod-1', type: 'object', refs: ['a', 'b'] },
          value: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          base: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          applies: 'live',
          secrets: [],
          revision: 0,
        },
        { ns: 'ui-onboarding', schema: { uid: 'zod-2' }, value: {} },
        { ns: 'web-search-deepseek', schema: { uid: 'zod-3' }, value: { enabled: false } },
      ],
    }),
  });
  try {
    const res = await fetch(host.settings);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.writable, true);
    assert.equal(body.hasDocument, true);
    assert.equal(body.namespaces.length, 3);
    assert.equal(body.namespaces[0].ns, 'agent-default-model');
    assert.deepEqual(body.namespaces[0].value, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    assert.deepEqual(body.namespaces[0].base, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    assert.equal(body.namespaces[0].applies, 'live');
    assert.equal(body.namespaces[0].revision, 0);
    assert.deepEqual(body.namespaces[0].secrets, []);
    assert.deepEqual(body.namespaces[1].value, {});
    assert.equal(body.namespaces[2].ns, 'web-search-deepseek');
    // schema 是序列化 zod 树，对手机没有价值：一个字节都不该出现在响应里。
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('schema'), 'schema 字段不该出现在响应里');
    assert.ok(!raw.includes('zod-1'), 'schema 内容不该出现在响应里');
  } finally {
    await host.close();
  }
});

test('宿主设置：凭据槽只给 path + set，值永远不出现', async () => {
  const host = await serve({
    describe: () => okValue({
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'llm-deepseek',
        value: { apiKey: 'sk-should-never-leak', model: 'deepseek-v4-flash' },
        applies: 'restart',
        revision: 3,
        secrets: [
          { path: ['llm', 'deepseek', 'apiKey'], set: true, value: 'sk-should-never-leak' },
          { path: [], set: true },
          { path: ['a'], set: 'yes' },
          null,
          'nope',
        ],
      }],
    }),
  });
  try {
    const res = await fetch(host.settings);
    const body = await res.json();
    assert.deepEqual(body.namespaces[0].secrets, [
      { path: 'llm.deepseek.apiKey', set: true },
      { path: 'a', set: false },
    ]);
    assert.equal(body.namespaces[0].applies, 'restart');
    assert.equal(body.namespaces[0].revision, 3);
    // path 只拼成点号字符串，不把数组塞给 UI
    assert.equal(typeof body.namespaces[0].secrets[0].path, 'string');
  } finally {
    await host.close();
  }
});

test('宿主设置：畸形命名空间丢干净', async () => {
  const host = await serve({
    describe: () => okValue({
      writable: true,
      hasDocument: true,
      namespaces: [
        null,
        'agent-default-model',
        { ns: '' },
        { ns: '   ' },
        {},
        7,
        { ns: '  keep-me  ', value: 1 },
      ],
    }),
  });
  try {
    const res = await fetch(host.settings);
    const body = await res.json();
    assert.equal(body.namespaces.length, 1);
    assert.equal(body.namespaces[0].ns, 'keep-me');
  } finally {
    await host.close();
  }
});

test('宿主设置：值限深限宽限长，bigint / 函数不炸 JSON', async () => {
  const long = 'x'.repeat(5000);
  const many = Array.from({ length: 100 }, (_, i) => i);
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const host = await serve({
    describe: () => okValue({
      writable: true,
      hasDocument: false,
      namespaces: [{
        ns: 'mix',
        value: {
          long,
          many,
          deep,
          big: 10n,
          fn: () => 1,
          nan: NaN,
          inf: Infinity,
          ok: true,
        },
      }],
    }),
  });
  try {
    const res = await fetch(host.settings);
    const value = (await res.json()).namespaces[0].value;
    assert.equal(value.long.length, 4001);
    assert.equal(value.long.slice(-1), '…');
    assert.equal(value.many.length, 40);
    assert.equal(value.many[39], 39);
    // value 自己占 depth 0，所以嵌套到第 4 层就封顶成 {}（deep 是 value 的一层）。
    assert.deepEqual(value.deep, { a: { b: { c: {} } } });
    assert.equal(value.big, '10');
    assert.equal(value.fn, null);
    assert.equal(value.nan, null);
    assert.equal(value.inf, null);
    assert.equal(value.ok, true);
  } finally {
    await host.close();
  }
});

test('宿主设置：命名空间数量封顶 60', async () => {
  const namespaces = Array.from({ length: 70 }, (_, i) => ({ ns: `ns-${i}`, value: i }));
  const host = await serve({
    describe: () => okValue({ writable: true, hasDocument: true, namespaces }),
  });
  try {
    const body = await (await fetch(host.settings)).json();
    assert.equal(body.namespaces.length, 60);
    assert.equal(body.namespaces[59].ns, 'ns-59');
  } finally {
    await host.close();
  }
});

test('宿主设置：writable / hasDocument 严格布尔，不认 "yes" / 1', async () => {
  for (const [raw, expected] of [[{ writable: 'yes', hasDocument: 1 }, [false, false]],
                                 [{ writable: true, hasDocument: true }, [true, true]],
                                 [{}, [false, false]],
                                 [null, [false, false]]]) {
    const host = await serve({ describe: () => okValue(raw && { ...raw, namespaces: [] }) });
    try {
      const body = await (await fetch(host.settings)).json();
      assert.equal(body.writable, expected[0], `writable for ${JSON.stringify(raw)}`);
      assert.equal(body.hasDocument, expected[1], `hasDocument for ${JSON.stringify(raw)}`);
      assert.deepEqual(body.namespaces, []);
    } finally {
      await host.close();
    }
  }
});

test('宿主设置：宿主错误原样透出，undefined 响应是 400 internal', async () => {
  const host = await serve({
    describe: () => errValue({ code: 'internal', message: 'settings unavailable: no document' }),
  });
  try {
    const res = await fetch(host.settings);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.match(body.error.message, /settings unavailable/);
    assert.equal(body.namespaces, undefined, '出错时不该带 namespaces');
  } finally {
    await host.close();
  }

  const empty = await serve({ describe: () => undefined });
  try {
    const res = await fetch(empty.settings);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'internal');
    assert.match(body.error.message, /空响应/);
  } finally {
    await empty.close();
  }
});

test('模型提供方：真实名单透传，只有 deepseek-official 是 active', async () => {
  const host = await serve({
    providers: () => okValue({
      providers: [
        {
          provider: 'deepseek-official',
          displayName: 'DeepSeek',
          settingsNs: 'llm-deepseek',
          settingsPath: [],
          active: true,
        },
        { provider: 'amazon-bedrock', displayName: 'Amazon Bedrock', active: false, declared: false },
        { provider: 'anthropic', displayName: 'Anthropic', active: false },
      ],
    }),
  });
  try {
    const body = await (await fetch(host.providers)).json();
    assert.equal(body.ok, true);
    assert.equal(body.providers.length, 3);
    assert.deepEqual(body.providers[0], {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      active: true,
    });
    assert.equal(body.providers[1].active, false);
    assert.equal(body.providers[2].provider, 'anthropic');
  } finally {
    await host.close();
  }
});

test('模型提供方：displayName 兜底、active 严格、畸形条目丢干净', async () => {
  const host = await serve({
    providers: () => okValue({
      providers: [
        { provider: '  spaced  ' },
        { provider: 'x', displayName: '   ' },
        { provider: 'y', active: 'yes' },
        { provider: 'z', active: 1 },
        null,
        'anthropic',
        { displayName: 'no id' },
        { provider: '' },
      ],
    }),
  });
  try {
    const body = await (await fetch(host.providers)).json();
    assert.deepEqual(body.providers, [
      { provider: 'spaced', displayName: 'spaced', active: false },
      { provider: 'x', displayName: 'x', active: false },
      { provider: 'y', displayName: 'y', active: false },
      { provider: 'z', displayName: 'z', active: false },
    ]);
  } finally {
    await host.close();
  }
});

test('模型提供方：空名单不是错误；宿主错误原样透出', async () => {
  const empty = await serve({ providers: () => okValue({}) });
  try {
    const body = await (await fetch(empty.providers)).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.providers, []);
  } finally {
    await empty.close();
  }

  const failed = await serve({
    providers: () => errValue({ code: 'internal', message: 'llm registry unavailable' }),
  });
  try {
    const res = await fetch(failed.providers);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'internal');
    assert.match(body.error.message, /llm registry unavailable/);
    assert.equal(body.providers, undefined);
  } finally {
    await failed.close();
  }
});

test('代理只传一个信封参数：宿主两个接口都不接受 signal', async () => {
  const host = await serve({
    describe: () => okValue({ writable: true, hasDocument: true, namespaces: [] }),
    providers: () => okValue({ providers: [] }),
  });
  try {
    await fetch(host.settings);
    await fetch(host.providers);
    assert.equal(host.calls.length, 2);
    assert.deepEqual(host.calls[0], { rpcId: 'mobile', method: 'settings.describe', payload: {} });
    assert.deepEqual(host.calls[1], { rpcId: 'mobile', method: 'llm.providers', payload: {} });
    // 宿主 settings.describe / llm.providers 的 invoke 都只传 request；
    // 多传一个 signal 会踩到 isAborted(undefined) 的老毛病。
    assert.equal(host.signals[0], undefined);
    assert.equal(host.signals[1], undefined);
  } finally {
    await host.close();
  }
});

test('辅助函数单独可驱动（boundValue / normalizeNamespace / normalizeProvider）', () => {
  assert.equal(boundValue('short'), 'short');
  assert.equal(boundValue(undefined), null);
  assert.equal(boundValue(true), true);
  assert.equal(normalizeNamespace({ ns: ' a ', value: 1 }).ns, 'a');
  assert.equal(normalizeNamespace({ ns: 'a' }).applies, 'live');
  assert.equal(normalizeNamespace({ ns: 'a', applies: 'restart' }).applies, 'restart');
  assert.equal(normalizeNamespace({ ns: 'a', revision: 'x' }).revision, 0);
  assert.equal(normalizeNamespace({ ns: 'a', base: undefined }).base, undefined);
  assert.equal(normalizeNamespace({ ns: 'a', base: null }).base, null);
  assert.equal(normalizeNamespace({ ns: 'a', user: { x: 1 } }).user.x, 1);
  assert.equal(normalizeProvider({ provider: 'p' }).displayName, 'p');
  assert.equal(normalizeProvider({ provider: 'p', active: true }).active, true);
});

test('接线：lib/index.js 注册了路由，模块导出了两个 handler', () => {
  const index = readWiring();
  assert.match(index, /require\('(?:\.\.\/mobile|\.\/mobile)\/host-settings\.js'\)/);
  assert.match(index, /route\('\/api\/mobile\/v1\/host-settings', hostSettings\.handleHostSettings\)/);
  assert.match(index, /route\('\/api\/mobile\/v1\/llm\/providers', hostSettings\.handleLlmProviders\)/);
  const mod = require('../lib/mobile/host-settings.js');
  assert.equal(typeof mod.handleHostSettings, 'function');
  assert.equal(typeof mod.handleLlmProviders, 'function');
});

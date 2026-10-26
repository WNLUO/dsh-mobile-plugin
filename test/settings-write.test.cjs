'use strict';

/**
 * 改宿主设置（POST /api/mobile/v1/host-settings/mutate）的透传契约。
 *
 * 桌面端「设置」里改默认模型走的是 `settings.mutate`：一次一个 op（`{op:'set',path:[…],value}`），
 * 带上看到的 revision 做乐观并发。这个 handler 很薄，但每条都容易写错：
 *
 *  1. op 按路径寻址，路径必须是**非空字符串数组**。空路径等于整段替换命名空间，手机端不该
 *     有这条路；`[0]` 这种下标也不该被当成合法路径放过去；
 *  2. expectedRevision 必须是正整数才带上。宿主 schema 是 `z.number().int().positive()`，
 *     把 0 / 负 / 小数字符串塞过去只会拿到一个难懂的 settings-rejected，不如不带；
 *  3. 宿主的 settings.mutate 不接受 signal（apiproxy 的 invoke 只传 request），多传一个
 *     参数就是真机上的 500；
 *  4. 成功时宿主回的是该命名空间的**新视图**（含 schema zod 树），要过一遍
 *     normalizeNamespace 再给手机，否则几百 KB 的 zod 树会原样漏出去；
 *  5. settings-conflict 的 details 里有 expected / actual，必须原样透传，App 才能说清
 *     「别处改过了」。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个只挂它的真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleHostSettingsMutate, normalizeOps } = require('../lib/mobile/host-settings.js');
const { readWiring } = require('./lib/wiring.cjs')

/**
 * 起一个只挂 mutate handler 的真 http 服务，并记下宿主收到的每一次调用与第二个参数。
 * 第二个参数必须是 undefined —— 宿主的 settings.mutate 不接受 signal。
 */
async function serve(impl) {
  const calls = [];
  const signals = [];
  const ctx = {
    apiProxy: {
      settings: {
        mutate: async (request, signal) => {
          calls.push(request);
          signals.push(signal);
          return impl(request, signal);
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON。
    Promise.resolve(handleHostSettingsMutate(ctx, req, res)).catch((error) => {
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
    url: `http://127.0.0.1:${port}/host-settings/mutate`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

/** 宿主成功时回的命名空间新视图（带 schema zod 树，代理必须丢掉）。 */
const namespaceView = (overrides = {}) => ({
  ns: 'agent-default-model',
  schema: { uid: 'zod-9', refs: ['x'] },
  value: { provider: 'deepseek-official', model: 'deepseek-v4' },
  user: { model: 'deepseek-v4' },
  applies: 'live',
  secrets: [],
  revision: 8,
  ...overrides,
});

test('改设置：一个 op 原样透传，成功后回新视图且 schema 被丢掉', async () => {
  const host = await serve(() => okValue(namespaceView()));
  try {
    const res = await post(host.url, {
      ns: 'agent-default-model',
      ops: [{ op: 'set', path: ['model'], value: 'deepseek-v4' }],
      expectedRevision: 7,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.namespace.ns, 'agent-default-model');
    assert.deepEqual(body.namespace.value, { provider: 'deepseek-official', model: 'deepseek-v4' });
    assert.deepEqual(body.namespace.user, { model: 'deepseek-v4' });
    assert.equal(body.namespace.revision, 8);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('zod-9'), 'schema 内容不该出现在响应里');
    assert.equal(body.namespace.schema, undefined);

    assert.equal(host.calls.length, 1);
    assert.deepEqual(host.calls[0], {
      rpcId: 'mobile',
      method: 'settings.mutate',
      payload: {
        ns: 'agent-default-model',
        ops: [{ op: 'set', path: ['model'], value: 'deepseek-v4' }],
        expectedRevision: 7,
      },
    });
    // 宿主 settings.mutate 的 invoke 只传 request；多传一个 signal 会踩 isAborted(undefined)。
    assert.equal(host.signals[0], undefined);
  } finally {
    await host.close();
  }
});

test('改设置：unset 与多 op 保序，value 允许任意 JSON 值', async () => {
  const host = await serve(() => okValue(namespaceView({ ns: 'mix' })));
  try {
    const ops = [
      { op: 'unset', path: ['b'] },
      { op: 'set', path: ['a', 'c'], value: null },
      { op: 'set', path: ['d'], value: { nested: [1, 2] } },
    ];
    const res = await post(host.url, { ns: 'mix', ops });
    assert.equal(res.status, 200);
    assert.deepEqual(host.calls[0].payload.ops, ops);
  } finally {
    await host.close();
  }
});

test('改设置：expectedRevision 缺失或不是正整数就不带这个字段', async () => {
  for (const bad of [undefined, 0, -3, 1.5, '7', null, true, NaN]) {
    const host = await serve(() => okValue(namespaceView()));
    try {
      const payload = { ns: 'agent-default-model', ops: [{ op: 'set', path: ['model'], value: 'm' }] };
      if (bad !== undefined) payload.expectedRevision = bad;
      const res = await post(host.url, payload);
      assert.equal(res.status, 200, `expectedRevision=${String(bad)}`);
      assert.equal('expectedRevision' in host.calls[0].payload, false, `expectedRevision=${String(bad)} 不该透传`);
    } finally {
      await host.close();
    }
  }
});

test('改设置：ns 前后的空白被去掉再转发', async () => {
  const host = await serve(() => okValue(namespaceView({ ns: 'agent-default-model' })));
  try {
    await post(host.url, { ns: '  agent-default-model  ', ops: [{ op: 'set', path: ['a'], value: 1 }] });
    assert.equal(host.calls[0].payload.ns, 'agent-default-model');
  } finally {
    await host.close();
  }
});

test('改设置：ns 缺失 / 空白 → 400 bad-request，且不调宿主', async () => {
  for (const body of [{}, { ns: '' }, { ns: '   ' }, { ns: 7 }, { ops: [{ op: 'set', path: ['a'], value: 1 }] }]) {
    const host = await serve(() => okValue(namespaceView()));
    try {
      const res = await post(host.url, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const parsed = await res.json();
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'bad-request');
      assert.match(parsed.error.message, /需要 \{ ns, ops \}/);
      assert.equal(host.calls.length, 0, `不该调宿主：${JSON.stringify(body)}`);
    } finally {
      await host.close();
    }
  }
});

test('改设置：畸形 ops 一律 400 bad-request，且不调宿主', async () => {
  const bad = [
    undefined,
    null,
    'nope',
    {},
    [],
    [{ op: 'replace', path: ['a'], value: 1 }],
    [{ op: 'set', path: [], value: 1 }],
    [{ op: 'set', path: ['a', ''], value: 1 }],
    [{ op: 'set', path: [1], value: 1 }],
    [{ op: 'set', path: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], value: 1 }],
    [{ op: 'unset', path: 'a' }],
    [null],
    ['x'],
    [7],
    [{ path: ['a'], value: 1 }],
    [{ op: 'set', value: 1 }],
    Array.from({ length: 41 }, (_, i) => ({ op: 'set', path: [`k${i}`], value: i })),
  ];
  for (const ops of bad) {
    const host = await serve(() => okValue(namespaceView()));
    try {
      const res = await post(host.url, { ns: 'agent-default-model', ops });
      assert.equal(res.status, 400, JSON.stringify(ops));
      const parsed = await res.json();
      assert.equal(parsed.error.code, 'bad-request');
      assert.match(parsed.error.message, /ops 必须是/);
      assert.equal(host.calls.length, 0, `不该调宿主：${JSON.stringify(ops)}`);
    } finally {
      await host.close();
    }
  }
});

test('改设置：恰好 40 个 op 放行，8 层路径放行', async () => {
  const host = await serve(() => okValue(namespaceView()));
  try {
    const ops = Array.from({ length: 40 }, (_, i) => ({ op: 'set', path: [`k${i}`], value: i }));
    assert.equal((await post(host.url, { ns: 'ns', ops })).status, 200);
    const deep = [{ op: 'set', path: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], value: 1 }];
    assert.equal((await post(host.url, { ns: 'ns', ops: deep })).status, 200);
    assert.equal(host.calls.length, 2);
  } finally {
    await host.close();
  }
});

test('改设置：settings-conflict 原样透出，details 里带着 expected / actual', async () => {
  const host = await serve(() => errValue({
    code: 'settings-conflict',
    message: 'settings namespace "agent-default-model" changed since revision 7',
    details: { ns: 'agent-default-model', expected: 7, actual: 9 },
  }));
  try {
    const res = await post(host.url, {
      ns: 'agent-default-model',
      ops: [{ op: 'set', path: ['model'], value: 'm' }],
      expectedRevision: 7,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'settings-conflict');
    assert.deepEqual(body.error.details, { ns: 'agent-default-model', expected: 7, actual: 9 });
    assert.equal(body.namespace, undefined, '出错时不该带 namespace');
  } finally {
    await host.close();
  }
});

test('改设置：settings-rejected 的宿主原因原样透出', async () => {
  const host = await serve(() => errValue({
    code: 'settings-rejected',
    message: 'agent-default-model/provider: expected string',
    details: { ns: 'agent-default-model' },
  }));
  try {
    const body = await (await post(host.url, {
      ns: 'agent-default-model',
      ops: [{ op: 'set', path: ['provider'], value: 7 }],
    })).json();
    assert.equal(body.error.code, 'settings-rejected');
    assert.match(body.error.message, /expected string/);
  } finally {
    await host.close();
  }
});

test('改设置：undefined 响应 → 400 internal 空响应；畸形视图 → 400 internal', async () => {
  const empty = await serve(() => undefined);
  try {
    const res = await post(empty.url, { ns: 'ns', ops: [{ op: 'set', path: ['a'], value: 1 }] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'internal');
    assert.match(body.error.message, /空响应/);
  } finally {
    await empty.close();
  }

  for (const garbage of [null, 'nope', 7, {}, { ns: '' }, { ns: '   ' }]) {
    const host = await serve(() => okValue(garbage));
    try {
      const res = await post(host.url, { ns: 'ns', ops: [{ op: 'set', path: ['a'], value: 1 }] });
      assert.equal(res.status, 400, JSON.stringify(garbage));
      const body = await res.json();
      assert.equal(body.error.code, 'internal');
      assert.match(body.error.message, /视图/);
    } finally {
      await host.close();
    }
  }
});

test('改设置：新视图里的 applies / revision / secrets 走同一套规范化', async () => {
  const host = await serve(() => okValue({
    ns: ' llm-deepseek ',
    value: { apiKey: 'sk-should-never-leak' },
    applies: 'restart',
    revision: 'x',
    secrets: [{ path: ['llm', 'deepseek', 'apiKey'], set: true, value: 'sk-should-never-leak' }],
  }));
  try {
    const body = await (await post(host.url, { ns: 'llm-deepseek', ops: [{ op: 'set', path: ['x'], value: 1 }] })).json();
    assert.equal(body.namespace.ns, 'llm-deepseek');
    assert.equal(body.namespace.applies, 'restart');
    assert.equal(body.namespace.revision, 0);
    assert.deepEqual(body.namespace.secrets, [{ path: 'llm.deepseek.apiKey', set: true }]);
    assert.equal(body.namespace.base, undefined);
    assert.equal(body.namespace.user, undefined);
  } finally {
    await host.close();
  }
});

test('normalizeOps 单独可驱动：合法形状原样重建，含坏条目整批拒绝', () => {
  assert.deepEqual(normalizeOps([{ op: 'set', path: ['a'], value: 1 }]), [{ op: 'set', path: ['a'], value: 1 }]);
  assert.deepEqual(normalizeOps([{ op: 'unset', path: ['a', 'b'] }]), [{ op: 'unset', path: ['a', 'b'] }]);
  // set 的 value 不做类型校验：那是宿主 schema 的活，undefined 也要能传过去。
  assert.deepEqual(normalizeOps([{ op: 'set', path: ['a'] }]), [{ op: 'set', path: ['a'], value: undefined }]);
  assert.equal(normalizeOps([]), null);
  assert.equal(normalizeOps('x'), null);
  assert.equal(normalizeOps(null), null);
  assert.equal(normalizeOps([{ op: 'set', path: [] }]), null);
  assert.equal(normalizeOps([{ op: 'del', path: ['a'] }]), null);
  assert.equal(normalizeOps([{ op: 'set', path: ['a'] }, 7]), null);
});

test('接线：lib/index.js 注册了 mutate 路由，模块导出了 handler', () => {
  const index = readWiring();
  assert.match(index, /route\('\/api\/mobile\/v1\/host-settings\/mutate', hostSettings\.handleHostSettingsMutate\)/);
  const mod = require('../lib/mobile/host-settings.js');
  assert.equal(typeof mod.handleHostSettingsMutate, 'function');
  assert.equal(typeof mod.normalizeOps, 'function');
});

'use strict';

/**
 * 子代理目录代理（GET /api/mobile/v1/subagents）的透传契约。
 *
 * 桌面端会话标题栏挂着「N 个子代理」下拉：父会话按 `origin === "subagent" && parentId ===
 * 当前会话` 把子代理收成一棵树，点进去能读子会话的完整记录。手机端把 origin === 'subagent'
 * 的行在侧栏里 continue 掉之后就再没有任何入口。职责很窄，但每条都容易写错：
 *
 *  1. sessionId 是必填：宿主 subagent.list 的 payload 是 `{ parentSessionId }`，缺了会被报
 *     invalid payload；代理应该在本地就 400，别把请求发出去；
 *  2. subagent.list 的签名是 `list(request, signal)`（**有** signal 形参），必须显式传一个
 *     AbortController 的 signal —— 不传 undefined 会 500；
 *  3. 条目是 union：child 要 mode/activity/hasChildren 都合法才留，diagnostic 只要有 id +
 *     认识的 reason；两者都不能把未知字段漏给手机；
 *  4. parentAvailable 用严格比较：宿主漏字段时按「父会话不在线」处理，与桌面端「父会话不在线
 *     → 只读」的判定方向一致，猜真值会让手机误以为还能发消息；
 *  5. 按 id 去重（保留先出现的）并限条数，避免异常宿主把手机列表撑爆。
 *
 * 本测试驱动真实的 handler（不是转写实现）：起一个只挂它的真 http 服务，用真 req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleSubagents, normalizeSubagentList } = require('../lib/mobile/subagents.js');
const { readWiring } = require('./lib/wiring.cjs')

const ROUTE = '/subagents';

/** 起一个只挂 handleSubagents 的真 http 服务，并记下宿主收到的每一次调用与第二个参数。 */
async function serve(listImpl) {
  const calls = [];
  const signals = [];
  const ctx = {
    apiProxy: {
      // 命名空间是复数 subagents（真宿主 apiProxy.subagents.list），而 RPC 方法名是
      // 单数 subagent.list。这里必须照抄真名：假 ctx 用单数时，handler 写成单数也能
      // 全绿，只有真机才会 500 "Cannot read properties of undefined (reading 'list')"。
      subagents: {
        list: async (request, signal) => {
          calls.push(request);
          signals.push(signal);
          return listImpl ? listImpl(request, signal) : okValue({ entries: [], parentAvailable: true });
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻 lib/index.js 的 guarded()：handler 抛错就回 500 JSON。
    Promise.resolve(handleSubagents(ctx, req, res)).catch((error) => {
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
    url: (query = '') => `http://127.0.0.1:${port}${ROUTE}${query}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

const child = (over = {}) => ({
  kind: 'child',
  id: 'child-1',
  mode: 'continuable',
  activity: 'running',
  hasChildren: false,
  label: '查一下天气',
  ...over,
});

test('子代理：真实形状透传，child 与 diagnostic 两种 kind 都保留', async () => {
  const host = await serve(() => okValue({
    entries: [
      child(),
      child({ id: 'child-2', mode: 'one-shot', activity: 'inactive', hasChildren: true }),
      { kind: 'diagnostic', id: 'child-3', reason: 'corrupt' },
    ],
    parentAvailable: true,
  }));
  try {
    const res = await fetch(host.url('?sessionId=session-parent'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.parentAvailable, true);
    assert.equal(body.entries.length, 3);
    assert.deepEqual(
      body.entries.map((e) => e.id),
      ['child-1', 'child-2', 'child-3'],
    );
    // child 行形状精确：这六个键，多一个都会让 App 多出无用字段。
    assert.deepEqual(
      Object.keys(body.entries[0]).sort(),
      ['activity', 'hasChildren', 'id', 'kind', 'label', 'mode'],
    );
    assert.equal(body.entries[0].mode, 'continuable');
    assert.equal(body.entries[0].activity, 'running');
    assert.equal(body.entries[0].hasChildren, false);
    assert.equal(body.entries[0].label, '查一下天气');
    // diagnostic 行只有三个键，且不透传 reason 之外的任何东西。
    assert.deepEqual(Object.keys(body.entries[2]).sort(), ['id', 'kind', 'reason']);
    assert.equal(body.entries[2].reason, 'corrupt');
  } finally {
    await host.close();
  }
});

test('子代理：请求信封与 method 精确，且传了取消信号', async () => {
  const host = await serve(() => okValue({ entries: [], parentAvailable: false }));
  try {
    const res = await fetch(host.url('?sessionId=session-abc123'));
    assert.equal(res.status, 200);
    assert.equal(host.calls.length, 1);
    assert.deepEqual(host.calls[0], {
      rpcId: 'mobile',
      method: 'subagent.list',
      payload: { parentSessionId: 'session-abc123' },
    });
    // 宿主 subagents.list 的签名是 list(request, signal)：必须传一个真 signal。
    assert.ok(host.signals[0], '必须传取消信号');
    assert.equal(typeof host.signals[0].aborted, 'boolean');
  } finally {
    await host.close();
  }
});

test('子代理：缺 sessionId 直接 400，且不打扰宿主', async () => {
  const host = await serve(() => okValue({ entries: [child()], parentAvailable: true }));
  try {
    for (const query of ['', '?sessionId=', '?sessionId=%20%20']) {
      const res = await fetch(host.url(query));
      assert.equal(res.status, 400, `query=${query}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'bad-request');
      assert.equal(body.error.message, '需要 sessionId');
      assert.equal(body.entries, undefined);
    }
    assert.equal(host.calls.length, 0, '缺 sessionId 不该调用宿主');
  } finally {
    await host.close();
  }
});

test('子代理：sessionId 两侧空白被 trim 后再发给宿主', async () => {
  const host = await serve(() => okValue({ entries: [], parentAvailable: true }));
  try {
    const res = await fetch(host.url('?sessionId=%20session-x%20'));
    assert.equal(res.status, 200);
    assert.equal(host.calls[0].payload.parentSessionId, 'session-x');
  } finally {
    await host.close();
  }
});

test('子代理：mode / activity / hasChildren 任一不合法就丢掉整条', async () => {
  const host = await serve(() => okValue({
    entries: [
      child({ id: 'ok' }),
      child({ id: 'bad-mode', mode: 'forever' }),
      child({ id: 'bad-mode-2', mode: 7 }),
      child({ id: 'no-mode', mode: undefined }),
      child({ id: 'bad-activity', activity: 'RUNNING' }),
      child({ id: 'bad-activity-2', activity: null }),
      child({ id: 'no-activity', activity: undefined }),
      child({ id: 'bad-children', hasChildren: 'yes' }),
      child({ id: 'bad-children-2', hasChildren: 1 }),
      child({ id: 'no-children', hasChildren: undefined }),
    ],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.deepEqual(body.entries.map((e) => e.id), ['ok']);
  } finally {
    await host.close();
  }
});

// DSH 0.2.0 的 subagentCatalog 有第三种 mode：目录知道这条子会话存在，但宿主还没读出
// 它的 subagent 身份。host-bridge 从投影重建目录时会原样带出 'unknown'，这里必须放行 ——
// 之前只认 one-shot/continuable，unknown 条目会被整条丢掉，手机端就看不见这条子代理了。
test('子代理：mode 为 unknown 的条目放行（0.2.0 的第三种模式）', async () => {
  const host = await serve(() => okValue({
    entries: [
      child({ id: 'unk', mode: 'unknown' }),
      child({ id: 'unk-labelled', mode: 'unknown', label: '  读身份的  ' }),
      child({ id: 'still-bad', mode: 'forever' }),
    ],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.deepEqual(body.entries.map((e) => e.id), ['unk', 'unk-labelled']);
    assert.equal(body.entries[0].mode, 'unknown');
    assert.equal(body.entries[1].label, '读身份的');
  } finally {
    await host.close();
  }
});

test('子代理：id 必须非空字符串，非对象条目丢掉', async () => {
  const host = await serve(() => okValue({
    entries: [
      null,
      'nope',
      7,
      [],
      {},
      child({ id: '' }),
      child({ id: '   ' }),
      child({ id: 5 }),
      child({ id: ['x'] }),
      child({ id: '  keep-me  ' }),
    ],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.deepEqual(body.entries.map((e) => e.id), ['keep-me']);
  } finally {
    await host.close();
  }
});

test('子代理：diagnostic 的 reason 只认三个词，其它丢掉', async () => {
  const host = await serve(() => okValue({
    entries: [
      { kind: 'diagnostic', id: 'd-corrupt', reason: 'corrupt' },
      { kind: 'diagnostic', id: 'd-unsupported', reason: 'unsupported' },
      { kind: 'diagnostic', id: 'd-unavailable', reason: 'unavailable' },
      { kind: 'diagnostic', id: 'd-bad', reason: 'exploded' },
      { kind: 'diagnostic', id: 'd-empty', reason: '' },
      { kind: 'diagnostic', id: 'd-null', reason: null },
      { kind: 'diagnostic', id: 'd-missing' },
      { kind: 'diagnostic', reason: 'corrupt' },
      { kind: 'other', id: 'd-kind' },
    ],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.deepEqual(body.entries.map((e) => e.id), ['d-corrupt', 'd-unsupported', 'd-unavailable']);
  } finally {
    await host.close();
  }
});

test('子代理：label 可选，空白当没有；超长截断补省略号', async () => {
  const long = 'L'.repeat(500);
  const host = await serve(() => okValue({
    entries: [
      child({ id: 'with-label', label: '  padded  ' }),
      child({ id: 'long-label', label: long }),
      child({ id: 'no-label', label: undefined }),
      child({ id: 'blank-label', label: '   ' }),
      child({ id: 'num-label', label: 42 }),
      child({ id: 'null-label', label: null }),
    ],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    const byId = Object.fromEntries(body.entries.map((e) => [e.id, e]));
    assert.equal(byId['with-label'].label, 'padded');
    assert.equal(byId['long-label'].label.length, 201, '200 字符 + 省略号');
    assert.ok(byId['long-label'].label.endsWith('…'));
    assert.ok(!('label' in byId['no-label']), '没有 label 时不该有 label 键');
    assert.ok(!('label' in byId['blank-label']));
    assert.ok(!('label' in byId['num-label']));
    assert.ok(!('label' in byId['null-label']));
  } finally {
    await host.close();
  }
});

test('子代理：parentAvailable 严格比较，漏字段按 false', async () => {
  for (const [value, expected] of [
    [{ entries: [], parentAvailable: true }, true],
    [{ entries: [], parentAvailable: false }, false],
    [{ entries: [] }, false],
    [{ entries: [], parentAvailable: 'yes' }, false],
    [{ entries: [], parentAvailable: 1 }, false],
    [{ entries: [], parentAvailable: null }, false],
  ]) {
    const host = await serve(() => okValue(value));
    try {
      const body = await (await fetch(host.url('?sessionId=s'))).json();
      assert.equal(body.parentAvailable, expected, JSON.stringify(value));
    } finally {
      await host.close();
    }
  }
});

test('子代理：entries 不是数组时回空目录（不是错误）', async () => {
  for (const value of [{}, { entries: null }, { entries: 'nope' }, { entries: {} }, null]) {
    const host = await serve(() => okValue(value));
    try {
      const res = await fetch(host.url('?sessionId=s'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.entries, []);
    } finally {
      await host.close();
    }
  }
});

test('子代理：按 id 去重保留先出现的，条数封顶 100', async () => {
  const many = Array.from({ length: 300 }, (_, i) => child({ id: `c-${i}` }));
  const host = await serve(() => okValue({
    entries: [child({ id: 'dup', label: 'first' }), child({ id: 'dup', label: 'second' }), ...many],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.equal(body.entries.length, 100);
    assert.equal(body.entries[0].id, 'dup');
    assert.equal(body.entries[0].label, 'first');
    assert.equal(body.entries[1].id, 'c-0');
    assert.equal(body.entries[99].id, 'c-98');
  } finally {
    await host.close();
  }
});

test('子代理：超长 id 被截断到 200', async () => {
  const host = await serve(() => okValue({
    entries: [child({ id: 'i'.repeat(300) })],
    parentAvailable: true,
  }));
  try {
    const body = await (await fetch(host.url('?sessionId=s'))).json();
    assert.equal(body.entries[0].id.length, 200);
  } finally {
    await host.close();
  }
});

test('子代理：宿主报错如实透传，不回空目录', async () => {
  const host = await serve(() => errValue({
    code: 'internal',
    message: 'subagent catalog read failed',
  }));
  try {
    const res = await fetch(host.url('?sessionId=s'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'subagent catalog read failed');
    assert.equal(body.entries, undefined);
  } finally {
    await host.close();
  }
});

test('子代理：宿主空响应 → 400 internal 空响应', async () => {
  const host = await serve(() => undefined);
  try {
    const res = await fetch(host.url('?sessionId=s'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, '空响应');
  } finally {
    await host.close();
  }
});

test('子代理：normalizeSubagentList 是纯函数，不改动入参', () => {
  const value = { entries: [child()], parentAvailable: true };
  const before = JSON.stringify(value);
  const out = normalizeSubagentList(value);
  assert.deepEqual(out, {
    entries: [{
      kind: 'child',
      id: 'child-1',
      mode: 'continuable',
      activity: 'running',
      hasChildren: false,
      label: '查一下天气',
    }],
    parentAvailable: true,
  });
  assert.equal(JSON.stringify(value), before, '入参不该被改动');
});

test('子代理：插件把 handler 挂到 /api/mobile/v1/subagents 并导出', () => {
  const root = path.join(__dirname, '..');
  const mod = fs.readFileSync(path.join(root, 'lib/mobile/subagents.js'), 'utf8');
  assert.ok(mod.includes("method: 'subagent.list'"), 'subagents.js 应调用 subagent.list');
  // 真宿主是 apiProxy.subagents（复数），方法名才是 subagent.list（单数）：
  // 写错命名空间在真机上只表现为 500，假 ctx 兜不住，所以这里钉住源码。
  assert.ok(mod.includes('ctx.apiProxy.subagents.list('), 'subagents.js 必须走 apiProxy.subagents（复数）');
  assert.ok(!mod.includes('ctx.apiProxy.subagent.list('), 'subagents.js 不能走 apiProxy.subagent（单数）');
  assert.ok(mod.includes('需要 sessionId'), 'subagents.js 缺 sessionId 时应 400');
  assert.ok(mod.includes('parentSessionId'), 'subagents.js 应发 parentSessionId');
  const index = readWiring();
  assert.ok(
    index.includes("const subagents = require('../mobile/subagents.js')"),
    '移动端路由表应 require mobile/subagents.js',
  );
  assert.ok(
    index.includes("route('/api/mobile/v1/subagents', subagents.handleSubagents)"),
    'index.js 应注册 /api/mobile/v1/subagents 路由',
  );
});

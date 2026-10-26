'use strict';

/**
 * 会话正文检索代理（GET /api/mobile/v1/session/search）的透传契约。
 *
 * 桌面端侧栏搜索是「本地元数据匹配 + 宿主检索页」两路合并；移动端只代理宿主这一路，标题 /
 * 工作区由 App 自己拼。职责很窄，也很容易写错：
 *
 *  1. query 必须先按桌面端同口径清洗（去 NUL / 去空白 / 上限 500 个 UTF-16 码元且不劈开
 *     代理对），清洗后为空要直接 400 —— 既不能拿空串去打宿主的检索预算，也不能把长串原样
 *     递给一个 `.max(500)` 的 schema（那样用户只会看到一个莫名其妙的 400）；
 *  2. 宿主的错误必须原样透出。本部署把 session-query-sqlite 配成 `openAt: never`（正文检索
 *     是显式开启的），宿主此时以错误回应；吞成空列表，界面就无法区分「没有命中」与「这台
 *     宿主没开正文检索」；
 *  3. 宿主只该收到 { sessionId, snippet }，畸形条目要丢干净，不能让 undefined 漏进 UI。
 *
 * 本测试驱动真实的 handleSessionSearch（不是转写实现）：起一个只挂它的真 http 服务，用真
 * req/res。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleSessionSearch } = require('../lib/mobile/sessions.js');
const { readWiring } = require('./lib/wiring.cjs')

/**
 * 复刻宿主 `sessions.search(request, signal)` 的第一步：对 signal 直接取 `.aborted`，没有
 * undefined 兜底。代理不传第二个参数时这里就会抛 `Cannot read properties of undefined
 * (reading 'aborted')` —— 真机上是 500。放进每个用例的入口，缺失 signal 的改动会在本文件
 * 全线报错。
 */
const hostIsAborted = (signal) => signal.aborted;

/** 起一个只挂 handleSessionSearch 的真 http 服务，并记下宿主收到的每一次调用。 */
async function serve(searchImpl) {
  const calls = [];
  const signals = [];
  const ctx = {
    apiProxy: {
      sessions: {
        search: async (request, signal) => {
          hostIsAborted(signal);
          calls.push(request);
          signals.push(signal);
          return searchImpl(request, signal);
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    // 复刻装配层 guarded() 的行为：handler 抛错就回 500 JSON —— 真机上那个
    // 「Cannot read properties of undefined (reading 'aborted')」500 就是从这里出去的。
    Promise.resolve(handleSessionSearch(ctx, req, res)).catch((error) => {
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
    base: `http://127.0.0.1:${port}/session/search`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 轮询等待，避免依赖固定 sleep 造成偶发失败。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

test('缺 query 或只有空白 → 400，且不触碰宿主', async () => {
  for (const suffix of ['', '?query=', '?query=%20%20', '?query=%00']) {
    const host = await serve(() => okValue({ items: [] }));
    try {
      const res = await fetch(`${host.base}${suffix}`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'bad-request');
      assert.match(body.error.message, /query/);
      assert.equal(host.calls.length, 0, `query=${JSON.stringify(suffix)} 不该打到宿主`);
    } finally {
      await host.close();
    }
  }
});

test('宿主收到的是清洗过的 query，且携带标准的 RPC 信封', async () => {
  const host = await serve(() => okValue({ items: [] }));
  try {
    await fetch(`${host.base}?query=%20%20hello%20%20`);
    assert.equal(host.calls.length, 1);
    assert.deepEqual(host.calls[0], {
      rpcId: 'mobile',
      method: 'session.search',
      payload: { query: 'hello' },
    });
  } finally {
    await host.close();
  }
});

test('超过 500 个 UTF-16 码元时截断到 500，不让宿主 schema 直接 400', async () => {
  const host = await serve(() => okValue({ items: [] }));
  try {
    const long = 'a'.repeat(600);
    const res = await fetch(`${host.base}?query=${long}`);
    assert.equal(res.status, 200);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].payload.query.length, 500);
    assert.equal(host.calls[0].payload.query, 'a'.repeat(500));
  } finally {
    await host.close();
  }
});

test('截断不劈开代理对（宁可少一个码元，也不送半个 emoji）', async () => {
  const host = await serve(() => okValue({ items: [] }));
  try {
    // 499 个 ASCII + 一个 emoji（2 个码元）：第 500 个码元正好是高位代理。
    const query = `${'a'.repeat(499)}😀b`;
    await fetch(`${host.base}?query=${encodeURIComponent(query)}`);
    assert.equal(host.calls.length, 1);
    const sent = host.calls[0].payload.query;
    assert.equal(sent, 'a'.repeat(499));
    const last = sent.charCodeAt(sent.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdfff), '结尾不能是落单的代理码元');
  } finally {
    await host.close();
  }
});

test('命中原样透出：只保留 { sessionId, snippet }，畸形条目丢干净', async () => {
  const host = await serve(() =>
    okValue({
      items: [
        { sessionId: 'session-a', snippet: '命中片段' },
        { sessionId: 'session-b' },
        { sessionId: 'session-c', snippet: 42 },
        { sessionId: '' },
        { snippet: '没有 id' },
        null,
        'not-an-object',
      ],
      hasMore: true,
    }),
  );
  try {
    const res = await fetch(`${host.base}?query=hit`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.items, [
      { sessionId: 'session-a', snippet: '命中片段' },
      { sessionId: 'session-b', snippet: '' },
      { sessionId: 'session-c', snippet: '' },
    ]);
    assert.equal(body.hasMore, true);
  } finally {
    await host.close();
  }
});

test('宿主报错时如实透传（正文检索未开启不能被伪装成空结果）', async () => {
  const host = await serve(() =>
    errValue({
      code: 'internal',
      message: 'session search failed: Error: SESSION_QUERY_SEARCH_DISABLED',
    }),
  );
  try {
    const res = await fetch(`${host.base}?query=hello`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.match(body.error.message, /SESSION_QUERY_SEARCH_DISABLED/);
    assert.equal(body.items, undefined);
  } finally {
    await host.close();
  }
});

test('宿主返回空响应 → 400 internal，而不是 undefined 崩在 handler 里', async () => {
  const host = await serve(() => undefined);
  try {
    const res = await fetch(`${host.base}?query=hello`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
  } finally {
    await host.close();
  }
});

test('宿主缺少 items / hasMore → 归一化成空页，不抛错', async () => {
  const host = await serve(() => okValue({}));
  try {
    const res = await fetch(`${host.base}?query=hello`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.hasMore, false);
  } finally {
    await host.close();
  }
});

test('代理把取消信号交给宿主，手机端断开后宿主能据此收手', async () => {
  let seen = null;
  const host = await serve(async (request, signal) => {
    seen = signal;
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', resolve, { once: true });
    });
    return okValue({ items: [] });
  });
  try {
    const req = http.get(`${host.base}?query=hello`);
    req.on('error', () => {});
    assert.equal(await waitFor(() => seen !== null), true, '宿主应当收到检索请求');
    assert.equal(typeof seen.aborted, 'boolean', '宿主收到的必须是 AbortSignal');
    assert.equal(seen.aborted, false, '请求还在途时不该被 abort');
    req.destroy();
    assert.equal(await waitFor(() => seen.aborted), true, '手机端断开后宿主的 signal 应该被 abort');
  } finally {
    await host.close();
  }
});

test('接线：lib/index.js 注册了路由，sessions.js 导出了 handler', () => {
  const root = path.join(__dirname, '..');
  const index = readWiring();
  assert.match(
    index,
    /route\('\/api\/mobile\/v1\/session\/search',\s*sessions\.handleSessionSearch\)/,
    'lib/index.js 必须注册 /session/search',
  );
  const sessions = fs.readFileSync(path.join(root, 'lib', 'mobile', 'sessions.js'), 'utf8');
  assert.match(sessions, /handleSessionSearch,\n/, 'sessions.js 的 module.exports 必须导出 handleSessionSearch');
  assert.equal(typeof handleSessionSearch, 'function');
});

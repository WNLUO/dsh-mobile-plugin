'use strict';

/**
 * 会话正文水位探针 `GET /api/mobile/v1/session/head`。
 *
 * 用途：App 进对话前先问一句「这条会话的正文到哪个水位了」，跟本地缓存水位一比就知道
 * 要不要重新拉全量历史。几十字节换几兆。
 *
 * 这里钉三件事：
 *   - 信号里有水位 → 如实回 seq 与 known:true；
 *   - **信号里没有 → 如实回 known:false**（插件刚重启、还没轮到推这个会话），
 *     绝不能为了「看起来有值」现读一次历史 —— 那样探针本身就变成了它要省掉的那次请求；
 *   - 子代理（带 parentSessionId）直接回 seq:0 / known:false：镜像里刻意不存子会话正文。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { handleSessionHead } = require('../lib/mobile/sessions.js');
const { sessionSignal } = require('../lib/shared/session-signal.js');

const ROUTE = '/api/mobile/v1/session/head';

/** 起一条真实的 HTTP 服务（handler 直接挂上去），返回请求用的地址。 */
async function serve() {
  const calls = [];
  // 任何宿主 RPC 都记下来：探针不许为了凑水位去读历史。
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request) => { calls.push({ method: 'history', request }); return { result: { ok: true, value: { events: [] } } }; },
        attachment: async (request) => { calls.push({ method: 'attachment', request }); return { result: { ok: true, value: { data: 'x' } } }; },
      },
    },
  };
  const server = http.createServer((req, res) => {
    Promise.resolve(handleSessionHead(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    url: (query = '') => `http://127.0.0.1:${port}${ROUTE}${query}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('信号里有水位：回 seq 与 known:true', async () => {
  const host = await serve();
  try {
    sessionSignal.bump('head-known', 42);
    const body = await (await fetch(host.url('?sessionId=head-known'))).json();
    assert.deepEqual(body, { ok: true, seq: 42, known: true });
    assert.deepEqual(host.calls, [], '探针不许发任何宿主 RPC');
  } finally {
    sessionSignal.reset();
    await host.close();
  }
});

test('信号里没有水位：如实回 known:false，且绝不现读历史', async () => {
  const host = await serve();
  try {
    sessionSignal.reset();
    const body = await (await fetch(host.url('?sessionId=head-unknown'))).json();
    assert.deepEqual(body, { ok: true, seq: 0, known: false });
    assert.deepEqual(host.calls, [], 'known:false 必须来自「信号里没有」，不许为了凑值去读一次历史');
  } finally {
    await host.close();
  }
});

test('子代理（带 parentSessionId）：直接回 seq:0 / known:false', async () => {
  const host = await serve();
  try {
    // 即便镜像里真有这个 child 的水位（不该有），子代理也要按「没有水位」回答。
    sessionSignal.bump('head-child', 99);
    const body = await (await fetch(host.url('?sessionId=head-child&parentSessionId=parent-1&mode=continuable'))).json();
    assert.deepEqual(body, { ok: true, seq: 0, known: false });
    assert.deepEqual(host.calls, []);
  } finally {
    sessionSignal.reset();
    await host.close();
  }
});

test('缺 sessionId：400 bad-request', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url(''));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad-request');
  } finally {
    await host.close();
  }
});

test('路由走 guarded 注册（与其他移动端路由一致）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const table = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'mobile-api.js'), 'utf8');
  assert.match(table, /route\('\/api\/mobile\/v1\/session\/head', sessions\.handleSessionHead\)/);
});

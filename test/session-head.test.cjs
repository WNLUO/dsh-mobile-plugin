'use strict';

/**
 * 会话正文水位探针 `GET /api/mobile/v1/session/head`。
 *
 * 用途：App 进对话前先问一句「这条会话的正文到哪个水位了」，跟本地缓存水位一比就知道
 * 要不要重新拉历史。答案必须来自**宿主日志**：答「一致」等于告诉手机「你手上那份就是最新，
 * 一条正文请求都别发」，所以这个答案错一次，用户就停在一份缺尾巴的正文上。
 *
 * 这里钉六件事：
 *   - 宿主日志尾巴里有消息 → 回那几行里最大的**消息** seq，且 `known:true`；
 *   - 不拿镜像信号当答案（正是 2026-11-01 改掉的那条路：镜像落后于日志，答「一致」时可能
 *     宿主上还有新内容）；
 *   - 不拿**事件** seq 冒充消息 seq（`turn/end` / `usage` 也推高它，冒充会让手机每进一次
 *     对话都白拉一发）；
 *   - 读失败 / 尾巴里一条消息都没有 → 如实 `known:false`（让 App 退回整份拉取），不抛 500；
 *   - 子代理（带 parentSessionId）直接回 seq:0 / known:false，且一次宿主 RPC 都不发；
 *   - 缺 sessionId → 400。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { handleSessionHead } = require('../lib/mobile/sessions.js');
const { sessionSignal } = require('../lib/shared/session-signal.js');

const ROUTE = '/api/mobile/v1/session/head';
const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

/** 一条 user / assistant 消息事件（宿主日志里折叠成一行正文的那种）。 */
function messageEvent(seq, role = 'user') {
  return {
    type: `${role}/message`,
    seq,
    time: seq,
    data: { turn: 1, step: 1, message: { id: `m-${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${seq} 条` }] } },
  };
}

/** 起一条真实的 HTTP 服务（handler 直接挂上去），返回请求用的地址。 */
async function serve({ sessionsHistory } = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request) => {
          calls.push({ method: 'history', request });
          if (sessionsHistory) return sessionsHistory(request);
          return okValue({ events: [], hasMore: false });
        },
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

test('宿主日志里有消息：回最后一行的 seq / known:true，且不读镜像信号', async () => {
  const host = await serve({
    sessionsHistory: () => okValue({
      events: [messageEvent(40, 'user'), messageEvent(42, 'assistant'), { type: 'turn/end', seq: 43, time: 43, data: { turn: 1, reason: 'completed' } }],
      hasMore: true,
    }),
  });
  try {
    // 镜像里故意报一个更高的水位：答案必须仍是日志那个（镜像落后就是这条探针要修的事）。
    sessionSignal.bump('head-log', 999);
    const body = await (await fetch(host.url('?sessionId=head-log'))).json();
    assert.deepEqual(body, { ok: true, seq: 42, known: true });
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].method, 'history');
    assert.equal(host.calls[0].request.payload.sessionId, 'head-log');
    assert.ok(host.calls[0].request.payload.maxMessages > 0, '只读一小段日志尾巴，不读整份');
  } finally {
    sessionSignal.reset();
    await host.close();
  }
});

test('尾巴里只有非消息事件：不拿事件 seq 冒充，如实回 known:false', async () => {
  const host = await serve({
    sessionsHistory: () => okValue({
      events: [
        { type: 'step/end', seq: 50, time: 50, data: { turn: 1, step: 1 } },
        { type: 'usage', seq: 51, time: 51, data: { turn: 1 } },
        { type: 'turn/end', seq: 52, time: 52, data: { turn: 1, reason: 'completed' } },
      ],
      hasMore: true,
    }),
  });
  try {
    const body = await (await fetch(host.url('?sessionId=head-events-only'))).json();
    assert.deepEqual(body, { ok: true, seq: 0, known: false });
  } finally {
    await host.close();
  }
});

test('宿主读历史抛错：如实回 known:false，不让探针 500', async () => {
  const host = await serve({ sessionsHistory: () => { throw new Error('boom'); } });
  try {
    const response = await fetch(host.url('?sessionId=head-throw'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, seq: 0, known: false });
  } finally {
    await host.close();
  }
});

test('宿主回错误信封：如实回 known:false', async () => {
  const host = await serve({ sessionsHistory: () => errValue({ code: 'session-not-found', message: '没了' }) });
  try {
    const body = await (await fetch(host.url('?sessionId=head-error'))).json();
    assert.deepEqual(body, { ok: true, seq: 0, known: false });
  } finally {
    await host.close();
  }
});

test('子代理（带 parentSessionId）：直接回 seq:0 / known:false，且不读宿主', async () => {
  const host = await serve();
  try {
    // 即便镜像里真有这个 child 的水位（不该有），子代理也要按「没有水位」回答。
    sessionSignal.bump('head-child', 99);
    const body = await (await fetch(host.url('?sessionId=head-child&parentSessionId=parent-1&mode=continuable'))).json();
    assert.deepEqual(body, { ok: true, seq: 0, known: false });
    assert.deepEqual(host.calls, [], '子会话正文刻意不进镜像，也没有可言的水位');
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
    assert.deepEqual(host.calls, []);
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

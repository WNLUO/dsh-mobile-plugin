'use strict';

/** Regression coverage for regular/subagent message history and HTTP error semantics. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleMessages } = require('../lib/mobile/session-snapshot.js');

const ROUTE = '/api/mobile/v1/session/messages';
const okValue = (value) => ({ result: { ok: true, value } });
const errValue = (error) => ({ result: { ok: false, error } });

async function serve({ sessionsHistory, subagentsHistory } = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request, signal) => {
          calls.push({ namespace: 'sessions', request, signal });
          return sessionsHistory ? sessionsHistory(request, signal) : okValue({ events: [], hasMore: false });
        },
      },
      subagents: {
        history: async (request, signal) => {
          calls.push({ namespace: 'subagents', request, signal });
          return subagentsHistory ? subagentsHistory(request, signal) : okValue({ events: [], hasMore: false });
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    Promise.resolve(handleMessages(ctx, req, res)).catch((error) => {
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

test('普通会话继续走 sessions.history', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url('?sessionId=root-1&limit=25'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].namespace, 'sessions');
    assert.deepEqual(host.calls[0].request, {
      rpcId: 'mobile',
      method: 'session.history',
      payload: { sessionId: 'root-1', maxMessages: 25 },
    });
  } finally {
    await host.close();
  }
});

test('子代理用 durable parent address 调 subagents.history', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url(
      '?sessionId=child-1&parentSessionId=parent-1&mode=continuable&beforeSeq=17&limit=25',
    ));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].namespace, 'subagents');
    assert.deepEqual(host.calls[0].request, {
      rpcId: 'mobile',
      method: 'subagent.history',
      payload: {
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        mode: 'continuable',
        maxMessages: 25,
        beforeSeq: 17,
      },
    });
    assert.ok(host.calls[0].signal instanceof AbortSignal);
  } finally {
    await host.close();
  }
});

test('不完整或未知模式的子代理地址在本地拒绝', async () => {
  const host = await serve();
  try {
    const response = await fetch(host.url('?sessionId=child-1&parentSessionId=parent-1&mode=unknown'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'bad-request');
    assert.equal(host.calls.length, 0);
  } finally {
    await host.close();
  }
});

for (const [code, expectedStatus] of [
  ['bad-request', 400],
  ['session-not-found', 404],
  ['subagent-not-found', 404],
  ['subagent-unauthorized', 403],
  ['host-unavailable', 503],
  ['host-call-failed', 502],
  ['gateway/arguments-invalid', 502],
]) {
  test(`history error ${code} maps to HTTP ${expectedStatus}`, async () => {
    const host = await serve({ sessionsHistory: async () => errValue({ code, message: 'upstream error' }) });
    try {
      const response = await fetch(host.url('?sessionId=root-1'));
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, code);
      assert.equal(body.error.message, 'upstream error');
    } finally {
      await host.close();
    }
  });
}

test('抛出的宿主调用失败作为 502，而非客户端 400', async () => {
  const host = await serve({ sessionsHistory: async () => { throw new Error('gateway offline'); } });
  try {
    const response = await fetch(host.url('?sessionId=root-1'));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'host-call-failed', message: 'gateway offline' },
    });
  } finally {
    await host.close();
  }
});

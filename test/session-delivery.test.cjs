'use strict';

/**
 * 「这一发到底进没进」（GET /api/mobile/v1/session/delivery）的契约。
 *
 * 它是 App 那条离线发件箱的安全绳：手机在「宿主已经收下、还没等到回包」那一刻被杀掉时，
 * 重启后会拿着同一个 `clientMessageId` 问一句 —— 答「进过了」就不再重发。答错的两种方向
 * 代价不一样：
 *   · 明明进了却说没进 → 用户看到同一条消息说了两遍（模型也跑两遍）；
 *   · 明明没进却说进了 → 那条消息永久消失，而界面把它划掉了。
 * 所以这里两组都要钉：按 `source.rpcId`（`mobile:<id>`）认得出，别的 id 一条都不认。
 *
 * 另外两条：参数不全会 400 且不打宿主；宿主说「没有这条会话」要回 404，让 App 把发件箱
 * 里那条标成失败，而不是永远重试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { handleSessionDelivery } = require('../lib/mobile/session-delivery.js');

function okValue(value) {
  return { result: { ok: true, value } };
}

function errValue(error) {
  return { result: { ok: false, error } };
}

/** 起一个只挂 handleSessionDelivery 的真 http 服务，并记下宿主收到的每一次 history 调用。 */
async function serve(historyImpl) {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        history: async (request) => {
          calls.push(request);
          return historyImpl(request);
        },
      },
    },
  };
  const server = http.createServer((req, res) => {
    Promise.resolve(handleSessionDelivery(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    base: `http://127.0.0.1:${port}/session/delivery`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 一条 user/message 事件：正文随便，关键是 source.rpcId 里的投递 id。 */
function userEvent({ seq, rpcId, text = '在吗' }) {
  return {
    event: {
      type: 'user/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        id: `msg-${seq}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId },
      },
    },
  };
}

test('缺参数 → 400，且一次都不打宿主', async () => {
  const host = await serve(() => okValue({ events: [] }));
  try {
    for (const suffix of ['', '?sessionId=s1', '?clientMessageId=c1', '?sessionId=&clientMessageId=']) {
      const res = await fetch(`${host.base}${suffix}`);
      assert.equal(res.status, 400, `suffix=${suffix}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'bad-request');
    }
    assert.equal(host.calls.length, 0, '参数不全不该消耗宿主一次历史扫描');
  } finally {
    await host.close();
  }
});

test('正文里认得到同一个投递 id → delivered:true 并带上 seq', async () => {
  const host = await serve(() => okValue({
    events: [userEvent({ seq: 3, rpcId: 'mobile:c1' }), userEvent({ seq: 4, rpcId: 'mobile:other' })],
  }));
  try {
    const res = await fetch(`${host.base}?sessionId=s1&clientMessageId=c1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.delivered, true);
    assert.equal(body.seq, 3, '认到了就把那一发的位置一起回，省得 App 再猜');
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].payload.sessionId, 's1');
    assert.equal(host.calls[0].payload.maxMessages, 200, '只查最近这一窗，不整段历史');
  } finally {
    await host.close();
  }
});

test('只认 id，别的 rpcId 一概不算进', async () => {
  const host = await serve(() => okValue({
    events: [userEvent({ seq: 1, rpcId: 'mobile:c2' }), userEvent({ seq: 2, rpcId: 'desktop' })],
  }));
  try {
    const res = await fetch(`${host.base}?sessionId=s1&clientMessageId=c1`);
    const body = await res.json();
    assert.equal(body.delivered, false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'seq'), false, '没认到时不许摆一个假 seq');
  } finally {
    await host.close();
  }
});

test('宿主说没有这条会话 → 404（App 据此把发件箱那条标成失败，而不是永远重试）', async () => {
  const host = await serve(() => errValue({ code: 'session-not-found', message: '找不到会话' }));
  try {
    const res = await fetch(`${host.base}?sessionId=s1&clientMessageId=c1`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'session-not-found');
  } finally {
    await host.close();
  }
});

test('其余宿主错误 → 502，原话带回来（别把「读不到」说成「没送到」）', async () => {
  const host = await serve(() => errValue({ code: 'host-unavailable', message: '宿主正忙' }));
  try {
    const res = await fetch(`${host.base}?sessionId=s1&clientMessageId=c1`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'host-unavailable');
    assert.equal(body.error.message, '宿主正忙');
  } finally {
    await host.close();
  }
});

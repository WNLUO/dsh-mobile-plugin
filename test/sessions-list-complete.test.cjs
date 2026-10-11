'use strict';

/**
 * 会话列表完整性回归测试：
 *  - 列表必须完整返回全部会话（此前 SESSIONS_ENRICH_LIMIT=20 会把第 21 个及以后
 *    的会话整体截掉，导致 APP 侧边栏工作区/项目下会话缺失）；
 *  - 历史预览（lastMessage 补全）仍受 SESSIONS_PREVIEW_LIMIT 上限约束，运行中会话优先；
 *  - 超出预览上限的会话保留全部身份字段，仅 lastMessage 为空。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionsResponse, SESSIONS_PREVIEW_LIMIT } = require('../lib/mobile/sessions.js');

function makeCtx(sessionCount) {
  const items = Array.from({ length: sessionCount }, (_, i) => ({
    sessionId: `session-${i}`,
    cwd: `/ws/${i % 3}`,
    updatedAt: 1000 + i,
    running: i === 0,
    blank: false,
  }));
  const historyCalls = new Set();
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async ({ payload }) => {
          const sessionId = payload && payload.sessionId;
          if (typeof sessionId === 'string') historyCalls.add(sessionId);
          if (sessionId === 'session-0') {
            // 运行中会话的历史折叠出最后一条消息预览。
            return { result: { ok: true, value: { events: [
              { event: { type: 'assistant/message', seq: 1, time: 5, data: { message: { id: 1, role: 'assistant', content: [{ type: 'text', text: 'running preview' }] } } } },
            ] } } };
          }
          return { result: { ok: true, value: { events: [] } } };
        },
      },
    },
  };
  return { ctx, historyCalls };
}

test('session list returns ALL sessions beyond the preview limit', async () => {
  const count = 30;
  const { ctx, historyCalls } = makeCtx(count);
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  const items = response.body.items;
  // 完整返回：一个都不能少，且保持 Host 列表顺序。
  assert.equal(items.length, count);
  assert.deepEqual(items.map((item) => item.sessionId), Array.from({ length: count }, (_, i) => `session-${i}`));
  // 每个会话的身份字段都在（标题/cwd/running/blank/updatedAt），不再受预览上限影响。
  for (const item of items) {
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.cwd, 'string');
    assert.equal(typeof item.running, 'boolean');
    assert.equal(typeof item.blank, 'boolean');
    assert.equal(typeof item.updatedAt, 'number');
  }
  // 预览（history 拉取）仍然受限，不会随列表膨胀。
  assert.ok(historyCalls.size <= SESSIONS_PREVIEW_LIMIT, `history calls = ${historyCalls.size}, cap = ${SESSIONS_PREVIEW_LIMIT}`);
});

test('running session is prioritized for preview even when not recently active', async () => {
  const count = 30;
  const { ctx } = makeCtx(count);
  const response = await buildSessionsResponse(ctx);
  const byId = new Map(response.body.items.map((item) => [item.sessionId, item]));
  // session-0 是最早更新（updatedAt=1000）但运行中：预览必须覆盖它。
  assert.equal(byId.get('session-0').lastMessage.text, 'running preview');
  // session-5（updatedAt=1005）不在最近活跃的预览子集内：保留身份字段，预览为空。
  const far = byId.get('session-5');
  assert.equal(far.lastMessage, null);
  assert.equal(far.cwd, '/ws/2');
  assert.equal(far.running, false);
});

test('preview history failures never drop sessions from the list', async () => {
  const count = 25;
  const items = Array.from({ length: count }, (_, i) => ({
    sessionId: `s-${i}`, cwd: '/ws', updatedAt: i, running: false, blank: false,
  }));
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => { throw new Error('history exploded'); },
      },
    },
  };
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, count);
  assert.ok(response.body.items.every((item) => item.lastMessage === null));
});

test('unchanged session previews are reused across list refreshes', async () => {
  let historyCalls = 0;
  const items = [{ sessionId: 'same', cwd: '/ws', updatedAt: 42, running: false, blank: false }];
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => {
          historyCalls += 1;
          return { result: { ok: true, value: { events: [] } } };
        },
      },
    },
  };

  await buildSessionsResponse(ctx);
  await buildSessionsResponse(ctx);

  assert.equal(historyCalls, 1);
});

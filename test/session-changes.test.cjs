'use strict';

/** 按需改动详情必须按轮且经过原会话寻址权限，窗口缺失不能伪装完整。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleSessionChanges, readTurnEvents } = require('../lib/mobile/session-changes.js');
const { noteLiveEvent } = require('../lib/mobile/live-steps.js');
const event = (type, seq, data = {}) => ({ type, seq, time: seq * 100, data: { turn: 1, ...data } });
function context(events, calls = []) {
  return { apiProxy: { sessions: { history: async (request) => {
    calls.push(request.payload);
    return { result: { ok: true, value: { events, hasMore: false } } };
  } } } };
}
async function call(ctx, query) {
  let status, body;
  await handleSessionChanges(ctx, { url: `/session/changes?${new URLSearchParams(query)}` }, {
    req: { headers: {} }, writeHead(code) { status = code; }, end(raw) { body = JSON.parse(String(raw)); },
  });
  return { status, body };
}

test('只返回点名轮的已应用文本，不读工作区', async () => {
  const events = [event('turn/start', 1), event('tool/result', 2, { message: { source: { callId: 'a' }, content: [] }, meta: { diffs: [{ path: 'a.md', oldText: 'old', newText: 'new' }] } }),
    event('turn/start', 3, { turn: 2 }), event('tool/result', 4, { turn: 2, message: { source: { callId: 'b' }, content: [] }, meta: { diffs: [{ path: 'b.md', oldText: '', newText: 'two' }] } })];
  const out = await call(context(events), { sessionId: 's', turn: '1' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.files, [{ path: 'a.md', oldText: 'old', newText: 'new' }]);
});

test('子代理地址成对传给history，拒绝不完整地址和非整数轮号', async () => {
  const calls = [];
  const ctx = context([event('turn/start', 1)], calls);
  assert.equal((await call(ctx, { sessionId: 's', turn: '1', parentSessionId: 'parent', mode: 'one-shot' })).status, 200);
  assert.equal(calls[0].parentSessionId, 'parent');
  assert.equal(calls[0].mode, 'one-shot');
  assert.equal((await call(ctx, { sessionId: 's', turn: '1.5' })).status, 400);
  assert.equal((await call(ctx, { sessionId: 's', turn: '1', parentSessionId: 'parent' })).status, 400);
  assert.equal(calls.length, 1);
});

test('直播副本存在也必须先通过读会话权限', async () => {
  const ctx = { apiProxy: { sessions: { history: async () => ({ result: { ok: false, error: { code: 'subagent-unauthorized', message: 'denied' } } }) } } };
  noteLiveEvent(ctx, 's', event('turn/start', 1));
  const out = await call(ctx, { sessionId: 's', turn: '1', parentSessionId: 'wrong', mode: 'one-shot' });
  assert.equal(out.status, 403);
});

test('向前翻页定位轮首且游标停滞明确标不完整', async () => {
  const calls = [];
  const ctx = { apiProxy: { sessions: { history: async ({ payload }) => {
    calls.push(payload);
    return { result: { ok: true, value: { events: [event('assistant/message', 9, { message: { content: [] } })], hasMore: true } } };
  } } } };
  const out = await readTurnEvents(ctx, 's', 1);
  assert.equal(out.truncated, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].beforeSeq, 9);
});

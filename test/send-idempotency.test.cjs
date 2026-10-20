'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promptOnce, sendIdempotencyStateOf } = require('../lib/mobile/sessions.js');

const ctxWith = (prompt) => {
  const ctx = { apiProxy: { sessions: { prompt } } };
  return ctx;
};

test('keeps the idempotency record after a successful prompt', async () => {
  const ctx = ctxWith(async () => ({ result: { ok: true, value: { accepted: true } } }));
  const p = promptOnce(ctx, 'cm-1', { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
  await assert.doesNotReject(() => p);
  const state = sendIdempotencyStateOf(ctx);
  assert.equal(state.has('s-1:cm-1'), true);
});

test('releases the record after a rejected prompt so a retry can re-run', async () => {
  let calls = 0;
  const ctx = ctxWith(async () => { calls += 1; throw new Error('transient'); });
  const key = 's-1:cm-1';

  const first = promptOnce(ctx, 'cm-1', { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
  await assert.rejects(() => first, /transient/);
  // 等待 rejection handler（模块内 promise.then 的 onError）把记录删掉。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendIdempotencyStateOf(ctx).has(key), false, 'rejected prompt must not stay cached');

  // 再次发送：应重新调用宿主（而不是拿到被毒化的旧 rejection）。
  const second = promptOnce(ctx, 'cm-1', { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
  await assert.rejects(() => second, /transient/);
  assert.equal(calls, 2);
});

test('concurrent sends with the same clientMessageId share one prompt', async () => {
  let calls = 0;
  const ctx = ctxWith(async () => { calls += 1; return { result: { ok: true, value: { accepted: true } } }; });
  const payload = { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] };
  const [a, b] = [promptOnce(ctx, 'cm-2', payload), promptOnce(ctx, 'cm-2', payload)];
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.equal(calls, 1);
});

test('把 clientMessageId 作为宿主 prompt 的 requestId 送过去', async () => {
  const seen = [];
  const ctx = {
    apiProxy: {
      sessions: {
        prompt: async (arg) => { seen.push(arg); return { result: { ok: true, value: { accepted: true } } }; },
      },
    },
  };
  await promptOnce(ctx, 'cm-9', { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
  assert.equal(seen.length, 1);
  // 宿主把 requestId 记成 user 消息的 source.rpcId，App 靠它（`mobile:` 前缀）认领自己的乐观行。
  assert.equal(seen[0].payload.requestId, 'mobile:cm-9');
});

'use strict';

const test = require('node:test');
const { mock } = require('node:test');
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

test('宿主回业务错误（信封 ok:false）也不占位：同一 id 重试会真的再发', async () => {
  let calls = 0;
  const ctx = ctxWith(async () => {
    calls += 1;
    return { result: { ok: false, error: { code: 'model-unavailable', message: '当前没有可用模型' } } };
  });
  const payload = { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] };
  const first = await promptOnce(ctx, 'cm-5', payload);
  assert.equal(first.result.ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendIdempotencyStateOf(ctx).has('s-1:cm-5'), false, '业务错误不能占位');
  await promptOnce(ctx, 'cm-5', payload);
  assert.equal(calls, 2, '被拒的那一发重试必须真的再试一次');
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

// 超时的那一发很可能已经交给宿主了（线路一侧丢的是回包）。用户隔几分钟再点的那次重试
// 必须还是同一次 prompt —— 记录按时间过期的话，这一下就是「模型把同一条消息跑两遍」。
test('成功之后不再按时间过期：半小时后重试仍回放同一次 prompt', async () => {
  let calls = 0;
  const ctx = ctxWith(async () => { calls += 1; return { result: { ok: true, value: { accepted: true } } }; });
  const payload = { sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] };
  await promptOnce(ctx, 'cm-3', payload);
  assert.equal(calls, 1);

  mock.timers.enable({ apis: ['Date'] });
  try {
    mock.timers.setTime(Date.now() + 30 * 60_000);
    await promptOnce(ctx, 'cm-3', payload);
    assert.equal(calls, 1, '会话级去重：过了旧窗口也不许再打一次宿主');
  } finally {
    mock.timers.reset();
  }
});

test('同一个 clientMessageId 换了会话就重新发（去重键带 sessionId）', async () => {
  const seen = [];
  const ctx = {
    apiProxy: {
      sessions: {
        prompt: async (arg) => { seen.push(arg); return { result: { ok: true, value: { accepted: true } } }; },
      },
    },
  };
  const content = [{ type: 'text', text: 'hi' }];
  await promptOnce(ctx, 'cm-4', { sessionId: 's-1', mode: 'queue', content });
  await promptOnce(ctx, 'cm-4', { sessionId: 's-2', mode: 'queue', content });
  assert.equal(seen.length, 2);
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

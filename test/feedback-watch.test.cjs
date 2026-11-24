// 用途：验证反馈 SSE 实时等待：只收更新的官方回复，超时/断流净返回，上游错误照状态带出。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerFeedbackTool, watchFeedback } = require('../lib/mobile/feedback.js');
const direct = require('../lib/mobile/feedback-watch.cjs').watchFeedback;

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

/** 用 ReadableStream 喂 SSE 帧；hang 时不开口，只能靠超时 abort 结束。 */
function sseResponse(chunks, signal, { hang = false } = {}) {
  const encoder = new TextEncoder();
  return {
    status: 200,
    body: new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => {
          try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* 已关闭 */ }
        });
        if (hang) return;
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

function fetchCalls(makeResponse, calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    return makeResponse(init);
  };
}

function replyFrame(id, author, content, created_at = '2026-11-24T10:00:00Z') {
  return `event: reply\ndata: ${JSON.stringify({ id, author, content, created_at })}\n\n`;
}

test('watchFeedback：公开 SSE 地址，跳过心跳/快照/用户，返回首条官方回复', async () => {
  const calls = [];
  const frames = [
    ': heartbeat\n\n',
    'event: snapshot\ndata: {"latest_message_id":9,"status":"open"}\n\n',
    replyFrame(7, 'user', '我这边还是不行', '2026-11-24T10:00:00Z'),
    replyFrame(8, 'staff', '请看版本号', '2026-11-24T10:01:00Z'),
  ];
  await withFetch(fetchCalls(init => sseResponse(frames, init.signal), calls), async () => {
    const reply = await watchFeedback('  tk-1  ', { afterMessageId: 6 });
    assert.deepEqual(reply, { id: 8, author: 'staff', content: '请看版本号', created_at: '2026-11-24T10:01:00Z' });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback/events?thread_key=tk-1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.accept, 'text/event-stream');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('watchFeedback：旧 id、user 与未知 event 都不算；默认水位是 0', async () => {
  const frames = [
    replyFrame(3, 'staff', '旧回复', 't0'),
    replyFrame(4, 'user', '继续追问', 't1'),
    'event: something_else\ndata: {"id":5,"author":"staff","content":"别收","created_at":"t2"}\n\n',
    replyFrame(5, 'staff', '新回复', 't3'),
  ];
  await withFetch(fetchCalls(init => sseResponse(frames, init.signal), []), async () => {
    assert.equal((await watchFeedback('tk-2', { afterMessageId: 3 })).content, '新回复');
  });
  await withFetch(fetchCalls(init => sseResponse([
    replyFrame(0, 'staff', 'id 零不算', 't0'),
    replyFrame(1, 'staff', '默认从 0 起', 't1'),
  ], init.signal), []), async () => {
    assert.equal((await watchFeedback('tk-2')).content, '默认从 0 起');
  });
});

test('watchFeedback：超时与断流返回 timedOut，不抛错', async () => {
  const calls = [];
  const hang = fetchCalls(init => sseResponse([], init.signal, { hang: true }), calls);
  await withFetch(hang, async () => {
    assert.deepEqual(await watchFeedback('tk-3', { timeoutMs: 20 }), { timedOut: true });
  });
  assert.equal(calls[0].init.signal.aborted, true);
  await withFetch(fetchCalls(init => sseResponse([': heartbeat\n\n'], init.signal), []), async () => {
    assert.deepEqual(await watchFeedback('tk-3', { timeoutMs: 200 }), { timedOut: true });
  });
  await withFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    assert.deepEqual(await watchFeedback('tk-3', { timeoutMs: 20 }), { timedOut: true });
  });
});

test('watchFeedback：非 2xx 与网络错误带状态/原文抛出，空 key 本地拒', async () => {
  await withFetch(async () => ({ status: 503, json: async () => ({ error: '订阅暂不可用' }) }), async () => {
    await assert.rejects(() => watchFeedback('tk-4'), error => error.status === 503 && error.message === '订阅暂不可用');
  });
  await withFetch(async () => ({ status: 500 }), async () => {
    await assert.rejects(() => watchFeedback('tk-4'), error => error.status === 500 && /HTTP 500/.test(error.message));
  });
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(() => watchFeedback('tk-4'), error => error.status === undefined && /network down/.test(error.message));
  });
  await withFetch(() => { throw new Error('不该联网'); }, async () => {
    for (const key of [undefined, null, '', '  ', 5, {}]) {
      await assert.rejects(() => watchFeedback(key), error => error.status === 400 && /需要 threadKey/.test(error.message));
    }
  });
});

test('dsh_feedback.watch：submit 后按 threadKey 等回复，执行结果与摘要都有两态', async () => {
  let registered = null;
  const ctx = { tools: { register: (tool) => { registered = tool; } } };
  registerFeedbackTool(ctx, { credentials: { listDevices: () => [] }, instanceId: () => 'inst-1' });
  assert.equal(watchFeedback, direct, '工具与模块导出同一份实现');
  assert.ok(registered.parameters.properties.action.enum.includes('watch'));
  assert.match(registered.description, /do NOT repeatedly poll `read`/);
  assert.equal(registered.parameters.properties.afterMessageId.type, 'number');
  assert.ok(registered.output.schema.properties.reply);
  assert.equal(registered.output.schema.properties.timedOut.type, 'boolean');

  const frames = [replyFrame(5, 'staff', '请升级到 0.5.51', '2026-11-24T11:00:00Z')];
  await withFetch(fetchCalls(init => sseResponse(frames, init.signal), []), async () => {
    const result = await registered.execute({ action: 'watch', threadKey: 'tk-5', afterMessageId: 4 });
    assert.deepEqual(result, {
      action: 'watch',
      threadKey: 'tk-5',
      reply: { id: 5, author: 'staff', content: '请升级到 0.5.51', created_at: '2026-11-24T11:00:00Z' },
    });
    assert.match(registered.output.render({}, result)[0].text, /请升级到 0\.5\.51/);
  });

  await withFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    const result = await registered.execute({ action: 'watch', threadKey: 'tk-6' });
    assert.deepEqual(result, { action: 'watch', threadKey: 'tk-6', timedOut: true });
    assert.match(registered.output.render({}, result)[0].text, /还没有官方回复/);
  });
});

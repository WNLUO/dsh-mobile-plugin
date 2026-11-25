// 用途：验证 watch 轮询现有 read 端点：只收比水位新的官方回复，按间隔重问，超时给出改用 read 的提示。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerFeedbackTool, watchFeedback } = require('../lib/mobile/feedback.js');
const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
  watchFeedback: direct,
} = require('../lib/mobile/feedback-watch.cjs');

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

/** 回一份与 read 同形状的线程包；非 2xx 时回平台错误体。 */
function readResponse(messages, { status = 200, error } = {}) {
  return {
    status,
    json: async () => (status >= 200 && status < 300
      ? { data: { thread_key: 'tk', status: 'open', messages } }
      : { error: error || `反馈读取失败（HTTP ${status}）` }),
  };
}

function fetchCalls(makeResponse, calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    return makeResponse(init);
  };
}

function staffMessage(id, content, created_at = '2026-11-24T10:01:00Z') {
  return { id, author: 'staff', content, created_at };
}

function userMessage(id, content) {
  return { id, author: 'user', content, created_at: '2026-11-24T10:00:00Z' };
}

test('watchFeedback：轮询 read 端点，取第一条比水位新的官方回复', async () => {
  const calls = [];
  const messages = [
    userMessage(5, '我这边还是不行'),
    staffMessage(6, '旧回复'),
    staffMessage(8, '请看版本号', '2026-11-24T10:01:00Z'),
  ];
  await withFetch(fetchCalls(() => readResponse(messages), calls), async () => {
    const reply = await watchFeedback('  tk-1  ', { afterMessageId: 6 });
    assert.deepEqual(reply, { id: 8, author: 'staff', content: '请看版本号', created_at: '2026-11-24T10:01:00Z' });
  });
  assert.equal(calls.length, 1, '第一轮就有回复时只发一次请求');
  // 原来钉的 /api/sdk/feedback/events 路由并不存在（带不带参数都 404 空体），改为轮询现有 read 端点。
  assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback?thread_key=tk-1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers, undefined, '不声明事件流');
  assert.ok(calls[0].init.signal instanceof AbortSignal, '沿用 read 的单次请求超时');
});

test('watchFeedback：旧 id、user 与未知作者都不算；默认水位是 0', async () => {
  await withFetch(fetchCalls(() => readResponse([
    staffMessage(3, '旧回复'),
    userMessage(4, '继续追问'),
    { id: 5, author: 'bot', content: '别收', created_at: 't2' },
    staffMessage(5, '新回复', 't3'),
  ]), []), async () => {
    assert.equal((await watchFeedback('tk-2', { afterMessageId: 3 })).content, '新回复');
  });
  await withFetch(fetchCalls(() => readResponse([
    staffMessage(0, 'id 零不算'),
    staffMessage(1, '默认从 0 起'),
  ]), []), async () => {
    assert.equal((await watchFeedback('tk-2')).content, '默认从 0 起');
  });
});

test('watchFeedback：默认两秒一问、最多两分钟；没有回复就按间隔重问', async () => {
  assert.equal(DEFAULT_INTERVAL_MS, 2000);
  assert.equal(DEFAULT_TIMEOUT_MS, 120000);

  const calls = [];
  let round = 0;
  await withFetch(fetchCalls(() => {
    round += 1;
    return readResponse(round < 3 ? [userMessage(1, '还没回')] : [staffMessage(2, '第三轮才回', 't3')]);
  }, calls), async () => {
    const started = Date.now();
    const reply = await watchFeedback('tk-poll', { intervalMs: 20, timeoutMs: 1000 });
    assert.equal(reply.content, '第三轮才回');
    assert.ok(Date.now() - started >= 40, '两轮空读各等了一个间隔');
  });
  assert.equal(calls.length, 3, '两轮空读后再问一次才拿到回复');
});

test('watchFeedback：到点仍无回复带明确提示返回，不无限等', async () => {
  const calls = [];
  await withFetch(fetchCalls(() => readResponse([]), calls), async () => {
    const result = await watchFeedback('tk-3', { timeoutMs: 40, intervalMs: 10 });
    assert.deepEqual(result, { timedOut: true, message: TIMEOUT_MESSAGE });
    assert.match(result.message, /暂时没收到回复，请用 read 查看/);
  });
  assert.ok(calls.length >= 2, '至少轮询两次才判超时');
});

test('watchFeedback：非 2xx 与网络错误带状态/原文抛出，空 key 本地拒', async () => {
  await withFetch(async () => readResponse(null, { status: 503, error: '读取暂不可用' }), async () => {
    await assert.rejects(() => watchFeedback('tk-4'), error => error.status === 503 && error.message === '读取暂不可用');
  });
  await withFetch(async () => ({ status: 500, json: async () => ({}) }), async () => {
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

test('dsh_feedback.watch：submit 后按 threadKey 轮询等回复，执行结果与摘要都有两态', async () => {
  let registered = null;
  const ctx = { tools: { register: (tool) => { registered = tool; } } };
  registerFeedbackTool(ctx, { credentials: { listDevices: () => [] }, instanceId: () => 'inst-1' });
  assert.equal(watchFeedback, direct, '工具与模块导出同一份实现');
  assert.ok(registered.parameters.properties.action.enum.includes('watch'));
  assert.match(registered.parameters.properties.action.description, /poll the existing read endpoint/);
  assert.match(registered.description, /checks the existing feedback endpoint every two seconds/);
  assert.doesNotMatch(registered.description, /long connection|event stream/);
  assert.equal(registered.parameters.properties.afterMessageId.type, 'number');
  assert.ok(registered.output.schema.properties.reply);
  assert.equal(registered.output.schema.properties.timedOut.type, 'boolean');

  const calls = [];
  await withFetch(fetchCalls(() => readResponse([staffMessage(5, '请升级到 0.5.51', '2026-11-24T11:00:00Z')]), calls), async () => {
    const result = await registered.execute({ action: 'watch', threadKey: 'tk-5', afterMessageId: 4 });
    assert.deepEqual(result, {
      action: 'watch',
      threadKey: 'tk-5',
      reply: { id: 5, author: 'staff', content: '请升级到 0.5.51', created_at: '2026-11-24T11:00:00Z' },
    });
    assert.match(registered.output.render({}, result)[0].text, /请升级到 0\.5\.51/);
  });
  assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback?thread_key=tk-5');

  const timedOut = { action: 'watch', threadKey: 'tk-6', timedOut: true, message: TIMEOUT_MESSAGE };
  assert.match(registered.output.render({}, timedOut)[0].text, /暂时没收到回复，请用 read 查看/);
});

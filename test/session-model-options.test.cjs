'use strict';

/**
 * 模型附加选项（速度、输出详略……）的读写契约。
 *
 * 这一层是「模型 + 推理等级」之外唯一多出来的东西：宿主的模型目录里没有它，是插件
 * 自己的偏好（Codex 订阅插件的 speedMode / outputVerbosity）。这里的每条规矩都对应
 * 一种会静默出错的写法：
 *
 *  1. 只认描述表里声明过的 provider / 行 / 取值 —— 这是移动 API 上唯一一处写插件设置
 *     的入口，不能因为 App 传了什么就写什么；
 *  2. 读不到设置（插件没装、宿主没开 settings）要返回空数组，不是抛错：模型目录得照常
 *     下发，少两行不能把整个面板弄没；
 *  3. 写入要带 describe 拿到的 revision（宿主按版本拒绝过期写），写完作废这条会话的
 *     目录缓存，否则手机上拿着旧值直到 20 秒 TTL 到期。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  readModelOptions,
  safeModelOptions,
  writeModelOption,
  handleModelOption,
} = require('../lib/mobile/session-model-options.js');
const { sessionModelsStateOf } = require('../lib/mobile/session-cache.js');
const { safeModelsValue } = require('../lib/mobile/session-models.js');

const NAMESPACE = {
  ns: 'codex-subscription',
  revision: 7,
  value: { speedMode: 'fast', outputVerbosity: 'high', unrelated: 'x' },
};

function contextOf(overrides = {}) {
  const calls = [];
  const ctx = {
    apiProxy: {
      settings: {
        describe: async (request) => {
          calls.push(['describe', request]);
          return overrides.describe ? overrides.describe(request) : { result: { ok: true, value: [NAMESPACE] } };
        },
        mutate: async (request) => {
          calls.push(['mutate', request]);
          return overrides.mutate ? overrides.mutate(request) : { result: { ok: true, value: NAMESPACE } };
        },
      },
    },
  };
  return { ctx, calls };
}

test('safeModelOptions 逐字段挑：坏行丢掉、空行不下发、说明保留', () => {
  const rows = safeModelOptions([
    { id: 'speed', title: '速度', value: 'fast', choices: [{ id: 'fast', name: '高速', description: '优先处理' }] },
    { id: 'broken' },
    null,
    { id: 'verbosity', title: '输出详略', value: 'high', choices: [{ id: 'high', name: '详细' }, { nope: true }] },
  ]);
  assert.deepEqual(rows, [
    { id: 'speed', title: '速度', value: 'fast', choices: [{ id: 'fast', name: '高速', description: '优先处理' }] },
    { id: 'verbosity', title: '输出详略', value: 'high', choices: [{ id: 'high', name: '详细' }] },
  ]);
  assert.deepEqual(safeModelOptions(undefined), []);
});

test('safeModelsValue 把 options 带进会话目录响应（坏行同样丢掉）', () => {
  const value = safeModelsValue({
    current: { provider: 'openai-codex', model: 'gpt-6-sol' },
    groups: [],
    options: [
      { id: 'speed', title: '速度', value: 'fast', choices: [{ id: 'fast', name: '高速' }] },
      { id: 'broken' },
    ],
  });
  assert.deepEqual(value.options.map((row) => row.id), ['speed']);
  assert.equal(value.options[0].choices[0].name, '高速');
});

test('readModelOptions：按 provider 找来源，读当前值；不相关的 provider 直接空数组', async () => {
  const { ctx, calls } = contextOf();
  const rows = await readModelOptions(ctx, 'openai-codex');
  assert.deepEqual(rows.map((row) => [row.id, row.title, row.value]), [
    ['speed', '速度', 'fast'],
    ['verbosity', '输出详略', 'high'],
  ]);
  assert.equal(rows[0].choices.length, 3);

  const before = calls.length;
  assert.deepEqual(await readModelOptions(ctx, 'deepseek'), []);
  assert.equal(calls.length, before, '没有来源时不该白调一次宿主');
});

test('readModelOptions：设置读不到（插件没装）是空数组，不是故障', async () => {
  const { ctx } = contextOf({ describe: () => ({ result: { ok: true, value: [] } }) });
  assert.deepEqual(await readModelOptions(ctx, 'openai-codex'), []);

  const failing = contextOf({ describe: () => ({ result: { ok: false, error: { code: 'host-unavailable', message: 'no' } } }) });
  assert.deepEqual(await readModelOptions(failing.ctx, 'openai-codex'), []);
});

test('宿主没有 settings 域时读不到选项，也不抛错（模型目录照常下发）', async () => {
  const ctx = { apiProxy: {} };
  assert.deepEqual(await readModelOptions(ctx, 'openai-codex'), []);
  const missing = await writeModelOption(ctx, 'openai-codex', 'speed', 'fast');
  assert.equal(missing.error.code, 'host-unavailable');
});

test('writeModelOption：只认声明过的行与取值，非法输入不碰宿主', async () => {
  const { ctx, calls } = contextOf();
  assert.equal((await writeModelOption(ctx, 'openai-codex', 'nope', 'fast')).error.code, 'bad-request');
  assert.equal((await writeModelOption(ctx, 'openai-codex', 'speed', 'turbo')).error.code, 'bad-request');
  assert.equal((await writeModelOption(ctx, 'deepseek', 'speed', 'fast')).error.code, 'bad-request');
  assert.equal(calls.filter(([kind]) => kind === 'mutate').length, 0);
});

test('writeModelOption：带 describe 的 revision 写回设置，字段就是表里那个', async () => {
  const { ctx, calls } = contextOf();
  const result = await writeModelOption(ctx, 'openai-codex', 'speed', 'fast');
  assert.deepEqual(result, { value: true });
  const mutate = calls.find(([kind]) => kind === 'mutate');
  assert.equal(mutate[1].method, 'settings.mutate');
  assert.deepEqual(mutate[1].payload, {
    ns: 'codex-subscription',
    ops: [{ op: 'set', path: ['speedMode'], value: 'fast' }],
    expectedRevision: 7,
  });
});

test('POST /session/model-option：缺字段本地 400，成功写设置并作废这条会话的目录缓存', async () => {
  const { ctx, calls } = contextOf();
  // 先让这条会话的目录缓存里有值，写完必须清掉。
  sessionModelsStateOf(ctx, 'legacy', 's1').value = { current: { provider: 'openai-codex', model: 'gpt-6-sol' } };

  const server = http.createServer(async (req, res) => { await handleModelOption(ctx, req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/mobile/v1/session/model-option`;

  const post = (body) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    const missing = await post({ sessionId: 's1' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'bad-request');

    const unknown = await post({ sessionId: 's1', provider: 'openai-codex', optionId: 'speed', value: 'turbo' });
    assert.equal(unknown.status, 400);

    const ok = await post({ sessionId: 's1', provider: 'openai-codex', optionId: 'verbosity', value: 'low' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const mutate = calls.find(([kind]) => kind === 'mutate');
    assert.deepEqual(mutate[1].payload.ops, [{ op: 'set', path: ['outputVerbosity'], value: 'low' }]);
    assert.equal(sessionModelsStateOf(ctx, 'legacy', 's1').value, null, '写完之后缓存必须是空的');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

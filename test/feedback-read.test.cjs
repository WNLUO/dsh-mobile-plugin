// 用途：验证固定平台线程读取、消息附件契约、key 校验和上游错误原样交付。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { readFeedback } = require('../lib/mobile/feedback.js');
const { handlePanelFeedback } = require('../lib/mobile/feedback.js');

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { await fn(); } finally { globalThis.fetch = original; }
}

function response(data, status = 200) {
  return { status, json: async () => data };
}

test('变异：读取多套 data、续回复丢 threadKey 都会被相同接口断言拒绝', async () => {
  const file = path.join(__dirname, '..', 'lib', 'routes', 'feedback.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const load = text => {
    const mod = { exports: {} };
    vm.runInNewContext(text, { module: mod, exports: mod.exports, URL, require: name => name === '../mobile/feedback.js'
      ? { readFeedback: async key => ({ thread_key: key, messages: [{ content: '官方回复' }] }),
        submitFeedback: async (_deps, _content, key) => ({ threadKey: key }) }
      : createRequire(file)(name) });
    return mod.exports.handleFeedback;
  };
  const assertContract = async handler => {
    const deps = { readJson: async req => req.body, sendJson: (res, status, body) => { res.status = status; res.body = body; } };
    const get = {};
    await handler({ ...deps, req: { method: 'GET', url: '/api/relay/feedback?thread_key=key' }, res: get });
    assert.equal(get.body.thread_key, 'key', 'GET直接返回线程');
    const post = {};
    await handler({ ...deps, req: { method: 'POST', body: { content: '继续补充', threadKey: 'key' } }, res: post });
    assert.equal(post.body.threadKey, 'key', 'POST必须延续原线程');
  };
  await assertContract(load(source));
  for (const [before, after] of [
    ['sendJson(res, 200, await readFeedback(key))', 'sendJson(res, 200, { data: await readFeedback(key) })'],
    ['body.content, body.threadKey', 'body.content, undefined'],
  ]) {
    const changed = source.replace(before, after);
    assert.notEqual(changed, source);
    await assert.rejects(() => assertContract(load(changed)), assert.AssertionError);
  }
});

test('readFeedback：固定平台 GET，转义非空 key，解 data 返回同 App 线程字段', async () => {
  const calls = [];
  const attachment = { id: 3, url: '/uploads/repro.txt', file_name: 'repro.txt', file_size: 7, mime: 'text/plain' };
  const fake = async (url, init) => {
    calls.push({ url, init });
    return response({ data: {
      id: 12, thread_key: 'key &?/#', status: 'closed', device_id: 'private-install-id',
      created_at: '2026-11-21T00:00:00Z', last_user_at: '2026-11-21T01:00:00Z', last_staff_at: '2026-11-21T02:00:00Z',
      messages: [
        { id: 4, author: 'user', content: '仍然失败', created_at: '2026-11-21T01:00:00Z', attachments: [attachment] },
        { id: 5, author: 'staff', content: '请提供版本', created_at: '2026-11-21T02:00:00Z' },
      ],
    } });
  };
  await withFetch(fake, async () => {
    const thread = await readFeedback('  key &?/#  ');
    assert.equal(thread.thread_key, 'key &?/#');
    assert.equal(thread.status, 'closed');
    assert.equal(thread.id, 12);
    assert.equal(thread.last_staff_at, '2026-11-21T02:00:00Z');
    assert.equal(thread.messages[0].id, 4);
    assert.equal(thread.messages[0].author, 'user');
    assert.equal(thread.messages[0].content, '仍然失败');
    assert.equal(thread.messages[0].created_at, '2026-11-21T01:00:00Z');
    assert.deepEqual(thread.messages[0].attachments, [attachment]);
    assert.equal(thread.messages[1].author, 'staff');
    assert.deepEqual(thread.messages[1].attachments, []);
    assert.equal(thread.data, undefined);
    assert.equal(thread.device_id, undefined);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback?thread_key=key%20%26%3F%2F%23');
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('readFeedback：只认非空字符串 key，无效输入不请求平台', async () => {
  await withFetch(() => { throw new Error('不该联网'); }, async () => {
    for (const key of [undefined, null, '', '  ', 5, {}, ['key']]) {
      await assert.rejects(() => readFeedback(key), error => error.status === 400 && /需要 threadKey/.test(error.message));
    }
  });
});

test('readFeedback：平台错误保留原文与状态，非 JSON 和缺线程不伪装成功', async () => {
  await withFetch(async () => response({ error: '这条反馈不存在' }, 404), async () => {
    await assert.rejects(() => readFeedback('missing'), error => error.status === 404 && error.message === '这条反馈不存在');
  });
  await withFetch(async () => ({ status: 503, json: async () => { throw new Error('not json'); } }), async () => {
    await assert.rejects(() => readFeedback('key'), /HTTP 503/);
  });
  await withFetch(async () => response({ data: null }), async () => {
    await assert.rejects(() => readFeedback('key'), error => error.status === 502 && /没有返回线程/.test(error.message));
  });
  await withFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    await assert.rejects(() => readFeedback('key'), error => error.status === 504 && /读取超时/.test(error.message));
  });
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    await assert.rejects(() => readFeedback('key'), /network down/);
  });
});

test('面板反馈同源转发：Node 侧发 multipart，字段与插件自报逐字一致', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return response({ data: { thread_key: 'panel-key' } });
  };
  const deps = {
    readJson: async () => ({
      summary: '会话镜像\n隧道未连接，镜像未推送',
      detail: '会话镜像\n隧道未连接，镜像未推送\ntunnel_state=off',
      context: { tunnel_state: 'off', title: '会话镜像', detail: '隧道未连接，镜像未推送' },
      version: '0.5.127', deviceId: 'install-1', submissionId: 'sub-1',
    }),
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
  };
  await withFetch(fake, async () => {
    const res = {};
    await handlePanelFeedback({ ...deps, req: { method: 'POST' }, res });
    assert.equal(res.status, 200);
    assert.equal(res.body.threadKey, 'panel-key');
    assert.equal(res.body.submissionId, 'sub-1');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback');
  assert.equal(calls[0].init.method, 'POST');
  const form = calls[0].init.body;
  const fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  assert.equal(fields.content, '会话镜像\n隧道未连接，镜像未推送');
  assert.equal(fields.source, 'plugin');
  assert.equal(fields.product_slug, 'dsh-mobile');
  assert.equal(fields.component_id, 'dsh-mobile-plugin');
  assert.equal(fields.component_version, '0.5.127');
  assert.equal(fields.device_id, 'install-1');
  assert.equal(fields.submission_id, 'sub-1');
  const context = JSON.parse(fields.context);
  assert.equal(context.device_source, 'install');
  assert.equal(context.tunnel_state, 'off');
  assert.ok(!('submit_kind' in context), '必须保持插件自报形态，不能变成 AI 代发技术报告');
  assert.ok(form.get('files'), '诊断文本要作为附件发出');
});

test('面板反馈转发失败：平台错误与超时原样回给面板，不伪装成功', async () => {
  const deps = {
    readJson: async () => ({ summary: 'x', detail: 'y', version: '0.5.127' }),
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
  };
  await withFetch(async () => response({ error: '反馈只收最新版插件' }, 400), async () => {
    const res = {};
    await handlePanelFeedback({ ...deps, req: { method: 'POST' }, res });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /最新版/);
  });
  await withFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    const res = {};
    await handlePanelFeedback({ ...deps, req: { method: 'POST' }, res });
    assert.equal(res.status, 502);
    assert.match(res.body.error.message, /超时/);
  });
});

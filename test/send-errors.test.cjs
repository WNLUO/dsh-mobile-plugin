'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleSend,
  MODEL_UNAVAILABLE_ERROR,
  promptErrorObject,
} = require('../lib/mobile/sessions.js');

function request(body) {
  const req = new EventEmitter();
  req.url = '/api/mobile/v1/session/send';
  req.headers = { 'x-dsh-device': 'phone-1' };
  process.nextTick(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(value) { this.body = JSON.parse(String(value)); },
  };
}

function ctxWithPrompt(prompt) {
  return { apiProxy: { sessions: { prompt } } };
}

const payload = { sessionId: 's-1', text: 'hello', clientMessageId: 'cm-1' };

test('normalizes no-model prompt failures to a stable actionable error', () => {
  assert.deepEqual(promptErrorObject(new Error('No model is configured')), MODEL_UNAVAILABLE_ERROR);
  assert.deepEqual(promptErrorObject({ code: 'model-not-routable', message: 'provider is offline' }), MODEL_UNAVAILABLE_ERROR);
});

test('returns stable no-model error for rejected host prompts', async () => {
  const ctx = ctxWithPrompt(async () => ({ result: { ok: false, error: { code: 'model-error', message: 'No model configured for this session' } } }));
  const res = response();
  await handleSend(ctx, request(payload), res);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { ok: false, error: MODEL_UNAVAILABLE_ERROR });
});

test('normalizes thrown no-model errors instead of leaking a server failure', async () => {
  const ctx = ctxWithPrompt(async () => { throw new Error('selected model is not routable'); });
  const res = response();
  await handleSend(ctx, request(payload), res);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { ok: false, error: MODEL_UNAVAILABLE_ERROR });
});

test('requires an explicit accepted acknowledgement', async () => {
  const ctx = ctxWithPrompt(async () => ({ result: { ok: true, value: { accepted: true } } }));
  const res = response();
  await handleSend(ctx, request(payload), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, accepted: true });
});

// ── 宿主错误的 details 透传 ────────────────────────────────────────
// 移动端要靠 details.reason 把 attachment-error 翻成中文（与桌面端
// attachmentErrorText 同一契约）；旧实现只回 { code, message }，reason 被吞掉，
// 手机只能显示宿主那句英文原文。

test('keeps a plain-object details payload from the host', () => {
  assert.deepEqual(
    promptErrorObject({
      code: 'attachment-error',
      message: 'Model "deepseek-v4-flash" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    }),
    {
      code: 'attachment-error',
      message: 'Model "deepseek-v4-flash" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    },
  );
});

test('drops details that are not a plain object', () => {
  for (const details of ['nope', 7, true, null, ['x'], new Error('boom')]) {
    const normalized = promptErrorObject({ code: 'attachment-error', message: 'rejected', details });
    assert.deepEqual(normalized, { code: 'attachment-error', message: 'rejected' });
  }
});

test('keeps details for other host codes too', () => {
  assert.deepEqual(promptErrorObject({ code: 'settings-conflict', message: 'stale', details: { ns: 'ui-theme', expected: 1, actual: 2 } }).details, {
    ns: 'ui-theme',
    expected: 1,
    actual: 2,
  });
});

test('no-model normalization still wins over details', () => {
  assert.deepEqual(promptErrorObject({ code: 'model-unavailable', message: 'no model', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }), MODEL_UNAVAILABLE_ERROR);
});

test('an image send rejected by the host reaches the phone with its reason code', async () => {
  const ctx = ctxWithPrompt(async () => ({
    result: {
      ok: false,
      error: {
        code: 'attachment-error',
        message: 'Model "deepseek-v4-flash" does not support image input.',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    },
  }));
  const res = response();
  await handleSend(
    ctx,
    request({
      sessionId: 's-1',
      clientMessageId: 'cm-img',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'probe.png' },
        { type: 'text', text: 'IMG-PROBE-1' },
      ],
    }),
    res,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    ok: false,
    error: {
      code: 'attachment-error',
      message: 'Model "deepseek-v4-flash" does not support image input.',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    },
  });
});

test('source contract: errorDetails guards the spread', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/mobile/history-derive.js'), 'utf8');
  assert.ok(source.includes('function errorDetails(error)'), 'errorDetails helper');
  assert.ok(source.includes("typeof details !== 'object' || Array.isArray(details)"), 'plain-object guard');
  assert.ok(source.includes('proto !== Object.prototype && proto !== null'), 'prototype guard');
  assert.ok(source.includes('...(details ? { details } : {})'), 'details spread');
});

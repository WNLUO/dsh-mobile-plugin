'use strict';

/**
 * 会话正文图片的**引用契约**：历史 / 快照 / 流式三条路径都只下发 attachmentId，不内联 base64。
 *
 * 真机现象（2026-10-20）：进一个长会话要等好几秒、流量几十兆。根因是 `resolveEventAttachments`
 * 把每个 `{type:'image', attachment:{attachmentId}}` 块经宿主 RPC 取回字节、内联成
 * `{type:'image', mediaType, data}`，于是 `/session/messages` 一页 200 条带十几张截图时
 * 响应接近 10MB，每次进会话都要重传一遍。
 *
 * 现在默认是**引用模式**：图片条目下发 `{mediaType, name?, attachmentId}`，字节由手机端
 * 要画的时候按 attachmentId 单张去取（`/session/attachment`）。两条例外保持原样：
 *   - 块里本来就只有内联 `data`、没有 attachmentId → 照旧下发 `{mediaType, data, name?}`；
 *   - 正文里指向本机文件的 markdown 图片（`local-images.js`）预算与行为不变。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEventAttachments } = require('../lib/mobile/attachments.js');
const { deriveMessages } = require('../lib/mobile/sessions.js');

/** 一次附件 RPC 就抛的宿主：引用模式下**一次都不该被调到**。 */
function makeCtx() {
  const calls = [];
  const ctx = {
    apiProxy: {
      sessions: {
        attachment: async (request) => {
          calls.push(request);
          return { result: { ok: true, value: { data: 'BASE64BYTES', attachment: { mediaType: 'image/png' } } } };
        },
      },
    },
  };
  return { ctx, calls };
}

const imageEvent = (blocks) => ({
  seq: 7,
  time: 1_700_000_000_000,
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: blocks } },
});

test('历史图片条目带 attachmentId、不带 data（默认引用模式）', async () => {
  const { ctx, calls } = makeCtx();
  const event = imageEvent([
    { type: 'text', text: '截图如下' },
    { type: 'image', mediaType: 'image/png', name: 'shot.png', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } },
  ]);
  const [item] = deriveMessages([await resolveEventAttachments(ctx, 'sess-1', event)]);
  assert.deepEqual(item.images, [{ mediaType: 'image/png', name: 'shot.png', attachmentId: 'sha256:abc' }]);
  assert.equal(Object.hasOwn(item.images[0], 'data'), false, '引用条目不许带 data');
  assert.equal(calls.length, 0, '引用模式不该发宿主 attachment RPC');
});

test('条目带上宿主附件里的原始宽高（手机靠它第一帧就占好位置）', async () => {
  const { ctx } = makeCtx();
  const event = imageEvent([
    {
      type: 'image',
      mediaType: 'image/png',
      attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 2165, height: 1937 },
    },
  ]);
  const [item] = deriveMessages([await resolveEventAttachments(ctx, 'sess-1', event)]);
  assert.deepEqual(item.images, [{ mediaType: 'image/png', width: 2165, height: 1937, attachmentId: 'sha256:abc' }]);
});

test('宽高非法（缺失 / 非正数）时不出这两格，别拿脏数据当已知尺寸', async () => {
  const { ctx } = makeCtx();
  const event = imageEvent([
    { type: 'image', mediaType: 'image/png', attachment: { attachmentId: 'a', width: 0, height: '1200' } },
  ]);
  const [item] = deriveMessages([await resolveEventAttachments(ctx, 'sess-1', event)]);
  assert.deepEqual(item.images, [{ mediaType: 'image/png', attachmentId: 'a' }]);
});

test('块里只有内联 data、没有 attachmentId：照旧下发 data（兜底不能删）', async () => {
  const { ctx } = makeCtx();
  const event = imageEvent([
    { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQ', name: 'inline.jpg' },
  ]);
  const [item] = deriveMessages([await resolveEventAttachments(ctx, 'sess-1', event)]);
  assert.deepEqual(item.images, [{ mediaType: 'image/jpeg', name: 'inline.jpg', data: '/9j/4AAQ' }]);
});

test('嵌套在 message / inserted / chunk.block 里的图片同样是引用', async () => {
  const { ctx, calls } = makeCtx();
  const image = { type: 'image', mediaType: 'image/webp', attachment: { attachmentId: 'sha256:nested' } };
  const event = {
    seq: 9,
    type: 'user/message',
    data: {
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }, image] },
      inserted: [{ content: [image] }],
      chunk: { block: image },
    },
  };
  const resolved = await resolveEventAttachments(ctx, 'sess-1', event);
  assert.deepEqual(resolved.data.message.content[1].attachment, { attachmentId: 'sha256:nested' });
  assert.equal(resolved.data.message.content[1].data, undefined);
  assert.deepEqual(resolved.data.inserted[0].content[0].attachment, { attachmentId: 'sha256:nested' });
  assert.equal(resolved.data.chunk.block.data, undefined);
  assert.equal(calls.length, 0);
});

test('取字节模式仍在（显式 referencesOnly:false 才发 RPC）', async () => {
  const { ctx, calls } = makeCtx();
  const event = imageEvent([
    { type: 'image', mediaType: 'image/png', attachment: { attachmentId: 'sha256:abc' } },
  ]);
  const [item] = deriveMessages([await resolveEventAttachments(ctx, 'sess-1', event, { referencesOnly: false })]);
  assert.equal(calls.length, 1);
  assert.deepEqual(item.images, [{ mediaType: 'image/png', data: 'BASE64BYTES' }]);
});

test('源码契约：快照与流式四条调用点都显式走引用模式', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['session-snapshot.js', 'stream.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', file), 'utf8');
    const calls = [...source.matchAll(/resolveEventAttachments\([^)]*\)/g)].map((m) => m[0]);
    assert.ok(calls.length >= 1, `${file} 里应当有 resolveEventAttachments 调用点`);
    for (const call of calls) {
      assert.match(call, /referencesOnly: true/, `${file} 的调用点必须显式走引用模式：${call}`);
    }
  }
});

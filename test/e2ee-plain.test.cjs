'use strict';

/**
 * 明文压缩的两端口径（信封层的 `z`）。
 *
 * 这一层做的是「AEAD 之前先 gzip」：密文没有可压缩的余量，同一份 58KB 消息 JSON
 * 明文 gzip 到 16KB、密文再 gzip 还有 77KB，所以压缩只能发生在封之前。
 *
 * 钉四件事：
 *  1. **两端真实现互通**：宿主 `compressPlain` 压、App `decompressPlain` 解，反过来也成立；
 *  2. **不声明就不压**：老 App 不带 `x-dsh-accept-enc` 时信封里不许出现 `z`，形状与原来一致；
 *  3. **小包不压、压了不更小也不压**：22 字节的 `{ok:true,items:[]}` gzip 后反而更大；
 *  4. **认不出的 `z` 要报错**，不能猜（猜错的表现是「解出一段乱码再 JSON.parse 失败」，
 *     错误码会指向业务而不是信封）。
 *
 * 跑法：`node dsh-mobile-plugin/test/e2ee-plain.test.cjs`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..', '..');
const hostPlain = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee-plain.js'));
const e2ee = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee.js'));
const { sealResponse } = require(path.join(root, 'dsh-mobile-plugin', 'lib', 'shared', 'e2ee-request.js'));

// 两端互通的两条用例要拿 App 侧的真实现来对账，所以得在主仓里跑（路径跨到 `app/`）。
// 单独检出插件仓库时（tag 流水线、把插件目录拷出去跑）没有那份源码：那两条带理由 skip，
// 宿主自己那几条照旧跑 —— 不跳过就是 `require` 当场抛错，整个文件判红。
let loadTsFromApp = null;
try {
  ({ loadTsFromApp } = require(path.join(root, 'app', 'scripts', 'load-ts.js')));
} catch {
  // 主仓的 app/ 不在场
}
const SKIP_NO_APP = loadTsFromApp ? false : '主仓的 app/ 不在场（单独检出插件仓库时）';
const appPlain = loadTsFromApp ? loadTsFromApp('src/services/viewmodels/e2ee-plain') : null;

const DEVICE_KEY = Buffer.alloc(32, 0x22);
const KEY_ID = '0011223344556677';
const keys = e2ee.deriveSessionKeys(DEVICE_KEY);
const ACCEPT = 'g';

/** 一段像真实消息 JSON 的载荷：中英混排、够长、可压。 */
const samplePayload = () => ({
  ok: true,
  items: Array.from({ length: 40 }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${i} 条消息：这是一段用来验证压缩的中文正文，里面还有 trailing whitespace      `.repeat(3),
  })),
});

test('宿主压的 App 能解，App 压的宿主能解（字节层面）', { skip: SKIP_NO_APP }, () => {
  const raw = Buffer.from(JSON.stringify(samplePayload()), 'utf8');
  const { payload: gz, z } = hostPlain.compressPlain(raw, ACCEPT);
  assert.equal(z, 'g');
  assert.ok(gz.length < raw.length, `压完应该更小：${gz.length} vs ${raw.length}`);

  const backToHost = Buffer.from(appPlain.decompressPlain(new Uint8Array(gz), z));
  assert.deepEqual(backToHost, raw, 'App 解出来的必须与宿主压之前逐字节一致');

  const { payload: gz2, z: z2 } = appPlain.compressPlain(new Uint8Array(raw));
  assert.equal(z2, 'g');
  assert.deepEqual(hostPlain.decompressPlain(Buffer.from(gz2), z2), raw, '宿主解出来的也必须逐字节一致');
});

test('不声明接受压缩时不压，信封里连 z 字段都不出现', () => {
  const raw = Buffer.from(JSON.stringify(samplePayload()), 'utf8');
  const { payload, z } = hostPlain.compressPlain(raw, undefined);
  assert.equal(z, undefined, '没声明就不许压');
  assert.deepEqual(payload, raw, '原样返回，一个字节都不改');

  // 端口到端：老 App 发的请求没有这个头，信封形状要与老版本逐字段一致。
  const ts = Date.now();
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const body = sealResponse({ method: 'GET', url: '/api/mobile/v1/session/messages' }, { statusCode: 200 }, keys, { ts, nonce: reqNonce }, samplePayload());
  assert.equal(body.z, undefined, '老客户端拿到的信封里不许有 z');
  assert.deepEqual(Object.keys(body).sort(), ['c', 'n', 'v'], `信封只该有这三个字段，实际 ${Object.keys(body)}`);
});

test('声明之后信封带 z，且线上字节明显更小', () => {
  const ts = Date.now();
  const reqNonce = e2ee.b64url(Buffer.alloc(12, 0x44));
  const payload = samplePayload();
  const req = { method: 'GET', url: '/api/mobile/v1/session/messages', headers: { 'x-dsh-accept-enc': ACCEPT } };
  const withZ = sealResponse(req, { statusCode: 200 }, keys, { ts, nonce: reqNonce }, payload);
  assert.equal(withZ.z, 'g', '声明了就该带 z');
  const plainBody = sealResponse({ method: 'GET', url: '/api/mobile/v1/session/messages' }, { statusCode: 200 }, keys, { ts, nonce: reqNonce }, payload);
  assert.ok(
    JSON.stringify(withZ).length < JSON.stringify(plainBody).length * 0.5,
    `压缩后的线上字节应不到一半：${JSON.stringify(withZ).length} vs ${JSON.stringify(plainBody).length}`,
  );
});

test('小响应不压：22 字节的 JSON gzip 之后反而更大', () => {
  const tiny = Buffer.from(JSON.stringify({ ok: true, items: [] }), 'utf8');
  const { payload, z } = hostPlain.compressPlain(tiny, ACCEPT);
  assert.equal(z, undefined, '低于阈值不压');
  assert.deepEqual(payload, tiny);
  // 顺便钉住「为什么」：压了确实更大，不是随手定的阈值。
  assert.ok(zlib.gzipSync(tiny).length > tiny.length);
});

test('已压过的字节压完不更小就不压（图片那种）', () => {
  // 用一段 gzip 过的随机字节冒充「已经压好的内容」。
  const incompressible = zlib.gzipSync(Buffer.alloc(64 * 1024, 7));
  const { z } = hostPlain.compressPlain(incompressible, ACCEPT);
  assert.equal(z, undefined, '压完不比原来小就不该压');
});

test('认不出的 z 一律报错，两端都是', { skip: SKIP_NO_APP }, () => {
  const bytes = Buffer.from('{}', 'utf8');
  assert.throws(() => hostPlain.decompressPlain(bytes, 'br'), /unknown plain compression/);
  assert.throws(() => appPlain.decompressPlain(new Uint8Array(bytes), 'br'), /unknown plain compression/);
  // 没有 z 的（老信封）要原样通过，两端都不许把它当成压过的。
  assert.deepEqual(hostPlain.decompressPlain(bytes, undefined), bytes);
  assert.deepEqual(Buffer.from(appPlain.decompressPlain(new Uint8Array(bytes), undefined)), bytes);
});

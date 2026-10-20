'use strict';

/**
 * 回归：手机侧的 JSON 响应没有压缩。
 *
 * 现场：手机每冷启动一次、每开一条会话，都要把列表 / 工作区 / 历史消息 / 统计这几份
 * JSON 原样拉一遍，而这些响应在中转隧道与公网两条腿上都按字节算。安卓 OkHttp 与 iOS
 * NSURLSession 本来就会声明 gzip 并自动解压，缺的只是服务端那一半。
 *
 * 这里钉住三件事：
 *  - 够大、且客户端声明了 gzip → 压缩，解压后与原文逐字节相同；
 *  - 太小 / 客户端没声明 → 发明文（绝不能赌客户端会解压）；
 *  - 中转和局域网的两条「读本地快照直接回」的捷径也走同一份实现（它们才是最大的那几份）。
 *
 * 运行：node --test test/json-gzip.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { sendJson, encodeJsonBody, JSON_GZIP_MIN_BYTES } = require('../lib/shared/http-util.js');

function response(acceptEncoding) {
  return {
    req: { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} },
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

const bigBody = () => ({ ok: true, items: Array.from({ length: 200 }, (_, i) => ({ sessionId: `s-${i}`, title: '会话标题'.repeat(4) })) });

test('客户端声明 gzip 且响应够大时压缩，解压后与原文一致', () => {
  const res = response('gzip, deflate, br');
  const body = bigBody();
  sendJson(res, 200, body);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip', '够大的 JSON 必须压');
  assert.equal(res.headers.vary, 'accept-encoding', '压缩与否取决于请求头，必须声明 vary（前面还有 CDN）');
  assert.ok(res.body.length < Buffer.byteLength(JSON.stringify(body)) / 2, '压完应当至少小一半');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), body);
});

test('客户端没声明 gzip 时发原文', () => {
  const res = response('');
  sendJson(res, 200, bigBody());
  assert.equal(res.headers['content-encoding'], undefined, '没声明就不能压：赌客户端会解压，赌输就是乱码');
  assert.ok(Array.isArray(JSON.parse(res.body.toString('utf8')).items));
});

test('小响应不压', () => {
  const raw = Buffer.from(JSON.stringify({ ok: true }));
  assert.ok(raw.length < JSON_GZIP_MIN_BYTES);
  const encoded = encodeJsonBody(raw, 'gzip');
  assert.equal(encoded.gzip, false, '压小响应的头部与 CPU 换不回字节');
  assert.deepEqual(encoded.body, raw);
});

test('body 为 undefined 时照旧发空，不抛', () => {
  const res = response('gzip');
  assert.doesNotThrow(() => sendJson(res, 204, undefined));
  assert.equal(res.status, 204);
  assert.equal(res.body.length, 0);
});

test('两条快照捷径都走同一份 JSON 压缩实现', () => {
  const root = path.join(__dirname, '..', 'lib', 'relay');
  for (const file of ['tunnel.js', 'lan-proxy.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /encodeJsonBody\(/, `${file} 的快照捷径没接上统一的 JSON 压缩`);
    assert.match(source, /'content-encoding': 'gzip'/, `${file} 没把压缩后的响应标出去`);
  }
});

test('隧道不再声明从没协商成功的 permessage-deflate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'tunnel.js'), 'utf8');
  assert.doesNotMatch(source, /perMessageDeflate/, '中转是 tungstenite 手写的 101，从不回压缩扩展；留着只会让人以为隧道压过');
});

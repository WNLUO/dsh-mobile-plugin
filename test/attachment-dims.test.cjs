'use strict';
// 附件图的「只要宽高」那一档（`POST /api/mobile/v1/session/attachment` 带 `dims: true`）。
//
// 存在的理由：老会话里宿主没存附件宽高，插件下发时带不上，手机只能先按兜底盒占位、等字节到了
// 再变高 —— 行一变高，上面那一截就被推走。这一档让手机在挂载那一帧就按真比例排好。
//
// 钉三条：只回两格数字（**字节一个都不许出**）、量不出来要如实 404、不带 dims 时行为不变。
const test = require('node:test');
const assert = require('node:assert/strict');

/** 造一张只有文件头、尺寸字段是真的假 PNG。 */
function fakePng(width = 3, height = 2) {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89;
  buf.write('PNG', 1, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 把宿主的 `callSessions` 换成假实现（必须在 require session-send 之前打）。 */
const rpc = require('../lib/mobile/rpc.js');
let payload = null;
rpc.callSessions = async () => ({
  result: { ok: true, value: payload },
});
const { handleSessionAttachment } = require('../lib/mobile/session-send.js');

async function call(body) {
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = text.toString(); },
  };
  await handleSessionAttachment({}, { body }, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('dims: true 只回宽高，字节一个都不出', async () => {
  payload = { data: fakePng(640, 480).toString('base64'), attachment: { mediaType: 'image/png', name: 'a.png' } };
  const { status, body } = await call({ sessionId: 's1', attachmentId: 'a1', dims: true });
  assert.equal(status, 200);
  assert.deepEqual({ width: body.width, height: body.height }, { width: 640, height: 480 });
  assert.equal(body.ok, true);
  assert.equal(body.data, undefined, '这一档绝不把整张图的 base64 发给手机');
});

test('量不出宽高（不是位图）如实回 404', async () => {
  payload = { data: Buffer.from('#!/bin/sh\n').toString('base64'), attachment: { mediaType: 'image/png' } };
  const { status, body } = await call({ sessionId: 's1', attachmentId: 'a1', dims: true });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'no-dims');
});

test('不带 dims 时照旧回整张字节', async () => {
  payload = { data: fakePng(8, 6).toString('base64'), attachment: { mediaType: 'image/png', name: 'b.png' } };
  const { status, body } = await call({ sessionId: 's1', attachmentId: 'a1' });
  assert.equal(status, 200);
  assert.equal(body.data, payload.data);
  assert.equal(body.name, 'b.png');
  assert.equal(body.width, undefined, '取字节那一档不夹带宽高，形状别漂');
});

// ── `raw: true`：字节走分块信封，base64 不上线路 ────────────────────────────
//
// 手机那边落盘的是密文，靠原生解盘口边解边写（一张两兆的截图原本要摊着两兆七的字符串
// 加一份解析副本）。这里按 `session-file` 那套口径解回来，证明两边逐字节对得上。

const e2ee = require('../lib/shared/e2ee');
const DOWN_KEY = Buffer.alloc(32, 5);
const REQUEST_NONCE = e2ee.b64url(Buffer.alloc(12, 9));

/** 收一个分块信封响应（真 res 的 write/end 语义）。 */
function collectRes() {
  const res = {
    headers: null,
    statusCode: 0,
    body: Buffer.alloc(0),
    ended: false,
    destroyed: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.ended = true; },
    destroy() { this.destroyed = true; },
    on() {},
  };
  return res;
}

function openChunks(payload, path) {
  const parts = [];
  let cursor = 0;
  let seq = 0;
  while (cursor + 4 <= payload.length) {
    const cipherLen = payload.readUInt32BE(cursor);
    cursor += 4;
    const block = payload.subarray(cursor, cursor + e2ee.NONCE_BYTES + cipherLen);
    cursor += e2ee.NONCE_BYTES + cipherLen;
    seq += 1;
    parts.push(e2ee.open(DOWN_KEY, block, e2ee.fileAad(path, REQUEST_NONCE, seq)));
  }
  assert.equal(cursor, payload.length);
  return Buffer.concat(parts);
}

test('raw: true 回分块信封，明文 PNG 不在线上', async () => {
  const png = fakePng(12, 7);
  payload = { data: png.toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = collectRes();
  await handleSessionAttachment({}, {
    body: { sessionId: 's1', attachmentId: 'a1', raw: true },
    url: '/api/mobile/v1/session/attachment',
    __dshE2ee: { keys: { down: DOWN_KEY }, req: { ts: 1, nonce: REQUEST_NONCE } },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/x-dsh-e2ee-chunks');
  assert.equal(res.headers['x-dsh-content-type'], 'image/png');
  assert.equal(res.headers['content-length'], undefined, '边收边加密的流不给长度');
  assert.equal(res.ended, true);
  assert.notDeepEqual(res.body.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), '明文 PNG 头不许出现在线上');
  assert.deepEqual(openChunks(res.body, '/api/mobile/v1/session/attachment'), png);
});

test('raw: true 但请求没封包 → 400，不降级成明文', async () => {
  payload = { data: fakePng().toString('base64'), attachment: { mediaType: 'image/png' } };
  const res = {
    statusCode: 200,
    body: '',
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = text.toString(); },
  };
  await handleSessionAttachment({}, { body: { sessionId: 's1', attachmentId: 'a1', raw: true } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, 'e2ee-required');
});

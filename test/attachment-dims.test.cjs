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

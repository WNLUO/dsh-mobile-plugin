'use strict';

/**
 * 移动路由里的真实流量记账（`lib/routes/mobile-api.js` 的 `withTraffic`）：
 * 请求体字节记下行、响应字节记上行。用假的 req/res 直接驱动。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { withTraffic } = require('../lib/routes/mobile-api.js');
const traffic = require('../lib/relay/traffic-stats.cjs');

function fakeReq() {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/mobile/v1/echo';
  req.headers = {};
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.chunks = [];
  res.statusCode = 200;
  res.setHeader = () => res;
  res.writeHead = (status) => { res.statusCode = Number(status) || 200; res.headersSent = true; return res };
  res.write = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); return true };
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(chunk); res.emit('finish'); return res };
  return res;
}

test('请求体字节记下行、响应字节记上行', async () => {
  const before = traffic.snapshot();
  const handler = withTraffic(async (_req, res) => { res.end('hello, phone') });
  const req = fakeReq();
  const res = fakeRes();
  const running = handler(req, res);
  req.emit('data', Buffer.alloc(30));
  req.emit('data', Buffer.alloc(20));
  await running;
  const after = traffic.snapshot();
  assert.equal(after.receivedBytes - before.receivedBytes, 50, '手机发来的 50 字节记下行');
  assert.equal(after.sentBytes - before.sentBytes, 'hello, phone'.length, '回给手机的字节记上行');
  assert.equal(res.chunks.join(''), 'hello, phone', '响应原样转发，不被计数改动');
});

test('字符串响应也按 UTF-8 字节数记上行', async () => {
  const before = traffic.snapshot();
  const handler = withTraffic(async (_req, res) => { res.write('上行'); res.end('完成') });
  await handler(fakeReq(), fakeRes());
  const after = traffic.snapshot();
  assert.equal(after.sentBytes - before.sentBytes, Buffer.byteLength('上行完成'), '中文按字节数算');
});

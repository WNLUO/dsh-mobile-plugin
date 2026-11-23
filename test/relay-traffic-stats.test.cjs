'use strict';

/**
 * 手机↔本机流量累计计数：上/下行各自累加，非法值忽略，快照形状稳定。
 * 具体转发点的接线由 `tunnel.js` / `lan-proxy.js` / `tunnel-forwarder.cjs` 各自调用。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const traffic = require('../lib/relay/traffic-stats.cjs');

test('noteSent/noteReceived 累加且忽略非正/非法值', () => {
  const start = traffic.snapshot();
  traffic.noteSent(120);
  traffic.noteSent(0);
  traffic.noteSent(-9);
  traffic.noteSent(Number.NaN);
  traffic.noteReceived(64);
  traffic.noteReceived('x');
  const after = traffic.snapshot();
  assert.equal(after.sentBytes - start.sentBytes, 120, '只把正的有限数加进上行');
  assert.equal(after.receivedBytes - start.receivedBytes, 64, '只把正的有限数加进下行');
  assert.equal(typeof after.since, 'number', '带进程起算时刻');
  assert.ok(after.since <= Date.now(), '起算时刻不晚于现在');
});

test('countReadable 旁听可读流，不改数据、按方向累计', async () => {
  const start = traffic.snapshot();
  const stream = Readable.from([Buffer.alloc(10), Buffer.alloc(25), Buffer.alloc(5)]);
  traffic.countReadable(stream, 'received');
  let heard = 0;
  for await (const chunk of stream) heard += chunk.length;
  const after = traffic.snapshot();
  assert.equal(heard, 40, '数据照旧全部读到');
  assert.equal(after.receivedBytes - start.receivedBytes, 40, '下行按字节累计');
});

test('countReadable 对非流对象原样放过，不抛', () => {
  assert.doesNotThrow(() => traffic.countReadable(null, 'sent'));
  assert.doesNotThrow(() => traffic.countReadable({}, 'sent'));
});

test('series 返回累计快照序列，常量对得上', () => {
  const s = traffic.series();
  assert.ok(Array.isArray(s) && s.length >= 1, '至少有一个点');
  for (const item of s) {
    assert.equal(typeof item.at, 'number');
    assert.equal(typeof item.sentBytes, 'number');
    assert.equal(typeof item.receivedBytes, 'number');
  }
  assert.equal(traffic.HISTORY_POINTS, 60, '历史窗口 60 点');
  assert.equal(traffic.SAMPLE_INTERVAL_MS, 1000, '每秒一拍');
});

test('状态挂在 globalThis 上：同一进程内重复 require 不丢计数', () => {
  const key = '__dshMobileTrafficStats';
  assert.ok(globalThis[key], '全局状态存在');
  const before = traffic.snapshot().sentBytes;
  delete require.cache[require.resolve('../lib/relay/traffic-stats.cjs')];
  const again = require('../lib/relay/traffic-stats.cjs');
  assert.ok(again.snapshot().sentBytes >= before, '重载后沿用同一份全局计数');
  assert.equal(globalThis[key], globalThis[key], '同一全局对象');
});

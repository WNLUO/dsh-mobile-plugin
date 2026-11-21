// 空心跳仅使用有界额外队列预算，普通帧仍受原水位约束。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { WebSocket } = require('ws');
const { RelayTunnel } = require('../lib/relay/tunnel');
const { T, encodeFrame } = require('../lib/relay/protocol');
const MAX = 16 * 1024 * 1024;
const ALLOWANCE = 1024;
function fixture(bufferedAmount, Tunnel = RelayTunnel) {
  const frames = [];
  let terminated = 0;
  const tunnel = new Tunnel({ relayUrl: 'wss://relay.invalid/tunnel', instanceId: 'heartbeat', upstream: 'http://127.0.0.1:1' });
  tunnel.ws = { readyState: WebSocket.OPEN, bufferedAmount,
    send(frame) { frames.push(frame); this.bufferedAmount += frame.length; }, terminate() { terminated++; } };
  return { tunnel, frames, terminated: () => terminated };
}
function assertHeartbeatHeadroom(Tunnel = RelayTunnel) {
  const f = fixture(MAX, Tunnel);
  assert.equal(f.tunnel.sendFrame(T.ping, 0, Buffer.alloc(0)), true);
  assert.equal(f.tunnel.sendFrame(T.pong, 0, Buffer.alloc(0)), true);
  assert.equal(f.frames.length, 2);
  assert.equal(f.tunnel.sendFrame(T.httpChunk, 1, Buffer.from('data')), false);
  assert.equal(f.tunnel.sendFrame(T.ping, 0, Buffer.from('not-empty')), false);
  assert.equal(f.tunnel.sendFrame(T.pong, 1, Buffer.alloc(0)), false, '只有id0空心跳可用余量');
  assert.equal(f.terminated(), 0);
}
test('数据达到16MiB时空心跳仍可排入同一队列', () => assertHeartbeatHeadroom());
test('心跳余量精确覆盖最终编码字节，耗尽后拒绝且不关闭共享隧道', () => {
  const size = encodeFrame(T.ping, 0, Buffer.alloc(0)).length;
  const f = fixture(MAX + ALLOWANCE - size);
  assert.equal(f.tunnel.sendFrame(T.ping, 0, Buffer.alloc(0)), true);
  assert.equal(f.tunnel.ws.bufferedAmount, MAX + ALLOWANCE);
  assert.equal(f.tunnel.sendFrame(T.pong, 0, Buffer.alloc(0)), false);
  assert.equal(f.terminated(), 0);
  f.tunnel.ws.readyState = WebSocket.CLOSED;
  assert.equal(f.tunnel.sendFrame(T.ping, 0, Buffer.alloc(0)), false);
});
test('变异：删除心跳余量会被16MiB边界行为拒绝', () => {
  const file = path.join(__dirname, '../lib/relay/tunnel.js');
  const source = fs.readFileSync(file, 'utf8');
  const marker = 'emptyHeartbeat ? HEARTBEAT_BUFFER_ALLOWANCE_BYTES : 0';
  assert.ok(source.includes(marker));
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source.replace(marker, '0'))(createRequire(file), loaded, loaded.exports);
  assert.throws(() => assertHeartbeatHeadroom(loaded.exports.RelayTunnel), assert.AssertionError);
});

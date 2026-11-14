// 密文字节必须拒绝重放、篡改、反射及跨连接复用。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/remote/crypto.cjs');

function connection() {
  return c.connectionKeys(c.random(), { instanceId: 'a', keyId: '0123456789abcdef', clientNonce: c.random(), serverNonce: c.random(), credential: 'secret' });
}

test('计数和AEAD拒绝重放、跳号、篡改以及方向反射', () => {
  const keys = connection();
  const client = c.codecs(keys, false);
  const server = c.codecs(keys, true);
  const frame = client.send.seal(0, Buffer.from('private bytes'));
  assert.equal(frame.includes(Buffer.from('private bytes')), false);
  assert.equal(server.receive.open(frame).data.toString(), 'private bytes');
  assert.throws(() => server.receive.open(frame), /Replayed/);
  const next = client.send.seal(0, Buffer.from('next'));
  const corrupted = Buffer.from(next);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => server.receive.open(corrupted));
  assert.equal(server.receive.open(next).data.toString(), 'next', '坏帧不能推进接收计数');
  assert.throws(() => client.receive.open(frame));
  assert.throws(() => c.codecs(connection(), true).receive.open(frame));
});

test('双方nonce、实例、凭据都参与逐连接派生', () => {
  const key = c.random();
  const context = { instanceId: 'a', keyId: '0123456789abcdef', clientNonce: c.random(), serverNonce: c.random(), credential: 'credential-a' };
  const first = c.connectionKeys(key, context);
  for (const change of [{ instanceId: 'b' }, { clientNonce: c.random() }, { serverNonce: c.random() }, { credential: 'credential-b' }]) {
    assert.notDeepEqual(c.connectionKeys(key, { ...context, ...change }).up, first.up);
  }
  assert.notDeepEqual(first.up, first.down);
});

test('邀请请求和响应使用不同方向密钥，部署前缀完整保留', () => {
  const keys = c.pairKeys(c.random(), 'a', 'ticket');
  const sealed = c.sealJson(keys.up, { key: 'secret' }, 'aad');
  assert.deepEqual(c.openJson(keys.up, sealed, 'aad'), { key: 'secret' });
  assert.throws(() => c.openJson(keys.down, sealed, 'aad'));
  assert.equal(c.endpoint({ url: 'https://relay.example/deploy/' }, '/api/mobile/v1/remote-computers/tunnel', true).href, 'wss://relay.example/deploy/api/mobile/v1/remote-computers/tunnel');
});

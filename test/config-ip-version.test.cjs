'use strict';
// 协议族策略进配置 schema 与投影：默认 auto、非法值被 schema 拒绝、缺失归一为 auto。
const test = require('node:test');
const assert = require('node:assert/strict');
const { RemoteControlSettingsSchema, configOf } = require('../lib/relay/config-store.js');

test('ipVersionPolicy 默认 auto，三档可选，非法值被 schema 拒绝', () => {
  assert.equal(RemoteControlSettingsSchema({}).ipVersionPolicy, 'auto');
  for (const ok of ['auto', 'ipv4-first', 'ipv4-only']) {
    assert.equal(RemoteControlSettingsSchema({ ipVersionPolicy: ok }).ipVersionPolicy, ok);
  }
  assert.throws(() => RemoteControlSettingsSchema({ ipVersionPolicy: 'bogus' }));
});

test('configOf 投影缺省/非法值归一为 auto', () => {
  assert.equal(configOf({}).ipVersionPolicy, 'auto');
  assert.equal(configOf({ ipVersionPolicy: 'ipv4-only' }).ipVersionPolicy, 'ipv4-only');
  assert.equal(configOf({ ipVersionPolicy: 'nonsense' }).ipVersionPolicy, 'auto');
});

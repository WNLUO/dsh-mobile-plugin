'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { controlAddresses, controlWsUrl } = require('../lib/relay/control.js');

test('上报全部中转地址（含自建），去重、保留首次出现', () => {
  const state = {
    lanEnabled: false,
    relayUrl: 'https://public.example',
    relayUrls: ['https://public.example', 'https://public.example', 'https://self.example'],
  };
  assert.deepEqual(controlAddresses(state, 0), [
    { kind: 'relay', url: 'https://public.example' },
    { kind: 'relay', url: 'https://self.example' },
  ]);
});

test('端口拿不到（0）时不带局域网候选，只留中转', () => {
  const state = { lanEnabled: true, relayUrl: 'https://a.example', relayUrls: ['https://a.example'] };
  assert.deepEqual(controlAddresses(state, 0), [{ kind: 'relay', url: 'https://a.example' }]);
});

test('局域网关掉时也不带局域网/IPv6', () => {
  const state = { lanEnabled: false, relayUrl: 'https://a.example', relayUrls: ['https://a.example'] };
  assert.deepEqual(controlAddresses(state, 19999), [{ kind: 'relay', url: 'https://a.example' }]);
});

test('wss 地址由 http/https 推出来', () => {
  assert.equal(controlWsUrl('https://x.example/findme'), 'wss://x.example/findme');
  assert.equal(controlWsUrl('http://127.0.0.1:8787/findme'), 'ws://127.0.0.1:8787/findme');
});

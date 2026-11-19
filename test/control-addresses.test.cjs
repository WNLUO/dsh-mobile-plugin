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

test('TCP 直连目标也上报（配了 TCP 会停公用中转，这时总控是手机拿到它的唯一途径）', () => {
  // 这与现实一致的组合：配了 TCP 直连 → 公用中转被停 → 局域网关掉 → 只剩这一条能连。
  // 漏报它，总控这条兜底就永远连不上。
  const state = { lanEnabled: false, relayUrls: [], manualTcpUrl: '103.40.14.14:51543' };
  assert.deepEqual(controlAddresses(state, 0), [{ kind: 'tcp', url: '103.40.14.14:51543' }]);
  // 带方括号的 IPv6 TCP 目标原样保留（`tcpDirectTarget` 同一口径）。
  assert.deepEqual(
    controlAddresses({ lanEnabled: false, relayUrls: [], manualTcpUrl: '[240e::1]:51543' }, 0),
    [{ kind: 'tcp', url: '[240e::1]:51543' }],
  );
});

test('TCP 目标不合法时不上报（别把一句不能用的值塞给总控）', () => {
  const state = { lanEnabled: false, relayUrls: [], manualTcpUrl: 'not-a-target' };
  assert.deepEqual(controlAddresses(state, 0), []);
  assert.deepEqual(controlAddresses({ lanEnabled: false, relayUrls: [], manualTcpUrl: '10.0.0.1' }, 0), []);
});


test('wss 地址由 http/https 推出来', () => {
  assert.equal(controlWsUrl('https://x.example/findme'), 'wss://x.example/findme');
  assert.equal(controlWsUrl('http://127.0.0.1:8787/findme'), 'ws://127.0.0.1:8787/findme');
});

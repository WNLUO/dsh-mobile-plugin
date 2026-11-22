// 远程桌面的候选里要有插件上报的第三方线路，和手机走同一批。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routesOf } = require('../lib/remote/host-control.cjs');

const bare = { relayUrl: '', relayUrls: [], manualTcpUrl: '' };
const routes = (state) => routesOf({ state: { ...bare, ...state }, lanPortInUse: () => 0, lanAvailable: () => false });

test('没有线路时远程候选不变', () => {
  assert.deepEqual(routes({}), []);
});

test('ZeroNews 与接入方线路都进远程候选，tcp 目标补成 URL', () => {
  const list = routes({
    zeroNewsUrl: 'https://abc.takin.cc/',
    customRoutes: [
      { url: 'https://other.example.com', name: 'B', transport: 'http' },
      { url: 'host.example:9000', name: 'C', transport: 'tcp' },
      { url: '', name: 'bad', transport: 'http' },
    ],
  });
  const custom = list.filter((row) => row.channel === 'custom');
  assert.deepEqual(custom.map((row) => row.url), [
    'https://abc.takin.cc',
    'https://other.example.com',
    'http://host.example:9000',
  ]);
  assert(custom.every((row) => row.url.startsWith('http')), '远程侧只收可解析的 http(s) 地址');
});

test('坏地址与重复地址被挡掉', () => {
  const list = routes({
    zeroNewsUrl: 'https://dup.takin.cc',
    customRoutes: [
      { url: 'https://dup.takin.cc', transport: 'http' },
      { url: 'not a url', transport: 'http' },
    ],
  });
  const custom = list.filter((row) => row.channel === 'custom');
  assert.deepEqual(custom.map((row) => row.url), ['https://dup.takin.cc']);
});

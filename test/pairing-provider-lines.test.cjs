// 配对二维码带上服务商线路：以后加服务商不用再改二维码（与心跳 / 总控同源）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { providerLinesOf } = require('../lib/relay/provider-lines.cjs');
const { pairingPayload } = require('../lib/relay/pairing-payload.cjs');

const baseState = (extra = {}) => ({
  name: 'host',
  instanceId: 'a0c64d5c',
  pairingCode: '123456',
  pairingTicket: 'x'.repeat(43),
  relayUrl: '',
  lanEnabled: false,
  lanPort: 18787,
  ...extra,
});

test('providerLinesOf 把各家服务商折成同一份（http / tcp），空与重复丢掉', () => {
  const lines = providerLinesOf({
    zeroNewsUrl: 'https://zero.example.com/',
    jdxbUrl: 'nb.nblink.cc:15565',
    frpUrl: 'https://frp.example.com',
    customRoutes: [
      { url: 'https://zero.example.com', name: '重复', transport: 'http' },
      { url: 'host.example:9000', name: '自定义', transport: 'tcp' },
      { url: '   ', name: '空', transport: 'http' },
    ],
  });
  assert.deepEqual(lines, [
    { url: 'https://zero.example.com', name: 'ZeroNews', transport: 'http' },
    { url: 'nb.nblink.cc:15565', name: '节点小宝', transport: 'tcp' },
    { url: 'https://frp.example.com', name: 'FRP', transport: 'http' },
    { url: 'host.example:9000', name: '自定义', transport: 'tcp' },
  ]);
});

test('没有服务商时二维码不多带 routes（老行为不回归）', () => {
  const { payload } = pairingPayload(baseState(), 18787);
  assert.equal(payload.routes, undefined);
});

test('服务商线路进二维码：每条带 url / transport / name', () => {
  const { payload } = pairingPayload(baseState({
    zeroNewsUrl: 'https://zero.example.com',
    customRoutes: [{ url: 'host.example:9000', name: '自定义', transport: 'tcp' }],
    cloudflareUrl: 'https://cf.example.com',
  }), 18787);
  assert.ok(Array.isArray(payload.routes), '服务商线路要进 routes 一栏');
  assert.deepEqual(payload.routes.map((row) => `${row.transport}:${row.url}`), [
    'http:https://zero.example.com',
    'tcp:host.example:9000',
    'http:https://cf.example.com',
  ], '顺序即配置顺序，Cloudflare 补在最后');
  assert.equal(payload.routes[2].name, 'Cloudflare');
});

test('只有 Cloudflare 时也只靠它就能配对（码里带得动）', () => {
  const { payload } = pairingPayload(baseState({ cloudflareUrl: 'https://cf.example.com' }), 18787);
  assert.deepEqual(payload.routes, [{ url: 'https://cf.example.com', transport: 'http', name: 'Cloudflare' }]);
});

test('服务商线路条数封顶（码太密扫不出来）', () => {
  const customRoutes = Array.from({ length: 12 }, (_, i) => ({ url: `https://line-${i}.example.com`, transport: 'http' }));
  const { payload } = pairingPayload(baseState({ customRoutes }), 18787);
  assert.equal(payload.routes.length, 8);
});

test('同址已经在 lanUrls 里的线路不重复写进 routes', () => {
  // 手填直连 = ZeroNews 地址（用户点过「从 ZeroNews 读取」）：二维码里只该出现一次。
  const { payload } = pairingPayload(baseState({
    lanEnabled: true,
    manualLanUrl: 'https://zero.example.com',
    zeroNewsUrl: 'https://zero.example.com',
  }), 18787);
  assert.ok(payload.lanUrls.includes('https://zero.example.com'));
  assert.equal(payload.routes, undefined, '同址已进 lanUrls，不再重复占字节');
});

// 配对二维码带上服务商线路：以后加服务商不用再改二维码（与心跳 / 总控同源）。
// 公用中转正式退役：码里不再塞内置地址，下面关于二维码兜底的旧断言不再成立。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { providerLinesOf } = require('../lib/relay/provider-lines.cjs');
const { pairingPayload, pairingHasAddress } = require('../lib/relay/pairing-payload.cjs');

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

test('pairingHasAddress：只配服务商线路也算有可用地址', () => {
  // 出码前那道判定以前只看中转和局域网，把只接一家服务商的机器挡在门外（二维码出不来）。
  const { payload } = pairingPayload(baseState({ zeroNewsUrl: 'https://zero.example.com' }), 18787);
  // 服务商线路进码后它自己就是老包能拨的地址：relayUrl 空、内置地址不再写，
  // 但 lanUrls 里有服务商地址，「服务商线路算可用地址」这条判据本身没变。
  assert.equal(payload.relayUrl, '', '配了服务商就不塞内置地址');
  assert.equal(payload.lanUrls.length, 1);
  assert.ok(payload.lanUrls.includes('https://zero.example.com'), '服务商 http 线路按直连进 lanUrls');
  assert.ok(payload.routes.length > 0);
  assert.equal(pairingHasAddress(payload), true, '服务商线路要算可用地址');

  const cfOnly = pairingPayload(baseState({ cloudflareUrl: 'https://cf.example.com' }), 18787).payload;
  assert.equal(cfOnly.relayUrl, '', '只有 Cloudflare 也不塞内置地址');
  assert.ok(cfOnly.lanUrls.includes('https://cf.example.com'));
  assert.equal(pairingHasAddress(cfOnly), true, '只有 Cloudflare 时也算');
});

test('老包可用的线路都写进 lanUrls：http 服务商进，tcp 服务商不进', () => {
  const { payload } = pairingPayload(baseState({
    zeroNewsUrl: 'https://zero.example.com',
    customRoutes: [{ url: 'host.example:9000', name: '自定义', transport: 'tcp' }],
  }), 18787);
  assert.deepEqual(payload.lanUrls, ['https://zero.example.com'], 'tcp 类不塞进 lanUrls，会被当 http 拨不通');
  assert.deepEqual(payload.routes.map((row) => `${row.transport}:${row.url}`), [
    'http:https://zero.example.com', 'tcp:host.example:9000',
  ]);
});

test('只配 tcp 类服务商线路：码里不再塞内置地址', () => {
  // iOS 老包没有原生转发模块时拨不了裸 TCP：二维码只带电脑自己配的线路，没有就是没有。
  const { payload } = pairingPayload(baseState({
    customRoutes: [{ url: 'host.example:9000', name: '自定义', transport: 'tcp' }],
  }), 18787);
  assert.equal(payload.relayUrl, '', 'tcp 服务商不算中转线路，不塞内置地址');
});

test('服务商地址同时是手填直连（同址被 routes 跳过）也不塞内置地址', () => {
  // 「从 ZeroNews 读取」会把同一地址写进手填直连：pairingRoutes 因同址已在 urls 而跳过它，
  // 但用户确实配了线路，码里只带自己配的线路。
  const { payload } = pairingPayload(baseState({
    lanEnabled: true,
    manualLanUrl: 'https://zero.example.com',
    zeroNewsUrl: 'https://zero.example.com',
  }), 18787);
  assert.ok(payload.lanUrls.includes('https://zero.example.com'));
  assert.equal(payload.routes, undefined, '同址不重复写进 routes');
  assert.equal(payload.relayUrl, '', '已配 http 服务商线路，不塞内置地址');
});

test('pairingHasAddress：裸载荷真的什么都没有时为假（判据本身没放宽）', () => {
  // 空配置的码里没有地址、判为假；这里再手工喂几种裸载荷，继续钉住判据：只有 IPv6 / 全空 /
  // null 都不算可用地址。IPv6 候选只是配对后的数据通道，不当配对地址。
  assert.equal(pairingHasAddress({ lanUrls: [], relayUrl: '', ipv6Candidates: ['http://[240e::1]:18787'] }), false);
  assert.equal(pairingHasAddress({ lanUrls: [], relayUrl: '' }), false);
  assert.equal(pairingHasAddress(null), false);
});

test('空配置不再往码里塞内置地址，也不写回宿主配置', () => {
  const state = baseState();
  const { payload } = pairingPayload(state, 18787);
  assert.equal(payload.relayUrl, '', '什么都没配就没有中转地址');
  assert.equal(payload.relayUrls, undefined, '空配置不写数组，省码点');
  assert.equal(state.relayUrl, '', '只改发进码的那一份，state 不动');
  assert.equal(state.relayUrls, undefined, '宿主配置这一格没被写过');

  // 宿主已配自建时，自建照旧排在前面；废弃的内置地址由读盘/落盘清理，不在这里兜底。
  const own = pairingPayload(baseState({ relayUrl: 'https://own.example', relayUrls: ['https://own.example'] }), 18787).payload;
  assert.equal(own.relayUrl, 'https://own.example');
  assert.equal(own.relayUrls, undefined, '单条自建不写数组');
  assert.equal(own.relayUrls?.[0] ?? own.relayUrl, own.relayUrl, '首项恒等于 relayUrl');
});

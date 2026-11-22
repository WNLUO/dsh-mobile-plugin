// 通用线路引擎（插件侧）：第三方线路清单进总控信封，transport / 名字逐条带到 APP。
'use strict';

/**
 * 守卫两件事：
 *   1. controlAddresses 把 customRoutes 拆成独立 `kind:'custom'` 条目，不并进 lan / direct / tcp / cf；
 *   2. config-store 的形状归一挡住半截、重复、超量的线路，transport 认不出按 http。
 * 没有 customRoutes 时清单一字不变（老插件行为不回归）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { controlAddresses } = require('../lib/relay/control.js');
const { customRoutesOf, configOf, RemoteControlSettingsSchema } = require('../lib/relay/config-store.js');

const bare = { lanEnabled: false, manualLanUrl: '', manualIpv6Url: '', manualTcpUrl: '', cloudflareUrl: '' };

test('没有 customRoutes 时上报清单不变（老行为不回归）', () => {
  assert.deepEqual(controlAddresses(bare, 0, ''), []);
  const withTcp = { ...bare, manualTcpUrl: 'example.com:9000' };
  assert.deepEqual(controlAddresses(withTcp, 0, ''), [{ kind: 'tcp', url: 'example.com:9000' }]);
});

test('每条第三方线路单独上报，名字与传输类型一起带过去', () => {
  const state = {
    ...bare,
    customRoutes: [
      { url: 'https://line-a.example.com', name: 'A 厂商', transport: 'http' },
      { url: 'line-b.example.com:9000', name: 'B 厂商', transport: 'tcp' },
    ],
  };
  const list = controlAddresses(state, 0, '');
  const custom = list.filter((a) => a.kind === 'custom');
  assert.equal(custom.length, 2);
  assert.deepEqual(custom[0], { kind: 'custom', url: 'https://line-a.example.com', name: 'A 厂商', transport: 'http' });
  assert.deepEqual(custom[1], { kind: 'custom', url: 'line-b.example.com:9000', name: 'B 厂商', transport: 'tcp' });
  assert(!list.some((a) => a.kind === 'cf'), '线路不混进 Cloudflare 那格');
  // 为老 APP 补的直连 / TCP 兜底是有意的；但它们排在线路之后之外的地方，不与线路本身混为一格。
  assert(list.some((a) => a.kind === 'direct' && a.url === 'https://line-a.example.com'), 'http 线路有直连兜底');
  assert(list.some((a) => a.kind === 'tcp' && a.url === 'line-b.example.com:9000'), 'tcp 线路有 TCP 兜底');
});

test('坏线路、重复地址不进信；transport 只认 tcp，其余按 http', () => {
  const state = {
    ...bare,
    customRoutes: [
      null,
      { name: '没有地址' },
      { url: '  https://dup.example.com  ' },
      { url: 'https://dup.example.com', name: '重复', transport: 'tcp' },
      { url: 'host:1', transport: 'bogus' },
    ],
  };
  const custom = controlAddresses(state, 0, '').filter((a) => a.kind === 'custom');
  assert.equal(custom.length, 2, '无地址与重复地址都丢掉');
  assert.equal(custom[0].url, 'https://dup.example.com');
  assert.equal(custom[0].transport, 'http', '缺失按 http');
  assert.equal(custom[1].transport, 'http', '不认识的 transport 按 http');
});

/** 老 APP 的分组口径：只认 relay/lan/ipv6/direct/cf/tcp，未知 kind 一律当 lan；按 url 去重、先到先得。 */
function oldPhoneGroups(addresses) {
  const seen = new Set();
  const groups = { lan: [], direct: [] };
  for (const row of addresses) {
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    if (row.kind === 'direct') groups.direct.push(row.url);
    else groups.lan.push(row.url);
  }
  return groups;
}

test('ZeroNews 隧道作为通用线路上报，同时保留 direct 给老手机', () => {
  const url = 'https://tunnel.example.takin.cc';
  // 关键：用户没点过「从 ZeroNews 读取」，manualLanUrl 为空——自动读到的线路仍要有直连兜底。
  const state = { ...bare, zeroNewsUrl: `${url}/` };
  const list = controlAddresses(state, 0, '');
  const custom = list.filter((a) => a.kind === 'custom');
  assert.equal(custom.length, 1);
  assert.deepEqual({ ...custom[0] }, { kind: 'custom', url, name: 'ZeroNews', transport: 'http' });
  const directAt = list.findIndex((a) => a.kind === 'direct' && a.url === url);
  const customAt = list.findIndex((a) => a.kind === 'custom');
  assert(directAt >= 0 && directAt < customAt, '直连兜底排在 custom 前面，老 APP 先认它');
  const old = oldPhoneGroups(list);
  assert.deepEqual(old.direct, [url], '老 APP 把它收进直连栏，不当局域网，不会判当前连接失效');
  assert(!old.lan.includes(url), '老 APP 的局域网候选里没有这条地址');
});

test('tcp 线路补同址 TCP 条目，老 APP 也认得出', () => {
  const state = { ...bare, customRoutes: [{ url: 'host.example:9000', name: 'B', transport: 'tcp' }] };
  const list = controlAddresses(state, 0, '');
  assert(list.some((a) => a.kind === 'tcp' && a.url === 'host.example:9000'), '老 APP 认 tcp 这一格');
  assert(list.some((a) => a.kind === 'custom' && a.url === 'host.example:9000' && a.transport === 'tcp'));
  assert(!list.some((a) => a.kind === 'tcp' && a.url === ''), '有线路自带目标时不发空 tcp 标记把目标清掉');
});

test('customRoutesOf 归一形状并被 configOf / schema 接纳', () => {
  const rows = customRoutesOf([
    { url: 'https://a.example.com', name: '  名字  ', transport: 'tcp' },
    { url: 'https://a.example.com' },
    { url: '' },
    'not an object',
  ]);
  assert.deepEqual(rows, [{ url: 'https://a.example.com', name: '名字', transport: 'tcp' }]);
  const config = configOf({ ...bare, customRoutes: rows });
  assert.deepEqual(config.customRoutes, rows);
  assert.deepEqual(RemoteControlSettingsSchema({ ...config, name: '' }).customRoutes, rows);
  assert.equal(customRoutesOf(Array.from({ length: 20 }, (_, i) => ({ url: `https://${i}.example.com` }))).length, 16);
});

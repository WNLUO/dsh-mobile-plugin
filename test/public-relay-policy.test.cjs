'use strict';

/**
 * 「配了公网自建 → 公用中转强制停用」的判定与真停用（2026-11-18 用户要求）。
 *
 * 判定口径只写一份（core.publicRelayBlocked）：有公网可达的自建——自建中转 / 直连
 * manualLanUrl / TCP 直连 manualTcpUrl——才停公用；局域网 preferredLanAddress 与 IPv6
 * manualIpv6Url 不算（外面访问不进来）。真停用是 core.stripPublicRelay：把公用地址从列表
 * 剔除，存下去的那份就不含公用，手机也就不可能再走公用。面板 status 的 publicRelayBlocked
 * 只是如实反映同一判据，让前端划删除线、禁用「启用」。
 *
 * data 目录先改临时再 require：core 在求值时就定死了 relay.json 路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-public-relay-policy-'));
const core = require('../lib/relay/core.js');

const PUBLIC = 'https://ai-hub-de-1.wnluo.com';
const SELF = 'https://relay.example.com';

test('公用地址识别：按 host 比，协议 / 端口 / 尾斜杠差异不影响', () => {
  assert.equal(core.isPublicRelayUrl(PUBLIC), true);
  assert.equal(core.isPublicRelayUrl(`${PUBLIC}/`), true, '尾斜杠不算新地址');
  assert.equal(core.isPublicRelayUrl('http://ai-hub-de-1.wnluo.com'), true, '协议不影响');
  assert.equal(core.isPublicRelayUrl('https://AI-HUB-DE-1.wnluo.com'), true, 'host 大小写不影响');
  assert.equal(core.isPublicRelayUrl(SELF), false, '自建地址不命中');
  assert.equal(core.isPublicRelayUrl(''), false);
  assert.equal(core.isPublicRelayUrl('not a url'), false);
});

test('判定：只有公网可达的自建才停公用', () => {
  // 只有公用 / 什么都没配 → 不停。
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC] }), false, '只有公用时照常用公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [] }), false, '什么都没配时不停');
  // 自建中转（列表里有非公用地址）→ 停。
  assert.equal(core.publicRelayBlocked({ relayUrls: [SELF] }), true, '自建中转要停公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC, SELF] }), true, '列表里混着自建也算');
  // 直连 / TCP 直连 → 停。
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], manualLanUrl: 'https://x.example.com' }), true, '公网直连要停公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], manualTcpUrl: 'relay.example.com:8443' }), true, 'TCP 直连要停公用');
  // 排除项：局域网优先地址与 IPv6 都不算。
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], preferredLanAddress: '192.168.31.69' }), false, '局域网地址不算');
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], manualIpv6Url: 'http://[240e::1]:18787' }), false, 'IPv6 地址不算');
  assert.equal(core.publicRelayBlocked(null), false);
});

test('真停用：从地址列表剔除公用项，自建项照留，不变式成立', () => {
  const mixed = { relayUrls: [PUBLIC, SELF], relayUrl: PUBLIC };
  assert.equal(core.stripPublicRelay(mixed), true, '剔除了东西');
  assert.deepEqual(mixed.relayUrls, [SELF], '公用项没了，自建项留着');
  assert.equal(mixed.relayUrl, SELF, '首项跟着变，relayUrls[0] === relayUrl 仍成立');

  // 自建是「公网直连」而非中转时：公用从列表剔除后 relayUrls 为空，中转这一档就没了，
  // 用户已有直连替代（relayUrls[0] === relayUrl 仍成立）。
  const withDirect = { relayUrls: [PUBLIC], relayUrl: PUBLIC, manualLanUrl: 'https://x.example.com' };
  assert.equal(core.stripPublicRelay(withDirect), true);
  assert.deepEqual(withDirect.relayUrls, []);
  assert.equal(withDirect.relayUrl, '');

  // 只有公用、没有任何自建时判据为假，一个字节不动（用户没配自建，公用照常用）。
  const untouched = { relayUrls: [PUBLIC], relayUrl: PUBLIC };
  const before = JSON.stringify(untouched);
  assert.equal(core.stripPublicRelay(untouched), false);
  assert.equal(JSON.stringify(untouched), before);
});

test('接线：配置写入点真调用了剔除，status 补了标志', () => {
  const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  const store = impl.slice(impl.indexOf('async update(patch, options = {})'), impl.indexOf('watch(listener)'));
  assert.match(store, /core\.normalizeRelayAddresses\(parsed\)/, '先收敛地址');
  assert.ok(
    store.indexOf('core.normalizeRelayAddresses(parsed)') < store.indexOf('core.stripPublicRelay(parsed)'),
    '剔除要在收敛之后',
  );
  assert.ok(
    store.indexOf('core.stripPublicRelay(parsed)') < store.indexOf('core.saveState(state)'),
    '剔除要在落盘之前，存下去的才不含公用',
  );
  const cp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js'), 'utf8');
  assert.match(cp, /status: rawStatus/, '宿主那份 status 另存');
  assert.match(cp, /publicRelayBlocked: core\.publicRelayBlocked\(state\)/, '面板 status 带标志');
  assert.match(cp, /const status = \(\) => \(\{ \.\.\.rawStatus\(\)/, '所有面板 status 回答都经这个包装');
});

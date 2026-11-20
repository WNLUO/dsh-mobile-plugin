// 公用清单补齐只恢复已启用实例的空列表，不改变自建与禁用意图。
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
  // 手机走的 /api/mobile/v1/status 心跳也要带这一格：面板知道、手机不知道的话，网络页会
  // 一直按「公用中转还开着」画 —— 选择线路 / 连接地址 / 线路检测 / 当前地址四处都收不掉。
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'mobile-api.js'), 'utf8');
  assert.match(mobile, /publicRelayBlocked: publicRelayBlocked\(state\)/, '手机心跳也带标志');
  assert.match(mobile, /const \{ relayAddressesOf, publicRelayBlocked \} = require\('\.\.\/relay\/core\.js'\)/, '判据仍只走 core 那一处');
});

// ── 老设备补齐：纯公用、缺公用地址 → 读盘时补成整份内置清单（2026-11-19 用户口径） ──

test('补齐：内置只有一台，配了它就是齐全，不做改动', () => {
  const state = { relayUrl: PUBLIC, relayUrls: [PUBLIC] };
  assert.equal(core.expandDefaultPublicRelays(state), false);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.relayUrl, PUBLIC, 'relayUrl 恒为首项');
});

test('补齐：有自建中转就不动（不归这管）', () => {
  const state = { relayUrl: 'https://self.example.com', relayUrls: ['https://self.example.com'] };
  assert.equal(core.expandDefaultPublicRelays(state), false);
  assert.deepEqual(state.relayUrls, ['https://self.example.com']);
});

test('补齐：配了公网自建直连（公用强制停用）就不补', () => {
  const state = { relayUrl: PUBLIC, relayUrls: [PUBLIC], manualLanUrl: 'https://穿透.example.com' };
  assert.equal(core.expandDefaultPublicRelays(state), false);
  assert.deepEqual(state.relayUrls, [PUBLIC]);
});

test('补齐：整份已齐时不动', () => {
  const full = { relayUrl: core.PUBLIC_RELAY_URLS[0], relayUrls: [...core.PUBLIC_RELAY_URLS] };
  assert.equal(core.expandDefaultPublicRelays(full), false);
});

test('回补：已启用且没有公网替代的空清单恢复完整公用兜底', () => {
  const state = { enabled: true, relayUrl: '', relayUrls: [] };
  assert.equal(core.expandDefaultPublicRelays(state), true);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.relayUrl, state.relayUrls[0]);
  assert.equal(state.enabled, true);
  assert.equal(core.expandDefaultPublicRelays(state), false, '回补幂等');
});

test('回补：禁用或尚未启用的空清单原样保留，不更改总开关', () => {
  for (const enabled of [false, undefined]) {
    const state = { enabled, relayUrl: '', relayUrls: [] };
    const before = { ...state, relayUrls: [] };
    assert.equal(core.expandDefaultPublicRelays(state), false);
    assert.deepEqual(state, before);
  }
});

test('回补：旧首项已经剔除时以空清单为准，不复活旧自建地址', () => {
  const state = { enabled: true, relayUrl: SELF, relayUrls: [] };
  assert.equal(core.expandDefaultPublicRelays(state), true);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.relayUrl, core.PUBLIC_RELAY_URLS[0]);
});

test('回补：公网直连仍在时保持空表，清掉最后一个替代后才恢复', () => {
  const state = { enabled: true, relayUrl: PUBLIC, relayUrls: [PUBLIC], manualLanUrl: 'https://direct.example.com', manualTcpUrl: 'tcp.example.com:8443' };
  assert.equal(core.stripPublicRelay(state), true);
  assert.deepEqual(state.relayUrls, []);
  assert.equal(state.relayUrl, '');
  assert.equal(core.expandDefaultPublicRelays(state), false);
  state.manualLanUrl = '';
  assert.equal(core.expandDefaultPublicRelays(state), false, 'TCP 替代仍在');
  state.manualTcpUrl = '';
  assert.equal(core.expandDefaultPublicRelays(state), true);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.relayUrl, core.PUBLIC_RELAY_URLS[0]);
});

test('回补：公网替代撤掉但实例已禁用时仍保持空表', () => {
  const state = { enabled: false, relayUrl: PUBLIC, relayUrls: [PUBLIC], manualLanUrl: 'https://direct.example.com' };
  core.stripPublicRelay(state);
  state.manualLanUrl = '';
  assert.equal(core.expandDefaultPublicRelays(state), false);
  assert.deepEqual(state.relayUrls, []);
  assert.equal(state.relayUrl, '');
  assert.equal(state.enabled, false);
});

test('回补：局域网偏好和手填 IPv6 不阻止公用兜底', () => {
  const state = { enabled: true, relayUrl: '', relayUrls: [], preferredLanAddress: '192.168.31.69', manualIpv6Url: 'http://[240e::1]:18787' };
  assert.equal(core.expandDefaultPublicRelays(state), true);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.manualIpv6Url, 'http://[240e::1]:18787');
});

test('配置装配：先剔除再回补，且两者都在状态写入与落盘之前', () => {
  const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  const store = impl.slice(impl.indexOf('async update(patch, options = {})'), impl.indexOf('watch(listener)'));
  assert.ok(store.indexOf('core.expandDefaultPublicRelays(parsed)') > store.indexOf('core.stripPublicRelay(parsed)'));
  assert.ok(store.indexOf('core.expandDefaultPublicRelays(parsed)') < store.indexOf('Object.assign(state, parsed)'));
  assert.ok(store.indexOf('core.expandDefaultPublicRelays(parsed)') < store.indexOf('core.saveState(state)'));
});

test('读盘即补齐：落盘只有第一台时 loadState 直接返回整份', () => {
  fs.mkdirSync(path.dirname(core.STATE_FILE), { recursive: true });
  fs.writeFileSync(core.STATE_FILE, JSON.stringify({ relayUrl: PUBLIC, relayUrls: [PUBLIC] }));
  const loaded = core.loadState();
  assert.deepEqual(loaded.relayUrls, [...core.PUBLIC_RELAY_URLS], '启动读盘就把老设备补成整份');
  assert.equal(loaded.relayUrl, PUBLIC);
});

test('退役的公用中转：认得出、从配置里剔掉、再补回现行公用', () => {
  assert.equal(core.isRetiredPublicRelayUrl('https://dsh.yfyidc.cn'), true);
  assert.equal(core.isRetiredPublicRelayUrl('https://dsh.iouf.cn/healthz'), true, '带路径也认');
  assert.equal(core.isRetiredPublicRelayUrl('https://my-own-relay.example.org'), false, '自建中转不算退役');
  const state = { enabled: true, relayUrl: 'https://dsh.yfyidc.cn', relayUrls: ['https://dsh.yfyidc.cn'] };
  assert.equal(core.pruneRetiredPublicRelays(state), true, '剔了东西');
  assert.deepEqual(state.relayUrls, [], '退役地址被清空');
  core.expandDefaultPublicRelays(state);
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS], '再补回现行公用');
  assert.equal(state.relayUrl, core.PUBLIC_RELAY_URLS[0]);
});

test('退役地址混在自建列表里：只剔退役那条，自建原样保留', () => {
  const self = 'https://my-own-relay.example.org';
  const state = { relayUrl: self, relayUrls: [self, 'https://dsh.iouf.cn'] };
  assert.equal(core.pruneRetiredPublicRelays(state), true);
  assert.deepEqual(state.relayUrls, [self]);
  assert.equal(state.relayUrl, self);
});

test('回补前先剔退役：只含退役地址的启用配置换成现行公用，混自建的只剔退役', () => {
  const onlyRetired = { enabled: true, relayUrl: 'https://dsh.iouf.cn', relayUrls: ['https://dsh.iouf.cn'] };
  assert.equal(core.expandDefaultPublicRelays(onlyRetired), true);
  assert.deepEqual(onlyRetired.relayUrls, [...core.PUBLIC_RELAY_URLS], '退役地址被换回现行公用');
  const self = 'https://my-own-relay.example.org';
  const mixed = { enabled: true, relayUrl: self, relayUrls: [self, 'https://dsh.yfyidc.cn'] };
  assert.equal(core.expandDefaultPublicRelays(mixed), true);
  assert.deepEqual(mixed.relayUrls, [self], '只剔退役，自建原样留着');
});

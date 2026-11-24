// 公用清单补齐只恢复已启用实例的空列表，不改变自建与禁用意图；退役地址只在读盘且与现行公用同列时清理、写入不碰。
'use strict';

/**
 * 「配了公网自建中转 → 公用中转强制停用」的判定与真停用。
 *
 * 判定口径只写一份（core.publicRelayBlocked）：只有**真正的中转**——relayUrls 里有一条非公用
 * 地址（自己搭的中转服务器）——才停公用。手填直连 manualLanUrl / TCP 直连 manualTcpUrl 只是
 * 手机直连这台电脑的入口，顶替不了公用中转「让新手机在外网发现这台电脑」的作用，不再据此
 * 停用（2026-11-21 反馈 #125 修正 2026-11-18 口径）；局域网 preferredLanAddress 与 IPv6
 * manualIpv6Url 同样不算。真停用是 core.stripPublicRelay：把公用地址从列表剔除，存下去的那份
 * 就不含公用，手机也就不可能再走公用。面板 status 的 publicRelayBlocked 只是如实反映同一
 * 判据，让前端划删除线、禁用「启用」。
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

test('判定：只有公网可达的自建中转才停公用', () => {
  // 只有公用 / 什么都没配 → 不停。
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC] }), false, '只有公用时照常用公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [] }), false, '什么都没配时不停');
  // 自建中转（列表里有非公用地址）→ 停。
  assert.equal(core.publicRelayBlocked({ relayUrls: [SELF] }), true, '自建中转要停公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC, SELF] }), true, '列表里混着自建也算');
  // 直连 / TCP 直连不算：它们是手机直连电脑的入口，顶替不了公用中转的发现作用，不再停用（反馈 #125）。
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], manualLanUrl: 'https://x.example.com' }), false, '直连地址不再停公用');
  assert.equal(core.publicRelayBlocked({ relayUrls: [PUBLIC], manualTcpUrl: 'relay.example.com:8443' }), false, 'TCP 直连不再停公用');
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

  // 只有直连地址、没有自建中转时判据为假：公用一个字节不动（反馈 #125）。
  const withDirect = { relayUrls: [PUBLIC], relayUrl: PUBLIC, manualLanUrl: 'https://x.example.com' };
  assert.equal(core.stripPublicRelay(withDirect), false, '直连地址不触发停用');
  assert.deepEqual(withDirect.relayUrls, [PUBLIC], '公用照留');
  assert.equal(withDirect.relayUrl, PUBLIC);

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

test('补齐：只有直连地址时不再抑制公用兜底（反馈 #125）', () => {
  const state = { enabled: true, relayUrl: '', relayUrls: [], manualLanUrl: 'https://穿透.example.com' };
  assert.equal(core.expandDefaultPublicRelays(state), true, '直连地址不再阻止公用兜底');
  assert.deepEqual(state.relayUrls, [...core.PUBLIC_RELAY_URLS]);
  assert.equal(state.relayUrl, state.relayUrls[0]);
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

test('回补：直连地址不触发停用，公用照常保留（反馈 #125）', () => {
  const state = { enabled: true, relayUrl: PUBLIC, relayUrls: [PUBLIC], manualLanUrl: 'https://direct.example.com', manualTcpUrl: 'tcp.example.com:8443' };
  assert.equal(core.stripPublicRelay(state), false, '直连 / TCP 直连都不停用公用');
  assert.deepEqual(state.relayUrls, [PUBLIC], '公用照留');
  assert.equal(state.relayUrl, PUBLIC);
  assert.equal(core.expandDefaultPublicRelays(state), false, '公用已齐全');
});

test('回补：直连地址撤掉后公用不受影响，实例禁用状态保持', () => {
  const state = { enabled: false, relayUrl: PUBLIC, relayUrls: [PUBLIC], manualLanUrl: 'https://direct.example.com' };
  assert.equal(core.stripPublicRelay(state), false, '直连地址不停用公用');
  assert.deepEqual(state.relayUrls, [PUBLIC]);
  state.manualLanUrl = '';
  assert.deepEqual(state.relayUrls, [PUBLIC]);
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

test('prune 本体的旧行为：直接调用时把退役项剔空并可被 expand 补回', () => {
  // 注意：loadState 现在只在「还有现行公用中转同列」时才调 prune（见下一条）；
  // 这里只单测 prune/expand 两个纯函数本身。
  const onlyRetired = { enabled: true, relayUrl: 'https://dsh.iouf.cn', relayUrls: ['https://dsh.iouf.cn'] };
  assert.equal(core.pruneRetiredPublicRelays(onlyRetired), true);
  assert.equal(core.expandDefaultPublicRelays(onlyRetired), true);
  assert.deepEqual(onlyRetired.relayUrls, [...core.PUBLIC_RELAY_URLS], '退役地址被换回现行公用');
  const self = 'https://my-own-relay.example.org';
  const mixed = { enabled: true, relayUrl: self, relayUrls: [self, 'https://dsh.yfyidc.cn'] };
  core.pruneRetiredPublicRelays(mixed);
  core.expandDefaultPublicRelays(mixed);
  assert.deepEqual(mixed.relayUrls, [self], '只剔退役，自建原样留着');
});

test('读盘不误伤：只剩退役地址（用户显式自建）保留，混有现行公用才剔退役（issue #26）', () => {
  fs.mkdirSync(path.dirname(core.STATE_FILE), { recursive: true });
  // 只有退役地址、没有现行公用：当作用户显式配置，读盘原样保留，不被换回内置公用。
  fs.writeFileSync(core.STATE_FILE, JSON.stringify({ enabled: true, relayUrl: 'https://dsh.iouf.cn', relayUrls: ['https://dsh.iouf.cn'] }));
  const sole = core.loadState();
  assert.deepEqual(sole.relayUrls, ['https://dsh.iouf.cn'], '显式自建（退役域名）读盘不被剔');
  assert.equal(sole.relayUrl, 'https://dsh.iouf.cn');
  // 混着现行公用：退役项才是老配置残留，剔掉、留现行公用。
  fs.writeFileSync(core.STATE_FILE, JSON.stringify({ enabled: true, relayUrl: PUBLIC, relayUrls: [PUBLIC, 'https://dsh.iouf.cn'] }));
  const mixed = core.loadState();
  assert.deepEqual(mixed.relayUrls, [PUBLIC], '混有现行公用时剔掉退役项');
  assert.equal(mixed.relayUrl, PUBLIC);
});

test('写入不清理退役地址：用户显式填的退役域名自建中转照存（issue #26）', () => {
  // 用户把自建中转搭在与退役官方地址相同的域名上：可通过面板或接口显式填进来。
  // 写入路径只调 expandDefaultPublicRelays（不再连带 prune），必须原样保留，不许静默
  // 改写成现行公用地址——那会让填了 dsh.iouf.cn 的用户看到地址「自己变了」还毫无提示。
  const explicit = { enabled: true, relayUrl: 'https://dsh.iouf.cn', relayUrls: ['https://dsh.iouf.cn'] };
  assert.equal(core.expandDefaultPublicRelays(explicit), false, '补齐这一步不碰它');
  assert.deepEqual(explicit.relayUrls, ['https://dsh.iouf.cn'], '显式填的退役域名原样留在列表');
  assert.equal(explicit.relayUrl, 'https://dsh.iouf.cn');
  // 混着真自建也一样：一个字节不动。
  const mixed = { enabled: true, relayUrl: 'https://dsh.yfyidc.cn', relayUrls: ['https://dsh.yfyidc.cn', 'https://self.example.com'] };
  assert.equal(core.expandDefaultPublicRelays(mixed), false);
  assert.deepEqual(mixed.relayUrls, ['https://dsh.yfyidc.cn', 'https://self.example.com']);
});

test('接线：退役清理只在 loadState，写入路径不带（issue #26）', () => {
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'core.js'), 'utf8');
  const loadState = coreSrc.slice(coreSrc.indexOf('function loadState('), coreSrc.indexOf('/**', coreSrc.indexOf('function loadState(')));
  assert.match(loadState, /pruneRetiredPublicRelays\(state\)/, '读盘要清理官方退役地址');
  const expand = coreSrc.slice(coreSrc.indexOf('function expandDefaultPublicRelays('), coreSrc.indexOf('module.exports'));
  assert.doesNotMatch(expand, /pruneRetiredPublicRelays/, '补齐函数不再连带剔退役地址，否则显式写入被误伤');
  const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  const store = impl.slice(impl.indexOf('async update(patch, options = {})'), impl.indexOf('watch(listener)'));
  assert.doesNotMatch(store, /pruneRetiredPublicRelays/, '写入路径不许直接剔退役地址');
});

// ── 显式停用公用中转（issue #27）：能关、能跨重启、能再启用 ──

test('显式停用：已启用 + 空列表 + disabled 时不再补回公用（这是「停用」现在的真行为）', () => {
  const state = { enabled: true, relayUrl: '', relayUrls: [], publicRelayDisabled: true };
  assert.equal(core.expandDefaultPublicRelays(state), false, '停用时不回补');
  assert.deepEqual(state.relayUrls, [], '列表保持为空');
});

test('显式停用：落盘里残留的公用地址会被剔掉，自建与直连保留', () => {
  const onlyPublic = { enabled: true, relayUrl: PUBLIC, relayUrls: [PUBLIC], publicRelayDisabled: true };
  assert.equal(core.expandDefaultPublicRelays(onlyPublic), true, '剔掉了公用项');
  assert.deepEqual(onlyPublic.relayUrls, []);
  assert.equal(onlyPublic.relayUrl, '');
  const keepsSelf = { enabled: true, relayUrl: SELF, relayUrls: [SELF], publicRelayDisabled: true };
  assert.equal(core.expandDefaultPublicRelays(keepsSelf), false, '自建项不动');
  assert.deepEqual(keepsSelf.relayUrls, [SELF]);
});

test('显式停用：loadState 读盘不把公用补回（跨重启持久）', () => {
  fs.mkdirSync(path.dirname(core.STATE_FILE), { recursive: true });
  fs.writeFileSync(core.STATE_FILE, JSON.stringify({ enabled: true, relayUrl: '', relayUrls: [], publicRelayDisabled: true }));
  const loaded = core.loadState();
  assert.deepEqual(loaded.relayUrls, [], '重启读盘也不回补公用');
  assert.equal(loaded.publicRelayDisabled, true);
});

test('显式停用：defaultState 带这一格且默认未停用', () => {
  assert.equal(core.defaultState().publicRelayDisabled, false);
});

test('显式停用接线：schema、configOf、控制面/手机 status 都带上这一格', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'config-store.js'), 'utf8');
  assert.match(store, /publicRelayDisabled: z\.boolean\(\)/, 'schema 收这一格');
  assert.match(store, /publicRelayDisabled: state\.publicRelayDisabled === true/, 'configOf 投影这一格');
  const cp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js'), 'utf8');
  assert.match(cp, /patch\.publicRelayDisabled = body\.publicRelayDisabled/, '控制面配置口认这一格');
  assert.match(cp, /publicRelayDisabled: state\.publicRelayDisabled === true/, '面板 status 带这一格');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'mobile-api.js'), 'utf8');
  assert.match(mobile, /publicRelayDisabled: state\.publicRelayDisabled === true/, '手机心跳也带这一格');
});

// 新用户引导页：进页把「公用中转」显式停用（publicRelayDisabled），之后再启用远程控制也不能
// 把公用地址补回宿主配置。判据就在 expandDefaultPublicRelays 开头那条 publicRelayDisabled 分支，
// 这里钉住它真的挡住了回补。2026-11-24 出码会把内置公用地址发进二维码（见 pairing-payload），
// 那只改码、不写回这里的状态；宿主配置这一格仍按本测试保持空。
test('新用户：显式停用公用中转后，启用也不回补宿主配置', () => {
  const state = { enabled: false, relayUrl: '', relayUrls: [], publicRelayDisabled: true };
  assert.equal(core.expandDefaultPublicRelays(state), false, '没启用时本来就补不了');
  assert.deepEqual(state.relayUrls, []);
  state.enabled = true;
  assert.equal(core.expandDefaultPublicRelays(state), false, '启用后也不许把公用补回配置');
  assert.deepEqual(state.relayUrls, [], '宿主配置列表仍为空（码里另带，是本测试之外的那层）');
  assert.equal(state.relayUrl, '');
});

// ── 配过自己的线路 → 公用中转一次性停用，清掉也不回（2026-11-24 用户口径） ──

test('自己线路的判定：自建中转 / 服务商 / 自定义算，Cloudflare 等默认兜底不算', () => {
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC] }), false, '只有公用不算');
  assert.equal(core.hasOwnRoute({ relayUrls: [SELF] }), true, '自建中转算');
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC], zeroNewsUrl: 'https://zn.example.com' }), true, 'ZeroNews 地址算');
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC], jdxbUrl: 'demo.example.com:9000' }), true, '节点小宝地址算');
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC], frpUrl: 'frp.example.com:7000' }), true, 'FRP 地址算');
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC], customRoutes: [{ url: 'https://line.example.com' }] }), true, '自定义线路算');
  // Cloudflare 快隧道默认就开着，绝不能据此停公用（否则人人一上来就停）。
  assert.equal(core.hasOwnRoute({ relayUrls: [PUBLIC], cloudflareUrl: 'https://x.trycloudflare.com' }), false, 'Cloudflare 不算');
});

test('一次性停用：配了服务商立刻停公用，清掉服务商后也不回补', () => {
  const state = { enabled: true, relayUrl: PUBLIC, relayUrls: [PUBLIC], zeroNewsUrl: 'https://zn.example.com' };
  assert.equal(core.retirePublicRelay(state), true, '配了服务商就置停用');
  core.stripPublicRelay(state);
  core.expandDefaultPublicRelays(state);
  assert.deepEqual(state.relayUrls, [], '公用中转被剔掉');
  assert.equal(state.relayUrl, '');
  // 清掉服务商之后：不再回补。
  state.zeroNewsUrl = '';
  assert.equal(core.retirePublicRelay(state), false, '已经置位过，不重复置');
  core.expandDefaultPublicRelays(state);
  assert.deepEqual(state.relayUrls, [], '清掉自己的线路也不回补公用');
  assert.equal(state.publicRelayDisabled, true, '停用意图跨重启保持');
});

test('一次性停用：自建中转同样置停用，清掉也不回', () => {
  const state = { enabled: true, relayUrl: SELF, relayUrls: [SELF] };
  assert.equal(core.retirePublicRelay(state), true, '自建中转也算自己的线路');
  state.relayUrls = [];
  state.relayUrl = '';
  state.publicRelayDisabled = true;
  core.expandDefaultPublicRelays(state);
  assert.deepEqual(state.relayUrls, [], '自建清掉后公用也不回来');
});

test('接线：配置写入点先 retire 再 strip / expand', () => {
  const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  const store = impl.slice(impl.indexOf('async update(patch, options = {})'), impl.indexOf('watch(listener)'));
  assert.match(store, /core\.retirePublicRelay\(parsed\)/, '写入点要调一次性停用');
  assert.ok(
    store.indexOf('core.retirePublicRelay(parsed)') < store.indexOf('core.stripPublicRelay(parsed)'),
    'retire 要在 strip 之前（先把 disabled 置上）',
  );
  assert.ok(
    store.indexOf('core.retirePublicRelay(parsed)') < store.indexOf('core.expandDefaultPublicRelays(parsed)'),
    'retire 要在 expand 之前（expand 见到 disabled 才不再回补）',
  );
});

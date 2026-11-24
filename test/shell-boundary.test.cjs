// 外壳边界守卫：外壳的引用图里不许出现「线路实现」，防止线路代码再溜回外壳、逼用户重启 DSH。
'use strict';

/**
 * 背景：宿主启动时按模块缓存把外壳冻住，改外壳就得重启一次 DSH。所以线路实现必须住在可热换的
 * 「代」里，外壳只做通用装载与持有。
 *
 * 判据是「外壳实际加载了哪些文件」（顺着入口引用算，见 lib/shell/loaded-files.js），不是手写
 * 一份清单——手写的一定会落后，落后一个就会让某一版更新静默不生效。这里用**前缀**兜住整类线路
 * 目录，而不是逐个文件列名：漏列一个就等于没守住。
 *
 * 注意：三条主链路（中转 sidecar / 总控上报 / mux）的实现也搬进了「代」，外壳以「稳定门面 + 提交时
 * 换实例」持有（见 transport-host），它们在下面的名单里。外壳里只剩内核与更新机制本身。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONTROL = path.join(ROOT, 'lib', 'relay', 'control.js');

/** 已经搬进「代」的线路实现目录前缀：外壳的引用图里不许出现其中任何文件。 */
const LINE_IMPL_PREFIXES = [
  'lib/frpc/',
  'lib/tailcat/',
  'lib/p2p/',
  'lib/jdxb/',
  'lib/zeronews/',
  'lib/cloudflared/',
  'lib/remote/',
];
/** 同样已搬进「代」、但散落在 relay/ 下的纯计算/线路文件（逐个点名）。 */
const LINE_IMPL_FILES = [
  'lib/relay/provider-lines.cjs',
  'lib/relay/lan-network.cjs',
  'lib/relay/tunnel-forwarder.cjs',
  // 三条主链路实现：外壳按「提交时换实例」持有（见 transport-host），实现本身住代里。
  'lib/sidecar-lifecycle.cjs',
  'lib/sidecar-facade.cjs',
  'lib/sidecar-facade-worker.cjs',
  'lib/relay/apply-ledger.cjs',
  'lib/relay/control.js',
  'lib/mobile/mux.js',
  'lib/mobile/permissions.js',
];

test('外壳的引用图里不许出现任何线路实现（前缀 + 点名）', async () => {
  const { shellFiles } = await import('../lib/shell/loaded-files.js');
  const files = shellFiles(ROOT);
  assert.ok(files.length > 0, '外壳引用图不该为空：入口算不出来要当场报，别静默放过');
  const byPrefix = files.filter(rel => LINE_IMPL_PREFIXES.some(prefix => rel.startsWith(prefix)));
  const byName = files.filter(rel => LINE_IMPL_FILES.includes(rel));
  const hits = [...new Set([...byPrefix, ...byName])];
  assert.deepEqual(hits, [], `外壳不许静态引用线路实现，请改成由「代」注入：${hits.join('、')}`);
});

test('总控上报不再自己 require 服务商清单（改由代注入）', () => {
  const src = fs.readFileSync(CONTROL, 'utf8');
  assert(
    !/require\(\s*['"]\.\/provider-lines\.cjs['"]\s*\)/.test(src),
    '总控上报要按注入取清单，别把静态引用搬回来 —— 搬回来加服务商就又要重启 DSH',
  );
});

test('服务商清单注入契约：不注入当空、注入则逐条进信封、注入方抛错只降级', () => {
  const { controlAddresses } = require('../lib/relay/control.js');
  const { providerLinesOf } = require('../lib/relay/provider-lines.cjs');
  const state = {
    lanEnabled: false,
    manualLanUrl: '',
    manualIpv6Url: '',
    manualTcpUrl: '',
    cloudflareUrl: '',
    zeroNewsUrl: 'https://tunnel.example.takin.cc',
    jdxbUrl: 'nb.nblink.cc:15565',
    frpUrl: 'frp.example.com:7000',
  };
  // 老代回滚到这一版：没注入 —— 信封里没有 custom，但不会崩，其余地址照旧出。
  const bare = controlAddresses(state, 0, '');
  assert.equal(bare.filter(a => a.kind === 'custom').length, 0, '没注入清单时不该冒出第三方线路');
  // 注入：与 providerLinesOf 逐条对上。
  const injected = controlAddresses(state, 0, '', { getProviderLines: providerLinesOf }).filter(a => a.kind === 'custom');
  const expected = providerLinesOf(state).map(row => ({ kind: 'custom', url: row.url, name: row.name, transport: row.transport }));
  assert.ok(expected.length > 0, '样例状态里至少要有一条第三方线路，否则下面这条断言没意义');
  assert.deepEqual(injected, expected, '注入了清单就该逐条进信封，顺序与内容都要一致');
  // 注入方抛错：退回空表，不能把整份总控上报/`/status` 打掉（其余地址照旧出）。
  const list = controlAddresses({}, 0, 'https://relay.example', { getProviderLines: () => { throw new Error('boom'); } });
  assert.ok(list.some(a => a.kind === 'relay' && a.url === 'https://relay.example'), '清单抛错时其它地址仍要上报');
  assert.equal(list.filter(a => a.kind === 'custom').length, 0);
});

test('候选计算注入契约：注入（对象或函数）就进信封，不注入降级为不出 LAN/IPv6/直连/TCP', () => {
  const { controlAddresses } = require('../lib/relay/control.js');
  const tools = {
    advertisedCandidates: () => [{ url: 'http://10.0.0.5:1234' }],
    orderCandidates: list => list,
    manualCandidate: value => (value ? { url: value } : null),
    ipv6Candidates: () => [],
    withManualIpv6Candidate: list => list,
    tcpDirectTarget: value => (value || ''),
  };
  const state = { lanEnabled: true, manualLanUrl: 'https://home.example.com:8443', manualTcpUrl: 'example.com:9000' };
  const withObject = controlAddresses(state, 19999, '', { lanTools: tools });
  assert.ok(withObject.some(a => a.kind === 'lan' && a.url === 'http://10.0.0.5:1234'), 'LAN 候选要进信封');
  assert.ok(withObject.some(a => a.kind === 'direct' && a.url === 'https://home.example.com:8443'), '直连要进信封');
  assert.ok(withObject.some(a => a.kind === 'tcp' && a.url === 'example.com:9000'), 'TCP 兜底要进信封');
  // 传「返回工具对象的函数」也要认（装配层就是这种形态）——这是 1b 曾把函数当对象、生产丢候选的回归点。
  assert.deepEqual(controlAddresses(state, 19999, '', { lanTools: () => tools }), withObject, 'lanTools 传函数也要认，结果一致');
  // 不注入：这几类都不出，但不崩。
  const none = controlAddresses(state, 19999, '', {});
  assert.equal(none.some(a => ['lan', 'ipv6', 'direct', 'tcp'].includes(a.kind) && a.url), false, '没注入候选工具时不该冒出 LAN/IPv6/直连/TCP');
});

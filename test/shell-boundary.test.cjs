// 外壳边界守卫：外壳的引用图里不许出现「线路实现」，防止线路代码再溜回外壳、逼用户重启 DSH。
'use strict';

/**
 * 背景：宿主启动时按模块缓存把外壳冻住，改外壳就得重启一次 DSH。所以「加 / 改线路」这类
 * 高频改动必须住在可热换的「代」里，外壳只做通用装载与持有。这条守卫把边界钉住：第一批先把
 * 服务商线路清单、节点小宝地址识别与地址候选计算移出外壳，之后每搬一批就往下面那份名单里加一条。
 *
 * 判据是「外壳实际加载了哪些文件」（顺着入口引用算，见 lib/shell/loaded-files.js），不是
 * 手写一份清单——手写的一定会落后，落后一个就会让某一版更新静默不生效。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONTROL = path.join(ROOT, 'lib', 'relay', 'control.js');

/** 已经搬进「代」、绝不许再被外壳静态引用的线路实现。 */
const LINE_IMPL_DENY = [
  'lib/relay/provider-lines.cjs',
  'lib/jdxb/probe.cjs',
  'lib/relay/lan-network.cjs',
  'lib/frpc/runner.cjs',
  'lib/frpc/provision.cjs',
  'lib/tailcat/wiring.cjs',
  'lib/tailcat/ingress.cjs',
  'lib/tailcat/session.cjs',
];

test('外壳的引用图里不许出现线路实现（第一批）', async () => {
  const { shellFiles } = await import('../lib/shell/loaded-files.js');
  const files = new Set(shellFiles(ROOT));
  assert.ok(files.size > 0, '外壳引用图不该为空：入口算不出来要当场报，别静默放过');
  const hits = LINE_IMPL_DENY.filter(file => files.has(file));
  assert.deepEqual(hits, [], `外壳不许静态引用线路实现，请改成由「代」注入：${hits.join('、')}`);
});

test('总控上报不再自己 require 服务商清单（改由代注入）', () => {
  const src = fs.readFileSync(CONTROL, 'utf8');
  assert(
    !/require\(\s*['"]\.\/provider-lines\.cjs['"]\s*\)/.test(src),
    '总控上报要按注入取清单，别把静态引用搬回来 —— 搬回来加服务商就又要重启 DSH',
  );
});

test('清单注入契约：不注入当空、注入则逐条进信封', () => {
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
  const injected = controlAddresses(state, 0, '', providerLinesOf).filter(a => a.kind === 'custom');
  const expected = providerLinesOf(state).map(row => ({ kind: 'custom', url: row.url, name: row.name, transport: row.transport }));
  assert.ok(expected.length > 0, '样例状态里至少要有一条第三方线路，否则下面这条断言没意义');
  assert.deepEqual(injected, expected, '注入了清单就该逐条进信封，顺序与内容都要一致');
});

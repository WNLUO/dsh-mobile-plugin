'use strict';

/**
 * 「内网穿透」这一格：用户自己把宿主的端口暴露到一个公网域名上，手机拨的是那个域名。
 *
 * 它**不是中转**：后面站的是这台宿主本身，对手机来说就是直连，只是地址在公网。所以它落在
 * 直连那一套里 —— 写 `manualLanUrl`（与局域网地址并列当候选），不写 `relayUrl`、也不算进
 * `isRelayMode`（算进去的话，界面会拿一条跟它无关的中转隧道状态来判「能不能连」）。
 *
 * 另外两条是回显与清除：宿主不报这一格，界面就分不清「没填」与「没取到」；而空串必须是合法
 * 值——那是这个字段唯一的清除方式（照 `name` 那样要求非空，填错了就再也改不回来）。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('引导页不再提供内网穿透入口（2026-11-07 起），主流程只配局域网 + 公用中转', () => {
  const onboarding = read('React', 'src', 'Onboarding.tsx');

  // 那一块连同「自建中转」一起被用户要求删掉了（引导页一上来说越简单越好）。
  // 这条路没有消失 —— 它搬到了主页「网络配置」弹窗，下面那条测试钉着。
  assert.ok(
    !/patch\.manualLanUrl\s*=/.test(onboarding),
    '引导页又写 manualLanUrl 了：那一页现在只配局域网与公用中转，穿透域名归主页',
  );
  assert.ok(
    !/savePenetration|penetrationOpen/.test(onboarding),
    '引导页的穿透弹窗已经删了，别留一半',
  );

  // 主流程配的就是这两条，一条都不许少：少了局域网，家里扫完就要绕中转。
  assert.match(onboarding, /lanEnabled: true/, '局域网直连要一起开着');
  assert.match(onboarding, /relayUrl: PUBLIC_RELAY_URL/, '默认那条中转是清单第一条（公用入口只有一个）');
});

test('宿主把穿透域名报给面板，主页「网络配置」接着改（引导页已不再提供这一格）', () => {
  const controlPlane = read('lib', 'routes', 'control-plane.js');
  const at = controlPlane.indexOf("'/api/relay/addresses'");
  assert.notEqual(at, -1, '找不到地址库那条路由');
  const route = controlPlane.slice(at, at + 900);
  // 不报这一格，界面就分不清「没填」与「没取到」，每次开窗都装作空着。
  assert.match(route, /manual/, '地址库要带上手填的穿透域名');
  assert.match(route, /state\.manualLanUrl/, '取值来源是设置项 manualLanUrl');

  // 引导页 2026-11-07 起不再提供这一格（用户要求删掉整块），所以这里不再要求它。
  // 但那一条地址仍然要能填、要能进二维码 —— 入口在主页「网络配置」，见下面的断言。

  // 进插件之后同一格搬到「网络配置」弹窗：四条地址在一起改，别在两扇窗里各改一半。
  const networkDialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(networkDialog, /panel\.address\.direct\b/, '「网络配置」里要有直连地址这一栏');
  assert.match(networkDialog, /panel\.address\.ipv6Url\b/, '「网络配置」里要有 IPv6 地址这一栏');
  assert.match(networkDialog, /patch\.manualLanUrl\s*=/, '直连地址保存的是 manualLanUrl');
  assert.match(networkDialog, /patch\.manualIpv6Url\s*=/, 'IPv6 地址保存的是 manualIpv6Url');
  assert.match(
    networkDialog,
    /addressBook\?\.manualIpv6/,
    '现值从地址库的 manualIpv6 预填（控制面只有 POST /api/relay/config，没有 GET）',
  );
  const lanDialog = read('React', 'src', 'components', 'PortDialog.tsx');
  assert.ok(
    !/manualLanUrl|AddressPicker/.test(lanDialog),
    '端口弹窗里不许再能改地址：地址只剩「网络配置」一个入口',
  );
});

test('空串是穿透域名的合法值（清除），面板填的东西真的进了二维码', () => {
  const controlPlane = read('lib', 'routes', 'control-plane.js');
  // 别照 `name` 那样要求非空：加了，填错一次就再也清不掉。
  assert.ok(
    !/typeof body\?\.manualLanUrl === 'string' && body\.manualLanUrl\.trim\(\)/.test(controlPlane),
    'manualLanUrl 不许要求非空（空串 = 清掉这一条）',
  );

  // 面板写进去的值要真的进候选：否则界面上填好了、手机扫到的还是旧那几条。
  const impl = read('lib', 'impl.js');
  assert.match(impl, /manual: state\.manualLanUrl/, '二维码/候选那边要带上这一条');
});

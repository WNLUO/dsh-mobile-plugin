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

test('引导页把内网穿透当成直连的一条：写 manualLanUrl，不算进中转', () => {
  const onboarding = read('React', 'src', 'Onboarding.tsx');

  // 只有那一支会写它。多出一处 = 有别的选项在顺手改用户的穿透域名。
  const writes = [...onboarding.matchAll(/patch\.manualLanUrl\s*=/g)];
  assert.equal(writes.length, 1, 'manualLanUrl 只能有一处写：内网穿透那一栏');
  const at = onboarding.indexOf('patch.manualLanUrl');
  assert.match(
    onboarding.slice(at - 400, at + 80),
    /mode === PENETRATION/,
    '写入必须被「选的是内网穿透」挡住，别在切别的选项时清掉用户填的值',
  );

  // 它走直连那一套判据：中转那两支才算 relay 模式。
  assert.match(
    onboarding,
    /const isRelayMode = selected === PUBLIC_RELAY \|\| selected === OWN_RELAY/,
    '内网穿透不算中转：算进去界面就会拿一条无关的隧道状态判「能不能连」',
  );
  // 两条直连写法一致：选直连/穿透都清掉中转地址，隧道压根不启动。
  assert.match(onboarding, /relayUrl: target/, '直连那两支仍然要清掉中转地址');
});

test('宿主把穿透域名报给面板，引导页与直连弹窗都摆了这一格', () => {
  const controlPlane = read('lib', 'routes', 'control-plane.js');
  const at = controlPlane.indexOf("'/api/relay/addresses'");
  assert.notEqual(at, -1, '找不到地址库那条路由');
  const route = controlPlane.slice(at, at + 900);
  // 不报这一格，界面就分不清「没填」与「没取到」，每次开窗都装作空着。
  assert.match(route, /manual/, '地址库要带上手填的穿透域名');
  assert.match(route, /state\.manualLanUrl/, '取值来源是设置项 manualLanUrl');

  const onboarding = read('React', 'src', 'Onboarding.tsx');
  assert.match(onboarding, /panel\.onboarding\.penetration\b/, '引导页要有这一条');
  assert.match(onboarding, /book\.manual/, '引导页要按宿主给的值预填');

  const lanDialog = read('React', 'src', 'components', 'LanDialog.tsx');
  assert.match(lanDialog, /panel\.lanDialog\.penetration/, '直连弹窗里是同一格（进插件之后改它就走这里）');
  assert.match(lanDialog, /manualLanUrl:/, '直连弹窗保存的也是 manualLanUrl');
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

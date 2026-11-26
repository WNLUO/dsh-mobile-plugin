// FRP 导入仅暂存，父窗保存应用；取消零副作用是 PLUG-30 的明确契约。
'use strict';

/**
 * 面板「网络配置」里的 TCP 直连地址那一栏。
 *
 * 宿主侧的读写（schema / config 白名单 / `tcpDirectTarget`）另有测试钉着；这条只钉面板这半段：
 * 宿主把 `manualTcpUrl` 报上来、面板回显、用户改了就写回去。少了其中任何一段，用户在这扇窗里
 * 都配不了这条通道 —— 要么看不见现值，要么填了存不上。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('网络配置弹窗有 TCP 直连地址一栏，现值从地址库预填、保存写 manualTcpUrl', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /panel\.address\.tcp\b/, '要有「TCP 直连地址」这一栏');
  assert.match(dialog, /panel\.address\.tcpPlaceholder/, '要有占位提示');
  assert.match(dialog, /addressBook\?\.manualTcp/, '现值从地址库的 manualTcp 预填');
  assert.match(dialog, /patch\.manualTcpUrl\s*=/, '保存时写 manualTcpUrl');
  assert.match(dialog, /editedTcpRef/, '用户动过这一栏后，别再被后来补上的地址库覆盖');
});

test('宿主地址库把 TCP 目标报给面板（取值来源 manualTcpUrl）', () => {
  const source = read('lib', 'routes', 'control-plane.js');
  const at = source.indexOf("'/api/relay/addresses'");
  assert.notEqual(at, -1, '找不到地址库那条路由');
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1200 : end);
  assert.match(route, /manualTcp/, '地址库要带上 TCP 目标，否则面板每次开窗都当它空着');
  assert.match(route, /state\.manualTcpUrl/, '取值来源是设置项 manualTcpUrl');
});

test('改配置的路由收 manualTcpUrl', () => {
  const source = read('lib', 'routes', 'control-plane.js');
  const at = source.indexOf("'/api/relay/config'");
  assert.notEqual(at, -1, '找不到改配置那条路由');
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1600 : end);
  assert.match(route, /patch\.manualTcpUrl/, 'config 白名单要收 manualTcpUrl');
});

test('TCP 那两栏文案在十一门语言里都有', () => {
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ["'panel.address.tcp':", "'panel.address.tcpPlaceholder':"]) {
    const count = panel.split(key).length - 1;
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(count, 11, `${key} 要有十一门语言，实际 ${count}`);
  }
});

test('TCP 栏右侧是「检测」：回环命中本机才算通', () => {
  // 2026-11-22 需求变更：TCP 那栏原来放「FRP 导入」，现在 FRP 挪到独立分区走「导入」弹窗，
  // TCP 栏改成一颗统一的「检测」按钮（跑回环探测，命中本机插件才算通）。
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /probeLoop\(manualTcpUrl, setTcpProbe\)/, 'TCP 栏的检测按钮跑回环探测');
  assert.ok(!/panel\.address\.frpImport/.test(dialog), 'TCP 栏不再有「FRP 导入」按钮');
});

test('FRP 走「导入」弹窗：粘配置、保存并启动，父窗不再直接摊配置框', () => {
  // 2026-11-22 需求变更：FRP 不再在主窗直接摊一大块编辑框，改成「导入」按钮开弹窗、粘配置保存。
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /panel\.frp\.import/, 'FRP 区要有「导入」按钮');
  assert.match(dialog, /setFrpDialogOpen\(true\)/, '点导入开配置弹窗');
  assert.match(dialog, /<textarea[\s\S]*?value=\{frpText\}/, '弹窗里粘 frpc 配置');
  assert.match(dialog, /saveFrp/, '保存并启动走 saveFrp');
  assert.match(dialog, /panel\.frp\.manageTitle/, 'FRP 区仍在');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
  assert.equal(panel.split("'panel.frp.import':").length - 1, 11, '导入文案十一门齐');
});

test('连接状态卡里也有「TCP 直连」一行：配了显示已配置+地址，没配显示未配置', () => {
  const card = read('React', 'src', 'components', 'ConnectionCard.tsx');
  assert.match(card, /panel\.connection\.tcp\b/, '连接状态卡要有 TCP 直连这一行');
  assert.match(card, /panel\.connection\.tcpSet/, '配好了要有「已配置」');
  assert.match(card, /panel\.connection\.tcpOff/, '没配要有「未配置」');
  assert.match(card, /addressBook\??\.manualTcp/, '从地址库的 manualTcp 读这条配置');
  const consoleSrc = read('React', 'src', 'Console.tsx');
  assert.match(consoleSrc, /<ConnectionCard[\s\S]*?addressBook=\{addresses\}/, '要把地址库传给连接状态卡');
});

test('TCP 那格只收「主机:端口」：带 scheme 的地址提示去直连地址并拦下保存', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  // 这格是明文裸 TCP，只该填 host:port；填了带 scheme 的（尤其 https://）要当场提示并拦住保存，
  // 而不是悄悄剥掉前缀当明文拨——那正是 issue #34/#35 的根。
  assert.match(dialog, /setTcpHint\(t\('panel\.address\.tcpSchemeHint'\)\)/, '输入与保存两处都要给提示');
  assert.match(dialog, /manualTcpUrl\.trim\(\)/, '保存前按实际输入判 scheme');
  assert.match(dialog, /event\.target\.value\.trim\(\)/, '输入时按现场值判 scheme');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
  assert.equal(panel.split("'panel.address.tcpSchemeHint':").length - 1, 11, '提示文案十一门齐');
});

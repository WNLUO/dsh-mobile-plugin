// 网络配置独立页：hash 路由、隐藏顶栏、自建中转检测与明文 http 提示。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('网络配置是独立子页：用 hash 路由，刷新留在这一页，并隐藏顶部状态栏', () => {
  // 2026-11-23 需求变更：网络配置拆成三层（主配置页 / 地区页 / 服务商页），路由表搬进
  // lib/network-region.ts，Console 只按页面状态渲染。
  const consoleSrc = read('React', 'src', 'Console.tsx');
  assert.match(consoleSrc, /window\.location\.hash/, '视图要跟地址栏 hash 走');
  assert.match(consoleSrc, /pageFromHash/, '初始视图由 hash 决定（刷新不丢）');
  assert.match(consoleSrc, /'hashchange'/, '前进后退 / 手改 hash 要跟着切视图');
  assert.match(consoleSrc, /page !== 'home' \? null/, '在网络配置这一组页面里不显示顶部状态栏');
  const routes = read('React', 'src', 'lib', 'network-region.ts');
  for (const hash of ['network/cn', 'network/global', 'network/cn/zeronews', 'network/cn/jdxb', 'network/global/cloudflare']) {
    assert.ok(routes.includes(hash), `要有 ${hash} 这条路径`);
  }
});

test('自建中转有「检测」：确认是不是我们的中转、取版本与延迟', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /async function checkSelfRelay/, '要有检测函数');
  assert.match(page, /\/api\/relay\/probe-relays/, '复用宿主已有的中转探测端点');
  assert.match(page, /hit\.service === 'dsh-mobile-relay'/, '只认我们中转的服务标识');
  for (const key of ['panel.relay.detect', 'panel.relay.detectOk', 'panel.relay.detectNotOurs', 'panel.relay.detectFail']) {
    assert.ok(page.includes(`'${key}'`), `要用到 ${key}`);
  }
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.relay.detect', 'panel.relay.detecting', 'panel.relay.detectOk', 'panel.relay.detectNotOurs', 'panel.relay.detectFail']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('明文 http 的直连 / 自建中转给出 iPhone ATS 提醒', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /panel\.address\.plainHttpWarn/, '明文 http 要提示 ATS');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  assert.equal(panel.split("'panel.address.plainHttpWarn':").length - 1, 10, '提示文案十门齐全');
});

test('直连地址回环检测：打回宿主自己（service=dsh-mobile-plugin 且 instanceId 一致）', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  // 2026-11-22：检测抽成通用 probeLoop（各栏共用同一套回环口径），判据不变。
  assert.match(page, /async function probeLoop/, '要有回环检测函数');
  assert.match(page, /hit\.service === 'dsh-mobile-plugin'/, '要认宿主自己的服务标识');
  assert.match(page, /hit\.instanceId === status\.instanceId/, 'instanceId 与本机一致才算绕回本机');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.address.detectLoop', 'panel.address.detectLoopOk', 'panel.address.detectLoopOther', 'panel.address.detectLoopFail']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('局域网 / IPv6 只选不手填，且能「添加地址」', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /readOnly/, '地址框设为只读（只能选）');
  assert.match(page, /function submitAdd/, '要有添加地址的处理');
  assert.match(page, /setAddOpen\('lan'\)/, '局域网能添加地址');
  assert.match(page, /setAddOpen\('ipv6'\)/, 'IPv6 能添加地址');
  assert.match(page, /extraLan/, '手动添加的局域网地址并入候选');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.address.add', 'panel.address.addInvalid']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('FRP 直连管理：读当前配置、保存并启动、停止', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /frpConfig\(\)/, '打开时读取当前 frpc 配置');
  assert.match(page, /async function saveFrp/, '保存并启动');
  assert.match(page, /async function stopFrpNow/, '停止');
  assert.match(page, /panel\.frp\.manageTitle/, '要有 FRP 管理区');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.frp.manageTitle', 'panel.frp.configLabel', 'panel.frp.saveStart', 'panel.frp.statusRun', 'panel.frp.statusStop']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('宿主探测端点也认宿主自己的健康响应（供直连回环检测）', () => {
  const cp = read('lib', 'routes', 'control-plane.js');
  assert.match(cp, /who\.service === 'dsh-mobile-plugin'/, 'probe-relays 要识别宿主自身的健康响应');
  assert.match(cp, /instanceId: who\.instanceId/, '要把 instanceId 带回面板做回环比对');
  assert.match(cp, /path: '\/api\/relay\/frp\/config'/, '要有读取 frpc 配置的路由');
  assert.ok(/readConfig/.test(read('lib', 'frpc', 'runner.cjs')), 'runner 要暴露 readConfig');
});

test('公网 IPv4 有独立一栏，写 manualIpv4Url', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /panel\.address\.ipv4Url/, '要有公网 IPv4 一栏');
  assert.match(page, /patch\.manualIpv4Url\s*=/, '保存写 manualIpv4Url');
  assert.match(page, /addressBook\?\.manualIpv4/, '现值从地址库 manualIpv4 预填');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.address.ipv4Url', 'panel.address.ipv4Placeholder']) {
    assert.equal(panel.split(`'${key}':`).length - 1, 10, `${key} 要十门齐全`);
  }
});

test('宿主把公网 IPv4 单列一格并缀进候选（地址库与手机候选都覆盖）', () => {
  const cp = read('lib', 'routes', 'control-plane.js');
  assert.match(cp, /manualIpv4/, '地址库要带上公网 IPv4');
  assert.match(cp, /withManualIpv4Candidate/, '公网候选要缀上手填 IPv4');
  const lan = read('lib', 'relay', 'lan-network.cjs');
  assert.match(lan, /function manualIpv4Candidate/, '要有 manualIpv4Candidate（只认 IPv4 字面量）');
  assert.match(read('lib', 'routes', 'mobile-api.js'), /withManualIpv4Candidate/, '手机 connection-info 候选也要带上');
  assert.match(read('lib', 'relay', 'pairing-payload.cjs'), /withManualIpv4Candidate/, '二维码候选也要带上');
});

test('网络配置页分区：主配置页平铺字段，线路按地区与服务商各自成页', () => {
  // 2026-11-22 需求变更：去掉会产生歧义的分组大标题，字段直接平铺。
  // 2026-11-23 需求变更：线路不再是主配置页底部的两段，而是按地区（中国 / 国际）→ 服务商
  // 分层，各自一页。主配置页只留地区入口。
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  for (const key of ['panel.network.secRelay', 'panel.network.secDirect', 'panel.network.secLocal', 'panel.network.secFrp']) {
    assert.ok(!page.includes(`'${key}'`), `不再渲染分组标题 ${key}`);
  }
  assert.ok(page.includes('<NetworkRegions onOpen={onOpenRegion} />'), '主配置页底部挂地区入口');
  assert.ok(!page.includes('<JdxbLineCard />'), '节点小宝不在主配置页里');
  assert.ok(!page.includes("'panel.zeronews.section'"), 'ZeroNews 不在主配置页里');
  const china = read('React', 'src', 'components', 'ChinaLinesPage.tsx');
  assert.ok(china.includes('providersOfRegion(\'cn\')'), '中国页列国内服务商');
  const globalPage = read('React', 'src', 'components', 'GlobalLinesPage.tsx');
  assert.ok(globalPage.includes('providersOfRegion(\'global\')'), '国际页列国际服务商');
  const jdxb = read('React', 'src', 'components', 'JdxbPage.tsx');
  assert.ok(jdxb.includes('<JdxbLineCard />'), '节点小宝在它自己那页');
  assert.ok(jdxb.includes('LineGuide'), '节点小宝那页带步骤条');
  // 四入口标题改成不歧义的短名（直连 / TCP 直连 / IPv4 / IPv6）。
  for (const key of ['panel.address.direct', 'panel.address.tcp', 'panel.address.ipv4Url', 'panel.address.ipv6Url']) {
    assert.ok(page.includes(`'${key}'`), `要有字段 ${key}`);
  }
});

test('节点小宝绑定成功要自己收掉链接：轮询设备端状态，读到已绑就清空', () => {
  // 授权/绑定是在它自己的页面完成的，插件这边只有轮询这一条路。不轮询的话，用户明明绑好了，
  // 链接还挂在面板上，看起来就像没成功（现场反馈）。
  const card = read('React', 'src', 'components', 'JdxbLineCard.tsx');
  assert.match(card, /setInterval\(/, '要定时问一次状态');
  assert.match(card, /jdxbStatus\(\)/, '问的是宿主那条 status 路由');
  assert.match(card, /next\.bound\) setBindLink\(''\)/, '读到已绑定就把链接收掉');
  assert.match(card, /clearInterval\(/, '卸载时要停掉轮询');
});

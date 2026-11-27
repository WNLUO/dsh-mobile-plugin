// 2026-11-27 需求变更：国内服务商只留 ZeroNews，节点小宝与 FRP 的配置页及文案从面板撤掉，
// 宿主侧线路能力保留；下面相应断言随之收窄。
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
  // 2026-11-27 需求变更：国内服务商只留 ZeroNews，节点小宝与 FRP 的配置页从面板撤掉，
  // 宿主能力保留。原来钉住的 cn/jdxb、cn/frp 路由随之删除。
  for (const hash of ['network/cn', 'network/global', 'network/cn/zeronews', 'network/global/cloudflare']) {
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
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
  }
});

test('明文 http 的直连 / 自建中转给出 iPhone ATS 提醒', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(page, /panel\.address\.plainHttpWarn/, '明文 http 要提示 ATS');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
  assert.equal(panel.split("'panel.address.plainHttpWarn':").length - 1, 11, '提示文案十一门齐全');
});

test('直连地址回环检测：打回宿主自己（service=dsh-mobile-plugin 且 instanceId 一致）', () => {
  const page = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  // 2026-11-22：检测抽成通用 probeLoop（各栏共用同一套回环口径），判据不变。
  assert.match(page, /async function probeLoop/, '要有回环检测函数');
  assert.match(page, /hit\.service === 'dsh-mobile-plugin'/, '要认宿主自己的服务标识');
  assert.match(page, /hit\.instanceId === status\.instanceId/, 'instanceId 与本机一致才算绕回本机');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.address.detectLoop', 'panel.address.detectLoopOk', 'panel.address.detectLoopOther', 'panel.address.detectLoopFail']) {
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
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
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
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
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
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
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
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
  // 2026-11-27 需求变更：服务商线路改成标题右边的「中国 / 国际」标签 + 专属面板，
  // 不再是两张地区入口卡；面板「详细配置」直接进服务商页。地区页路由保留给老 hash。
  assert.ok(page.includes('<NetworkRegions status={status} />'), '主配置页挂标签面板');
  assert.ok(!page.includes('<JdxbLineCard />'), '节点小宝不在主配置页里');
  const china = read('React', 'src', 'components', 'ChinaLinesPage.tsx');
  assert.ok(china.includes('providersOfRegion(\'cn\')'), '中国页列国内服务商');
  const globalPage = read('React', 'src', 'components', 'GlobalLinesPage.tsx');
  assert.ok(globalPage.includes('providersOfRegion(\'global\')'), '国际页列国际服务商');
  // 2026-11-27 需求变更：节点小宝与 FRP 的配置页已从面板撤掉，宿主能力保留，这里不再钉它们的页面。
  // 四入口标题改成不歧义的短名（直连 / TCP 直连 / IPv4 / IPv6）。
  for (const key of ['panel.address.direct', 'panel.address.tcp', 'panel.address.ipv4Url', 'panel.address.ipv6Url']) {
    assert.ok(page.includes(`'${key}'`), `要有字段 ${key}`);
  }
});

test('服务商线路：标题右边中国/国际标签，按语言定默认、点过以手动为准，下面铺两地面板', () => {
  // 2026-11-27 用户要求：面板区分区分国内 / 国际用户。识别只决定默认标签，不锁死；
  // 用户点一次标签就记住选择，改界面语言也不会被切到另一边。
  const region = read('React', 'src', 'components', 'NetworkRegions.tsx');
  assert.match(region, /usePanelLanguage\(\)/, '默认标签看界面语言，不是系统时区');
  assert.match(region, /language === 'zh-Hans' \|\| language === 'zh-Hant' \? 'cn' : 'global'/, '中文 / 繁体默认中国，其余默认国际');
  assert.match(region, /localStorage\.setItem\(REGION_CHOICE_KEY/, '手动选择要记下来');
  assert.match(region, /chosen \?\? defaultRegionOf\(language\)/, '没手动选过才跟语言走');
  assert.match(region, /t\('panel\.region\.title'\)/, '标题还是服务商线路');
  assert.ok(region.includes("'panel.providerRegion.tabChina'"), '要有中国标签文案');
  assert.ok(region.includes("'panel.providerRegion.tabGlobal'"), '要有国际标签文案');
  const panels = read('React', 'src', 'components', 'ProviderRegionPanel.tsx');
  assert.match(panels, /region === 'cn'/, '中国标签铺 zeronews 面板');
  assert.match(panels, /zeroNewsAccount\(\)/, '中国面板读宿主账号快照');
  assert.match(panels, /<CloudflarePanel/, '国际面板复用 Cloudflare 面板实现');
  // 2026-11-27 用户按截图反馈收敛：面板不放「详细配置」按钮，状态只在 CloudflarePanel 里出现一次；
  // 中国面板也不再铺隧道域名行与「流量用量…」提示，只留使用情况与控制台入口。
  assert.ok(!panels.includes('openDetail'), '面板不再有详细配置入口');
  assert.ok(!panels.includes('consoleHint'), '面板不再摆流量用量提示');
  assert.ok(!panels.includes('tunnels.slice'), '面板不再列隧道域名');
  const globalPart = panels.slice(panels.indexOf('function GlobalProviderPanel'));
  assert.ok(!globalPart.includes('statusText='), 'Cloudflare 头部不再重复显示状态，状态只在面板里');
});

test('ZeroNews 等浏览器确认不再无限转圈：显地址、可重开/重试、超时收口，并留 AuthToken 兜底', () => {
  // 现场反馈：登录页弹不出来 / 确认没生效时，面板只显示「已打开浏览器，请确认登录」一直转圈，
  // 地址被藏起来、按钮锁死，用户只能干看着。现在等确认时把地址摆出来，可重开或点「我已登录，
  // 重试」；等太久自动收口；浏览器这条路走不通还能粘 AuthToken 直接绑。
  const page = read('React', 'src', 'components', 'ZeroNewsPage.tsx');
  assert.match(page, /panel\.zeronews\.loginUrlHint/, '要把确认地址和手动打开的提示摆出来');
  assert.match(page, /panel\.zeronews\.reopen/, '要能重新打开登录页');
  assert.match(page, /panel\.zeronews\.loginRetry/, '要能「我已登录，重试」');
  assert.match(page, /panel\.zeronews\.loginTimeout/, '等太久要收口，不许一直转圈');
  assert.match(page, /setTimeout\(/, '等待要有超时');
  assert.match(page, /async function saveToken/, '要有粘贴 AuthToken 绑定的兜底');
  assert.match(page, /zeroNewsConnect\(value\)/, '兜底要把 token 交给宿主连接');
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of ['panel.zeronews.loginUrlHint', 'panel.zeronews.reopen', 'panel.zeronews.loginRetry', 'panel.zeronews.loginTimeout']) {
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(panel.split(`'${key}':`).length - 1, 11, `${key} 要十一门齐全`);
  }
});


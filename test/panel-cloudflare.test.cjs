// Cloudflare 兜底隧道：ConnectionCard 入口行 + CloudflarePanel 开关/状态源码断言。
// 等待端口时两处都要带出局域网端口的真实错误，别让用户误判这条隧道。
// 接口与文案由 api.ts / panel.ts 钉住；管理弹窗与国际线路页共用 CloudflarePanel，不写两份实现。
'use strict';

/**
 * Cloudflare 兜底隧道的面板这半段。
 *
 * 宿主侧的守护进程、路由另有测试钉着；这条只钉面板：
 *   1. 「连接状态」卡在 TCP 直连那一行下面新起一行「Cloudflare 兜底」，带一颗「管理」按钮；
 *   2. 点「管理」打开的 CloudflareDialog 里有开关，开调 `/api/cloudflare/start`、关调 `/stop`，
 *      请求中禁用、失败行内红字，状态行能读出「可用 / 运行中 / 错误」；
 *   3. 网络配置弹窗那扇已经搬走，不再留第二份实现；
 *   4. api.ts 提供接口与状态类型，中英等十一门语言词条齐平。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('ConnectionCard 在 TCP 行下面新起一行 Cloudflare 兜底，带「管理」按钮', () => {
  const card = read('React', 'src', 'components', 'ConnectionCard.tsx');
  // 这一行放在 TCP 直连那行之后：先出现 panel.connection.tcp，再出现 panel.cloudflare.title。
  const tcpAt = card.indexOf('panel.connection.tcp');
  const cfAt = card.indexOf('panel.cloudflare.title');
  assert.ok(tcpAt > 0, '找不到 TCP 直连那一行');
  assert.ok(cfAt > tcpAt, 'Cloudflare 兜底这一行要在 TCP 直连下面');
  assert.match(card, /onManageCloudflare/, '要接上打开 Cloudflare 弹窗的回调');
  assert.match(card, /cloudflareTextKey/, '状态字要走状态映射');
  assert.match(card, /panel\.cloudflare\.disabled/, '未启用是一种状态');
  assert.match(card, /panel\.cloudflare\.running/, '运行中是一种状态');
  assert.match(card, /ToneValue/, '状态值复用现有的状态点组件');
  assert.match(card, /t\('panel\.(cf|tailcat)\.manage'\)|panel\.cloudflare\.manage/, '「管理」按钮文案走字典');
});

test('CloudflarePanel 有开关，开→start、关→stop，请求中禁用', () => {
  const panel = read('React', 'src', 'components', 'CloudflarePanel.tsx');
  assert.match(panel, /from '@appica\/ui-react\/switch'/, '复用现有的 Switch 组件，别另造一个');
  assert.match(panel, /<Switch/, '要渲染 Switch');
  assert.match(panel, /next \? await cloudflareStart\(\) : await cloudflareStop\(\)/, '开走 start、关走 stop');
  assert.match(panel, /setBusy\(true\)/, '请求开始置忙');
  assert.match(panel, /setBusy\(false\)/, '请求结束清忙');
  assert.match(panel, /disabled=\{disabled\}/, '开关的禁用态要接上');
  assert.match(panel, /const disabled = busy \|\| cf\?\.available === false/, '忙 / 未安装时禁用开关');
});

test('CloudflarePanel 状态行复用 InfoRow / 状态点，从传入的 status.cloudflare 读', () => {
  const panel = read('React', 'src', 'components', 'CloudflarePanel.tsx');
  assert.match(panel, /InfoRow/, '状态行复用现有的 InfoRow');
  assert.match(panel, /ToneValue/, '状态值复用现有的状态点组件');
  assert.match(panel, /status\.cloudflare/, '状态从传入的 status.cloudflare 读');
  assert.match(panel, /panel\.cloudflare\.available/, '要有「可用」态');
  assert.match(panel, /panel\.cloudflare\.running/, '要有「运行中」态');
  assert.match(panel, /panel\.cloudflare\.error/, '要有「错误 / 连不上」态');
  assert.match(panel, /panel\.cloudflare\.url/, '运行中要能显示当前地址');
  assert.match(panel, /cf\.running/, '运行态按 cf.running 判');
  assert.match(panel, /cf\.error/, '错误态按 cf.error 判');
  assert.match(panel, /cf\?\.waitingForPort && status\.lan\?\.error \? status\.lan\.error/, '等端口时带出局域网真实错误');
});

test('连接卡的 Cloudflare 行在等待端口时也带出局域网错误', () => {
  const card = read('React', 'src', 'components', 'ConnectionCard.tsx');
  assert.match(card, /cloudflare\?\.waitingForPort && status\.lan\?\.error \? \{ detail: status\.lan\.error \}/);
});

test('CloudflarePanel 失败按现有方式在行下给红字提示', () => {
  const panel = read('React', 'src', 'components', 'CloudflarePanel.tsx');
  assert.match(panel, /error \? <p className="text-xs text-error">\{error\}<\/p> : null/, '失败沿用现有的红字提示');
  assert.match(panel, /errorText\(err\)/, '网络层错误也要变成一句人话');
  assert.match(panel, /reply\.error\?\.message/, '回包里的失败原因要透出来');
});

test('CloudflareDialog 只做窗口外壳，内容交给共用的 CloudflarePanel', () => {
  const dialog = read('React', 'src', 'components', 'CloudflareDialog.tsx');
  assert.match(dialog, /import \{ CloudflarePanel \} from '\.\/CloudflarePanel\.tsx'/, '内容来自共用组件');
  assert.match(dialog, /<CloudflarePanel status=\{status\} onChanged=\{onChanged\} \/>/, '弹窗只把状态与回调传下去');
  assert.doesNotMatch(dialog, /cloudflareStart|cloudflareStop/, '开关与请求逻辑只在 CloudflarePanel 一份');
});

test('网络配置弹窗不再重复一份 Cloudflare 开关', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.doesNotMatch(dialog, /panel\.cloudflare\./, 'Cloudflare 那一栏已挪到 ConnectionCard + CloudflareDialog，别留两份实现');
  assert.doesNotMatch(dialog, /cloudflareStart|cloudflareStop/, '网络配置弹窗不再直接调 Cloudflare 接口');
});

test('Console 挂上 CloudflareDialog 并把 onManageCloudflare 传给 ConnectionCard', () => {
  const src = read('React', 'src', 'Console.tsx');
  assert.match(src, /import \{ CloudflareDialog \}/, '要引入 CloudflareDialog');
  assert.match(src, /onManageCloudflare=\{/, '连接卡要接上打开弹窗的回调');
  assert.match(src, /<CloudflareDialog[\s\S]*?open=\{cloudflareOpen\}/, '要渲染 CloudflareDialog');
});

test('api.ts 提供 cloudflareStart / cloudflareStop，打对路径，并给状态类型', () => {
  const api = read('React', 'src', 'lib', 'api.ts');
  assert.match(api, /export function cloudflareStart\(\): Promise<CloudflareActionReply> \{\s*return apiPost\('\/api\/cloudflare\/start'\)/, '开启走 POST /api/cloudflare/start');
  assert.match(api, /export function cloudflareStop\(\): Promise<CloudflareActionReply> \{\s*return apiPost\('\/api\/cloudflare\/stop'\)/, '关闭走 POST /api/cloudflare/stop');
  assert.match(api, /export type CloudflareStatus = \{/, '要有 CloudflareStatus 类型');
  for (const field of ['available', 'enabled', 'running', 'url', 'error', 'startedAt', 'starting', 'retrying', 'waitingForPort']) {
    assert.match(api, new RegExp(`\\b${field}[?]?:`), `CloudflareStatus 要带 ${field}`);
  }
  assert.match(api, /cloudflare\?: CloudflareStatus \| null/, 'StatusView 要带上 cloudflare 这一格');
  const view = api.slice(api.indexOf('export type StatusView'));
  const at = view.indexOf('cloudflare?:');
  assert.ok(at > 0 && at < view.indexOf('}'), 'cloudflare 字段要在 StatusView 里');
});

test('Cloudflare 那批文案在十一门语言里都有', () => {
  const panel = read('React', 'src', 'lib', 'i18n', 'messages', 'panel.ts');
  for (const key of [
    'title',
    'state',
    'available',
    'unavailable',
    'running',
    'starting',
    'retrying',
    'waitingForPort',
    'url',
    'error',
    'disabled',
  ]) {
    const needle = `'panel.cloudflare.${key}':`;
    const count = panel.split(needle).length - 1;
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(count, 11, `${needle} 要有十一门语言，实际 ${count}`);
  }
});

test('远程电脑线路里 cloudflare 通道有中文名，十一门语言齐平', () => {
  const remote = read('React', 'src', 'lib', 'i18n', 'messages', 'remote-computers.ts');
  const needle = "'panel.remote.channel.cloudflare':";
  // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
  assert.equal(remote.split(needle).length - 1, 11, `${needle} 要有十一门语言`);
  const card = read('React', 'src', 'components', 'RemoteComputersCard.tsx');
  assert.match(card, /cloudflare: 'cloudflare'/, 'channelText 的键映射要认得 cloudflare');
});

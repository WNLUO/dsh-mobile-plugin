// Cloudflare 兜底隧道：面板开关 + 状态行只读源码断言，接口与文案由 api.ts / panel.ts 钉住。
'use strict';

/**
 * 面板「网络配置」里的 Cloudflare 兜底隧道开关与状态行。
 *
 * 宿主侧的守护进程、路由另有测试钉着；这条只钉面板这半段：开关渲染、开/关分别打
 * `/api/cloudflare/start` / `/stop`、状态行能读出「可用 / 运行中 / 错误」三种态，
 * 以及中英等十门语言的词条齐平。少了任何一段，用户在这扇窗里都开不了、也看不出这条兜底在不在跑。
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('网络配置弹窗有「Cloudflare 兜底隧道」开关，复用 Switch 组件', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /panel\.cloudflare\.title/, '要有「Cloudflare 兜底隧道」这一栏');
  assert.match(dialog, /from '@appica\/ui-react\/switch'/, '复用现有的 Switch 组件，别另造一个');
  assert.match(dialog, /<Switch/, '要渲染 Switch');
  assert.match(dialog, /onCheckedChange=\{\(next\) => void toggleCloudflare\(next\)\}/, '开关切换要交给 toggleCloudflare');
});

test('开→调 start、关→调 stop，请求中禁用开关', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /next \? await cloudflareStart\(\) : await cloudflareStop\(\)/, '开走 start、关走 stop');
  assert.match(dialog, /setCfBusy\(true\)/, '请求开始置忙');
  assert.match(dialog, /setCfBusy\(false\)/, '请求结束清忙');
  assert.match(dialog, /disabled=\{cfDisabled\}/, '开关的禁用态要接上');
  assert.match(dialog, /const cfDisabled = !canSave \|\| cfBusy \|\| cf\?\.available === false/, '忙 / 全局禁用 / 未安装时禁用开关');
});

test('状态行复用 InfoRow / 状态点，读出 可用 / 运行中 / 错误 三种态', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /InfoRow/, '状态行复用现有的 InfoRow');
  assert.match(dialog, /ToneValue/, '状态值复用现有的状态点组件');
  assert.match(dialog, /status\.cloudflare/, '状态从 /api/relay/status 的 cloudflare 格读');
  assert.match(dialog, /panel\.cloudflare\.available/, '要有「可用」态');
  assert.match(dialog, /panel\.cloudflare\.running/, '要有「运行中」态');
  assert.match(dialog, /panel\.cloudflare\.error/, '要有「错误」态');
  assert.match(dialog, /panel\.cloudflare\.url/, '运行中要能显示当前地址');
  assert.match(dialog, /cf\.running/, '运行态按 cf.running 判');
  assert.match(dialog, /cf\.error/, '错误态按 cf.error 判');
});

test('失败按现有方式在行下给红字提示', () => {
  const dialog = read('React', 'src', 'components', 'RelayConfigDialog.tsx');
  assert.match(dialog, /cfError \? <p className="text-xs text-error">\{cfError\}<\/p> : null/, '失败沿用现有的红字提示');
  assert.match(dialog, /errorText\(err\)/, '网络层错误也要变成一句人话');
  assert.match(dialog, /reply\.error\?\.message/, '回包里的失败原因要透出来');
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

test('Cloudflare 那批文案在十门语言里都有', () => {
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
  ]) {
    const needle = `'panel.cloudflare.${key}':`;
    const count = panel.split(needle).length - 1;
    assert.equal(count, 10, `${needle} 要有十门语言，实际 ${count}`);
  }
});

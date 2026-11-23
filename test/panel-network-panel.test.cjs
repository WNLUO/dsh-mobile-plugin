'use strict';

/**
 * 网络面板（顶卡右列）：单一容器，里面只画当前中转的延迟折线，不摆文字。
 * 容器高度由外层 grid 拉齐左列；延迟走宿主代测，曲线与色档复用公用中转面板那一份。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('顶卡右列挂网络面板，单一容器且高度拉齐左列', () => {
  const app = read('React', 'src', 'Console.tsx');
  assert.match(app, /lg:col-span-4">\s*<NetworkPanel status=\{status\}/, '右列挂网络面板');
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /<Card frame="solid" className="h-full min-h-0 p-4">/, '单一容器且高度拉齐');
  assert.equal((panel.match(/<section|<div/g) ?? []).length, 0, '里面没有内衬容器');
  assert.doesNotMatch(panel, /from '\.\.\/lib\/i18n\/index\.ts'/, '不接字典');
  assert.doesNotMatch(panel, /<p\b|<h[1-6]\b|<span\b/, '不渲染任何文字节点');
});

test('延迟走宿主代测，曲线与色档只有一份实现', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /\/api\/relay\/probe-relays/, '由宿主代测，不在浏览器直连');
  assert.match(panel, /latencySparklinePath/, '曲线走共用尺子');
  assert.match(panel, /latencyStrokeColor/, '描边色走共用函数');
  assert.match(panel, /setInterval\(\(\) => \{ void probe\(\) \}, PROBE_INTERVAL_MS\)/, '按时取样');
  assert.match(panel, /\.slice\(-HISTORY_POINTS\)/, '历史窗口滚动裁剪');
  const lib = read('React', 'src', 'lib', 'latency-sparkline.ts');
  assert.match(lib, /export function latencyColorClass/);
  assert.match(lib, /export function latencyStrokeColor/);
  const dialog = read('React', 'src', 'components', 'PublicRelayPanelDialog.tsx');
  assert.match(dialog, /latencyColorClass/, '公用中转面板也从同一份取色');
  assert.doesNotMatch(dialog, /function latencyColorClass/, '本地不再写第二份');
});

'use strict';

/**
 * 网络面板（顶卡右列）：照用户给的样式——四个指标 + 带网格的双曲线。
 * 所有数字都来自当前中转的真实延迟采样；没有数据源的流量数字一律不摆。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('顶卡两列同处一个 flex 行，面板绝对定位填满、高度完全跟左列', () => {
  const app = read('React', 'src', 'Console.tsx');
  assert.match(app, /<NetworkPanel status=\{status\} \/>/, '右列挂网络面板');
  assert.match(app, /flex flex-col gap-4 p-4 lg:flex-row/, '两列同处一个 flex 行');
  assert.match(app, /className="relative lg:w-2\/5"/, '右列只给宽度，不撑高度');
  assert.match(app, /className="lg:absolute lg:inset-0"/, '宽屏绝对定位填满，高度由左列决定');
  assert.doesNotMatch(app, /pairingColumnRef|panelHeight/, '不再量高度套给右列');
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /<Card frame="solid" className="h-full min-h-0 p-3">/, '单一容器，撑满 stretch 给的高度');
  assert.equal((panel.match(/<Card\b/g) ?? []).length, 1, '只有一层卡片容器');
});

test('四个指标与双曲线都从真实延迟采样算出来', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /\/api\/relay\/probe-relays/, '由宿主代测，不在浏览器直连');
  assert.match(panel, /setInterval\(\(\) => \{ void probe\(\) \}, PROBE_INTERVAL_MS\)/, '按时取样');
  assert.match(panel, /\.slice\(-HISTORY_POINTS\)/, '历史窗口滚动裁剪');
  for (const key of ['panel.network.current', 'panel.network.average', 'panel.network.min', 'panel.network.max']) {
    assert.ok(panel.includes(`key: '${key}'`), `${key} 指标卡要挂上`);
  }
  assert.match(panel, /const valid = history/, '指标从采样里算，不写死');
  assert.match(panel, /const smoothed = history\.map/, '平滑线由同一份采样算');
  assert.match(panel, /GRID_MAX_MS = 500/, '纵轴刻度钉死，不让一次尖峰压平平时');
});

test('图里有网格、双线和渐变，没有流量假数字', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /strokeDasharray="4 4"/, '横向虚线网格');
  assert.equal((panel.match(/<linearGradient/g) ?? []).length, 2, '两条曲线各一份渐变');
  assert.match(panel, /#f59e0b/, '橙线');
  assert.match(panel, /#22c55e/, '绿线');
  assert.match(panel, /clock\(at\)/, '底部时间轴');
  assert.doesNotMatch(panel, /总发送|总接收|上行|下行|MB|TB/, '不摆没有数据源的流量数字');
});

test('指标文案十门齐', () => {
  const dict = read('React', 'src', 'lib', 'i18n', 'messages', 'network-panel.ts');
  for (const key of ['panel.network.current', 'panel.network.average', 'panel.network.min', 'panel.network.max']) {
    assert.equal(dict.split(`'${key}':`).length - 1, 10, `${key} 十门齐`);
  }
});

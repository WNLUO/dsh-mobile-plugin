'use strict';

/**
 * 网络面板（顶卡右列）：一个容器，里面先放延迟曲线和流量占位。
 *
 * 延迟必须走宿主代测（浏览器直连会被 CORS 挡，读到的是拦截不是真实耗时），曲线与色档
 * 复用公用中转面板那一份；流量目前没有真实接口，这里钉住「明确写暂无统计、不摆假数字」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('顶卡右列挂网络面板容器，容器里分块摆内容', () => {
  const app = read('React', 'src', 'Console.tsx');
  assert.match(app, /lg:col-span-4">\s*<NetworkPanel status=\{status\}/, '右列挂网络面板');
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /<Card frame="solid">/, '面板自己是一张卡容器');
  assert.equal((panel.match(/<section/g) ?? []).length, 2, '容器里先分延迟与流量两块');
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

test('流量格明确写暂无统计，不摆假数字', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /panel\.network\.trafficEmpty/, '流量格走字典里的暂无统计');
  assert.doesNotMatch(panel, /Math\.random|mock|sampleData|fake/, '不造看起来像真的数字');
});

test('面板文案十门齐', () => {
  const dict = read('React', 'src', 'lib', 'i18n', 'messages', 'network-panel.ts');
  for (const key of [
    'panel.network.title',
    'panel.network.latencyTitle',
    'panel.network.latencyHint',
    'panel.network.noRelay',
    'panel.network.trafficTitle',
    'panel.network.trafficEmpty',
  ]) {
    assert.equal(dict.split(`'${key}':`).length - 1, 10, `${key} 十门齐`);
  }
});

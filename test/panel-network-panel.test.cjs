'use strict';

/**
 * 网络面板（顶卡右列）：手机↔本机这条连接的真实上下行流速。
 * 数据来自宿主 `/api/relay/traffic` 的累计快照序列；面板按时间铺开、逐帧向左流动。
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
  assert.match(app, /flex flex-col gap-4 p-4 min-\[880px\]:flex-row min-\[880px\]:gap-6/, '两列同处一个 flex 行（880px 起并排）');
  assert.match(app, /className="relative min-w-0 min-\[880px\]:w-2\/5"/, '右列只给宽度，不撑高度，且可压缩');
  assert.match(app, /className="min-\[880px\]:absolute min-\[880px\]:inset-0"/, '宽屏绝对定位填满，高度由左列决定');
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  // 2026-11-23 用户要求：去掉外框与浅色底、内容上下与二维码区域齐平（无上下内边距）。
  assert.match(panel, /<Card frame=\{false\} inset=\{false\} className="h-full min-h-0 px-1" contentProps=\{\{ className: 'border-0' \}\}>/, '单一容器，内容与二维码区同高、无外框');
  assert.equal((panel.match(/<Card\b/g) ?? []).length, 1, '只有一层卡片容器');
});

test('四个指标与两条曲线都从真实流量算出来', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /getTraffic\(\)/, '读宿主真实流量接口，不自己编数字');
  assert.match(panel, /\/api\/relay\/traffic/, '数据来自流量接口');
  assert.match(panel, /payload\.samples/, '用宿主给的累计快照序列');
  assert.match(panel, /const sentDelta = current\.sentBytes - previous\.sentBytes/, '上行速率由相邻快照差算');
  assert.match(panel, /const receivedDelta = current\.receivedBytes - previous\.receivedBytes/, '下行速率由相邻快照差算');
  for (const key of ['panel.network.up', 'panel.network.down', 'panel.network.totalSent', 'panel.network.totalReceived']) {
    assert.ok(panel.includes(`key: '${key}'`), `${key} 指标卡要挂上`);
  }
  assert.match(panel, /MIN_SCALE_BYTES_PER_SEC/, '纵轴有下限量程，0..0 不会把网格压扁');
  assert.doesNotMatch(panel, /probe-relays/, '不再走延迟探针那套');
});

test('图里有网格、双线、平滑曲线，且是逐帧向左流动', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /strokeDasharray="4 4"/, '横向虚线网格');
  assert.equal((panel.match(/<linearGradient/g) ?? []).length, 2, '两条曲线各一份渐变');
  assert.match(panel, /#f59e0b/, '上行橙线');
  assert.match(panel, /#22c55e/, '下行绿线');
  assert.match(panel, /function clock\(at/, '底部时间轴');
  assert.match(panel, /function smoothPath/, '曲线用平滑段（Catmull-Rom 转贝塞尔）');
  assert.match(panel, /C\$\{cp1x/, '贝塞尔控制点拼进路径');
  assert.match(panel, /WINDOW_MS = 60_000/, '横轴按最近一分钟铺开');
  assert.match(panel, /requestAnimationFrame/, '常驻帧循环，逐帧重画');
  assert.match(panel, /RENDER_FPS/, '按帧率节流重画');
  assert.match(panel, /x: WIDTH/, '末尾沿当前速率平推到右边界（流动/缓冲）');
});

test('纵轴量程有迟滞、会缓动，不随每秒数据抖动', () => {
  const panel = read('React', 'src', 'components', 'NetworkPanel.tsx');
  assert.match(panel, /axisTargetRef/, '量程目标单独存一份');
  assert.match(panel, /axisInitRef/, '初次一次性对齐');
  assert.match(panel, /peak > axisTargetRef\.current \* 1\.02/, '明显变大才抬高');
  assert.match(panel, /peak < axisTargetRef\.current \* 0\.5/, '明显变小才收窄');
  assert.match(panel, /AXIS_TAU_SECONDS/, '量程过渡是缓动的');
});

test('指标文案十一门齐', () => {
  const dict = read('React', 'src', 'lib', 'i18n', 'messages', 'network-panel.ts');
  for (const key of ['panel.network.up', 'panel.network.down', 'panel.network.totalSent', 'panel.network.totalReceived']) {
    // 2026-11-26：新增土耳其语，界面语言数由 10 变 11，断言跟着抬。
    assert.equal(dict.split(`'${key}':`).length - 1, 11, `${key} 十一门齐`);
  }
});

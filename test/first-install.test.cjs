'use strict';

/**
 * 「第一次装进一台正在跑的 DSH」的判定：只钉那个纯函数 `decideNeedsRestart`。
 *
 * 现场取样（落盘时间 / 进程启动时间 / 标记文件）都在调用方，纯函数只回答要不要提示重启。
 * 四种组合都要覆盖，因为这四种恰好对应四种真实处境：
 *   · 首次 + 装的时候 DSH 开着  → 要提示（这是本次需求的全部）；
 *   · 首次 + 装的时候 DSH 关着  → 不提示（下次启动自然就加载了）；
 *   · 已经跑过（连更新都算）    → 不提示（换代不靠重启）；
 *   · 取不到落盘时间            → 不提示（宁可少提醒，不给假提醒）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../lib/shell/first-install.js');

test('首次安装、且落盘晚于进程启动：要提示重启', async () => {
  const { decideNeedsRestart } = await load();
  assert.equal(decideNeedsRestart({ seenBefore: false, installedBirthMs: 2000, processStartMs: 1000 }), true);
});

test('首次安装、但装的时候 DSH 本来就没开（落盘早于启动）：不提示', async () => {
  const { decideNeedsRestart } = await load();
  assert.equal(decideNeedsRestart({ seenBefore: false, installedBirthMs: 1000, processStartMs: 2000 }), false);
});

test('这个 profile 里跑过（哪怕只是更新）：一律不提示', async () => {
  const { decideNeedsRestart } = await load();
  assert.equal(decideNeedsRestart({ seenBefore: true, installedBirthMs: 2000, processStartMs: 1000 }), false);
});

test('取不到落盘时间（源码挂载 / 无头部署）：不提示', async () => {
  const { decideNeedsRestart } = await load();
  assert.equal(decideNeedsRestart({ seenBefore: false, installedBirthMs: null, processStartMs: 1000 }), false);
});

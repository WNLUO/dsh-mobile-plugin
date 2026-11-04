'use strict';

/**
 * CLI 会话的三件「跟正常对话对齐」的事：指标行、模型显示开关、模型名前缀。
 *
 * 钉的是用户能立刻看到的断法：
 *   1. 底部那行指标（tok/s · 缓存命中 · 上下文）在 CLI 会话上过去一直是空的 —— 那两个来源
 *      本来就有（`usage_update` 通知 + prompt 回包的累计 usage），只是没人接；
 *   2. 模型管理页的开关必须**存在电脑上**（换手机也一致），而且只影响显示；
 *   3. `OpenCode Go/xxx` 这种名字里的渠道前缀要摘掉，否则每行同一个词开头、厂商也认不出。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-usage-'));
process.env.DSH_HOME = HOME;

const usage = require('../lib/mobile/cli/usage.js');
const visibility = require('../lib/mobile/cli/model-visibility.js');
const { modelLabelOf } = require('../lib/mobile/cli/mobile.js');

test('上下文占用：usage_update 报到 used / size 才给，缺一个都不编', () => {
  const u = usage.createUsage();
  assert.deepEqual(usage.statsOf(u).contextPressure, undefined);
  assert.equal(usage.applyUsageUpdate(u, { used: 8715, size: 200000 }), true);
  assert.deepEqual(usage.statsOf(u).contextPressure, { contextWindow: 200000, pressureTokens: 8715 });
  // 只有 used 没有 size：窗口不知道，宁可不给这一项。
  const half = usage.createUsage();
  usage.applyUsageUpdate(half, { used: 100 });
  assert.equal(usage.statsOf(half).contextPressure, undefined);
});

test('token 用量：ACP 的 inputTokens 含缓存，三个桶要分开算', () => {
  const u = usage.createUsage();
  usage.applyPromptUsage(u, { usage: { inputTokens: 6923, outputTokens: 3, totalTokens: 8718, cachedReadTokens: 1792 } }, 2790);
  const stats = usage.statsOf(u);
  assert.deepEqual(stats.tokenUsage, {
    uncachedInputTokens: 6923 - 1792,
    outputTokens: 3,
    cacheReadTokens: 1792,
    cacheWriteTokens: 0,
  });
  // 缓存命中率与 App 那条公式同一口径：cacheRead / 三个桶之和。
  const billed = stats.tokenUsage.uncachedInputTokens + 1792 + 0;
  assert.equal(usage.cacheHitPercent(1792, billed), Math.round((1792 / billed) * 100));
  assert.equal(usage.cacheHitPercent(0, 0), null, '没有输入计费量时是 null，不是 0%');
});

test('token 速度按这一轮算：累计输出要减掉上一轮的快照', () => {
  const u = usage.createUsage();
  usage.applyPromptUsage(u, { usage: { inputTokens: 10, outputTokens: 100 } }, 1000);
  assert.equal(usage.statsOf(u).sessionStats.decodeTokens, 100);
  usage.applyPromptUsage(u, { usage: { inputTokens: 20, outputTokens: 260 } }, 2000);
  const stats = usage.statsOf(u).sessionStats;
  assert.equal(stats.decodeTokens, 160, '第二轮是 260 − 100');
  assert.equal(stats.turns, 2);
  assert.equal(stats.llmMs, 3000);
});

test('适配器不回 usage 时不画假数字：一个字段都不给', () => {
  const u = usage.createUsage();
  usage.applyPromptUsage(u, {}, 1200);
  const stats = usage.statsOf(u);
  assert.equal(stats.tokenUsage, undefined);
  assert.equal(stats.contextPressure, undefined);
  // 轮数与耗时还是真的（那是我们自己量的），所以这一项照给。
  assert.equal(stats.sessionStats.turns, 1);
});

test('模型显示开关：按 CLI 记一份、只记关掉的，换手机读到的是同一份', () => {
  assert.deepEqual(visibility.hiddenOf('opencode'), { models: [], configs: [] });
  visibility.setVisible('opencode', 'model', 'opencode/big-pickle', false);
  visibility.setVisible('opencode', 'config', 'opencode-go', false);
  assert.deepEqual(visibility.hiddenOf('opencode'), { models: ['opencode/big-pickle'], configs: ['opencode-go'] });
  // 另一个 CLI 是另一本账。
  assert.deepEqual(visibility.hiddenOf('codex'), { models: [], configs: [] });
  // 「打开」= 从账里删掉，而不是记一个 true —— 模型目录天天在长，记白名单会让新模型默认不出现。
  visibility.setVisible('opencode', 'model', 'opencode/big-pickle', true);
  assert.deepEqual(visibility.hiddenOf('opencode'), { models: [], configs: ['opencode-go'] });
  // 落盘了：重新 require 之后还在（进程重启 / 换手机都是读这个文件）。
  const raw = JSON.parse(fs.readFileSync(visibility.storeFile(), 'utf8'));
  assert.deepEqual(raw.agents.opencode, { configs: ['opencode-go'] });
});

test('模型名摘掉渠道前缀：有信息的那段变成标签', () => {
  assert.deepEqual(modelLabelOf('opencode-go/gemini-4-argon', 'OpenCode Go/Gemini 4 Argon'), { name: 'Gemini 4 Argon', tag: 'Go' });
  assert.deepEqual(modelLabelOf('opencode/big-pickle', 'OpenCode/Big Pickle'), { name: 'Big Pickle', tag: '' });
  // 不带前缀 / 前缀不是这家 CLI 名字的：原样留着，不猜。
  assert.deepEqual(modelLabelOf('plain', 'Plain Model'), { name: 'Plain Model', tag: '' });
  assert.deepEqual(modelLabelOf('x/y', 'Some Vendor/Model'), { name: 'Some Vendor/Model', tag: '' });
});

test('图标缓存：官方 SVG 原样收着（描边那几家不能被筛没），拉不到就空着', () => {
  const icons = require('../lib/mobile/cli/icons.js');
  // 尺寸由 App 给、viewBox 留着（各家画布不一样，丢了会裁掉大半）。
  const filled = icons.normalizeSvg('<svg width="16" height="16" viewBox="0 0 1200 1200"><path d="M0 0h1"/></svg>');
  assert.match(filled, /viewBox="0 0 1200 1200"/);
  assert.doesNotMatch(filled, /width="16"/);
  // 描边写法（Agoragentic 那枚是圆 + 三条线）：不能按「只留 path」筛掉。
  const stroked = icons.normalizeSvg('<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" stroke="currentColor"/></svg>');
  assert.match(stroked, /<circle /);
  assert.equal(icons.normalizeSvg('not svg'), '');
  assert.equal(icons.normalizeSvg('<svg viewBox="0 0 8 8"></svg>'), '', '里头什么都没有等于没拉到');
});

test('清单只列装了的：注册表补进来的要探到包，内置四条不受此限', () => {
  const agents = require('../lib/mobile/cli/agents.js');
  const installed = new Set(['cline']);
  const cline = { id: 'cline', label: 'Cline', transport: 'npx', package: 'cline@3.0.74' };
  const bob = { id: 'bob', label: 'Bob', transport: 'npx', package: '@ibm/bob@2.0.9' };
  assert.equal(agents.isInstalled(cline, installed), true, '装了 cline 就算装了（包名带版本要摘掉）');
  assert.equal(agents.isInstalled(bob, installed), false, '没装的不算');
  assert.equal(agents.barePackage('@ibm/bob@2.0.9'), '@ibm/bob');
  assert.equal(agents.barePackage('cline@3.0.74'), 'cline');
});

'use strict';

/**
 * 厂商识别与品牌图标的守卫。
 *
 * 认错厂商的代价比认不出大得多：那一行前面摆的是别家的 logo，用户会以为自己的量跑到了别家。
 * 所以这里钉两类断言 —— 「同一个模型的不同写法都要认出同一家」（`deepseek-v4.1-flash` /
 * `DeepSeek V4.1 flash` / `deepseek_v4_1_flash`），以及「认不出就空着，不许兜一个默认厂商」。
 *
 * 顺带把图标表本身也验一遍：App 那边是 `SvgXml` 直接渲染，带 fill / style / defs 的写法
 * 到手机上要么不显示、要么画成一坨黑块，而这两种失效在 JS 侧都是静默的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { VENDOR_LOGOS } = require('../lib/mobile/vendor-logos.cjs');
const { foldText, vendorOfText, identifyVendor, vendorLogoOf } = require('../lib/mobile/model-vendors.js');
const ledger = require('../lib/mobile/stats-ledger.cjs');

test('规范化：大小写与分隔符不影响识别', () => {
  assert.equal(foldText('DeepSeek-V4.1-flash'), 'deepseekv41flash');
  assert.equal(foldText('DeepSeek V4.1 flash'), foldText('deepseek_v4_1_flash'));
  assert.equal(foldText('  '), '');
  assert.equal(foldText(null), '');
  // 汉字保留：国产模型的别名常常是中文。
  assert.equal(foldText('深度求索 V3'), '深度求索v3');
});

test('同一个模型的不同写法认出同一家', () => {
  const spellings = [
    'deepseek-v4.1-flash',
    'DeepSeek V4.1 flash',
    'deepseek_v4_1_flash',
    'DeepSeek/V4.1-flash',
    'deepseekv4.1flash',
    '深度求索-v4.1-flash',
  ];
  assert.deepEqual([...new Set(spellings.map((name) => vendorOfText(name)))], ['deepseek']);
});

test('各家主力模型的写法都认得出', () => {
  const cases = [
    ['claude-sonnet-4-5', 'anthropic'],
    ['Claude Opus 4.1', 'anthropic'],
    ['gpt-5-mini', 'openai'],
    ['GPT 4o', 'openai'],
    ['o3-mini', 'openai'],
    ['codex-mini-latest', 'openai'],
    ['gemini-2.5-pro', 'google'],
    ['Gemma-3-27B', 'google'],
    ['qwen3-max', 'alibaba'],
    ['通义千问-Plus', 'alibaba'],
    ['kimi-k2', 'moonshot'],
    ['Moonshot-v1-128k', 'moonshot'],
    ['glm-4.6', 'zhipu'],
    ['chatglm3-6b', 'zhipu'],
    ['llama-3.3-70b-instruct', 'meta'],
    ['mistral-large-latest', 'mistral'],
    ['mixtral-8x22b', 'mistral'],
    ['grok-4', 'xai'],
    ['command-r-plus', 'cohere'],
    ['doubao-seed-1.6', 'bytedance'],
    ['豆包-pro', 'bytedance'],
    ['ernie-4.5-turbo', 'baidu'],
    ['hunyuan-t1', 'tencent'],
    ['minimax-m2', 'minimax'],
    ['nemotron-4-340b', 'nvidia'],
    ['phi-4', 'microsoft'],
  ];
  for (const [name, vendor] of cases) {
    assert.equal(vendorOfText(name), vendor, `${name} → ${vendorOfText(name)}`);
  }
  // 图标表里没那一家时只是「画不出 logo」，认出来的厂商 id 不变（页面退回首字母徽标）。
  const recognized = new Set(cases.map(([, vendor]) => vendor));
  const withLogo = [...recognized].filter((vendor) => VENDOR_LOGOS[vendor]);
  assert.ok(withLogo.length >= 10, `只有 ${withLogo.length} 家能画 logo`);
  assert.equal(vendorLogoOf('zhipu'), null);
});

test('认不出就空着：不许兜一个默认厂商', () => {
  assert.equal(vendorOfText('route-model-a'), '');
  assert.equal(vendorOfText('my-finetune-001'), '');
  assert.equal(vendorOfText(''), '');
  // 短词只在整段上认：`o3` 是 OpenAI 的型号，但 `sol3` 这种串里出现不算。
  assert.equal(vendorOfText('sol3-preview'), '');
  // 模型名认不出时用渠道兜底（网关渠道常见：渠道叫 anthropic、模型名是自家别名）。
  assert.equal(identifyVendor({ model: 'route-model-a', provider: 'anthropic' }), 'anthropic');
  // 两边都认不出 → 空串，页面退回首字母徽标。
  assert.equal(identifyVendor({ model: 'route-model-a', provider: 'mygateway' }), '');
  // 名字写得清楚时以名字为准，不被渠道带跑（自建渠道可以挂任何模型）。
  assert.equal(identifyVendor({ modelName: 'Claude Sonnet 4.5', provider: 'mygateway' }), 'anthropic');
  // 模型名认出的那一家暂时没有图标（GLM / Grok / Cohere 就是），只能退回首字母 ——
  // 不许接着拿渠道名再认一遍，那会把 Grok 摆上 OpenAI 的标。
  assert.equal(identifyVendor({ model: 'grok-4', provider: 'openai' }), 'xai');
  assert.equal(vendorLogoOf(identifyVendor({ model: 'grok-4', provider: 'openai' })), null);
});

test('图标表本身能被 SvgXml 直接渲染', () => {
  const vendors = Object.keys(VENDOR_LOGOS);
  assert.ok(vendors.length >= 10, `只认得出 ${vendors.length} 家`);
  for (const vendor of vendors) {
    const entry = VENDOR_LOGOS[vendor];
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0, `${vendor} 缺展示名`);
    const icon = entry.icon;
    assert.match(icon, /^<svg [^>]*viewBox="[^"]+"[^>]*>/, `${vendor} 的 svg 头不对`);
    assert.match(icon, /<path /, `${vendor} 没有 path`);
    // 上色由主题给：图标里自带 fill / style / defs 就没法着色，SvgXml 也可能整块不画。
    assert.ok(!/fill=|style=|<defs|<mask|<linearGradient|<image|[\n\r]/.test(icon), `${vendor} 的图标带了不该有的东西`);
    assert.ok(icon.length < 8000, `${vendor} 的图标过大（${icon.length} 字节）`);
  }
  assert.equal(vendorLogoOf('deepseek').name, 'DeepSeek');
  assert.equal(vendorLogoOf('nope'), null);
});

test('总览里：认得出的模型带 vendor，图标只随用到的那几家下发', () => {
  const now = Date.now();
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, models: {}, composition: null };
  ledger.applyDelta(book, {
    sessionId: 's1',
    at: now,
    delta: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, turns: 1, steps: 1 },
    model: { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 flash' },
  });
  ledger.applyDelta(book, {
    sessionId: 's2',
    at: now,
    delta: { uncachedInputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, turns: 1, steps: 1 },
    model: { provider: 'mygateway', providerName: '我的网关', model: 'route-model-a', modelName: '' },
  });

  const overview = ledger.summarize(book, '7d', now);
  const byModel = Object.fromEntries(overview.models.map((row) => [row.model, row]));
  assert.equal(byModel['deepseek-v4.1-flash'].vendor, 'deepseek');
  // 认不出的那条不带 vendor 字段（不是空串）：页面据此退回首字母徽标。
  assert.equal('vendor' in byModel['route-model-a'], false);
  assert.deepEqual(Object.keys(overview.vendors), ['deepseek']);
  assert.match(overview.vendors.deepseek.icon, /^<svg /);
});

test('一个厂商都没认出来时整项不出', () => {
  const now = Date.now();
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, models: {}, composition: null };
  ledger.applyDelta(book, {
    sessionId: 's1',
    at: now,
    delta: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, turns: 1, steps: 1 },
    model: { provider: 'mygateway', model: 'route-model-a' },
  });
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.models.length, 1);
  assert.equal('vendors' in overview, false);
});

'use strict';

/**
 * 模型单价的守卫：查价规则（先渠道、再同名、认不出不猜）、四档折算，以及那张快照本身。
 *
 * 这一组全部跑真实现：查找规则错了不会报错，只会让统计页那行钱**悄悄不见了**或者差一个数量级，
 * 所以「按什么顺序找」「找不到时给什么」都要被钉住。快照那半只钉形状与规模 —— 价格本身会变，
 * 钉具体数字只会在下次重新生成时假红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AS_OF, costOfUsage, foldKey, priceOf } = require('../lib/mobile/model-prices.cjs');
const table = require('../lib/mobile/model-prices-table.cjs');

/** 一份小表：一份各家同价、一份逐渠道价（含一个和同名价不一样的那条）。 */
const FAKE = {
  byModel: { 'sharedmodel': [1, 2, 0.1, 0.2] },
  byProviderModel: {
    'deepseek/deepseekchat': [0.3, 1.2, 0.006, 0],
    'openaigateway/sharedmodel': [9, 9, 9, 9],
  },
};

test('归一化：大小写、分隔符都折掉，汉字保留', () => {
  assert.equal(foldKey('DeepSeek-V4.1 Flash'), 'deepseekv41flash');
  assert.equal(foldKey('deepseek_v4_1_flash'), 'deepseekv41flash');
  assert.equal(foldKey('GLM 4.6'), 'glm46');
  assert.equal(foldKey('通义 千问3'), '通义千问3');
  assert.equal(foldKey(''), '');
  assert.equal(foldKey(null), '');
});

test('先按「渠道 + 模型」精确查，归一化之后才对得上', () => {
  assert.deepEqual(priceOf('deepseek', 'deepseek-chat', FAKE), [0.3, 1.2, 0.006, 0]);
  assert.deepEqual(priceOf('DeepSeek', 'DeepSeek_Chat', FAKE), [0.3, 1.2, 0.006, 0], '写法不同也认得出');
});

test('认不出渠道时退到「同名模型各家同价」那一份', () => {
  assert.deepEqual(priceOf('route-model-a', 'Shared-Model', FAKE), [1, 2, 0.1, 0.2]);
  assert.deepEqual(priceOf('', 'shared model', FAKE), [1, 2, 0.1, 0.2], '没有渠道也照样查');
});

test('渠道自己有报价时以它为准，不被同名那一份盖掉', () => {
  assert.deepEqual(priceOf('openai-gateway', 'shared-model', FAKE), [9, 9, 9, 9]);
});

test('同名但各家报的价不一致、渠道又认不出：不猜，返回 null', () => {
  const conflicting = { byModel: {}, byProviderModel: { 'a/x': [1, 1, 1, 1], 'b/x': [2, 2, 2, 2] } };
  assert.equal(priceOf('route-model-a', 'x', conflicting), null);
  assert.deepEqual(priceOf('a', 'x', conflicting), [1, 1, 1, 1], '认得出渠道就照它的价');
});

test('查不到就是 null：不返回 0（0 是「免费」，null 是「没有价」）', () => {
  assert.equal(priceOf('deepseek', 'never-heard-of-it', FAKE), null);
  assert.equal(priceOf('whatever', '', FAKE), null);
});

test('四档折算：每档各算各的，缓存读按缓存读价、缓存写按缓存写价', () => {
  // 一百万 token × 一档价 = 那一档的价本身。
  const all = { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
  assert.equal(costOfUsage(all, [1, 2, 0.1, 0.2]), 3.3);
  // 缓存读便宜一个数量级：一千万缓存读只花 1 块，别把它按输入价算成 10。
  assert.equal(costOfUsage({ cacheReadTokens: 10e6 }, [1, 2, 0.1, 0.2]), 1);
  assert.equal(costOfUsage({ cacheWriteTokens: 1e6 }, [1, 2, 0.1, 0.2]), 0.2);
  assert.equal(costOfUsage({}, [1, 2, 0.1, 0.2]), 0, '一个 token 都没有就是 0，不是 null');
  assert.equal(costOfUsage({ uncachedInputTokens: -5, outputTokens: Number.NaN }, [1, 2, 0.1, 0.2]), 0, '脏数当没有');
  assert.equal(costOfUsage(all, null), null, '没价就是 null，调用方据此不画');
  assert.equal(costOfUsage(null, [1, 2, 0.1, 0.2]), null);
});

test('快照本身：日期、规模、每条的形状', () => {
  assert.match(AS_OF, /^\d{4}-\d{2}-\d{2}$/, '快照日期要能显示给用户');
  assert.equal(AS_OF, table.AS_OF);

  const shared = Object.keys(table.BY_MODEL).length;
  const exact = Object.keys(table.BY_PROVIDER_MODEL).length;
  assert.ok(shared > 500, `同名同价那半只剩 ${shared} 条，快照疑似被裁坏了`);
  assert.ok(exact > 1000, `逐渠道那半只剩 ${exact} 条，快照疑似被裁坏了`);

  for (const [key, price] of Object.entries(table.BY_PROVIDER_MODEL)) {
    assert.ok(key.includes('/'), `逐渠道价的键应形如「渠道/模型」：${key}`);
    assert.equal(price.length, 4, `${key} 的四档价不齐`);
    for (const value of price) assert.ok(Number.isFinite(value) && value >= 0, `${key} 有脏价：${price}`);
    assert.ok(price.some((value) => value > 0), `${key} 四档全 0，不该进表（免费档按未计价处理）`);
    assert.ok(!/[A-Z]/.test(key), `${key} 没有归一化，查价时会对不上`);
  }
  for (const [key, price] of Object.entries(table.BY_MODEL)) {
    assert.equal(price.length, 4, `${key} 的四档价不齐`);
    assert.ok(!/[A-Z]/.test(key), `${key} 没有归一化`);
  }
});

test('快照与查找共用一套归一化：抽一批键，按「渠道 + 模型」都查得回来', () => {
  const keys = Object.keys(table.BY_PROVIDER_MODEL);
  const step = Math.max(1, Math.floor(keys.length / 200));
  for (let index = 0; index < keys.length; index += step) {
    const key = keys[index];
    const at = key.indexOf('/');
    const provider = key.slice(0, at);
    const model = key.slice(at + 1);
    assert.deepEqual(
      priceOf(provider, model),
      table.BY_PROVIDER_MODEL[key],
      `${key} 按渠道 + 模型查不回同一份价（两边归一化分家了）`,
    );
  }
});

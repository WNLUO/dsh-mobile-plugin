'use strict';

/**
 * 模型单价：把账本里那四个 token 桶折成一个金额（美元，估算值）。
 *
 * 价目来自 `model-prices-table.cjs`（models.dev 的快照，与宿主内置那套模型目录同源；
 * 重新生成见 `scripts/build-model-prices.mjs`）。宿主自己有这份价，但它对外那两份模型清单
 * 是逐字段拼的、价格被剪掉了，注释里也写着「没有任何消费者报账」—— 所以只能由插件带一份。
 *
 * ## 为什么先查「渠道 + 模型」再查「模型」
 *
 * 账本里的渠道 id 就是宿主的 provider id：官方渠道（`deepseek` / `anthropic` / `openai`…）
 * 与表里的写法一致，能精确命中，同名不同价的那几个（同一个模型各家报不一样的价）也就不会串。
 * 自建路由的 id 是用户自己起的（`route-model-a`），认不出时退到「同名模型各家同价」那一份；
 * 各家报的价不一致时不猜 —— 一份错的钱比一个「未计价」还糟。
 *
 * ## 口径
 *
 * `cost = (未缓存输入 × 输入价 + 输出 × 输出价 + 缓存读 × 缓存读价 + 缓存写 × 缓存写价) / 1e6`
 *
 * 四档分开算，因为缓存读通常只有输入价的十分之一、缓存写反而更贵（Anthropic 是 1.25 倍），
 * 合成一个均价会把最省钱的那一块算没。缺档按 0 计（见生成脚本的文件头）。
 *
 * 纯函数、不碰文件不碰网络（表在 require 时读一次），守卫直接跑真实现。
 */

const { AS_OF, BY_MODEL, BY_PROVIDER_MODEL } = require('./model-prices-table.cjs');

/** 表里的价都是「每百万 token」，账本里是 token 数。 */
const PER_MILLION = 1e6;

/**
 * 归一化：小写、只留字母与数字（汉字保留）。
 *
 * 必须与 `scripts/build-model-prices.mjs` 的 `foldKey` 逐字一致 —— 两边各写一套，
 * 一改就整张表都查不到，而症状是「成本那一行突然没了」而不是报错。
 * 与 `model-vendors.js` 的 `foldText` 同一条规则（`v4.1` / `v4-1` 落到同一个串上）。
 */
function foldKey(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 查一份四档价：`[输入, 输出, 缓存读, 缓存写]`（每百万 token 的美元）。
 *
 * 查不到返回 `null` —— 调用方据此**不画**这个数，而不是画一个 0。
 *
 * `table` 只在守卫里传：真表太大，测查找规则时喂一份假的就行。
 */
function priceOf(provider, model, table) {
  const source = table || { byModel: BY_MODEL, byProviderModel: BY_PROVIDER_MODEL };
  const modelKey = foldKey(model);
  if (!modelKey) return null;
  const providerKey = foldKey(provider);
  if (providerKey) {
    const exact = source.byProviderModel[`${providerKey}/${modelKey}`];
    if (exact) return exact;
  }
  return source.byModel[modelKey] || null;
}

/**
 * 一份用量折成金额（美元）。`price` 为空返回 `null`（＝这个模型没价，不算进合计）。
 *
 * 返回的是未取整的原值：合计由调用方加完再取整，逐行先取整再加会和合计差几个零头。
 */
function costOfUsage(usage, price) {
  if (!price || !usage) return null;
  const amount = (
    finite(usage.uncachedInputTokens) * finite(price[0])
    + finite(usage.outputTokens) * finite(price[1])
    + finite(usage.cacheReadTokens) * finite(price[2])
    + finite(usage.cacheWriteTokens) * finite(price[3])
  ) / PER_MILLION;
  return amount;
}

module.exports = {
  AS_OF,
  PER_MILLION,
  foldKey,
  priceOf,
  costOfUsage,
};

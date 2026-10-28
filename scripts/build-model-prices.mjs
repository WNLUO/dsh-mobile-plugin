#!/usr/bin/env node
/**
 * 重新生成 `lib/mobile/model-prices-table.cjs`（统计页的成本估算靠它）。
 *
 * 来源只有一处：models.dev（https://github.com/sst/models.dev，MIT）的 `api.json`。挑它是因为
 * 宿主自己装的那套模型目录（pi-ai）也是从这份合成的 —— 同一份数据，估算出来的钱才和宿主
 * 认的价对得上。宿主从不把价格给任何客户端（它对外那份模型清单逐字段拼、价格被剪掉），
 * 所以插件这边只能自己带一份快照。
 *
 * 用法（在仓库根）：
 *
 *     node dsh-mobile-plugin/scripts/build-model-prices.mjs
 *
 * 抓完直接覆盖快照；跟着跑一遍 `node --test dsh-mobile-plugin/test/model-prices.test.cjs`。
 *
 * 两条取舍写在这里：
 *   - **缺档按 0 计**，不拿输入价顶上。多数上游「没有这一档」就是「不收这一档」（OpenAI 不收
 *     缓存写、DeepSeek 明写 0）；按输入价补会把缓存那一截估算抬高一整倍。代价是少数把缓存
 *     读藏在输入价里、又没单列报价的渠道会被算少。
 *   - **报价全 0 的模型不收进表**（免费档）。它们在页面上落进「未计价」，不冒充一份 $0 的账单
 *     —— 免费账号渠道本来就该看真实账单，而不是这张公开单价表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://models.dev/api.json';
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile', 'model-prices-table.cjs');

/** 与 `lib/mobile/model-prices.cjs` 的 `foldKey` 必须同一套归一化，否则查不到。 */
function foldKey(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '';
}

/** 四档价都只认有限的正数；缺档、负数、字符串一律当这档没有。 */
function priceOf(model) {
  const cost = model && typeof model.cost === 'object' && model.cost ? model.cost : null;
  if (!cost) return null;
  const pick = (name) => {
    const value = cost[name];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const price = [pick('input'), pick('output'), pick('cache_read'), pick('cache_write')];
  // 一个价都没给（或者四档全 0）等于没有报价：免费档不进表，见文件头。
  if (price.every((value) => value === 0)) return null;
  return price;
}

async function fetchJson(url) {
  const answer = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-mobile-plugin' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}

const catalog = await fetchJson(SOURCE);

/** `渠道/模型`（两边已归一化）→ 四档价。 */
const pairs = new Map();
/** 归一化模型名 → 各家报的价（用来判「同名不同价」与取众数）。 */
const byModel = new Map();
for (const [providerId, provider] of Object.entries(catalog)) {
  const providerKey = foldKey(providerId);
  const models = provider && typeof provider.models === 'object' && provider.models ? provider.models : {};
  for (const [modelId, model] of Object.entries(models)) {
    const modelKey = foldKey(modelId);
    if (!providerKey || !modelKey) continue;
    const price = priceOf(model);
    if (!price) continue;
    pairs.set(`${providerKey}/${modelKey}`, price);
    if (!byModel.has(modelKey)) byModel.set(modelKey, new Map());
    const key = price.join(',');
    const seen = byModel.get(modelKey).get(key) || { price, count: 0 };
    seen.count += 1;
    byModel.get(modelKey).set(key, seen);
  }
}

/** 认不出渠道时（自建路由随便起的 id）退到这一份。 */
const shared = {};
for (const [modelKey, prices] of byModel) {
  if (prices.size === 1) {
    shared[modelKey] = [...prices.values()][0].price;
    continue;
  }
  // 同名不同价：取**报得最多的那一份**，但至少要有两家这么报。
  //
  // 中转站给同一个模型加价是常态（同一个 `deepseek-v4.1-flash` 有二十几份报价），只认「全票
  // 一致」等于把这一整片模型全推到「未计价」—— 实测一台机器上九成以上的量都落在那儿。
  // 众数一般是官方那份被各家重复抄走的价；只有一家报的价不进表，那是别人的独家加价。
  let top = null;
  for (const entry of prices.values()) {
    if (!top || entry.count > top.count) top = entry;
  }
  if (top && top.count >= 2) shared[modelKey] = top.price;
}

/** 与上面那份不一致（或者根本没进那份）的才逐渠道存：能省掉大半张表。 */
const overrides = {};
for (const [key, price] of pairs) {
  const modelKey = key.slice(key.indexOf('/') + 1);
  const known = shared[modelKey];
  if (known && known.join(',') === price.join(',')) continue;
  overrides[key] = price;
}

const byModelJson = JSON.stringify(shared);
const overridesJson = JSON.stringify(overrides);
/** 快照日期按本机日历（`toISOString` 是 UTC，凌晨生成会写成前一天）。 */
const now = new Date();
const asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const body = `'use strict';

/**
 * 模型价目表快照（自动生成，别手改；重新生成见 \`scripts/build-model-prices.mjs\`）。
 *
 * 来源 models.dev（MIT），与宿主内置那套模型目录同源。价 = 每百万 token 的美元价，四档顺序
 * 固定为 \`[输入, 输出, 缓存读, 缓存写]\`。缺档按 0 计（多数上游没有这一档就是不收）。
 *
 * 两张表：
 *   - \`BY_MODEL\`：同名模型各家报价一致的那一份（认不出渠道时用它）；
 *   - \`BY_PROVIDER_MODEL\`：报价不一致的逐渠道价，键 \`渠道/模型\`，两边都已归一化。
 *
 * 报价全 0 的免费档不在表里 —— 落在「未计价」，不冒充 $0。
 */

/** 快照日期：页面上那句「按 x 的公开单价估算」就取它。 */
const AS_OF = '${asOf}';

const BY_MODEL = ${byModelJson};

const BY_PROVIDER_MODEL = ${overridesJson};

module.exports = { AS_OF, BY_MODEL, BY_PROVIDER_MODEL };
`;

fs.writeFileSync(OUT_FILE, body);

const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
console.log(
  `${asOf} · ${pairs.size} 个「渠道 + 模型」有报价 · ${Object.keys(shared).length} 个模型各家同价 · ` +
    `${Object.keys(overrides).length} 条逐渠道价 · ${kb} KB`,
);

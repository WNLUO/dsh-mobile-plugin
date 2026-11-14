// 公开参数保留宿主支持的全部推理档位。
'use strict';

/**
 * 公开模型参数快照的查表层：模型名 → 上下文 / 输出上限 / 读图 / 思考档位。
 *
 * 自建渠道与中转站的 `/v1/models` 大多只回 id 和名字：上下文多大、单次能输出多少、能不能
 * 看图、思考有几档，一个字都没有。这些数公开库里有，所以插件带一份快照（由
 * `scripts/build-model-meta.mjs` 生成），查到就替用户填好，查不到就留空让人自己改。
 *
 * ## 名字怎么对
 *
 * 键是**折叠后的模型名**：小写、只留字母与数字（`foldKey`，与生成脚本 `scripts/build-model-meta.mjs` 逐字一致）。
 * 于是 `Claude-Sonnet-4.5`、`anthropic/claude-sonnet-4-5`、`claude_sonnet_4.5（中转）` 落到
 * 同一个键上 —— 用户说的「大小写不一样、中间加符号、带括号」都是同一件事。
 *
 * 只做**精确折叠相等**：不猜后缀、不做模糊匹配、不维护别名表。`-20250929`、`:free` 这些
 * 查不到就是查不到，让用户自己改，比猜错一个上下文上限好。
 *
 * ## 搜索
 *
 * 折叠后的子串匹配（键与公开名字都算），**完全相等的排最前**、其次是前缀命中，其余按名字
 * 长短排 —— 用户多半是在抄一个 id，先让他看到那一条。
 */

const { REV, ROWS } = require('./model-meta-table.cjs');

/** 与宿主 pi-ai 的可选档位一致，保留 off / minimal / xhigh 的独立含义。 */
const MODEL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 折叠：小写、只留字母与数字。必须与生成脚本的 `foldKey` 逐字一致。 */
function foldKey(value) {
  if (typeof value !== 'string') return '';
  const flat = value.trim().toLowerCase();
  // 中转站常写成 `anthropic/claude-sonnet-4-5`：砍掉厂商前缀，剩下的还是官方那个名字。
  const cut = flat.lastIndexOf('/');
  const bare = cut < 0 ? flat : flat.slice(cut + 1);
  return bare.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 末尾带括号注释的那种写法：`claude-sonnet-4-5（中转）`、`gpt-4o (free)`。
 *
 * 只剥**结尾**的方括号段，且只用来兜第二遍查表 —— 用户给模型起名时常在后面加一句自己的
 * 备注，而括号里的东西通常不是模型的一部分。`-preview` / `:free` 这类真变体不剥（剥了就等于
 * 把另一个模型的窗口塞进来）。
 */
function withoutTrailingBrackets(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  const tail = /\s*(?:\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]|【[^【】]*】)\s*$/;
  while (tail.test(text)) text = text.replace(tail, '');
  return text;
}

/** 快照的修订号（内容哈希）与条目数：App 拿它判断缓存要不要重拉。 */
const revision = REV;
const size = Object.keys(ROWS).length;

/**
 * 快照里的一行 → 对外的参数形状。
 *
 * `reasoning: []` 与「没有 reasoning 这个键」是两件事：前者是「查到了，它不思考」，
 * 后者是「公开库里没这条」，界面上前者要能把四档勾掉、后者要留默认。
 */
function metaOf(key, row) {
  const meta = { id: key };
  if (typeof row.n === 'string' && row.n !== '') meta.name = row.n;
  if (Number.isInteger(row.c) && row.c > 0) meta.contextWindow = row.c;
  if (Number.isInteger(row.m) && row.m > 0) meta.maxTokens = row.m;
  if (row.i === 1 || row.i === 0) meta.vision = row.i === 1;
  if (Array.isArray(row.r)) meta.reasoning = row.r.filter((level) => MODEL_LEVELS.includes(level));
  if (row.w && typeof row.w === 'object') meta.reasoningWires = row.w;
  return meta;
}

/**
 * 查一条公开参数。
 *
 * @param {string} id 模型 id，大小写随意，可带 `厂商/` 前缀与括号后缀。
 * @returns {{id: string, name?: string, contextWindow?: number, maxTokens?: number, vision?: boolean, reasoning?: string[]}|undefined}
 *   查不到回 `undefined`（「公开库里没有」），别和「查到了、但没这个字段」混。
 */
function lookupModelMeta(id) {
  const key = foldKey(id);
  if (key !== '' && ROWS[key] !== undefined) return metaOf(key, ROWS[key]);
  // 第二遍：把结尾那句括号备注剥掉再查一次。只有这一种容错，别再加模糊匹配。
  const bare = foldKey(withoutTrailingBrackets(id));
  if (bare === '' || bare === key || ROWS[bare] === undefined) return undefined;
  return metaOf(bare, ROWS[bare]);
}

/**
 * 按关键词搜一批。
 *
 * @param {string} query 用户敲的那几个字（大小写、空格、符号都不敏感）。
 * @param {number} [limit] 最多回几条，缺省 20。
 */
function searchModelMeta(query, limit = 20) {
  const needle = foldKey(query);
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 100) : 20;
  if (needle === '') return [];
  const hits = [];
  for (const key of Object.keys(ROWS)) {
    const row = ROWS[key];
    const name = foldKey(row.n);
    const inKey = key.indexOf(needle);
    const inName = name.indexOf(needle);
    if (inKey < 0 && inName < 0) continue;
    // 完全相等 → 0，前缀 → 1，其余 → 2；同档按名字长短（更像同一个东西的排前面）。
    const rank = key === needle || name === needle
      ? 0
      : (key.startsWith(needle) || name.startsWith(needle) ? 1 : 2);
    hits.push({ rank, length: key.length, key });
    if (hits.length > max * 20) break;
  }
  hits.sort((left, right) => (left.rank - right.rank) || (left.length - right.length) || left.key.localeCompare(right.key));
  return hits.slice(0, max).map((hit) => metaOf(hit.key, ROWS[hit.key]));
}

/** 整份表（App 端缓存 + 本地搜索用）。 */
function fullModelMeta() {
  return { revision, total: size, items: ROWS };
}

module.exports = {
  MODEL_LEVELS,
  foldKey,
  lookupModelMeta,
  withoutTrailingBrackets,
  searchModelMeta,
  fullModelMeta,
  revision,
  size,
};

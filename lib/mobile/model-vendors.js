'use strict';

/**
 * 模型 → 厂商的识别，以及厂商图标（`vendor-logos.cjs` 那张表）的取用。
 *
 * 为什么需要猜：宿主只给「渠道 id + 模型 id」，没有厂商这一栏，而同一个模型在不同渠道下写法
 * 各不相同 —— `deepseek-v4.1-flash`、`DeepSeek V4.1 flash`、`deepseek_v4_1_flash` 都是同一个
 * 东西；有些渠道还把模型名整个改掉（`route-model-a`）。所以先规范化（小写、去掉所有分隔符），
 * 再按关键词认；模型名认不出时再看渠道名（`anthropic`、`moonshotai` 这类渠道 id 往往就是厂商）。
 *
 * 认不出来的就**不猜**：宁可那一行退回首字母徽标，也不要给一个错的品牌 —— 厂商名是用户用来
 * 认模型的，猜错比空着更糟。这条与「取不到就整块不出」是同一个口径。
 *
 * 纯函数、不碰网络也不碰文件，守卫直接跑真实现。
 */

const { VENDOR_LOGOS } = require('./vendor-logos.cjs');

/**
 * 规范化：小写、只留字母与数字（汉字保留 —— 国产模型的别名经常是中文）。
 *
 * 去掉分隔符是关键：`v4.1` / `v4-1` / `v4_1` 都应该落到同一个串上，否则每种写法都要单独列一条。
 */
function foldText(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '';
}

/** 按非字母数字切开的小写片段：给「o3」「phi」这种两三个字符的短词用（它们不能按子串认）。 */
function tokensOf(value) {
  return typeof value === 'string'
    ? value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    : [];
}

/**
 * 认法表。匹配顺序就是优先级，长关键词在前。
 *
 * `terms` 在规范化后的串上按子串认（`deepseekv41flash` 里含 `deepseek`）；
 * `tokens` 按切开后的整段认（`o3-mini` 的 `o3`、`phi-4` 的 `phi`）—— 短词按子串认会把
 * 一堆无关模型认成同一家。
 */
const VENDOR_PATTERNS = [
  ['deepseek', { terms: ['deepseek', '深度求索', '深度探索'] }],
  ['anthropic', { terms: ['claude', 'anthropic', 'sonnet', 'opus', 'haiku'] }],
  ['openai', { terms: ['openai', 'chatgpt', 'gpt', 'codex', 'davinci', 'omni'], tokens: ['o1', 'o3', 'o4'] }],
  ['google', { terms: ['gemini', 'gemma', 'google', 'vertex', 'bard'] }],
  ['alibaba', { terms: ['qwen', 'qwq', 'tongyi', 'alibaba', '通义', '千问', '阿里'] }],
  ['moonshot', { terms: ['kimi', 'moonshot', '月之暗面'] }],
  ['zhipu', { terms: ['glm', 'chatglm', 'zhipu', '智谱', '清言'] }],
  ['meta', { terms: ['llama', 'meta'] }],
  ['mistral', { terms: ['mistral', 'mixtral', 'codestral', 'devstral', 'magistral'] }],
  ['xai', { terms: ['grok', 'xai'] }],
  ['cohere', { terms: ['cohere', 'commandr'] }],
  ['bytedance', { terms: ['doubao', 'bytedance', 'seed', '豆包', '火山'] }],
  ['baidu', { terms: ['ernie', 'wenxin', 'baidu', '文心', '百度'] }],
  ['tencent', { terms: ['hunyuan', 'tencent', '混元', '腾讯'] }],
  ['minimax', { terms: ['minimax', 'abab', '海螺'] }],
  ['nvidia', { terms: ['nemotron', 'nvidia', '英伟达'] }],
  ['microsoft', { terms: ['microsoft', 'azure'], tokens: ['phi', 'phi3', 'phi4', 'phi35'] }],
];

/** 一段文字认哪家；认不出返回空串。 */
function vendorOfText(value) {
  const folded = foldText(value);
  if (!folded) return '';
  for (const [vendor, rule] of VENDOR_PATTERNS) {
    if (rule.terms && rule.terms.some((term) => folded.includes(term))) return vendor;
  }
  const tokens = tokensOf(value);
  if (tokens.length > 0) {
    for (const [vendor, rule] of VENDOR_PATTERNS) {
      if (rule.tokens && rule.tokens.some((token) => tokens.includes(token))) return vendor;
    }
  }
  return '';
}

/**
 * 一条模型用量认哪家：先看模型名 / 模型 id，再看渠道名 / 渠道 id。
 *
 * 顺序有意如此 —— 渠道可以挂着任何模型（自建渠道尤其如此），名字写对了就以名字为准；
 * 只有名字认不出来时才用渠道兜底，这也是很多网关渠道的实际情况（渠道叫 `anthropic`、
 * 模型名是它自己起的别名）。
 *
 * 返回的是**认出来的那一家**，跟它有没有图标无关：有一家（比如 GLM / Grok）暂时没有图标，
 * 这一行就该退回首字母徽标，而不是接着往下试渠道名 —— 那样「模型名认出 A、渠道名像 B」时会
 * 认成 B，摆上别家的 logo。认错厂商比不认更糟，这一条是硬规矩。
 */
function identifyVendor(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const candidates = [entry.modelName, entry.model, entry.providerName, entry.provider];
  for (const candidate of candidates) {
    const vendor = vendorOfText(candidate);
    if (vendor) return vendor;
  }
  return '';
}

/** 厂商的展示名与图标标记；不在表里返回 null。 */
function vendorLogoOf(vendor) {
  const entry = VENDOR_LOGOS[vendor];
  return entry ? { name: entry.name, icon: entry.icon } : null;
}

module.exports = { foldText, tokensOf, vendorOfText, identifyVendor, vendorLogoOf, VENDOR_PATTERNS };

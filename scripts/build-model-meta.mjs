#!/usr/bin/env node
// 快照保留公开资料中的完整推理档位和明确的读图状态。
/**
 * 重新生成 `lib/mobile/model-meta-table.cjs`（「模型能力配置」弹窗里的公开参数快照）。
 *
 * 来源两张公开表（都是 MIT）：
 *   - models.dev（https://github.com/sst/models.dev）：字段最全，思考档位只有它给。
 *   - LiteLLM（https://github.com/BerriAI/litellm）的 model_prices_and_context_window.json：
 *     条目更多，用来补 models.dev 没收录的名字。
 *
 * 用法（在仓库根）：
 *
 *     node dsh-mobile-plugin/scripts/build-model-meta.mjs
 *
 * 抓完直接覆盖快照；跟着跑一遍 `node --test dsh-mobile-plugin/test/model-meta.test.cjs`。
 *
 * 三条口径写在这里：
 *   - **键是折叠后的模型名**（小写、只留字母数字，与 `model-meta.js` 的 `foldKey` 逐字一致）：
 *     同一份资料在聊天里可能写成 `Claude-Sonnet-4.5`、`anthropic/claude-sonnet-4-5`、
 *     `claude_sonnet_4_5 (中转)`，折叠之后落到同一个键上。不猜后缀、不做模糊匹配 ——
 *     宁可查不到、让用户自己填，也不把另一个模型的上下文塞进去。
 *   - **同一个名字被十几家收录时取第一方的**（OpenAI / Anthropic / Google / DeepSeek 这些厂商
 *     自己的条目）：聚合站偶尔把窗口写大、把档位写多。
 *   - **输出上限必须小于上下文**：测到过聚合站把两者写成一样大，那种数不要。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelsOf, wiresOf } from './model-meta-data.mjs';

const SOURCES = {
  modelsDev: 'https://models.dev/api.json',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
};

const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile', 'model-meta-table.cjs');

/** 与 `lib/mobile/model-meta.js` 的 `foldKey` 必须逐字一致，否则两边查的是两张表。 */
function foldKey(value) {
  if (typeof value !== 'string') return '';
  const flat = value.trim().toLowerCase();
  // 中转站常写成 `anthropic/claude-sonnet-4-5`：砍掉厂商前缀，剩下的还是官方那个名字。
  const cut = flat.lastIndexOf('/');
  const bare = cut < 0 ? flat : flat.slice(cut + 1);
  return bare.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 第一方厂商（models.dev 里的 provider 写法）。不在名单里的都算第三方，排在后面。 */
const FIRST_PARTY = [
  'openai', 'anthropic', 'google', 'google-vertex', 'deepseek', 'alibaba', 'alibaba-cn',
  'xai', 'mistral', 'zhipuai', 'moonshotai', 'moonshotai-cn', 'minimax', 'minimax-cn',
  'meta', 'cohere', 'amazon-bedrock', 'microsoft',
];

const CHAT_MODES = new Set(['chat', 'responses']);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function rankOf(provider) {
  const at = FIRST_PARTY.indexOf(provider);
  return at < 0 ? FIRST_PARTY.length : at;
}

async function fetchJson(url) {
  const answer = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-mobile-plugin' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.json();
}

const [modelsDev, litellm] = await Promise.all([fetchJson(SOURCES.modelsDev), fetchJson(SOURCES.litellm)]);

/** 折叠键 → 收录它的条目（按第一方优先排好）。 */
const groups = new Map();
for (const [provider, pack] of Object.entries(modelsDev)) {
  const models = pack && typeof pack.models === 'object' && pack.models ? pack.models : {};
  for (const [id, record] of Object.entries(models)) {
    const key = foldKey(id);
    if (key === '' || !record || typeof record !== 'object') continue;
    const entry = { rank: rankOf(provider), record };
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [entry]);
    else list.push(entry);
  }
}

const firstPartyLimit = FIRST_PARTY.length;
const table = {};
let fromLiteLLM = 0;
for (const [key, list] of groups) {
  list.sort((left, right) => left.rank - right.rank);
  const first = list[0];
  const firstOf = (read) => {
    for (const row of list) {
      const value = read(row);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const context = firstOf((row) => positive(row.record.limit && row.record.limit.context));
  const output = firstOf((row) => {
    const value = positive(row.record.limit && row.record.limit.output);
    return value !== undefined && (context === undefined || value < context) ? value : undefined;
  });
  const modalities = firstOf((row) => (Array.isArray(row.record.modalities && row.record.modalities.input)
    ? row.record.modalities.input : undefined));
  const reasoningRow = list.find((row) => levelsOf(row.record) !== undefined);
  const levels = reasoningRow ? levelsOf(reasoningRow.record) : undefined;
  const wires = reasoningRow ? wiresOf(reasoningRow.record) : undefined;
  const name = typeof first.record.name === 'string' && first.record.name.trim() ? first.record.name.trim() : undefined;
  const compact = {};
  if (name) compact.n = name;
  if (context !== undefined) compact.c = context;
  if (output !== undefined) compact.m = output;
  if (Array.isArray(modalities)) compact.i = modalities.includes('image') ? 1 : 0;
  if (levels !== undefined) compact.r = levels;
  if (wires && Object.keys(wires).length > 0) compact.w = wires;
  if (levels === undefined && list.some((row) => row.rank < firstPartyLimit && row.record.reasoning === false)) compact.r = [];
  if (Object.keys(compact).length === 0) continue;
  table[key] = compact;
}

for (const [id, record] of Object.entries(litellm)) {
  if (id === 'sample_spec' || !record || typeof record !== 'object') continue;
  if (record.mode !== undefined && !CHAT_MODES.has(String(record.mode))) continue;
  const key = foldKey(id);
  if (key === '' || table[key] !== undefined) continue;
  const context = positive(record.max_input_tokens) ?? positive(record.max_tokens);
  const output = positive(record.max_output_tokens);
  const compact = {};
  const name = typeof record.model_name === 'string' && record.model_name.trim() ? record.model_name.trim() : undefined;
  if (name) compact.n = name;
  if (context !== undefined) compact.c = context;
  if (output !== undefined && (context === undefined || output < context)) compact.m = output;
  if (typeof record.supports_vision === 'boolean') compact.i = record.supports_vision ? 1 : 0;
  if (Object.keys(compact).length === 0) continue;
  table[key] = compact;
  fromLiteLLM += 1;
}

/** 键排序 + 一份自校验用的修订号：同一份输入每次生成同一份字节，diff 只反映数据变化。 */
const rows = Object.keys(table).sort();
const sorted = {};
for (const key of rows) sorted[key] = table[key];
const body = JSON.stringify(sorted);
let hash = 5381;
for (let index = 0; index < body.length; index += 1) hash = ((hash * 33) ^ body.charCodeAt(index)) >>> 0;

const header = `'use strict';

/**
 * 模型参数快照（自动生成，别手改；重新生成见 \`scripts/build-model-meta.mjs\`）。
 *
 * 来源 models.dev 与 LiteLLM（都是 MIT）。键是**折叠后的模型名**（小写、只留字母数字），
 * 与 \`model-meta.js\` 的 \`foldKey\` 逐字一致；一行里只有这几个字段：
 *
 *   - \`n\`：公开名字（弹窗列表上给人看的）；
 *   - \`c\`：上下文窗口；
 *   - \`m\`：单次输出上限（一定小于 \`c\`）；
 *   - \`i\`：读图能力（1 = 能，0 = 不能，缺省 = 未知）；
 *   - \`r\`：推理档位（off / minimal / low / medium / high / xhigh / max；空数组 = 明确不思考，缺省 = 未知）；
 *   - \`w\`：档位与协议参数不同名时的映射。
 *
 * \`REV\` 是内容哈希：App 按它判断缓存要不要重拉。
 */

const REV = '${hash.toString(36)}';
const ROWS = ${JSON.stringify(sorted)};

module.exports = { REV, ROWS };
`;

fs.writeFileSync(OUT_FILE, header);
console.log(
  `${rows.length} 个模型 · ${Math.round(fs.statSync(OUT_FILE).size / 1024)} KB · ` +
  `其中 ${fromLiteLLM} 个只有 LiteLLM 收录 · rev=${hash.toString(36)}`,
);

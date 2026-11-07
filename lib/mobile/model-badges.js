'use strict';

/**
 * 模型清单里那枚「徽标」的归一化：上游 `LlmModelBadge` → 手机端能直接画的 `{text, tone}`。
 *
 * 为什么单独成文件：`session-models.js` 有 220 行的拆分上限（见 `test/module-split.test.cjs`），
 * 而这段是「一个字段怎么裁」的纯函数，搬出来既让那份模块守住上限，也方便单独测。
 *
 * 上游形状（`packages/llm/llm/src/types.ts` 的 `LlmModelBadge`）：
 *   `{ text: '1017' | { en: '1017', 'zh-hans': '1017' }, tone: 'neutral' | 'info' | 'success' | 'warning' }`
 * 手机端拿到的是**已经拍平的字符串**，App 不需要再决定用哪门语言。
 */

/** 徽标文案下发上限：选择器里那枚标签是单行小字，官方 `1017` 这类顶多几个字。 */
const MODEL_BADGE_TEXT_MAX = 32;
/** 上游 `LlmModelBadgeTone` 只有这四个值；不认识的当没给。 */
const MODEL_BADGE_TONES = ['neutral', 'info', 'success', 'warning'];

/**
 * 徽标文案：字面量字符串直接用；本地化对象优先取当前语言、退英文（英文必填），
 * 都取不到就退回表里第一条能用的字符串 —— 绝不让标签空着。
 *
 * 语言标签做一次宽松匹配：先精确（全小写），再按主语言子标签（`zh-cn` 的 `zh`
 * 能对上键 `zh-hans`），最后英文。上游清单的键是「小写语言 id」。
 */
function badgeText(value, language) {
  if (typeof value === 'string') return value.slice(0, MODEL_BADGE_TEXT_MAX);
  if (!value || typeof value !== 'object') return '';
  const want = String(language || 'en').toLowerCase();
  const keys = Object.keys(value);
  const ordered = [want, want.split('-')[0], 'en'];
  for (const key of ordered) {
    if (!key) continue;
    const match = keys.find((k) => k.toLowerCase() === key)
      || keys.find((k) => k.toLowerCase().split('-')[0] === key);
    const text = match ? value[match] : undefined;
    if (typeof text === 'string' && text) return text.slice(0, MODEL_BADGE_TEXT_MAX);
  }
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key].slice(0, MODEL_BADGE_TEXT_MAX);
  }
  return '';
}

/** 徽标强调档：只认那四个值，其余原样丢掉。 */
function badgeTone(value) {
  return typeof value === 'string' && MODEL_BADGE_TONES.includes(value) ? value : '';
}

/**
 * 一个模型条目的徽标：没有、或文案裁完是空的，就返回空对象（**不挂这个键**，
 * 老宿主的目录形状不变）。有 tone 才带 tone。
 *
 * @param model 宿主清单里的一个模型条目
 * @param language 请求方语言（缺省英文）
 */
function modelBadgeOf(model, language) {
  const badge = model && typeof model === 'object' ? model.badge : null;
  if (!badge || typeof badge !== 'object') return {};
  const text = badgeText(badge.text, language);
  if (!text) return {};
  const tone = badgeTone(badge.tone);
  return { badge: { text, ...(tone ? { tone } : {}) } };
}

/**
 * 请求方语言标签（`Accept-Language` 第一段，如 `zh-CN`），用来挑本地化徽标文案；
 * 读不到退回 `en`。
 */
function requestLanguage(headers) {
  const raw = headers && (headers['accept-language'] || headers['Accept-Language']);
  if (typeof raw !== 'string') return 'en';
  const first = raw.split(',')[0].trim().toLowerCase();
  return first || 'en';
}

module.exports = { modelBadgeOf, badgeText, badgeTone, requestLanguage, MODEL_BADGE_TEXT_MAX, MODEL_BADGE_TONES };

'use strict';

/**
 * 证据账本 + 回答来源挑选。
 *
 * 一轮跑下来，助手实际读到的材料（读屏、读到的网页、命令输出、读到的文件、工具结果里的事实）
 * 记在这本账上：**脱敏、截短、去重、可回看**。交给核查、挑来源、落运行记录都读同一本账，
 * 各看各的就没有「核对时看得见、回答时对不上」这种事。
 *
 * 回答下面的来源**由代码从账本里挑，不靠模型写**（照 Mika `core/verify/AnswerSources.kt`）：
 * 回答里的事实对得上的那几条观察，至多 6 处，指回具体步骤（哪一步、哪个 App/网址、标题、
 * 画面编号）。回答里没有可对的事实时用最后一条观察——那是回答说的那个结果所在的地方。
 *
 * 与脱敏（M4）的关系：**共用同一份规则**。账本进账前一律先过 `phone/redact.js` 的
 * `redact(text)`——运行记录、证据账本、网络数据用的是同一套口径，一处改了都跟着改。
 * 万一那份还没就位（单独拷走这个模块调试），退回本地最小遮罩顶上，不会裸奔。
 */

const grounding = require('./grounding.js');

/** 回答下面至多列这么多处来源。 */
const MAX_SOURCES = 6;

/** 账本总字数的安全上限：超了从最早的丢起（正常任务碰不到）。 */
const STORE_CHARS = 400_000;

/** 读屏 / 网页 / 别的 AI 的回答每条至多这么多字。 */
const READ_CHARS = 6_000;

/** 命令输出 / 文件内容 / 工具事实每条至多这么多字（按头尾截短）。 */
const OUTPUT_CHARS = 4_000;

const OUTPUT_KINDS = new Set(['output', 'fact', 'file']);

/**
 * 找统一脱敏模块（M4 的 `phone/redact.js`）。存在就共用它的 `redact(text)`；
 * 找不到（模块被单独拷走调试）返回 null，用下面的本地最小遮罩顶上。
 */
function loadSharedRedactor() {
  for (const candidate of ['./redact.js', '../../redact.js', '../../../redact.js']) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.redact === 'function') return { fn: mod.redact };
      if (mod && typeof mod.evidence === 'function') return { fn: mod.evidence };
      if (mod && typeof mod.text === 'function') return { fn: mod.text };
    } catch {
      // 还没落地 / 路径不对，继续试下一个候选。
    }
  }
  return null;
}

const sharedRedactor = loadSharedRedactor();

const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{30,}/g;
const GOOGLE_AUTH_KEY = /\bAQ\.[0-9A-Za-z_-]{20,}/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const CODE_WORD = /验证|校验码|动态码|动态密码|确认码|安全码|短信|口令|\b(?:code|otp|passcode|pin|2fa)\b/i;
const CODE_DIGITS = /(?<![\d.¥$€£])\d(?:[ -]?\d){3,7}(?!\d)(?!\.\d)(?!,\d{3}(?!\d))/g;
const MASK = '***';
const CODE_WINDOW = 24;

/** 本地最小遮罩：Key、Bearer、以及「验证码/短信/code」附近 4–8 位数字。近似 Mika `Redactor.evidence`。 */
function localRedact(text) {
  let out = String(text == null ? '' : text)
    .replace(SK_KEY, MASK)
    .replace(GOOGLE_KEY, MASK)
    .replace(GOOGLE_AUTH_KEY, MASK)
    .replace(GITHUB_TOKEN, MASK)
    .replace(BEARER, `Bearer ${MASK}`);
  // 一次性码：词与数字之间 24 字以内。
  const words = [];
  CODE_WORD.lastIndex = 0;
  let w;
  while ((w = CODE_WORD.exec(out)) !== null) words.push([w.index, w.index + w[0].length]);
  if (words.length > 0) {
    out = out.replace(CODE_DIGITS, (m, offset) => {
      const near = words.some(([s, e]) => (offset - e >= 0 && offset - e <= CODE_WINDOW) || (s - (offset + m.length) >= 0 && s - (offset + m.length) <= CODE_WINDOW));
      return near ? MASK : m;
    });
  }
  return out;
}

/** 一条材料进账前的脱敏（账本、来源、给模型看都用这一份）。 */
function redactText(text) {
  if (sharedRedactor) return sharedRedactor.fn(text);
  return localRedact(text);
}

function clip(kind, text) {
  const value = String(text == null ? '' : text);
  if (OUTPUT_KINDS.has(kind)) {
    if (value.length <= OUTPUT_CHARS) return value;
    return `${value.slice(0, (OUTPUT_CHARS * 3) / 4 | 0)}\n…(中间省略)…\n${value.slice(-(OUTPUT_CHARS / 4 | 0))}`;
  }
  return value.length <= READ_CHARS ? value : value.slice(0, READ_CHARS);
}

/**
 * 造一本证据账本。
 *
 * @param {{capChars?:number}} [opts]
 */
function createLedger(opts) {
  const capChars = opts && Number.isFinite(opts.capChars) && opts.capChars > 0 ? opts.capChars : STORE_CHARS;
  const entries = [];
  let total = 0;
  let seq = 0;

  /**
   * 记一条材料。脱敏、截短后为空的返回 null（不占账）。
   *
   * @param {{kind?:string, text:string, place?:string, title?:string, step?:number, source?:string, mediaIds?:number[], atMs?:number}} item
   * @returns {object|null} 记下的那一条（带 id / step / atMs）
   */
  function record(item) {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') return null;
    const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'read';
    let text = clip(kind, redactText(item.text));
    if (text.trim() === '') return null;
    const place = item.place != null && item.place !== '' ? redactText(String(item.place)) : '';
    // 同一原文 + 同一处只留最近一次（来处随时间更新）。
    const dup = entries.findIndex((e) => e.text === text && e.place === place);
    if (dup >= 0) {
      total -= entries[dup].text.length;
      entries.splice(dup, 1);
    }
    const stored = {
      id: ++seq,
      kind,
      text,
      place,
      title: item.title != null && item.title !== '' ? redactText(String(item.title)) : '',
      step: Number.isInteger(item.step) ? item.step : 0,
      source: typeof item.source === 'string' ? item.source : '',
      mediaIds: Array.isArray(item.mediaIds) ? item.mediaIds.filter(Number.isInteger) : [],
      atMs: Number.isFinite(item.atMs) ? item.atMs : 0,
    };
    entries.push(stored);
    total += stored.text.length;
    while (total > capChars && entries.length > 1) total -= entries.shift().text.length;
    return stored;
  }

  /** 账本里此刻的全部条目（按读到先后）。 */
  function all() {
    return entries.slice();
  }

  /** 这段原文（脱敏、截短后）是否已经在账本里。 */
  function has(kind, text) {
    const k = typeof kind === 'string' && kind ? kind : 'read';
    const t = clip(k, redactText(text));
    return entries.some((e) => e.text === t);
  }

  /** 回答里某条事实对得上的条目（按读到先后）。回答里没有可核对的事实时为空。 */
  function supporting(answer, goal) {
    return entries.filter((e) => {
      const r = grounding.check({ answer: String(answer == null ? '' : answer), evidence: [e.text], goal: typeof goal === 'string' ? goal : '' });
      return r.matched > 0 && r.claims.length > 0;
    });
  }

  /**
   * 挑来源：对得上回答的条目；一条都对不上时退回最后一条观察（回答说的结果就在那儿）。
   * 至多 MAX_SOURCES 处，取最近的几条，指回步骤与画面编号。**只给指针，不带正文**。
   *
   * @param {string} answer
   * @param {{goal?:string}} [opts]
   * @returns {Array<{obsId:number,kind:string,place:string|null,title:string|null,step:number,mediaIds:number[],source:string|null}>}
   */
  function selectSources(answer, opts) {
    const goal = opts && typeof opts.goal === 'string' ? opts.goal : '';
    let hits = supporting(answer, goal);
    if (hits.length === 0 && entries.length > 0) hits = [entries[entries.length - 1]];
    return hits.slice(-MAX_SOURCES).map((e) => ({
      obsId: e.id,
      kind: e.kind,
      place: e.place || null,
      title: e.title || null,
      step: e.step,
      mediaIds: e.mediaIds.slice(),
      source: e.source || null,
    }));
  }

  return {
    record,
    all,
    has,
    supporting,
    selectSources,
    get size() { return entries.length; },
    get totalChars() { return total; },
    capChars,
  };
}

/** 直接作用于账本的 `record(item)`（等价于 `ledger.record(item)`）。 */
function record(ledger, item) {
  if (!ledger || typeof ledger.record !== 'function') return null;
  return ledger.record(item);
}

/**
 * 直接作用于账本的 `selectSources(answer, ledger, opts)`（等价于 `ledger.selectSources`）。
 * 返回 Mika `AnswerSource` 形状的来源数组，至多 6 处，不带正文。
 */
function selectSources(answer, ledger, opts) {
  if (!ledger || typeof ledger.selectSources !== 'function') return [];
  return ledger.selectSources(answer, opts);
}

module.exports = {
  createLedger,
  record,
  selectSources,
  redactText,
  clip,
  MAX_SOURCES,
  STORE_CHARS,
  READ_CHARS,
  OUTPUT_CHARS,
};

'use strict';

/**
 * 与模型无关的字面核查：回答里的引文、带单位/货币的数、日期时刻，必须能在**本次读到的
 * 材料原文**里找到。
 *
 * 只核它核得准的——「有没有这句 / 有没有这个数」；**不核**一个值是不是属于回答说的那个
 * 东西（哪个页面、哪个商品、哪一行）。语义归属要看懂上下文，那交给核查模型，不由这里判。
 *
 * 口径照 Mika `core/verify/Grounding.kt` 收窄：引号里的原文、带单位或货币或百分号或数量级
 * 的数、小数、三位以上整数、日期与时刻；两位以内不带单位的整数（计数、序号、排名）不核。
 *
 * `check({answer, evidence, goal})` 返回 `{ ok, unmet, claims, matched }`：
 *  - `claims` 是回答里可核对的具体事实，`matched` 是其中对上的条数；
 *  - `unmet` 是对不上的那几条（`{ kind, text }`），`ok` 为 `unmet` 为空。
 *
 * 不通过时用 `rewriteHint(結果)` 给一句「退回改写一次」的提示；`review(...)` 把这个
 * 「改写一次、再不行标未确认」的口径也一并给定（见文件底）。
 */

/** 引号：中文直角 / 双引号 / 弯引号 / 直引号。空引号直接跳过。 */
const QUOTED = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"|‘([^’]*)’/g;

/** 「依据[：:]」之后只核引文，其余（来源、网址、时间）不是要核对的事实。 */
const EVIDENCE = /依据\**\s*[:：]/;

/** 数（含千分位与小数）；后面紧跟的万/亿/千是数量级（千后面不能是米/克/瓦之类单位词）。 */
const NUMBER = /(?<!\d)(?<!\d[.,])\d+(?:[.,]\d+)*(?!\d)([ \t]*(?:[亿万]|千(?![米克瓦卡帕焦])))?/g;

/** 日期与时刻：10月23日、2026-10-23、2026/10/23、14:05、14:05:30。 */
const DATE = /(?<!\d)(?:\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2}\s*[日号]?)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?)(?!\d)/g;

/** 数后面紧跟的量/单位（不含「条」「个」这类量词——那是回答自己数出来的）。 */
const UNIT_AFTER = /^\s*(?:%|‰|元|块|角|美元|欧元|日元|港元|英镑|℃|°|度|公里|千米|米|厘米|毫米|公斤|千克|斤|克|吨|小时|分钟|秒|毫秒|岁|英寸|寸|折|星|km|cm|mm|kg|mAh|GB|MB|KB|TB|Hz|ms)(?![A-Za-z])/;

/** 数前面的货币符号。 */
const CURRENCY_BEFORE = /[¥$€£]\s*$/;

/** 引用编号（@e16 / @v2）与脚注（[1] / 【3】）不是回答内容，比对前去掉。 */
const REF_CITATION = /\(?\s*@[ev]\d+(?:\s*[,、]\s*@[ev]\d+)*\s*\)?/g;
const FOOTNOTE = /\[\^?\d{1,3}\]|【\d{1,3}】/g;

/** 排版强调与行内代码只是排版，不是内容（单个 * 可能是乘号，不动）。 */
const MARKUP = /\*\*|__|~~|`/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

/** 屏上「当前 App:」那一行不算屏上文字。 */
const APP_HEADER = '当前 App:';

/** 截断标记。 */
const CUT = '...';

const MAGNITUDE = { 亿: 8, 万: 4, 千: 3 };

function canon(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(MARKUP, '')
    .replace(REF_CITATION, ' ')
    .replace(FOOTNOTE, ' ');
}

/** 只留字母与数字，用于「这句原文在不在这行里」。 */
function norm(s) {
  return String(s == null ? '' : s).replace(/[^\p{L}\p{N}]/gu, '');
}

function quotes(s) {
  const out = [];
  QUOTED.lastIndex = 0;
  let m;
  while ((m = QUOTED.exec(s)) !== null) {
    const q = m.slice(1).find((x) => typeof x === 'string' && x !== '');
    if (q !== undefined) out.push(q);
  }
  return out;
}

/** 一个数 + 数量级。scaled 是折算到基本单位后的写法（5.3万 = 53000）。 */
function makeNum(value, magnitude) {
  const clean = value.replace(/,/g, '');
  let scaled = null;
  if (/^\d+(?:\.\d+)?$/.test(clean)) {
    const base = Number(clean);
    if (Number.isFinite(base)) {
      const pow = MAGNITUDE[magnitude];
      scaled = pow ? String(base * 10 ** pow) : String(base);
    }
  }
  return { value: clean, magnitude: magnitude || '', scaled };
}

function numMatches(a, b) {
  if (a.value === b.value && (a.magnitude === '' || a.magnitude === b.magnitude)) return true;
  return a.scaled !== null && a.scaled === b.scaled;
}

/** 一行里的全部数（不判它们是不是「值」，只做比对底料）。 */
function numbersIn(s) {
  const out = [];
  NUMBER.lastIndex = 0;
  let m;
  while ((m = NUMBER.exec(s)) !== null) {
    const mag = m[1] || '';
    const magnitude = mag.trim();
    const raw = m[0].slice(0, m[0].length - mag.length);
    out.push(makeNum(raw, magnitude));
  }
  return out;
}

/**
 * 回答里算作事实的数：带数量级 / 单位 / 货币的，小数，三位以上整数。
 * 题目里给了的数（goal 里的数）视为已知，不再核（但据它算出的结果仍要在屏上读到）。
 */
function valueNumbers(line, goalValues) {
  const out = [];
  NUMBER.lastIndex = 0;
  let m;
  while ((m = NUMBER.exec(line)) !== null) {
    const mag = m[1] || '';
    const magnitude = mag.trim();
    const raw = m[0].slice(0, m[0].length - mag.length);
    const n = makeNum(raw, magnitude);
    if (n.scaled !== null && goalValues.has(n.scaled)) continue;
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 8);
    const before = line.slice(0, m.index);
    const unit = magnitude !== '' || UNIT_AFTER.test(after) || CURRENCY_BEFORE.test(before);
    const decimal = n.value.includes('.');
    const long = n.value.split('.')[0].length >= 3;
    if (unit || decimal || long) out.push({ kind: 'number', text: `${n.value}${magnitude}`, num: n });
  }
  return out;
}

/** 一行里的日期 / 时刻（题目里已有的不算）。 */
function dateClaims(line, goalDigits) {
  const out = [];
  DATE.lastIndex = 0;
  let m;
  while ((m = DATE.exec(line)) !== null) {
    const text = m[0].trim();
    const digits = digitsOf(text);
    if (digits.length > 0 && digits.every((d) => goalDigits.has(d))) continue;
    out.push({ kind: 'date', text });
  }
  return out;
}

function digitsOf(s) {
  return (String(s).match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, '')).filter((d) => d !== '');
}

/** 把一处材料拆成「按行预处理好」的比对底料。 */
function prepareSources(evidence) {
  const texts = Array.isArray(evidence)
    ? evidence
    : (evidence && typeof evidence === 'object' && typeof evidence.text === 'string' ? [evidence.text] : []);
  return texts
    .filter((t) => typeof t === 'string' && t !== '')
    .map((text) => {
      const lines = canon(text).split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith(APP_HEADER));
      return {
        normLines: lines.map(norm),
        // 每行的数、数字串、字母数字串
        nums: lines.map((l) => numbersIn(l)),
        digits: lines.map((l) => digitsOf(l)),
        tokens: lines.map((l) => (l.toLowerCase().match(/[a-z0-9]+/g) || [])),
      };
    });
}

/** 引文在某处材料里：被 ... 分开的几段各对得上，而且在同一处。 */
function quoteInSources(quote, sources) {
  const parts = canon(quote).split(CUT).map(norm).filter((p) => p.length >= 2);
  if (parts.length === 0) return false;
  return sources.some((src) => parts.every((p) => src.normLines.some((line) => line.includes(p))));
}

/** 数在某处材料里（按整个数比，含数量级折算）。 */
function numberInSources(num, sources) {
  return sources.some((src) => src.nums.some((lineNums) => lineNums.some((n) => numMatches(num, n))));
}

/** 日期在某处材料里：数字串窗口对上（含丢掉年份的「月日」）。 */
function dateInSources(text, sources) {
  const comps = digitsOf(text);
  if (comps.length === 0) return false;
  const variants = [comps];
  if (comps.length === 3 && comps[0].length === 4) variants.push(comps.slice(1));
  return sources.some((src) => variants.some((v) => src.digits.some((line) => {
    if (v.length > line.length) return false;
    for (let i = 0; i + v.length <= line.length; i += 1) {
      if (v.every((d, k) => line[i + k] === d)) return true;
    }
    return false;
  })));
}

/**
 * 核一遍。
 *
 * @param {{answer:string, evidence:(string|string[]|{text:string}), goal?:string}} input
 * @returns {{ ok:boolean, unmet:Array<{kind:string,text:string}>, claims:Array<{kind:string,text:string}>, matched:number }}
 */
function check(input) {
  const answer = input && typeof input.answer === 'string' ? input.answer : '';
  const goal = input && typeof input.goal === 'string' ? input.goal : '';
  const sources = prepareSources(input && input.evidence);

  const a = canon(answer);
  const at = EVIDENCE.exec(a);
  const body = at ? a.slice(0, at.index) : a;
  const basis = at ? a.slice(at.index + at[0].length) : '';

  const goalText = norm(goal);
  const goalNumbers = numbersIn(canon(goal));
  const goalValues = new Set(goalNumbers.map((n) => n.scaled).filter((v) => v !== null));
  const goalDigits = new Set(digitsOf(goal));

  const claims = [];

  // 回答正文里的引文（题目里本来有的、空的不算）。
  const plainBody = body.replace(QUOTED, ' ');
  for (const q of quotes(body)) {
    if (norm(q).length < 2) continue;
    if (norm(q) && goalText && goalText.includes(norm(q))) continue;
    claims.push({ kind: 'quote', text: q });
  }
  // 「依据:」里的引文同样要核。
  for (const q of quotes(basis)) {
    if (norm(q).length < 2) continue;
    claims.push({ kind: 'quote', text: q });
  }

  // 逐行取数、取日期（正文里引号内容要遮掉，避免引文里的数被重复当成正文的事实）。
  for (const rawLine of plainBody.split('\n')) {
    const line = rawLine.replace(MARKUP, '');
    for (const c of dateClaims(line, goalDigits)) claims.push(c);
    for (const c of valueNumbers(line, goalValues)) claims.push(c);
  }

  // 去重
  const seen = new Set();
  const unique = claims.filter((c) => {
    const key = `${c.kind}\u0000${c.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let matched = 0;
  const unmet = [];
  for (const c of unique) {
    let ok;
    if (c.kind === 'quote') ok = quoteInSources(c.text, sources);
    else if (c.kind === 'number') ok = numberInSources(c.num || makeNum(c.text, ''), sources);
    else ok = dateInSources(c.text, sources);
    if (ok) matched += 1;
    else unmet.push({ kind: c.kind, text: c.text });
  }

  // 去掉内部字段再返回。
  const claimsOut = unique.map((c) => ({ kind: c.kind, text: c.text }));
  return { ok: unmet.length === 0, unmet, claims: claimsOut, matched };
}

const KIND_LABEL = { quote: '引文', number: '数', date: '日期' };

/** 给「退回改写一次」用的一句提示：把对不上的逐条列出来，让它改写或标未确认。 */
function rewriteHint(result) {
  const unmet = result && Array.isArray(result.unmet) ? result.unmet : [];
  if (unmet.length === 0) return '';
  const items = unmet.map((u) => `- ${KIND_LABEL[u.kind] || u.kind}「${u.text}」`).join('\n');
  return [
    '下面这些在本次读到的材料里找不到原文：',
    items,
    '请改写一次：删掉，或改成材料里确实出现过的话和数；确实没法确认的，标成「未确认」。',
  ].join('\n');
}

/** 最多退回改写几次。 */
const MAX_REWRITE = 1;

/**
 * 交回答前的核查口径：对不上就退回改写**一次**；改写过还是一样对不上，就标未确认交出
 * （不无限重试，也不假装通过）。
 *
 * @param {{answer:string, evidence:*, goal?:string, alreadyRewritten?:boolean}} input
 * @returns {{ action:'pass'|'rewrite'|'unconfirmed', ok:boolean, unmet:Array, claims:Array, matched:number, rewriteHint:string }}
 */
function review(input) {
  const result = check(input);
  if (result.ok) return { ...result, action: 'pass', rewriteHint: '' };
  const hint = rewriteHint(result);
  if (input && input.alreadyRewritten) return { ...result, action: 'unconfirmed', rewriteHint: hint };
  return { ...result, action: 'rewrite', rewriteHint: hint };
}

module.exports = {
  check,
  review,
  rewriteHint,
  // 守卫可直接用的纯函数与小常量：
  canon,
  norm,
  quotes,
  numbersIn,
  valueNumbers,
  dateClaims,
  MAX_REWRITE,
  CUT,
};

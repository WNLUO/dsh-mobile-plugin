'use strict';

/**
 * 统一脱敏：运行记录、证据账本、网络数据三处共用同一套规则，一处改了另两处跟着改。
 * 纯逻辑、无 IO、不改入参（redactObject 返回新对象）。
 *
 * 覆盖 Mika Redactor.kt 的全部口径，并补上卡号：
 *   - 密码框里打进去的字（字段名像凭据的，整段打码）；
 *   - sk-* / AIza* / AQ.* / ghp_* 等已知格式的 Key、Bearer 令牌；
 *   - JWT（eyJ… 三段）；
 *   - 又长又杂的串（≥32 位，且同时有大写、小写、数字）；
 *   - 16 位 / 19 位卡号类数字串（含分组空格 / 连字符）；
 *   - 名字像凭据的 query / 表单 / JSON / 头字段的值（token、secret、password、cookie、
 *     authorization…；author、keyword 这类不算）；
 *   - OAuth 回跳里的 code、state；
 *   - 前后 24 字内有「验证码 / 短信 / code / otp」一类词的 4–8 位数字。
 *
 * 三个导出的分工：
 *   redact(text)          对一段自由文本跑全部文本级规则（Key/JWT/长串/卡号/验证码）。
 *   redactObject(obj)     递归处理对象/数组：凭据名整段打码，其余字符串跑 redact。
 *   redactNetwork(body)   网络数据（URL / 表单 / JSON 正文 / 头表）：凭据名与 OAuth 一并打码。
 */

const MASK = '***';

/* ── 已知格式的凭据 ───────────────────────────────────────────────────── */

const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{30,}/g;
/** Google 新格式认证 Key：AQ. 开头一长串 base64url。 */
const GOOGLE_AUTH_KEY = /\bAQ\.[0-9A-Za-z_-]{20,}/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

/* ── JWT 与又长又杂的串 ───────────────────────────────────────────────── */

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const LONG = /[A-Za-z0-9_\-+=]{32,}/g;
const LONG_SLASH = /[A-Za-z0-9_\-+/=]{32,}/g;

/* ── 16 / 19 位卡号类 ─────────────────────────────────────────────────── */

/** 13–19 位数字，允许单个空格或连字符分组；是否真按卡号遮由位数（16 或 19）决定。 */
const CARD_LIKE = /(?<![\d.,])(?:\d[ -]?){15,18}\d(?![\d.,])/g;

/* ── 验证码一类的 4–8 位数字 ──────────────────────────────────────────── */

const CODE_WORD = /验证|校验码|动态码|动态密码|确认码|安全码|短信|口令|\b(?:code|otp|passcode|pin|2fa)\b/gi;
/** 4–8 位数字，中间可隔单个空格或连字符；后面跟单位 / 年份 / 货币的是量，不是码。 */
const CODE_DIGITS =
  /(?<![\d.¥$€£])(?<!\d,)\d(?:[ -]?\d){3,7}(?!\d)(?!\.\d)(?!,\d{3}(?!\d))(?!\s*(?:年|元|块|角|分钟|小时|秒|天|月|日|号|次|个|人|件|条|米|公里|千米|克|公斤|千克|斤|吨|度|℃|°|%|‰|[¥$€£]|km|kg|mb|gb|kb|ms|cm|mm|mah|rmb|usd|cny))/gi;
/** 码和词之间至多隔几个字（哪一边都算）。 */
const CODE_WINDOW = 24;

/* ── 名字像凭据 ──────────────────────────────────────────────────────── */

const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'password', 'passwd', 'pwd', 'passcode', 'session', 'sessionid', 'sessid', 'sid',
  'auth', 'authorization', 'csrf', 'xsrf', 'signature', 'sig', 'otp', 'cookie', 'credential', 'credentials',
  'apikey', 'jwt', 'bearer', 'pin', 'privatekey',
]);
const SECRET_COMPOUNDS = new Set([
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'clientsecret', 'sessionkey', 'authkey',
]);
const CASE_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g;
const WORD_SPLIT = /[^A-Za-z0-9]+/g;

/** 字段名按驼峰 / 下划线 / 连字符拆成词，有像凭据的词就是凭据字段。 */
function secretName(name) {
  const words = String(name == null ? '' : name)
    .split(WORD_SPLIT)
    .flatMap((part) => part.split(CASE_BOUNDARY))
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_COMPOUNDS.has(words.join(''));
}

const OAUTH_MARKERS = new Set(['state', 'redirect_uri', 'client_id', 'code_verifier']);
const OAUTH_RESULTS = new Set(['code', 'state']);

/* ── 文本级规则 ──────────────────────────────────────────────────────── */

function maskLong(s, slash) {
  const re = slash ? LONG_SLASH : LONG;
  return s.replace(re, (m) => {
    if (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m)) return MASK;
    return m;
  });
}

function maskCards(s) {
  return s.replace(CARD_LIKE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits === 16 || digits === 19 ? MASK : m;
  });
}

function maskCodes(s) {
  const words = [];
  for (const m of s.matchAll(CODE_WORD)) {
    words.push({ start: m.index, last: m.index + m[0].length - 1 });
  }
  if (words.length === 0) return s;
  return s.replace(CODE_DIGITS, (match, offset) => {
    const first = offset;
    const last = offset + match.length - 1;
    const near = words.some((w) => {
      const afterWord = first - w.last;
      const beforeWord = w.start - last;
      return (afterWord >= 1 && afterWord <= CODE_WINDOW + 1) || (beforeWord >= 1 && beforeWord <= CODE_WINDOW + 1);
    });
    return near ? MASK : match;
  });
}

/**
 * 自由文本脱敏：Key / Bearer / JWT / 长杂串 / 卡号 / 验证码。
 * @param {string} input
 * @returns {string}
 */
function redact(input) {
  if (input === null || input === undefined) return input;
  let s = typeof input === 'string' ? input : String(input);
  s = s.replace(SK_KEY, MASK);
  s = s.replace(GOOGLE_KEY, MASK);
  s = s.replace(GOOGLE_AUTH_KEY, MASK);
  s = s.replace(GITHUB_TOKEN, MASK);
  s = s.replace(BEARER, 'Bearer ' + MASK);
  s = s.replace(JWT, MASK);
  s = maskLong(s, true);
  s = maskCards(s);
  s = maskCodes(s);
  return s;
}

/* ── 结构化数据：query / 表单 / JSON / 头 ────────────────────────────── */

/**
 * 查询串或表单里 a=b&c=d：凭据名的值遮住；像 OAuth 回跳的（有 state 等，且带 code 或凭据）把 code、state 也遮住。
 * [bareKey] 为真时，孤零零一个叫 key 的参数也算凭据。
 */
function maskParams(q, bareKey) {
  const parts = q.split('&');
  const names = parts.map((p) => p.split('=')[0].toLowerCase());
  const oauth = names.some((n) => OAUTH_MARKERS.has(n)) && (names.includes('code') || names.some((n) => secretName(n)));
  return parts
    .map((p) => {
      const eq = p.indexOf('=');
      if (eq <= 0) return p;
      const name = p.slice(0, eq);
      const n = name.toLowerCase();
      const hide = secretName(name) || (bareKey && n === 'key') || (oauth && OAUTH_RESULTS.has(n));
      return hide ? name + '=' + MASK : p;
    })
    .join('&');
}

function maskUrl(u) {
  const hash = u.indexOf('#');
  const beforeHash = hash >= 0 ? u.slice(0, hash) : u;
  const fragment = hash >= 0 ? u.slice(hash + 1) : null;
  const q = beforeHash.indexOf('?');
  const base = q >= 0 ? beforeHash.slice(0, q + 1) + maskParams(beforeHash.slice(q + 1), true) : beforeHash;
  return fragment === null ? base : base + '#' + (fragment.includes('=') ? maskParams(fragment, true) : fragment);
}

const JSON_PAIR = /"((?:[^"\\]|\\.){1,100})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;
const FORM = /^[^\s{}[\]"<>]+=[^\s]*$/;

function maskBody(b) {
  if (FORM.test(b)) return maskParams(b, false);
  return b.replace(JSON_PAIR, (m, key, sep) => (secretName(key) ? `"${key}"${sep}"${MASK}"` : m));
}

/**
 * 网络数据里的一个字符串（URL / 表单 / JSON 正文）脱敏。先按结构遮凭据名与 OAuth，
 * 再跑一遍文本级规则兜住值里的 Key / JWT / 长串 / 卡号。
 */
function maskNetworkString(s) {
  let out;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (/^[^\s]*\?/.test(s) && s.includes('='))) {
    out = maskUrl(s);
  } else if (FORM.test(s)) {
    out = maskParams(s, false);
  } else {
    out = maskBody(s);
  }
  return redact(out);
}

/**
 * 递归脱敏对象 / 数组。名字像凭据的键整段打码；其余字符串跑 redact；数字布尔原样。
 * @param {*} value
 * @returns {*}
 */
function redactObject(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v));
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (secretName(k)) out[k] = MASK;
      else out[k] = redactObject(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * 网络数据脱敏：body 可以是字符串（URL / 表单 / JSON 正文），也可以是头表这类对象。
 * @param {*} body
 * @returns {*}
 */
function redactNetwork(body) {
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') return maskNetworkString(body);
  if (Array.isArray(body)) return body.map((b) => redactNetwork(b));
  if (typeof body === 'object') return redactObject(body);
  return body;
}

module.exports = {
  redact,
  redactObject,
  redactNetwork,
  secretName,
  maskParams,
  maskUrl,
  // 给「证据账本 / 运行记录」这类只要纯文本遮罩的调用方留的别名，语义等价于 redact：
  // phone/evidence.js 的 loadSharedRedactor 找的就是 evidence / text 这两个名字之一。
  evidence: redact,
  text: redact,
  MASK,
  CODE_WINDOW,
};

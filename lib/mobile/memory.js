'use strict';

/**
 * 长期记忆层（数据层 + 纯逻辑）：保存用户的事实 / 偏好 / 做事方式，跨会话按工作区或全局分开。
 *
 * ## 这一层做什么、不做什么
 *
 * 记忆的**真值**在宿主会话记录那一侧：抽取器只读「用户这次说的话 + 相关旧记忆」，产出
 * add/update/forget，再由代码校验引文确实出自用户原话；每轮再把记忆拼进 prompt。那一段
 * （抽取任务、引文校验、注入、预算裁剪的落地）要宿主内核配合，本模块不硬做。
 *
 * 本模块把「存储 + 检索 + 管理」抽成一本按 scope 分开的 JSON 账本，负责：
 *  · 写入前过敏感信息关卡（密码 / 验证码 / 卡号 / 身份证 / api key 一律不落盘）；
 *  · 按类型去重（同 kind + 同内容不重复记）、来源与时间（quote / conversationId / atMs / channel）；
 *  · 置顶、删除、撤销（最近 {@link UNDO_KEEP} 次变更）、做法需用户批准（procedure 默认 pending）；
 *  · BM25 检索与把一撮记忆渲染成上下文块（纯文本，供将来注入调用）。
 *
 * 记忆是用户私有数据，只落本机（`$DSH_HOME/storages/mobile-plugin/memory/`），不经中转；
 * 这里不碰 shell、不写任意路径，scope 名也被收窄成安全文件名。
 *
 * ## 落盘形状
 *
 *   memory/global.json              —— 全局记忆：{ version, scope, items: [...] }
 *   memory/workspaces/<slug>-<h>.json —— 某个工作区的记忆
 *
 * 读不出（JSON 坏了、权限不对）时**拒绝写入**，宁可这轮不记，也不能用空表把真正的记忆盖掉；
 * 文件不存在是正常空账本。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');

/** 三类记忆。procedure（做法）默认待批准。 */
const KINDS = Object.freeze(['fact', 'preference', 'procedure']);
/** 状态：active 在用；pending 等用户点头（只有 procedure 会 pending）。 */
const STATUSES = Object.freeze(['active', 'pending']);
/** 全局 scope 的固定名。 */
const GLOBAL_SCOPE = 'global';

/** 单条记忆正文上限（字符）：记忆块按行编号，太长会占满上下文。 */
const MAX_CONTENT = 200;
/** 单条记忆的关键词上限。 */
const MAX_KEYWORDS = 8;
/** 一本账本的记忆条数上限。 */
const LIMIT = 500;
/** 撤销令牌在内存里保留的最近变更数。 */
const UNDO_KEEP = 50;

/** 逻辑拒绝：code 供 handler 翻成 400 的 error.code。 */
class MemoryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MemoryError';
    this.code = code;
  }
}

/** 记忆库根。`DSH_MOBILE_MEMORY` 只给测试用。 */
function memoryRoot() {
  return process.env.DSH_MOBILE_MEMORY || path.join(dshHome(), 'storages', 'mobile-plugin', 'memory');
}

/**
 * 由工作区路径算出一个稳定的 scope 名。空路径回落全局。
 * 只做可读的归一（保留名字好排查），真正的唯一性由落盘文件名的短哈希保证。
 */
function scopeForWorkspace(workspacePath) {
  const raw = typeof workspacePath === 'string' ? workspacePath.trim() : '';
  if (!raw) return GLOBAL_SCOPE;
  const slug = raw
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `workspace:${slug || 'workspace'}`;
}

// ── 敏感信息关卡 ─────────────────────────────────────────────────────────────

const SPACES = /\s+/g;

/** 先把全角数字字母、兼容字符统一成 NFKC，再比对。 */
function normalizeForSensitive(text) {
  return String(text == null ? '' : text).normalize('NFKC');
}

// 支付/凭据类关键词（中英）。pin/otp 太短，单独只在后面跟数字时算。
const SECRET_KEYWORDS = /支付密码|密码|口令|验证码|校验码|动态码|安全码|安全问题|(?<![A-Za-z])(?:password|passcode|passwd|cvv|cvc|verification code|security code|security question|one-time code)(?![A-Za-z])/i;
const DIGIT_KEYWORDS = /(?<![A-Za-z])(?:pin|otp)(?![A-Za-z])/i;
// 关键词与 4 位以上数字/字母串之间只允许很短的连接，免得一句普通话里的数字被误判。
const KEYWORD_GAP = '[\\s:：=,，是为叫]{0,4}(?:(?:is|was|are)\\s+)?';
const OWNER = '\\s*(?:就是|是|为)(?:我的|我|用户的)?\\s*';

const KEYWORD_RULES = [
  new RegExp(`(?:${SECRET_KEYWORDS.source})${KEYWORD_GAP}[A-Za-z0-9]{4,}`, 'i'),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z0-9]{4,}${OWNER}(?:${SECRET_KEYWORDS.source})`, 'i'),
  new RegExp(`(?:${DIGIT_KEYWORDS.source})${KEYWORD_GAP}[0-9]{4,}`, 'i'),
  new RegExp(`(?<![A-Za-z0-9])[0-9]{4,}${OWNER}(?:${DIGIT_KEYWORDS.source})`, 'i'),
];

// 18 位身份证（出生日期是真实日期、末位符合 ISO 7064 MOD 11-2）。
const ID_NUMBER = /(?<![0-9])[1-9][0-9]{16}[0-9Xx](?![0-9A-Za-z])/;
// 卡号：13–19 位数字，允许单个空格或连字符分组。
const CARD_LIKE = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';

// 常见凭据形状。
const API_KEY_PATTERNS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/,
  /(?<![A-Za-z])Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9])/,
];

function luhn(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    let d = reversed[i].charCodeAt(0) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function validIdNumber(id) {
  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  if (!(year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

/**
 * 这段文字里有没有不该长期落盘的秘密。命中返回类别（`api_key` / `id_number` /
 * `card_number` / `password`），否则 null。手机号、地址、生日、家人称呼放行（办事常用的
 * 事实），别把它们当秘密。
 */
function sensitiveHit(text) {
  const t = normalizeForSensitive(text);
  if (!t) return null;
  const compact = t.replace(SPACES, '');
  if (API_KEY_PATTERNS.some((re) => re.test(t))) return 'api_key';
  const idCandidates = t.match(new RegExp(ID_NUMBER.source, 'g')) || [];
  if (idCandidates.some(validIdNumber)) return 'id_number';
  const cardCandidates = t.match(new RegExp(CARD_LIKE.source, 'g')) || [];
  if (cardCandidates.some((c) => luhn(c.replace(/[^0-9]/g, '')))) return 'card_number';
  if (KEYWORD_RULES.some((re) => re.test(t) || re.test(compact))) return 'password';
  return null;
}

// ── 检索（词法切词 + BM25）──────────────────────────────────────────────────

const WORD = /[A-Za-z0-9]+/g;

/** 是否汉字。 */
function isHan(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2ebef)
  );
}

/**
 * 本机词法切词：汉字取相邻两字（单字成词时保留单字），英文数字按单词小写。
 * withUnigrams 另给每个汉字单字（查询用，让「辣」这类单字检索词能对上）。
 */
function tokenize(text, withUnigrams = false) {
  const source = String(text == null ? '' : text);
  const out = [];
  let han = '';
  const flushHan = () => {
    if (!han) return;
    if (han.length === 1) out.push(han);
    else {
      for (let i = 0; i < han.length - 1; i += 1) out.push(han.slice(i, i + 2));
      if (withUnigrams) for (const ch of han) out.push(ch);
    }
    han = '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (isHan(ch)) {
      han += ch;
      i += 1;
      continue;
    }
    flushHan();
    WORD.lastIndex = i;
    const m = WORD.exec(source);
    if (m && m.index === i) {
      out.push(m[0].toLowerCase());
      i += m[0].length;
    } else {
      i += 1;
    }
  }
  flushHan();
  return out;
}

const STOP_TERMS = new Set([
  '帮我', '给我', '一下', '我的', '不要', '这个', '那个', '可以', '一个', '用户',
  '今天', '这次', '现在', '什么', '怎么', '我们', '一些', '看看',
]);

const K1 = 1.2;
const B = 0.75;
const KEYWORD_TF = 2;
const MIN_CORPUS = 50;

function isUnigram(term) {
  return term.length === 1 && isHan(term[0]);
}

/**
 * 对一个条目集合建倒排、按 BM25 打分，只回相关的。供 {@link createMemoryStore} 的 search 用。
 * 相关判据与 Mika 一致：检索词对上了，或至少两个不同查询词命中，或唯一命中的词只此一条有
 * 且是它的检索词；单字只参与打分、不算进这三条。
 */
function rankItems(items, query, limit) {
  const eligible = items;
  if (eligible.length === 0 || limit <= 0) return [];
  const docs = eligible.map((item) => {
    const counts = new Map();
    for (const term of tokenize(item.content)) counts.set(term, (counts.get(term) || 0) + 1);
    for (const kw of item.keywords || []) {
      for (const term of tokenize(kw)) counts.set(term, (counts.get(term) || 0) + KEYWORD_TF);
    }
    return counts;
  });
  const lengths = docs.map((d) => {
    let total = 0;
    for (const v of d.values()) total += v;
    return total;
  });
  const keywordTerms = eligible.map((item) => {
    const set = new Set();
    for (const kw of item.keywords || []) for (const term of tokenize(String(kw).toLowerCase())) set.add(term);
    return set;
  });
  const corpus = Math.max(eligible.length, MIN_CORPUS);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / eligible.length || 1;
  const q = String(query || '').toLowerCase();
  const terms = [...new Set(tokenize(q, true))].filter((t) => !STOP_TERMS.has(t));
  if (terms.length === 0) return [];
  const termSet = new Set(terms);
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.has(t)).length]));
  const idf = new Map(terms.map((t) => {
    const n = df.get(t);
    return [t, Math.log(1 + (corpus - n + 0.5) / (n + 0.5))];
  }));
  const scored = [];
  eligible.forEach((item, idx) => {
    const doc = docs[idx];
    const matched = terms.filter((t) => doc.has(t));
    if (matched.length === 0) return;
    const multi = matched.filter((t) => !isUnigram(t));
    const keywordHit = (item.keywords || []).some((kw) => {
      const k = String(kw).toLowerCase();
      const kt = tokenize(k);
      return q.includes(k) || (kt.length > 0 && kt.every((t) => termSet.has(t)));
    });
    const relevant = keywordHit || multi.length >= 2 ||
      (multi.length === 1 && df.get(multi[0]) === 1 && keywordTerms[idx].has(multi[0]));
    if (!relevant) return;
    const norm = K1 * (1 - B + (B * lengths[idx]) / Math.max(avgLen, 1));
    let score = 0;
    for (const t of matched) {
      const tf = doc.get(t);
      score += (idf.get(t) * tf * (K1 + 1)) / (tf + norm);
    }
    scored.push({ item, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── 账本 ────────────────────────────────────────────────────────────────────

function cleanContent(value) {
  return String(value == null ? '' : value).replace(SPACES, ' ').trim();
}

function cleanKeywords(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const kw = cleanContent(raw);
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function normalizeSource(source, now) {
  const src = source && typeof source === 'object' ? source : {};
  const type = src.type === 'manual' ? 'manual' : 'user_said';
  return {
    type,
    quote: typeof src.quote === 'string' && src.quote.trim() ? cleanContent(src.quote) : null,
    conversationId: typeof src.conversationId === 'string' && src.conversationId.trim() ? src.conversationId.trim() : null,
    atMs: Number.isFinite(src.atMs) ? src.atMs : now,
    channel: typeof src.channel === 'string' && src.channel.trim() ? src.channel.trim() : null,
  };
}

function isItemRecord(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.content === 'string' &&
    KINDS.includes(value.kind);
}

function cloneItem(item) {
  return {
    ...item,
    keywords: Array.isArray(item.keywords) ? item.keywords.slice() : [],
    source: item.source ? { ...item.source } : item.source,
  };
}

/**
 * 建一个记忆账本。
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] 账本根目录，缺省 {@link memoryRoot}（测试可指临时目录）。
 * @param {() => number} [options.clock] 时钟，缺省 Date.now。
 * @param {() => string} [options.ids] id/撤销令牌生成器，缺省 randomUUID。
 * @param {number} [options.limit] 每个 scope 的条数上限，缺省 {@link LIMIT}。
 */
function createMemoryStore(options = {}) {
  const root = options.rootDir || memoryRoot();
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const makeId = typeof options.ids === 'function' ? options.ids : () => crypto.randomUUID();
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : LIMIT;

  const cache = new Map(); // scope -> items[]
  const undos = new Map(); // token -> { scope, change }

  function fileFor(scope) {
    if (scope === GLOBAL_SCOPE) return path.join(root, 'global.json');
    const safe = String(scope).replace(/^workspace:/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workspace';
    const hash = crypto.createHash('sha1').update(String(scope)).digest('hex').slice(0, 8);
    return path.join(root, 'workspaces', `${safe}-${hash}.json`);
  }

  function load(scope) {
    const hit = cache.get(scope);
    if (hit) return hit;
    const file = fileFor(scope);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const empty = [];
        cache.set(scope, empty);
        return empty;
      }
      throw new MemoryError('unavailable');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MemoryError('unavailable');
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      throw new MemoryError('unavailable');
    }
    const items = parsed.items.filter(isItemRecord).map(cloneItem);
    cache.set(scope, items);
    return items;
  }

  function save(scope, items) {
    const file = fileFor(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = `${JSON.stringify({ version: 1, scope, items }, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.${clock()}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
    cache.set(scope, items);
  }

  function remember(scope, change) {
    const token = makeId();
    undos.set(token, { scope, change });
    while (undos.size > UNDO_KEEP) undos.delete(undos.keys().next().value);
    return token;
  }

  function check(content, keywords, source) {
    if (content.length === 0 || content.length > MAX_CONTENT) throw new MemoryError('too_long');
    const texts = [content, ...keywords, source && source.quote ? source.quote : ''];
    for (const text of texts) if (sensitiveHit(text)) throw new MemoryError('sensitive');
  }

  function add(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    if (!KINDS.includes(input.kind)) throw new MemoryError('invalid_kind');
    const items = load(scope);
    const content = cleanContent(input.content);
    const keywords = cleanKeywords(input.keywords);
    const source = normalizeSource(input.source, clock());
    check(content, keywords, source);

    // 同类型同内容视为同一条：不重复记，只把更新时间推到现在。
    const dup = items.find((it) => it.kind === input.kind && cleanContent(it.content) === content);
    if (dup) {
      const bumped = { ...dup, updatedAt: clock() };
      save(scope, items.map((it) => (it.id === dup.id ? bumped : it)));
      return { item: cloneItem(bumped), undoToken: null, deduped: true };
    }

    if (items.length >= limit) throw new MemoryError('memory_full');
    const id = makeId();
    if (items.some((it) => it.id === id)) throw new MemoryError('duplicate_id');
    const now = clock();
    const item = {
      id,
      kind: input.kind,
      content,
      keywords,
      source,
      status: input.kind === 'procedure' ? 'pending' : 'active',
      pinned: input.pinned === true,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      replaces: null,
    };
    const undoToken = remember(scope, { type: 'added', item: cloneItem(item) });
    save(scope, [...items, item]);
    return { item: cloneItem(item), undoToken, deduped: false };
  }

  function update(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    const items = load(scope);
    const before = items.find((it) => it.id === input.id);
    if (!before) throw new MemoryError('not_found');
    const content = cleanContent(input.content != null ? input.content : before.content);
    const keywords = input.keywords != null ? cleanKeywords(input.keywords) : before.keywords;
    const source = input.source != null ? normalizeSource(input.source, clock()) : before.source;
    check(content, keywords, source);
    // 做法被非手写来源改动后要重新批准；用户手改或没有来源的改动保持原状态。
    const reapprove = before.kind === 'procedure' && input.source != null && source.type !== 'manual';
    const item = {
      ...before,
      content,
      keywords,
      source,
      updatedAt: clock(),
      replaces: content !== before.content ? before.content : before.replaces,
      status: reapprove ? 'pending' : before.status,
    };
    const undoToken = remember(scope, { type: 'updated', item: cloneItem(item), before: cloneItem(before) });
    save(scope, items.map((it) => (it.id === item.id ? item : it)));
    return { item: cloneItem(item), undoToken };
  }

  function forget(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    const items = load(scope);
    const before = items.find((it) => it.id === input.id);
    if (!before) throw new MemoryError('not_found');
    const undoToken = remember(scope, { type: 'forgot', before: cloneItem(before) });
    save(scope, items.filter((it) => it.id !== before.id));
    return { item: cloneItem(before), undoToken };
  }

  /** 未知/过期/已用过的令牌回 false。更新的撤销只在条目仍是这次改后的样子时才做。 */
  function undo(token) {
    const entry = undos.get(String(token));
    if (!entry) return false;
    const items = load(entry.scope);
    const { change } = entry;
    let next;
    if (change.type === 'added') {
      next = items.filter((it) => it.id !== change.item.id);
    } else if (change.type === 'forgot') {
      next = items.some((it) => it.id === change.before.id) ? items : [...items, cloneItem(change.before)];
    } else if (change.type === 'updated') {
      const cur = items.find((it) => it.id === change.item.id);
      if (!cur || cur.content !== change.item.content || cleanKeywords(cur.keywords).join('\u0000') !== cleanKeywords(change.item.keywords).join('\u0000')) {
        return false;
      }
      next = items.map((it) => {
        if (it.id !== change.item.id) return it;
        return { ...cloneItem(change.before), useCount: cur.useCount, lastUsedAt: cur.lastUsedAt, pinned: cur.pinned };
      });
    } else {
      return false;
    }
    save(entry.scope, next);
    undos.delete(String(token));
    return true;
  }

  function approve(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    const items = load(scope);
    const target = items.find((it) => it.id === input.id);
    if (!target || target.status !== 'pending') return false;
    save(scope, items.map((it) => (it.id === input.id ? { ...it, status: 'active', updatedAt: clock() } : it)));
    return true;
  }

  function setPinned(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    const items = load(scope);
    if (!items.some((it) => it.id === input.id)) return false;
    save(scope, items.map((it) => (it.id === input.id ? { ...it, pinned: input.pinned === true } : it)));
    return true;
  }

  function markUsed(input = {}) {
    const scope = input.scope || GLOBAL_SCOPE;
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
    if (ids.length === 0) return;
    const set = new Set(ids);
    const items = load(scope);
    const now = clock();
    save(scope, items.map((it) => (set.has(it.id) ? { ...it, useCount: (it.useCount || 0) + 1, lastUsedAt: now } : it)));
  }

  /** 用户要整本清除：这就是用户的意思，空表覆盖。 */
  function clear(scope = GLOBAL_SCOPE) {
    undos.clear();
    save(scope, []);
  }

  /** 列出某个 scope 的全部记忆（副本）。 */
  function list(scope = GLOBAL_SCOPE) {
    return load(scope).map(cloneItem);
  }

  /** 某个 scope 里待批准的做法。 */
  function pending(scope = GLOBAL_SCOPE) {
    return load(scope).filter((it) => it.status === 'pending').map(cloneItem);
  }

  /**
   * 按 query 检索。默认只搜 active；includePending 时可带上待批准做法（给模型看前应过滤）。
   * 返回 [{ item, score }]，按分数降序。
   */
  function search(scope = GLOBAL_SCOPE, query = '', opts = {}) {
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 8;
    const items = load(scope).filter((it) => (opts.includePending ? true : it.status === 'active'));
    return rankItems(items, query, limit);
  }

  return {
    root,
    fileFor,
    add,
    update,
    forget,
    undo,
    approve,
    setPinned,
    markUsed,
    clear,
    list,
    pending,
    search,
  };
}

/**
 * 把一撮记忆渲染成一段上下文文本（纯逻辑；将来由宿主注入时直接拼到 prompt 前面）。
 * 置顶优先、其后按更新时间倒序；做法最多 3 条；超过 maxChars 从末尾丢。
 */
function renderContext(items, opts = {}) {
  const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 8000;
  const active = (Array.isArray(items) ? items : []).filter((it) => it && it.status === 'active');
  if (active.length === 0) return '';
  const sorted = active.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
  const facts = sorted.filter((it) => it.kind !== 'procedure');
  const procedures = sorted.filter((it) => it.kind === 'procedure').slice(0, 3);
  const sections = [];
  if (facts.length > 0) {
    sections.push(
      'Memories about the user (things the user told you; may be out of date; when they conflict with what the user says now, follow what they say now):\n' +
      facts.map((it, i) => `${i + 1}. ${it.content}`).join('\n'),
    );
  }
  if (procedures.length > 0) {
    sections.push(
      'Ways of doing things the user approved (when they conflict with what the user says now, follow what they say now):\n' +
      procedures.map((it, i) => `${i + 1}. ${it.content}`).join('\n'),
    );
  }
  let text = sections.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

module.exports = {
  KINDS,
  STATUSES,
  GLOBAL_SCOPE,
  MAX_CONTENT,
  MAX_KEYWORDS,
  LIMIT,
  UNDO_KEEP,
  MemoryError,
  memoryRoot,
  scopeForWorkspace,
  sensitiveHit,
  normalizeForSensitive,
  tokenize,
  rankItems,
  createMemoryStore,
  renderContext,
};

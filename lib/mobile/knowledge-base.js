'use strict';

/**
 * 知识库：他说过、定下来的事，一条一个小文件，外加一份关键词索引。
 *
 * ## 只准往里加
 *
 * 模型能做的只有 `appendEntry`：写一条新条目。**没有任何接口能改写或删除已存条目** ——
 * 写错了只能在 App 里由人删（那半边归界面那条任务）。所以这里没有 `update`、没有 `remove`，
 * 新建时编号永远由宿主现取，调用方给不了已有编号来覆写。
 *
 * 这条约束不是为了防谁，是因为「记忆被悄悄改掉」这种失败没人发现得了：翻出来的时候它读着
 * 很顺，只是跟当初说的不一样了。宁可同一件事记两条，也不要改历史。
 *
 * ## 目录形状
 *
 * `<DSH_HOME>/storages/mobile-plugin/knowledge/`
 *  · `entries/<id>.json` —— 一条一个文件，几百字节，写一次之后再也不动
 *  · `index.json`       —— 关键词 → 编号，追加时顺手加，丢了能从 entries 重建
 *
 * 一条一个文件而不是一本大 JSON：追加只写那一个文件，不会因为一次写坏把整库带走；读一条
 * 也只读那一个。索引是**可重建的派生数据**，读坏 / 缺文件都当空，检索时再从 entries 补。
 *
 * ## 检索只用关键词
 *
 * 切词与打分复用 `memory.js` 那份（汉字双字 + 英文小写单词），不引向量库、不加依赖。
 * 电话里问「上次那个绿点的事」，靠的就是「绿点」这两个字对得上。
 *
 * ## 通话结束后整理再写
 *
 * 通话中不落盘：一句一句往里写，除了噪声什么都没攒下。通话中只往内存里的那份草稿上记，
 * 一轮结束（`turn/end`）或显式调 `flushCall` 时才整理一遍 —— 去掉与已存条目雷同的、
 * 去掉同一通里重复的、每条补上关键词 —— 然后**逐条追加**。整理只做取舍，不改已存的。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
const { tokenize } = require('./memory.js');

/** 库格式版本。 */
const VERSION = 1;

/** 条目编号：`kb` + 8 位小写十六进制。目录名、路径参数、用户嘴里念的都是这一串。 */
const ID_RE = /^kb[0-9a-f]{8}$/;

/** 一条正文上限（字符）：通话里一句话的长度，再长就不是「定下来的事」了。 */
const MAX_TEXT = 500;
/** 一条的关键词上限。 */
const MAX_KEYWORDS = 8;
/** 检索默认回几条。 */
const DEFAULT_LIMIT = 5;
/** 检索最多次数上限（别让一句超长查询把整库扫穿）。 */
const MAX_LIMIT = 20;

/** 一通里最多攒多少条草稿：再多的通话也该当场说清，攒着等于不记。 */
const MAX_DRAFT = 32;
/** 草稿保留时长：通话没正常收尾（插件换代、宿主被杀）时，超过这个时间就丢掉。 */
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

/** 库根。`DSH_MOBILE_KNOWLEDGE` 只给测试用。 */
function rootDir() {
  return process.env.DSH_MOBILE_KNOWLEDGE
    || path.join(dshHome(), 'storages', 'mobile-plugin', 'knowledge');
}

function entriesDir() {
  return path.join(rootDir(), 'entries');
}

function indexFile() {
  return path.join(rootDir(), 'index.json');
}

function entryFile(id) {
  return path.join(entriesDir(), `${id}.json`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 单行字符串：换行在「念出来」和「关键词切词」两处都没有意义。 */
function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeKeywords(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const keyword = oneLine(raw, 40);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** 新编号。碰撞了就重取，最多试几次（八位十六进制，实际撞不上）。 */
function newId() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `kb${crypto.randomBytes(4).toString('hex')}`;
    if (!fs.existsSync(entryFile(id))) return id;
  }
  return `kb${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 原子写：先写临时文件再 rename。宿主随时可能被杀，半个 JSON 会让这一条打不开。
 * 写失败抛出去 —— 调用方要如实知道这条没记上，而不是以为记上了。
 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 读一条。文件不在 / 读坏 / 编号不合规矩都回 null，不抛。 */
function readEntry(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(entryFile(id), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const text = oneLine(raw.text, MAX_TEXT);
  if (!text) return null;
  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : 0;
  return {
    id,
    text,
    keywords: normalizeKeywords(raw.keywords),
    sessionId: oneLine(raw.sessionId, 200),
    sessionTitle: oneLine(raw.sessionTitle, 120),
    source: raw.source === 'manual' ? 'manual' : 'call',
    createdAt,
  };
}

/** 全部条目（按发布时间倒序，旧的在后）。坏档跳过、不占位。 */
function listEntries() {
  let names;
  try {
    names = fs.readdirSync(entriesDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const entry = readEntry(id);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** 空索引。 */
function emptyIndex() {
  return { version: VERSION, updatedAt: 0, terms: {} };
}

/**
 * 读索引。读坏 / 缺文件回空 —— 它是派生数据，检索那条会在候选为空时从 entries 重建一次，
 * 丢一份索引不该让「想起来」这件事整块失效。
 */
function readIndex() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
  } catch {
    return emptyIndex();
  }
  if (!isRecord(raw) || !isRecord(raw.terms)) return emptyIndex();
  const terms = {};
  for (const [term, ids] of Object.entries(raw.terms)) {
    if (!Array.isArray(ids)) continue;
    const kept = ids.filter((id) => typeof id === 'string' && ID_RE.test(id));
    if (kept.length > 0) terms[term] = kept;
  }
  return {
    version: VERSION,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    terms,
  };
}

function saveIndex(index) {
  const next = { ...index, version: VERSION, updatedAt: Date.now() };
  // 索引坏了最多重扫一遍目录，不值得让一次追加失败：写不进去就放弃。
  try {
    writeFileAtomic(indexFile(), `${JSON.stringify(next)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 一条条目进哪些词：正文的常用词 + 显式给的关键词（关键词权重更高，检索时按命中数算）。 */
function termsOf(entry) {
  const set = new Set();
  for (const term of tokenize(entry.text)) set.add(term);
  for (const keyword of entry.keywords) {
    for (const term of tokenize(keyword)) set.add(term);
  }
  return set;
}

function addToIndex(index, entry) {
  for (const term of termsOf(entry)) {
    const bucket = Array.isArray(index.terms[term]) ? index.terms[term] : [];
    if (!bucket.includes(entry.id)) bucket.push(entry.id);
    index.terms[term] = bucket;
  }
}

/** 从 entries 重建整份索引。只在索引缺失 / 读空时走这条路（几十条以内，几毫秒）。 */
function rebuildIndex() {
  const index = emptyIndex();
  for (const entry of listEntries()) addToIndex(index, entry);
  saveIndex(index);
  return index;
}

/**
 * 追加一条。**唯一的写入口**：没有编号可给，永远新建。
 *
 * @param {{text: string, keywords?: string[], sessionId?: string, sessionTitle?: string, source?: string}} input
 * @returns {object|null} 写不成（正文为空、编号冲突）时回 null
 */
function appendEntry(input) {
  if (!isRecord(input)) return null;
  const text = oneLine(input.text, MAX_TEXT);
  if (!text) return null;
  const id = newId();
  const entry = {
    id,
    text,
    keywords: normalizeKeywords(input.keywords),
    sessionId: oneLine(input.sessionId, 200),
    sessionTitle: oneLine(input.sessionTitle, 120),
    source: input.source === 'manual' ? 'manual' : 'call',
    createdAt: Date.now(),
  };
  // 文件编号已经验过不存在；这里用 `wx` 再兜一道，防的是「两次追加同时挑中同一个编号」。
  try {
    fs.mkdirSync(entriesDir(), { recursive: true });
    fs.writeFileSync(entryFile(id), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    return null;
  }
  const index = readIndex();
  addToIndex(index, entry);
  saveIndex(index);
  return entry;
}

/**
 * 删掉一条。**只给人在 App 里用**：模型手上没有这个口子（它只有 `appendEntry`）。
 * 编号不合规矩 / 文件不在都回 false，不抛。删完从 entries 重建索引，顺带把那条从
 * 所有词桶里摘干净 —— 索引是派生数据，重扫几十条是几毫秒的事，比逐桶摘更不容易留残。
 *
 * @param {string} id
 * @returns {boolean} 真删掉了才 true
 */
function removeEntry(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return false;
  try {
    fs.unlinkSync(entryFile(id));
  } catch {
    return false;
  }
  rebuildIndex();
  return true;
}

/**
 * 关键词检索：只认词面命中，按「命中多少个不同的词」排序（打平看关键词命中与时间）。
 *
 * `keywords` 那一格是给调用方显示为什么要它用的，不参与另外的打分。
 */
function search(query, options) {
  const limit = (() => {
    const wanted = options && Number.isFinite(options.limit) ? Math.trunc(options.limit) : DEFAULT_LIMIT;
    if (wanted <= 0) return DEFAULT_LIMIT;
    return Math.min(wanted, MAX_LIMIT);
  })();
  const terms = [...new Set(tokenize(String(query || ''), true))];
  if (terms.length === 0) return [];

  /** 按当前索引收集候选：编号 → 命中的不同词数（同一句里重复出现的词只算一次）。 */
  const collect = (index) => {
    const hits = new Map();
    for (const term of terms) {
      for (const id of index.terms[term] || []) hits.set(id, (hits.get(id) || 0) + 1);
    }
    return hits;
  };

  let index = readIndex();
  if (Object.keys(index.terms).length === 0) index = rebuildIndex();
  let hits = collect(index);
  // 索引可能落后于目录（写索引失败、或有人在盘上补了一条）：一个候选都没有就重扫一次。
  if (hits.size === 0) {
    index = rebuildIndex();
    hits = collect(index);
  }
  if (hits.size === 0) return [];

  const matchedTerms = new Map();
  for (const term of terms) {
    for (const id of index.terms[term] || []) {
      const bucket = matchedTerms.get(id) || [];
      if (!bucket.includes(term)) bucket.push(term);
      matchedTerms.set(id, bucket);
    }
  }

  const rows = [];
  for (const [id, score] of hits) {
    const entry = readEntry(id);
    if (!entry) continue;
    const keywordHit = entry.keywords.some((keyword) => {
      const k = String(keyword).toLowerCase();
      return String(query || '').toLowerCase().includes(k)
        || tokenize(k).some((term) => terms.includes(term));
    });
    rows.push({ entry, score, keywordHit, terms: matchedTerms.get(id) || [] });
  }
  rows.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.keywordHit !== b.keywordHit) return a.keywordHit ? -1 : 1;
    return b.entry.createdAt - a.entry.createdAt;
  });
  return rows.slice(0, limit).map((row) => ({
    ...row.entry,
    score: row.score,
    matched: row.terms,
  }));
}

// ── 通话里的草稿 ────────────────────────────────────────────────────────────

/** sessionId → { startedAt, at, sessionTitle, notes: [] }。只活在内存里，通话结束才落盘。 */
const drafts = new Map();

function draftOf(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId : 'unknown';
  let draft = drafts.get(key);
  if (draft) return draft;
  draft = { startedAt: Date.now(), at: Date.now(), sessionTitle: '', notes: [] };
  drafts.set(key, draft);
  return draft;
}

/**
 * 通话里记一笔（**不落盘**）。同一通里攒着，等收尾那次统一整理。
 *
 * @returns {boolean} 攒进去了没有
 */
function noteForCall(sessionId, text, extra) {
  const line = oneLine(text, MAX_TEXT);
  if (!line) return false;
  const draft = draftOf(sessionId);
  if (draft.notes.length >= MAX_DRAFT) return false;
  draft.notes.push({
    text: line,
    keywords: normalizeKeywords(isRecord(extra) ? extra.keywords : undefined),
  });
  draft.at = Date.now();
  if (isRecord(extra) && typeof extra.sessionTitle === 'string') {
    draft.sessionTitle = oneLine(extra.sessionTitle, 120);
  }
  return true;
}

/** 两条正文是不是「同一件事」：去掉标点空白后完全相同。整理时按这一条去重。 */
function normalizeForCompare(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 整理 + 落盘：这一通的草稿逐条追加，返回写进去的条目。
 *
 * 整理做两件事，一件也不改已存的：
 *  1. 与本通里前面那条雷同的丢掉；
 *  2. 与库里已存条目雷同的丢掉（同一件事说过两遍不该占两条）。
 *
 * 关键词不在这里补：正文的词已经全进了索引，检索对得上；显式关键词是调用方给的额外抓手，
 * 悄悄替它编几个反而会让「为什么这条被想起来」说不清。
 */
function flushCall(sessionId) {
  const key = typeof sessionId === 'string' && sessionId ? sessionId : 'unknown';
  const draft = drafts.get(key);
  drafts.delete(key);
  if (!draft || draft.notes.length === 0) return [];

  const existing = new Set(listEntries().map((entry) => normalizeForCompare(entry.text)));
  const written = [];
  for (const note of draft.notes) {
    const fingerprint = normalizeForCompare(note.text);
    if (!fingerprint || existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    const entry = appendEntry({
      text: note.text,
      keywords: note.keywords,
      sessionId: key === 'unknown' ? '' : key,
      sessionTitle: draft.sessionTitle,
      source: 'call',
    });
    if (entry) written.push(entry);
  }
  return written;
}

/**
 * 把挂在内存里的草稿按龄清掉：通话没正常收尾（插件换代、宿主被杀）时草稿不会有人来取。
 * 不落盘 —— 半通电话里攒的东西不成条目。
 */
function sweepDrafts(now = Date.now()) {
  let dropped = 0;
  for (const [key, draft] of drafts) {
    if (now - draft.at < DRAFT_TTL_MS) continue;
    drafts.delete(key);
    dropped += 1;
  }
  return dropped;
}

/** 测试用：清空内存里的草稿。 */
function resetDraftsForTest() {
  drafts.clear();
}

/** 测试用：删掉整个库目录，回到「还没有知识」。 */
function resetForTest() {
  drafts.clear();
  try {
    fs.rmSync(rootDir(), { recursive: true, force: true });
  } catch {
    // 本来就没有。
  }
}

module.exports = {
  VERSION,
  ID_RE,
  MAX_TEXT,
  MAX_KEYWORDS,
  DEFAULT_LIMIT,
  MAX_DRAFT,
  DRAFT_TTL_MS,
  rootDir,
  entriesDir,
  indexFile,
  entryFile,
  readEntry,
  listEntries,
  readIndex,
  rebuildIndex,
  appendEntry,
  removeEntry,
  search,
  noteForCall,
  flushCall,
  sweepDrafts,
  resetDraftsForTest,
  resetForTest,
};

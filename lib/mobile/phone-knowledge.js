'use strict';

/**
 * 用法知识库：把 `knowledge/apps/*.md` 与 `knowledge/sites/*.md` 读进来。
 * App 那条按前台包名匹配一段说明，网站那条按当前网页地址（主机名）匹配。
 *
 * 知识只讲事实（这个 App / 网站是什么、界面怎么组织、有哪些功能、有哪些容易混淆的入口），
 * 不写行为规则 —— 该不该做、要不要确认是审批层的事，写进知识里就会和审批层打架。
 *
 * 两条设计取舍：
 * - **按 mtime 缓存**：目录里十几份小文件，每次读屏都重读一遍纯属浪费；mtime 没变就用上一份。
 * - **加载失败安静退化**：知识库目录不存在、某个文件读坏了，都只当这一条没有，绝不抛异常。
 *   知识是锦上添花，不能因为它把整个插件装载掀翻。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 知识库根目录：本文件在 lib/mobile/ 下，往上是插件根。 */
const KNOWLEDGE_ROOT = path.join(__dirname, '..', '..', 'knowledge');

/** 默认 App / 网站知识目录。 */
const DEFAULT_DIR = path.join(KNOWLEDGE_ROOT, 'apps');
const DEFAULT_SITES_DIR = path.join(KNOWLEDGE_ROOT, 'sites');

/** filePath -> { mtimeMs, doc }。文件没改就不重读。 */
const cache = new Map();

/** sessionId -> Set<知识条目名>。同一个对话、同一个 App 只附一次。 */
const noted = new Map();

/**
 * App 知识目录。允许用环境变量覆盖，方便测试「目录不存在时返回空」这条退化路径。
 */
function knowledgeDir() {
  const override = process.env.DSH_PHONE_KNOWLEDGE_DIR;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return DEFAULT_DIR;
}

/**
 * 网站知识目录。优先用 `DSH_PHONE_SITES_DIR` 覆盖；没有时按 App 目录的同级 `sites`
 * 推（App 目录被 `DSH_PHONE_KNOWLEDGE_DIR` 指到别处时，网站跟着它的兄弟目录走），
 * 否则用插件自带的 `knowledge/sites`。
 */
function sitesDir() {
  const explicit = process.env.DSH_PHONE_SITES_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const appsOverride = process.env.DSH_PHONE_KNOWLEDGE_DIR;
  if (typeof appsOverride === 'string' && appsOverride.trim()) {
    return path.join(path.dirname(appsOverride.trim()), 'sites');
  }
  return DEFAULT_SITES_DIR;
}

/** 把一段 `["a","b"]` 或普通标量解析成数组。解析不了就当空数组。 */
function toArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/** 去掉两端成对的引号。 */
function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

/**
 * 解析一份知识文件：frontmatter 进字段，剩下的是正文。
 *
 * 只认简单的一层 `key: value`，够用了；数组用 JSON（`["com.tencent.mm"]`），
 * 与 Mika 的 APP.md 写法一致。解析不出来的键就留默认值，不抛。
 */
function parseDoc(filePath, text) {
  const meta = {};
  let body = typeof text === 'string' ? text : '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body);
  if (match) {
    const raw = match[1];
    body = match[2] || '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf(':');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (value.startsWith('[')) {
        try {
          value = JSON.parse(value);
        } catch {
          value = [];
        }
      } else {
        value = unquote(value);
      }
      if (key) meta[key] = value;
    }
  }
  return {
    name: typeof meta.name === 'string' ? meta.name : '',
    display: typeof meta.display === 'string' ? meta.display : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    packages: toArray(meta.packages),
    sites: toArray(meta.sites),
    aliases: toArray(meta.aliases),
    open: typeof meta.open === 'string' ? meta.open : '',
    pace: typeof meta.pace === 'string' ? meta.pace : '',
    body: body.trim(),
    file: path.basename(filePath),
  };
}

/**
 * 读出某个目录下的全部知识条目（带正文，供匹配和守卫使用）。目录不存在或读不了就返回空数组。
 *
 * `dir` 缺省是 App 目录；网站知识传 `sitesDir()`。缓存按完整文件路径做键，两个目录互不干扰，
 * 清缓存时也只清这个目录下的，不会把另一个目录的缓存顺手删掉。
 */
function loadDocs(dir = knowledgeDir()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 目录不存在：只清这个目录前缀下的缓存，别误删别的目录的。
    for (const key of [...cache.keys()]) if (key.startsWith(dir + path.sep)) cache.delete(key);
    return [];
  }
  const seen = new Set();
  const docs = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    seen.add(filePath);
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs) {
      docs.push(hit.doc);
      continue;
    }
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const doc = parseDoc(filePath, text);
      cache.set(filePath, { mtimeMs: stat.mtimeMs, doc });
      docs.push(doc);
    } catch {
      // 单个文件读坏了只算它没有，其余照常。
    }
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(dir + path.sep) && !seen.has(key)) cache.delete(key);
  }
  docs.sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
  return docs;
}

/** 列出知识库里的所有 App（不带正文）。 */
function listApps() {
  return loadDocs().map((doc) => ({
    name: doc.name,
    display: doc.display,
    packages: doc.packages.slice(),
    aliases: doc.aliases.slice(),
    open: doc.open,
  }));
}

/**
 * 按包名或别名找到一条知识。包名精确匹配优先（忽略大小写），其次才看别名。
 * 找不到返回 null。
 */
function matchApp(packageName) {
  const pkg = typeof packageName === 'string' ? packageName.trim() : '';
  if (!pkg) return null;
  const needle = pkg.toLowerCase();
  const docs = loadDocs();
  const byPackage = docs.find((doc) => doc.packages.some((item) => item.toLowerCase() === needle));
  if (byPackage) return byPackage;
  const byAlias = docs.find((doc) => doc.aliases.some((item) => item.toLowerCase() === needle));
  return byAlias || null;
}

/** 按包名或别名匹配，返回它的正文；匹配不到返回空串。 */
function matchByPackage(packageName) {
  const doc = matchApp(packageName);
  return doc && doc.body ? doc.body : '';
}

/** 列出知识库里的所有网站（不带正文）。 */
function listSites() {
  return loadDocs(sitesDir()).map((doc) => ({
    name: doc.name,
    display: doc.display,
    description: doc.description,
    sites: doc.sites.slice(),
    aliases: doc.aliases.slice(),
  }));
}

/** 从一段地址里抽出主机名（小写）。认不出就退回按 `/`、`:` 切的第一段。 */
function hostOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    return url.hostname.toLowerCase();
  } catch {
    return text.toLowerCase().split('/')[0].split(':')[0];
  }
}

/** 归一化站点条目：去协议、去路径、去开头的 www.。 */
function normalizeSite(site) {
  return String(site || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/**
 * 按当前网页地址找到一条网站知识。主机名匹配：完全相等，或是它的子域（`www.youtube.com`
 * 命中 `youtube.com`）。一条都没有时再退回按别名匹配整段输入。找不到返回 null。
 */
function matchSite(url) {
  const host = hostOf(url);
  if (!host) return null;
  const docs = loadDocs(sitesDir());
  const hit = docs.find((doc) => doc.sites.some((site) => {
    const s = normalizeSite(site);
    if (!s) return false;
    return host === s || host === `www.${s}` || host.endsWith(`.${s}`);
  }));
  if (hit) return hit;
  const needle = typeof url === 'string' ? url.trim().toLowerCase() : '';
  if (!needle) return null;
  return docs.find((doc) => doc.aliases.some((alias) => alias.toLowerCase() === needle)) || null;
}

/** 按网址匹配，返回它的正文；匹配不到返回空串。 */
function matchBySite(url) {
  const doc = matchSite(url);
  return doc && doc.body ? doc.body : '';
}

/**
 * 给某个对话附一次某个 App 的正文。同一个 sessionId + 同一个 App 只返回一次，之后返回空串。
 * sessionId 或包名为空、匹配不到、正文为空，都返回空串。
 */
function noteFor(sessionId, packageName) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) return '';
  const doc = matchApp(packageName);
  if (!doc || !doc.body) return '';
  let set = noted.get(sid);
  if (!set) {
    set = new Set();
    noted.set(sid, set);
  }
  const key = doc.name || doc.file;
  if (set.has(key)) return '';
  set.add(key);
  return doc.body;
}

/** 测试用：清掉「已经附过」的账本。 */
function resetNotes() {
  noted.clear();
}

/** 测试用：丢掉 mtime 缓存，强制下次重读。 */
function resetCache() {
  cache.clear();
}

module.exports = {
  knowledgeDir,
  sitesDir,
  loadDocs,
  listApps,
  listSites,
  matchApp,
  matchByPackage,
  matchSite,
  matchBySite,
  noteFor,
  resetNotes,
  resetCache,
};

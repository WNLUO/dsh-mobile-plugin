'use strict';

/**
 * 公众号文章的库：文章存在电脑上，手机只读。
 *
 * ## 为什么存在宿主这一侧
 *
 * 文章是 AI 在对话里写的，写在跑对话的那台电脑上；手机连着电脑看，不该把正文再抄一份到
 * 手机里。好处是三样：手里这台手机换掉、清缓存都不丢；AI 返工时读的就是本机那一个文件，
 * 不用另开一条「读接口」；以后要发出去，直接拿这份 HTML。
 *
 * ## 目录形状
 *
 * `<DSH_HOME>/storages/mobile-plugin/wechat/<id>/`
 *  · `article.json` —— 档案（标题 / 摘要 / 时间 / 来自哪条对话 / 字数 / 阅读时长）
 *  · `body.html`   —— 正文，成品 HTML 原文，不转码不改写
 *  · `media/`      —— 正文用到的图片，正文里写的是相对地址 `media/xxx.png`
 *
 * 正文里的图片写成相对地址（`media/xxx.png`），**不内联成 base64**：一篇带十几张图的文章
 * 内联进正文，手机每次进页面都要重传好几 MB，而且 AI 也写不了那一大串。手机要画的时候按
 * `handleArticleMedia` 一张一张取，正文本身一个字不改。
 *
 * ## id 是给用户复制的
 *
 * 用户会照着它跟我说话（「这篇 wxa1b2c3d4 改一下」），所以给一串短的、念得出来的字符；
 * 标题会改，不能当标识。id 同时是目录名，所以形状卡得很死，别的形状一律不认 —— 这一条
 * 顺带把路径穿越挡在门外。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { dshHome } = require('../shared/paths.js');

/** 文章 id：`wx` + 8 位小写十六进制。目录名、路径参数、用户嘴里念的都是这一串。 */
const ID_RE = /^wx[0-9a-f]{8}$/;
/** 正文上限：公众号一篇文章几十 KB 就算长文了，两 MB 是「明显不对劲」的那条线。 */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** 摘要长度（字符）：列表一行放不下更多。 */
const EXCERPT_CHARS = 80;
/** 阅读时长按 400 字/分钟估，与业界口径一致。 */
const CHARS_PER_MINUTE = 400;
/** 一张图的上限：与本机图片内联那条口径一致。 */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
/** 媒体文件名：只认这套字符，不接受任何带斜杠的写法。 */
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** 库根。`DSH_MOBILE_WECHAT` 只给测试用。 */
function rootDir() {
  return process.env.DSH_MOBILE_WECHAT || path.join(dshHome(), 'storages', 'mobile-plugin', 'wechat');
}

function articleDir(id) {
  return path.join(rootDir(), id);
}

function articleFile(id) {
  return path.join(articleDir(id), 'article.json');
}

function bodyFile(id) {
  return path.join(articleDir(id), 'body.html');
}

function mediaDir(id) {
  return path.join(articleDir(id), 'media');
}

/** 400 / 404 信封：与其余移动端接口同形。 */
function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 从成品 HTML 里剥出纯文本：先整块去掉 `<style>` / `<script>`（正文带样式块是常事，只剥
 * 标签会把 CSS 当正文，摘要与字数一起失真），再剥标签、还实体、压空白。
 */
function plainTextOf(html) {
  const stripped = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return stripped
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(html, limit = EXCERPT_CHARS) {
  const text = plainTextOf(html);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 阅读时长：按纯文本字数估，空文章也算 1 分钟（写 0 分钟既没意义又像出错）。 */
function readingMinutesOf(html) {
  const chars = plainTextOf(html).replace(/\s/g, '').length;
  return Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE));
}

function charCountOf(html) {
  return plainTextOf(html).replace(/\s/g, '').length;
}

/** 新 id：`wx` + 8 位十六进制。撞了就在调用点重来一次（几千篇才可能撞，不值得写循环外的逻辑）。 */
function newId() {
  return `wx${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 读一篇的档案 + 正文，给出列表与阅读页要的形状。
 *
 * 盘上坏了（JSON 不成形、正文不见了）一律按「这篇不存在」处理，不让一个坏目录把整页打不开。
 */
async function readArticle(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(articleFile(id), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(meta)) return null;
  let html = '';
  try {
    html = await fsp.readFile(bodyFile(id), 'utf8');
  } catch {
    // 只有档案、还没有正文：这是正常的一步（先定标题、再写内容），不是坏数据。
    html = '';
  }
  const updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0;
  return {
    id,
    title: textOf(meta.title, 200) || '未命名',
    excerpt: excerptOf(html),
    updatedAt,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : updatedAt,
    sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
    sessionTitle: typeof meta.sessionTitle === 'string' ? meta.sessionTitle : '',
    chars: charCountOf(html),
    minutes: readingMinutesOf(html),
    hasBody: html.length > 0,
    html,
  };
}

/** 列表：只读 `article.json`（不读正文）—— 一篇几 MB 的正文，列一百篇就是几百 MB 的读。 */
async function listArticles() {
  let entries;
  try {
    entries = await fsp.readdir(rootDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const article = await readArticleMetaOnly(entry.name);
    if (article) rows.push(article);
  }
  // 新写的排前面：用户刚跟 AI 聊完就进来看这一篇，它必须一眼在顶上。
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

/**
 * 列表项：档案 + 摘要 + 字数。
 *
 * 摘要与字数离不开正文，但**只读一遍正文、读完就丢**：列表要的几格（摘要 / 字数 / 时长）
 * 都靠它算出来，逐篇缓存又会在 AI 改一次之后全部过期。
 */
async function readArticleMetaOnly(id) {
  const article = await readArticle(id);
  if (!article) return null;
  const { html, ...rest } = article;
  return rest;
}

/**
 * 一项图片的字节：优先从电脑上的文件读，其次才认递上来的 base64。
 *
 * 路径来源只有一个 —— 调用方（模型）自己给的。所以这里不放宽成「任意文件」：只认图片
 * 魔术字节，非图片的、读不到的一律当没给，别让一次写文章顺手把别的东西抄进 media 里。
 */
async function mediaBytesOf(item) {
  const fromPath = textOf(item.path, 1024);
  if (fromPath) {
    const filePath = resolveLocalPath(fromPath);
    if (!filePath) return null;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) return null;
      const bytes = await fsp.readFile(filePath);
      if (!looksLikeImage(bytes)) return null;
      return bytes;
    } catch {
      return null;
    }
  }
  const data = typeof item.base64 === 'string' ? item.base64.trim() : '';
  if (!data) return null;
  let bytes;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) return null;
  if (!looksLikeImage(bytes)) return null;
  return bytes;
}

/** 路径统一走与正文图片同一条口径：绝对路径、`~/`、`file://`，相对地址按当前目录解析。 */
function resolveLocalPath(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim();
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.slice(7));
    } catch {
      return null;
    }
  } else if (text === '~' || text.startsWith('~/')) {
    text = path.join(require('node:os').homedir(), text.slice(1));
  }
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(process.cwd(), text);
}

/** 魔术字节：只认手机上画得出来的四种位图，不信扩展名。 */
function looksLikeImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 6).startsWith('GIF8')) return true;
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return true;
  return false;
}

/**
 * 写入一篇。新建与更新走同一条路：
 *  · 没给 id → 新建一篇全新的（只有标题也行，正文可以之后再补）；
 *  · 给了 id → 更新那篇（标题 / 正文 / 图片，给什么改什么）。
 *
 * `images` 每项是两种形状之一：
 *  · `{name, path}` —— **优先**：电脑上一个图片文件的位置，宿主自己读过来复制进 media。
 *    模型生成完一张图，手里只有那条路径（它自己用工具产出的图就落在那台机器上），
 *    这才是它真能给的东西；
 *  · `{name, base64}` —— 兜底：字节由调用方直接递上来（App 那边、或者模型手上真有字节时）。
 *
 * 为什么以 `path` 为主：让模型把整张图的 base64 写进工具参数，等于让它把几兆字节抄一遍 ——
 * 抄不动、也抄不对。给路径让它自己读，是它真做得到的那件事。
 */
async function writeArticle(input) {
  const title = textOf(input.title, 200);
  const htmlInput = typeof input.html === 'string' ? input.html : '';
  if (Buffer.byteLength(htmlInput, 'utf8') > MAX_HTML_BYTES) {
    const error = new Error('正文太大了（上限 2MB），图片请放到 media 里、正文只写图片地址。');
    error.code = 'too-large';
    throw error;
  }

  let id = typeof input.id === 'string' ? input.id.trim() : '';
  let existing = null;
  if (id) {
    existing = await readArticle(id);
    if (!existing) {
      const error = new Error(`没有找到编号为 ${id} 的文章。不传 id 会新建一篇。`);
      error.code = 'not-found';
      throw error;
    }
  } else {
    id = newId();
    while (await readArticle(id)) id = newId();
  }

  const now = Date.now();
  const createdAt = existing ? existing.createdAt : now;
  const nextTitle = title || (existing ? existing.title : '未命名');

  await fsp.mkdir(articleDir(id), { recursive: true });

  // 图片先落地：档案里的「这篇有图」必须在正文写完之后仍然成立，反过来的顺序会让一次
  // 中途失败的写入留下一篇指向空目录的正文。
  const media = Array.isArray(input.images) ? input.images : [];
  const written = [];
  const rejected = [];
  if (media.length > 0) {
    await fsp.mkdir(mediaDir(id), { recursive: true });
    for (const item of media) {
      if (!isRecord(item)) continue;
      const name = textOf(item.name, 90);
      if (!MEDIA_NAME_RE.test(name)) {
        rejected.push(textOf(item.path, 120) || name || '(没有名字)');
        continue;
      }
      const bytes = await mediaBytesOf(item);
      if (!bytes) {
        rejected.push(textOf(item.path, 120) || name);
        continue;
      }
      await fsp.writeFile(path.join(mediaDir(id), name), bytes);
      written.push(name);
    }
  }

  if (typeof input.html === 'string') {
    await fsp.writeFile(bodyFile(id), htmlInput, 'utf8');
  }

  const meta = {
    id,
    title: nextTitle,
    createdAt,
    updatedAt: now,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : (existing ? existing.sessionId : ''),
    sessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : (existing ? existing.sessionTitle : ''),
  };
  // 先写临时文件再改名：宿主随时可能被杀，半个 JSON 会让这篇从此打不开。
  const tmp = `${articleFile(id)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(tmp, articleFile(id));

  const article = await readArticle(id);
  return { article, images: written, rejected };
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

/**
 * `GET /wechat/articles` —— 列表 + 首页那几格总数。
 *
 * 总数与列表同源：不另存一份计数（存了就会跟列表对不上），七十篇以内扫一遍目录也就几毫秒。
 */
async function handleArticleList(_ctx, req, res) {
  const rows = await listArticles();
  const totals = rows.reduce(
    (acc, row) => {
      acc.count += 1;
      acc.chars += row.chars;
      if (row.hasBody) acc.withBody += 1;
      if (row.updatedAt > acc.updatedAt) acc.updatedAt = row.updatedAt;
      return acc;
    },
    { count: 0, chars: 0, withBody: 0, updatedAt: 0 },
  );
  sendJson(res, 200, { ok: true, items: rows, totals });
}

/** `GET /wechat/article?id=` —— 一篇的正文（阅读页用）。 */
async function handleArticleRead(_ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id') || '';
  const article = await readArticle(id);
  if (!article) return fail(res, 404, 'article-not-found', '这篇不在了：可能删掉了，或者编号不对。');
  sendJson(res, 200, {
    ok: true,
    article: {
      id: article.id,
      title: article.title,
      excerpt: article.excerpt,
      updatedAt: article.updatedAt,
      createdAt: article.createdAt,
      sessionId: article.sessionId,
      sessionTitle: article.sessionTitle,
      chars: article.chars,
      minutes: article.minutes,
      hasBody: article.hasBody,
      html: article.html,
    },
  });
}

/**
 * `GET /wechat/media?id=&name=` —— 正文里的图片（base64 JSON，与 `session/attachment` 同形）。
 *
 * 为什么走 JSON 而不是直接回字节：手机上取这张图要用 App 那份鉴权头，而图片最终是塞进
 * 阅读页的 WebView 里渲染的，网页自己发出去的请求带不了鉴权头。所以由 App 取回字节、转成
 * data URI 再交给网页 —— 形状与附件那条一致，也能直接复用同一套解包。
 *
 * 只认「这篇的 media 目录里、名字合规矩」的那一张：路径全由宿主拼，客户端给不了路径。
 */
async function handleArticleMedia(_ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id') || '';
  const name = url.searchParams.get('name') || '';
  if (!ID_RE.test(id) || !MEDIA_NAME_RE.test(name)) return fail(res, 400, 'bad-request', '参数不对。');
  const filePath = path.join(mediaDir(id), name);
  // 上一步已经把两个参数都收窄成不含斜杠的形状了；这里再判一次前缀，是让「拼错的路径」
  // 在任何一处改动之后都落在这里而不是读到别处去。
  if (!filePath.startsWith(mediaDir(id) + path.sep)) return fail(res, 400, 'bad-request', '参数不对。');
  let bytes;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) throw new Error('bad');
    bytes = await fsp.readFile(filePath);
  } catch {
    return fail(res, 404, 'media-not-found', '这张图不在了。');
  }
  sendJson(res, 200, { ok: true, mediaType: mediaTypeOf(name, bytes), data: bytes.toString('base64') });
}

/** 按魔术字节认类型（不信扩展名），认不出按 png 给 —— 微信里绝大多数是 png / jpeg。 */
function mediaTypeOf(name, bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  return 'image/png';
}

/**
 * `POST /wechat/article` —— 写一篇（App 侧目前不用，留给「在手机上删 / 改名」这类动作；
 * AI 那条路走的是工具，见 `tools.js`）。
 */
async function handleArticleWrite(_ctx, req, res) {
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  if (!isRecord(body)) return fail(res, 400, 'bad-request', '请求体不是对象。');
  try {
    const { article } = await writeArticle(body);
    sendJson(res, 200, {
      ok: true,
      id: article.id,
      title: article.title,
      hasBody: article.hasBody,
      chars: article.chars,
    });
  } catch (error) {
    if (error && error.code === 'not-found') return fail(res, 404, 'article-not-found', error.message);
    if (error && error.code === 'too-large') return fail(res, 413, 'too-large', error.message);
    return fail(res, 500, 'write-failed', '没能写进去，稍后重试。');
  }
}

/**
 * `DELETE /wechat/article?id=` —— 删掉一篇（连正文带图片）。
 *
 * App 那边还没有入口，先留着：删一篇是「管理」里最该有的一件，接到界面上是一行按钮的事。
 */
async function handleArticleDelete(_ctx, req, res) {
  // 删除用 GET 那条路径的形状（`?id=`），但只认 DELETE：一条 GET 不该能把文章删掉
  // （浏览器预取、链接预览都会发 GET，那是最容易误删的一条路）。
  if (String(req.method || 'GET').toUpperCase() !== 'DELETE') {
    return fail(res, 405, 'method-not-allowed', '删除只接受 DELETE。');
  }
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id') || '';
  if (!ID_RE.test(id)) return fail(res, 400, 'bad-request', '参数不对。');
  try {
    await fsp.rm(articleDir(id), { recursive: true, force: true });
  } catch {
    return fail(res, 500, 'delete-failed', '没能删掉，稍后重试。');
  }
  sendJson(res, 200, { ok: true });
}

module.exports = {
  handleArticleList,
  handleArticleRead,
  handleArticleMedia,
  handleArticleWrite,
  handleArticleDelete,
  // 工具那一侧直接用这几个（不经过 HTTP）
  writeArticle,
  readArticle,
  listArticles,
  plainTextOf,
  excerptOf,
  readingMinutesOf,
  rootDir,
  ID_RE,
};

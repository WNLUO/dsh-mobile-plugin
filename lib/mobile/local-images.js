'use strict';

/**
 * 正文图片内联：把消息文本里指向本机文件的图片语法（`![](/abs/path.png)`）换成 data URI，
 * 让手机端能直接画出来。
 *
 * 手机拿到的只是文本，`/Users/…/a.png` 既不是手机上的文件，移动 API 也没有「按路径读文件」
 * 的能力面，原样过去只会显示成一串字面 markdown。这里把「正文里写的本机图片」拉齐到附件那种
 * 内联形状，App 不需要新增通道。
 *
 * 保守取舍——宁可保留字面 markdown，也不给半截东西：
 * - 本机路径认三种：绝对（`/x/y.png`、`file:///x/y.png`）、`~/y.png`、相对（`deliverables/a.png`，
 *   按调用方给的工作区目录解析，与桌面端同口径；没给目录就当成不是本机图）；http(s)、`data:` 不碰；
 * - 只认 png/jpg/jpeg/webp/gif，并核对魔术字节，不按扩展名撒谎；
 * - 三级体积预算（单图 / 单段 / 单次响应），超预算就保持字面；
 * - 读不到、不是普通文件、读取失败一律原样保留；
 * - 围栏代码块与行内代码里的图片语法不碰，那是写法示例。
 */

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * `![alt](dest)`。dest 两种写法都认：裸路径（不含空白与右括号）与 `<>` 包裹（里面可以有空格，
 * 因为 `![](</a b/图 1.png>)` 是 CommonMark 唯一能给带空格路径的合法写法，而 App 侧解析器认它
 * ——两边必须一致，否则「App 解析得出地址、插件却没内联」会变成一串死链接）。
 * 括号内的首尾空白照 mdast 的做法忽略。
 */
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\s]+)\s*\)/g;

/** 图片类型白名单：扩展名 → mediaType。 */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 单张原图上限（base64 后约 1.33 倍，见下面的字符预算）。 */
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
/** 一段文本里内联进去的 data URI 总字符上限。 */
const MAX_TEXT_CHARS = 3 * 1024 * 1024;
/** 一次响应（一页历史 / 一帧 SSE / 一次镜像快照）共用的字符上限。 */
const MAX_RESPONSE_CHARS = 5 * 1024 * 1024;
/** data URI 复用条数：同一张图常在同一轮里出现多次（历史 + 流式 + 镜像）。 */
const MAX_CACHE_ENTRIES = 8;

/** path+mtime+size → data URI。会话里同一张图会被反复解析，但文件内容只读一次。 */
const cache = new Map();

function mediaTypeFor(filePath) {
  return MEDIA_TYPES[path.extname(filePath).toLowerCase()] || null;
}

/** 魔术字节判定：只认我们真的能画的那四种位图，不信扩展名。 */
function sniffMediaType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 6).startsWith('GIF8')) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * `![](…)` 里的地址 → 本机路径；不是本机图片（远程、data、非图片后缀）返回 null。
 * 尖括号包裹的目的地（CommonMark 允许 `![](</abs/a.png>)`）在这里一并剥掉。
 *
 * 相对地址（`deliverables/a.png`、`./a.png`）按 `cwd` 解析——那是会话的工作区目录，也是
 * 桌面端画正文图的基准；没给 `cwd` 时相对地址照样返回 null（老口径：保持字面 markdown）。
 */
function localImagePathOf(url, cwd) {
  if (typeof url !== 'string') return null;
  let value = url.trim();
  if (!value) return null;
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (value.slice(0, 7).toLowerCase() !== 'file://') return null;
    try {
      value = decodeURIComponent(value.slice(7));
    } catch {
      return null;
    }
    if (value.startsWith('localhost/')) value = value.slice('localhost'.length);
  } else if (value === '~' || value.startsWith('~/')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  if (!path.isAbsolute(value)) {
    if (!cwd) return null;
    value = path.resolve(cwd, value);
  }
  if (!mediaTypeFor(value)) return null;
  return path.normalize(value);
}

/**
 * 正文里有没有「相对地址」的本机图片语法。
 *
 * 只有这种文本才值得去取会话的工作区目录（`sessions.list` 要扫一遍全部会话），
 * 其余情况一条会话列表都不查：绝对路径照常内联，相对地址原样留着。
 */
function hasRelativeImage(text) {
  if (typeof text !== 'string' || text.indexOf('![') < 0) return false;
  for (const m of text.matchAll(IMAGE_RE)) {
    let dest = m[2].trim();
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1).trim();
    if (!dest || path.isAbsolute(dest)) continue;
    if (dest === '~' || dest.startsWith('~/')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
    if (mediaTypeFor(dest)) return true;
  }
  return false;
}

/**
 * 一次响应共用的内联预算；不给就按单次调用算一份。
 *
 * `cwd` 由调用方按需补上（相对地址的解析基准，见 localImagePathOf）：`undefined` 表示
 * 「还没查过工作区目录」，空串表示「查过了，这条会话没有」。
 */
function createTextImageBudget(limit = MAX_RESPONSE_CHARS) {
  return { remaining: limit };
}

/** 读文件 → data URI（带缓存）；不满足条件一律 null。 */
async function dataUriFor(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return null;
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let buf;
  try {
    buf = await fs.readFile(filePath);
  } catch {
    return null;
  }
  const mediaType = sniffMediaType(buf);
  if (!mediaType) return null;
  const uri = `data:${mediaType};base64,${buf.toString('base64')}`;
  cache.set(key, uri);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return uri;
}

/**
 * Markdown 里「必须保持字面」的区间：围栏代码块与行内代码。
 *
 * 代码块里的 `![](/tmp/a.png)` 是**写法示例**而不是要画的图。旧实现整段正则替换，
 * 会把三行代码换成几十万字符的 base64——App 把这段按代码文本铺开，就成了很长很长
 * 的一块（真机现象：图片语法那块刷出几十屏，要划很久）。围栏判定与 App 的
 * `utils/markdown/parser.ts` 同口径（两边都 trim 后看 3 个以上 ` / ~）。
 */
function literalRanges(text) {
  const ranges = [];
  const lines = text.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  let fence = null;
  let fenceStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(line.trim());
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        ranges.push([fenceStart, lineStarts[index] + line.length]);
        fence = null;
      }
      continue;
    }
    const open = /^(`{3,}|~{3,})/.exec(line.trim());
    if (!open) continue;
    fence = { char: open[1][0], length: open[1].length };
    fenceStart = lineStarts[index];
  }
  // 没闭合的围栏按 App 的解析口径一直吃到文末。
  if (fence) ranges.push([fenceStart, text.length]);

  // 行内代码：同长度的反引号成对（`code`）。围栏内部的反引号已在上面标过。
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '`' || inRanges(cursor, ranges)) {
      cursor += 1;
      continue;
    }
    let ticks = 1;
    while (text[cursor + ticks] === '`') ticks += 1;
    let scan = cursor + ticks;
    let closed = -1;
    while (scan < text.length) {
      if (text[scan] !== '`' || inRanges(scan, ranges)) {
        scan += 1;
        continue;
      }
      let run = 1;
      while (text[scan + run] === '`') run += 1;
      if (run === ticks) {
        closed = scan + run;
        break;
      }
      scan += run;
    }
    if (closed < 0) {
      cursor += ticks;
      continue;
    }
    ranges.push([cursor, closed]);
    cursor = closed;
  }
  return ranges;
}

function inRanges(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * 把一段文本里的本机图片语法换成 data URI。返回原字符串本身（`===`）表示一个字没动，
 * 调用方据此免掉不必要的对象拷贝。
 */
async function inlineTextImages(text, budget) {
  if (typeof text !== 'string' || text.indexOf('![') < 0) return text;
  const ranges = literalRanges(text);
  const matches = [...text.matchAll(IMAGE_RE)].filter((m) => !inRanges(m.index, ranges));
  if (!matches.length) return text;
  const pool = budget || createTextImageBudget();
  let textBudget = MAX_TEXT_CHARS;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (textBudget <= 0 || pool.remaining <= 0) break;
    const filePath = localImagePathOf(m[2], pool.cwd);
    if (!filePath) continue;
    const uri = await dataUriFor(filePath);
    if (!uri || uri.length > textBudget || uri.length > pool.remaining) continue;
    textBudget -= uri.length;
    pool.remaining -= uri.length;
    out += text.slice(cursor, m.index) + `![${m[1]}](${uri})`;
    cursor = m.index + m[0].length;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

module.exports = { inlineTextImages, createTextImageBudget, localImagePathOf, hasRelativeImage };
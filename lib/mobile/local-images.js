'use strict';

/**
 * 正文图片内联：把消息文本里指向**本机文件**的图片语法（`![](/abs/path.png)`）换成 data URI，
 * 让手机端能直接把它画出来。
 *
 * 为什么只能在这里换：手机拿到的只是文本，`/Users/…/a.png` 既不是手机上的文件，移动 API 也
 * 没有「按路径读文件」的能力面（见 host-bridge-endpoints 守卫的 forbidden 表），所以地址原样
 * 过去只会显示成一串字面 markdown。会话里用户自己发的图片本来就是内联形状（宿主把附件解成
 * base64，见 attachments.js 与 App 侧 chat.ts 的 images[]），这里只是把「正文里写的本机图片」
 * 拉齐到同一种形状，App 侧因此不需要新增任何通道或依赖。
 *
 * 保守取舍（宁可保留原样的字面 markdown，也不给个半截东西）：
 * - 只认能解析成**绝对路径**的地址：`/x/y.png`、`file:///x/y.png`、`~/y.png`；
 *   http(s)、`data:`、`www.`、相对路径一律不碰。
 * - 只认 png/jpg/jpeg/webp/gif（与 app/src/services/viewmodels/image-limits.ts 的 mediaTypes
 *   同白名单），并且**核对魔术字节**：字节不是图片就放弃，绝不按扩展名撒谎。
 * - 三级体积预算（单图 / 单段文本 / 单次响应，见下方常量）：超预算的图保持字面 markdown，
 *   不截断、不缩水成半张图。
 * - 读不到、不是普通文件、读取失败：原样保留 —— 一条图片取不到不能让整段历史或整帧 SSE 挂掉。
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
 * `![](…)` 里的地址 → 本机绝对路径；不是本机图片（远程、data、相对路径、非图片后缀）返回 null。
 * 尖括号包裹的目的地（CommonMark 允许 `![](</abs/a.png>)`）在这里一并剥掉。
 */
function localImagePathOf(url) {
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
  if (!path.isAbsolute(value)) return null;
  if (!mediaTypeFor(value)) return null;
  return path.normalize(value);
}

/** 一次响应共用的内联预算；不给就按单次调用算一份。 */
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
 * 把一段文本里的本机图片语法换成 data URI。返回原字符串本身（`===`）表示一个字没动，
 * 调用方据此免掉不必要的对象拷贝。
 */
async function inlineTextImages(text, budget) {
  if (typeof text !== 'string' || text.indexOf('![') < 0) return text;
  const matches = [...text.matchAll(IMAGE_RE)];
  if (!matches.length) return text;
  const pool = budget || createTextImageBudget();
  let textBudget = MAX_TEXT_CHARS;
  let out = text;
  for (const m of matches) {
    if (textBudget <= 0 || pool.remaining <= 0) break;
    const filePath = localImagePathOf(m[2]);
    if (!filePath) continue;
    const uri = await dataUriFor(filePath);
    if (!uri || uri.length > textBudget || uri.length > pool.remaining) continue;
    textBudget -= uri.length;
    pool.remaining -= uri.length;
    out = out.replace(m[0], `![${m[1]}](${uri})`);
  }
  return out === text ? text : out;
}

module.exports = { inlineTextImages, createTextImageBudget, localImagePathOf };
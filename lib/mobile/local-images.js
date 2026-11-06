'use strict';

/**
 * 正文里本机图片 → 一个短编号（`![alt](dsh-local-image:<id>?w=..&h=..)`）。
 *
 * 为什么不内联 base64（2026-10-29 改）：整张图的字节塞进消息正文有三个代价，全落在用户身上 ——
 *  ① 正文里没有宽高，手机只能先按固定尺寸占位、等解码完再改；翻页时那一行高度晚到，内容被顶；
 *  ② 体积：一张 135KB 的图进正文就是 180KB 字符，而正文整段会进本地缓存（1MiB 预算），
 *     六七张图就把缓存吃穿 —— 于是「打开过很多次还是要重新加载」；
 *  ③ 每次重拉历史都要重传一遍。
 * 业界（WhatsApp / Telegram / Slack / 各家大模型客户端）都是「消息里只放引用 + 宽高」，
 * 这里对齐同一条口径：正文只留编号，字节按编号单张取（`/session/local-image`）。
 *
 * 安全边界不变：**不是「按路径读文件」**。编号只由本模块在投影历史时登记，取图口只认
 * 登记表里的编号 —— 构造一个编号读不到任何别的文件。登记表活在进程内；插件重启后老编号
 * 取不到就如实 404，App 走「失败 + 重试」那条现成的路。
 *
 * 保守取舍——宁可保留字面 markdown，也不给半截东西：
 * - 本机路径认三种：绝对（`/x/y.png`、`file:///x/y.png`）、`~/y.png`、相对（`deliverables/a.png`，
 *   按调用方给的工作区目录解析，与桌面端同口径；没给目录就当成不是本机图）；http(s)、`data:` 不碰；
 * - 双分隔符打头的网页地址（协议相对 `//host/…`）与 Windows 网络 / 扩展路径（`\\host\…`、`\\?\…`）
 *   不碰：它们不是本机文件，在 Windows 上会被当成 UNC 去 stat、一读就卡几十秒；
 * - 只认 png/jpg/jpeg/webp/gif，并核对魔术字节，不按扩展名撒谎；
 * - 宽高只读文件头（最多 64KB）；读不出来就不带宽高，App 那边照旧现量；
 * - 围栏代码块与行内代码里的图片语法不碰，那是写法示例。
 */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

/** 单张图上限：再大的东西不该整包回给手机。 */
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
/** 读宽高只需要文件头：JPEG 的 SOF 段可能在几百字节之后，64KB 足够覆盖绝大多实拍图。 */
const HEAD_BYTES = 64 * 1024;
/** 登记表上限：翻历史时同一张图反复出现也只登记一次，512 条够一两百个会话轮着用。 */
const MAX_REGISTRY_ENTRIES = 512;
/** 一张响应（一页历史 / 一帧 SSE / 一次镜像快照）里最多换几张：防一段文字里几十上百个图片语法。 */
const MAX_TEXT_IMAGES = 64;

/**
 * 编号 → { filePath, mediaType, width?, height? }。
 *
 * 只由本模块登记，取图口只认这里面的编号 —— 这是「不扩能力面」的全部依据（见文件头）。
 */
const registry = new Map();

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
  // 盘符路径（`C:\…`、`C:/…`）不是 URL 协议：单字母后跟分隔符的别当成 scheme 拦掉。
  const hasUrlScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
  if (hasUrlScheme) {
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
  // 双分隔符打头的是网页地址（协议相对 `//host/…`）或 Windows 网络 / 扩展路径（`\\host\…`、
  // `\\?\…`）。它们不是本机文件，在 Windows 上会被当成 UNC 去 stat、一读就卡几十秒；
  // `file://` 的远程主机经上面剥完也可能落到这里，同样不认。
  if (/^[\\/]{2}/.test(value)) return null;
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
function createTextImageBudget(limit = MAX_TEXT_IMAGES) {
  return { remaining: limit };
}

/**
 * JPEG 的 EXIF 朝向（0x0112），没有就返回 0。
 *
 * 手机相机竖着拍出来的照片，像素本身是横的，靠 EXIF 里的朝向告诉播放器「先转 90°」。
 * 宽高只按像素读的话，正文里就会出现「横盒子装竖图」：App 按 `resizeMode="contain"` 画，
 * 图缩成中间一条、两侧一大片空白（2026-10-31 平板实测）。所以 5–8 这四档要对调宽高。
 *
 * 只认 JPEG：PNG / WebP 里带 eXIf 的极少，不值得为它多扫一遍。
 */
function jpegOrientation(buf) {
  let at = 2;
  while (at + 4 < buf.length) {
    if (buf[at] !== 0xff) { at += 1; continue; }
    const marker = buf[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    // 到扫描数据了，后面不会再有 APP 段。
    if (marker === 0xda) return 0;
    const length = buf.readUInt16BE(at + 2);
    if (length < 2) return 0;
    if (marker === 0xe1 && at + 10 <= buf.length && buf.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
      return tiffOrientation(buf, at + 10);
    }
    at += 2 + length;
  }
  return 0;
}

/** EXIF 里的 TIFF 头 → 朝向值；字节序按 `II` / `MM` 判，读不到返回 0。 */
function tiffOrientation(buf, base) {
  if (base + 8 > buf.length) return 0;
  const order = buf.toString('latin1', base, base + 2);
  if (order !== 'II' && order !== 'MM') return 0;
  const little = order === 'II';
  const u16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  if (u16(base + 2) !== 42) return 0;
  const ifd = base + u32(base + 4);
  if (ifd + 2 > buf.length) return 0;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buf.length) return 0;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/** 从文件头解析宽高；认不出来返回 null（不是错误：App 那边照旧现量）。 */
function imageSizeOf(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // 竖拍照片的像素本身是横的，朝向 5–8 时播放器会转 90° 再画 —— 宽高必须跟着对调，
    // 否则正文那个盒子是横的、图是竖的（见 jpegOrientation）。
    const orientation = jpegOrientation(buf);
    const swap = orientation >= 5 && orientation <= 8;
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) { at += 1; continue; }
      const marker = buf[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = buf.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const width = buf.readUInt16BE(at + 7);
        const height = buf.readUInt16BE(at + 5);
        return swap ? { width: height, height: width } : { width, height };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  return null;
}

/** 读文件头（最多 HEAD_BYTES）；打不开就 null。 */
async function readHead(filePath, size) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const length = Math.min(size, HEAD_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * 登记一张本机图片，返回它的编号与宽高。
 *
 * 编号取「路径 + 大小 + 修改时间」的短哈希：同一张图在同一轮历史里会被反复解析，
 * 这个组合稳定，且改过之后自然换号（图片内容变了本来就该换）。
 *
 * **超过单张上限的图也登记，只是标一句 `tooLarge`**：不登记的话正文里那一段就退回字面
 * markdown，用户在手机上看到的是一串 `![](路径)` 源码 —— 既不知道发生过什么，也没有任何
 * 入口。标了之后取图口如实回 413，App 画成「图片太大」的占位块，这才是用户能读懂的一句话。
 */
async function registerLocalImage(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  const id = crypto.createHash('sha1').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
  const known = registry.get(id);
  if (known) return { id, ...known };
  const head = await readHead(filePath, stat.size);
  if (!head) return null;
  const mediaType = sniffMediaType(head);
  if (!mediaType) return null;
  const over = stat.size > MAX_IMAGE_BYTES;
  const parsed = over ? null : imageSizeOf(head);
  const sane = parsed && parsed.width > 0 && parsed.height > 0
    && parsed.width <= 30000 && parsed.height <= 30000;
  const size = sane ? parsed : {};
  const entry = { filePath, mediaType, ...size, ...(over ? { tooLarge: true } : {}) };
  registry.set(id, entry);
  trimRegistry();
  return { id, ...entry };
}

/** 登记表满了就淘汰最老的一条；取回来的临时文件一并删掉，别在地上留垃圾。 */
function trimRegistry() {
  while (registry.size > MAX_REGISTRY_ENTRIES) {
    const oldestId = registry.keys().next().value;
    const entry = registry.get(oldestId);
    registry.delete(oldestId);
    if (entry && entry.fetched && entry.filePath) fs.unlink(entry.filePath).catch(() => {});
  }
}

/** 取图口用：只认登记表里的编号（构造不出来的编号一律 null → 404）。 */
function localImageOf(id) {
  if (typeof id !== 'string' || !id) return null;
  return registry.get(id) || null;
}

/** 清空登记表（测试用）。取回来的临时文件一并删掉。 */
function clearLocalImages() {
  for (const entry of registry.values()) {
    if (entry && entry.fetched && entry.filePath) fs.unlink(entry.filePath).catch(() => {});
  }
  registry.clear();
  loopbackUrlCache.clear();
}

/**
 * 回环地址的主机名：出现在正文里时指的是「跑插件这台电脑自己」，手机拿着同一个地址
 * 只会指回手机自己。生图插件常把成品图挂在自己电脑上的一个小服务上，回的就是这种地址。
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::']);

/** 取回回环图片的超时：只在投影一条消息时占这一小会儿，取不到就保持字面 markdown。 */
const LOOPBACK_FETCH_TIMEOUT_MS = 4000;
/** 失败后多久内不再重试同一地址：翻历史碰上已经关掉的服务，不该每次都干等一次超时。 */
const LOOPBACK_FAIL_TTL_MS = 30 * 1000;
/** 同一地址取到过的图片编号；翻历史时直接复用，不必重复取。 */
const loopbackUrlCache = new Map();

/**
 * `![](…)` 里的地址若是**回环地址的 http(s) 图片**，回那条地址；否则 null。
 *
 * 只认回环：别的远程地址一律不碰 —— 那会把「本机图片」变成「替手机随便抓任意网址」，
 * 能力面就从「读这台电脑上的文件」扩成了代理一切出站请求。回环地址连不到外网，
 * 只是这台电脑自己起的服务，与「读本机文件」同一类。
 */
function loopbackImageUrlOf(url) {
  if (typeof url !== 'string') return null;
  let value = url.trim();
  if (!value) return null;
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTNAMES.has(hostname) ? value : null;
}

/**
 * 取回的图片字节落成临时文件再登记：取图口按编号读 `filePath`，与磁盘上的图同一条路。
 *
 * 编号取内容哈希：同一张图反复出现只落一份。超过单张上限的照样登记、但标 `tooLarge`
 * （取图口回 413，App 画「图片太大」占位），与磁盘图片那条口径一致。
 */
async function registerLocalImageBytes(buffer, mediaType) {
  if (!buffer || buffer.length === 0) return null;
  const id = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const known = registry.get(id);
  if (known) return { id, ...known };
  const over = buffer.length > MAX_IMAGE_BYTES;
  const parsed = over ? null : imageSizeOf(buffer);
  const sane = parsed && parsed.width > 0 && parsed.height > 0
    && parsed.width <= 30000 && parsed.height <= 30000;
  const size = sane ? parsed : {};
  if (over) {
    const entry = { filePath: '', mediaType, ...size, tooLarge: true, fetched: true };
    registry.set(id, entry);
    trimRegistry();
    return { id, ...entry };
  }
  const ext = mediaType === 'image/jpeg' ? '.jpg'
    : mediaType === 'image/gif' ? '.gif'
      : mediaType === 'image/webp' ? '.webp' : '.png';
  let filePath;
  try {
    const dir = path.join(os.tmpdir(), 'dsh-local-images');
    await fs.mkdir(dir, { recursive: true });
    filePath = path.join(dir, `${id}${ext}`);
    await fs.writeFile(filePath, buffer);
  } catch {
    return null;
  }
  const entry = { filePath, mediaType, ...size, fetched: true };
  registry.set(id, entry);
  trimRegistry();
  return { id, ...entry };
}

/**
 * 从回环地址取回一张图片：有超时、有大小上限、必须过魔术字节。
 *
 * 取不到 / 不是图 / 太大 / 重定向去别处，一律返回 null，调用方保持字面 markdown ——
 * 宁可显示成字面文本，也不能让一段历史或一帧 SSE 因为一张图取不到而挂掉（与现有口径一致）。
 * 只走一次 GET、不跟随重定向：跟去别处就不再是「回环图片」了。
 */
async function fetchLoopbackImage(url) {
  if (typeof fetch !== 'function') return null;
  const hit = loopbackUrlCache.get(url);
  if (hit) {
    if (hit.id && registry.has(hit.id)) return { id: hit.id, ...registry.get(hit.id) };
    if (!hit.id && hit.failedAt && Date.now() - hit.failedAt < LOOPBACK_FAIL_TTL_MS) return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOPBACK_FETCH_TIMEOUT_MS);
  let buffer;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error('too large');
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    loopbackUrlCache.set(url, { failedAt: Date.now() });
    return null;
  } finally {
    clearTimeout(timer);
  }
  const mediaType = buffer && buffer.length > 0 && buffer.length <= MAX_IMAGE_BYTES
    ? sniffMediaType(buffer)
    : null;
  if (!mediaType) {
    loopbackUrlCache.set(url, { failedAt: Date.now() });
    return null;
  }
  const entry = await registerLocalImageBytes(buffer, mediaType);
  if (!entry) {
    loopbackUrlCache.set(url, { failedAt: Date.now() });
    return null;
  }
  loopbackUrlCache.set(url, { id: entry.id });
  return entry;
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
 * 把一段文本里的本机图片语法换成**短编号**（带宽高）：`![alt](dsh-local-image:<id>?w=..&h=..)`。
 *
 * 返回原字符串本身（`===`）表示一个字没动，调用方据此免掉不必要的对象拷贝。
 * `budget` 只为兼容调用点保留：标识只有几十字节，不再有字符预算这回事。
 */
async function inlineTextImages(text, budget) {
  if (typeof text !== 'string' || text.indexOf('![') < 0) return text;
  const ranges = literalRanges(text);
  const matches = [...text.matchAll(IMAGE_RE)].filter((m) => !inRanges(m.index, ranges));
  if (!matches.length) return text;
  const pool = budget || createTextImageBudget();
  let count = pool.remaining;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (count <= 0) break;
    let entry = null;
    const filePath = localImagePathOf(m[2], pool.cwd);
    if (filePath) {
      entry = await registerLocalImage(filePath);
    } else {
      // 第二种「本机图片」：生图插件把成品图挂在自己电脑的一个回环小服务上，回的是
      // `http://127.0.0.1:<端口>/…`。手机拿着它只会指回手机自己，所以由电脑去取回来、
      // 按编号给手机（与磁盘图片同一条路，宽高/缓存/重试全现成）。
      const loopbackUrl = loopbackImageUrlOf(m[2]);
      if (loopbackUrl) entry = await fetchLoopbackImage(loopbackUrl);
    }
    if (!entry) continue;
    count -= 1;
    pool.remaining = count;
    const query = entry.width && entry.height ? `?w=${entry.width}&h=${entry.height}` : '';
    out += text.slice(cursor, m.index) + `![${m[1]}](dsh-local-image:${entry.id}${query})`;
    cursor = m.index + m[0].length;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

module.exports = { inlineTextImages, createTextImageBudget, localImagePathOf, hasRelativeImage, localImageOf, registerLocalImage, imageSizeOf, sniffMediaType, clearLocalImages, MAX_IMAGE_BYTES };
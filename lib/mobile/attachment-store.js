'use strict';

/**
 * 宿主附件库的直读 —— 手机取图那条路少绕一圈。
 *
 * 为什么要有它：手机要一张图时，插件今天只能调宿主的取附件接口，拿回**整份 base64** 再
 * 解成字节、分块写给手机。那一发要等宿主把整张读出来、编码完才返回，宿主主线程正忙
 * （比如在派生一条几千条的会话）时，手机那边就是一个字节都没有 —— 2026-10-31 中转日志里
 * 有 109 次请求整整 15 秒收不到任何字节，全部是这一条路上来的。
 *
 * 附件在宿主本机本来就是**按内容哈希分两级目录存的文件**（`<DSH_HOME>/attachments/v1/
 * objects/<前两位>/<其余>`），插件和宿主同机同进程，直接从盘上流进隧道就行：首字节不等
 * 宿主做主活，内存里也不再摊一份两兆七的 base64 字符串。
 *
 * **只认「我们确实告诉过手机的那几个 id」**（`remember` 在引用下发时记账）。这条不是多余的
 * 防御：附着在会话里的图片 id 是我们自己下发的，反过来「拿任意一个 64 位十六进制串来读」
 * 就不该成立 —— 能力面与 `session/file`、`session/local-image` 同一条口径：只读登记过的。
 * 记账没命中、文件不在、不是加密会话，一律退回原来那条宿主接口，行为与今天完全一致。
 *
 * 记账只在内存里：插件重启后手机重连会重新拉一遍消息、重新登记；过期与上限见下面两个常量。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dshHome } = require('../shared/paths.js');
const { chunksHeaders, pipeEncrypted } = require('../shared/e2ee-chunks.js');
const { imageSizeOf, sniffMediaType } = require('./local-images.js');

/** 量宽高只需要文件头；JPEG 的 SOF 段可能在几百字节之后，64KB 覆盖绝大多数实拍图。 */
const HEAD_BYTES = 64 * 1024;

/** 一个会话最多记多少个附件 id（会话里几千张图也不该无限涨）。 */
const MAX_IDS_PER_SESSION = 4096;
/** 最多记多少个会话（滚动淘汰最久没登记的）。 */
const MAX_SESSIONS = 64;
/** 记账多久算新鲜：超过这个时间没再被引用过，就当手机手里那份已经过期了。 */
const TTL_MS = 30 * 60 * 1000;

/** sessionId -> { at, entries: Map<attachmentId, { mediaType, at }> } */
const SESSIONS = new Map();

/**
 * 宿主附件编号的形状：`sha256:<64 位小写十六进制>`（见宿主 `attachment-local` 的 `ID_PATTERN`）。
 *
 * **前缀不能省**：宿主发的编号带 `sha256:`，磁盘上的文件名却是去掉前缀的那段哈希。以前这里
 * 只认裸哈希，于是每个真实编号都被当成「不是我们发过的」，直读这条路一次都没生效过。
 */
const OBJECT_ID = /^sha256:([0-9a-f]{64})$/;

function nowMs() {
  return Date.now();
}

/** 从附件编号里取出裸哈希（磁盘文件名那段）；形状不对回 null。 */
function hexOf(attachmentId) {
  if (typeof attachmentId !== 'string') return null;
  const match = OBJECT_ID.exec(attachmentId);
  return match ? match[1] : null;
}

/**
 * 附件 id → 宿主附件库里的绝对路径。
 *
 * 宿主 `normalizedImagePath` 的落盘形状是 `objects/<前两位>/<完整 64 位哈希>` —— 子目录取前两位、
 * **文件名仍是完整哈希**（不是去掉前两位的那段）。曾经拼成 `objects/<前两位>/<其余>`，于是每一份
 * 真实附件都找不到、直读与现量元数据全部落空（取图恒 404）。
 *
 * 形状不对（不是 `sha256:<64 位小写十六进制>`）直接回 null：这条路径要拼进
 * `createReadStream`，校验放在这里、而不是靠调用方记得先校验。
 */
function objectPathOf(attachmentId) {
  const hex = hexOf(attachmentId);
  if (!hex) return null;
  const root = path.join(dshHome(), 'attachments', 'v1', 'objects');
  return path.join(root, hex.slice(0, 2), hex);
}

/**
 * 记账：这个附件我们刚在 `sessionId` 的消息里下发过（手机接下来就可能来取字节）。
 *
 * 顺手把**完整引用**（媒体类型 / 字节数 / 宽高 / 名字）也记下来。回退去问宿主时，宿主新版
 * 的取附件接口要的是整份 `ImageAttachmentRef`，只有编号它不收。取字节本身宿主只用到编号，
 * 但请求形状这五个字段都必填。
 */
function remember(sessionId, attachmentId, ref) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (!hexOf(attachmentId)) return;
  const at = nowMs();
  let slot = SESSIONS.get(sessionId);
  if (!slot) {
    slot = { at, entries: new Map() };
    SESSIONS.set(sessionId, slot);
    // 会话数到顶：淘汰最久没动静的那一个（Map 保持插入顺序，第一条就是最旧的）。
    while (SESSIONS.size > MAX_SESSIONS) {
      const oldest = SESSIONS.keys().next().value;
      if (oldest === undefined) break;
      SESSIONS.delete(oldest);
    }
  }
  slot.at = at;
  const entry = {
    at,
    mediaType: ref && typeof ref.mediaType === 'string' && ref.mediaType ? ref.mediaType : 'application/octet-stream',
  };
  if (ref && Number.isFinite(ref.bytes)) entry.bytes = ref.bytes;
  if (ref && Number.isFinite(ref.width)) entry.width = ref.width;
  if (ref && Number.isFinite(ref.height)) entry.height = ref.height;
  if (ref && typeof ref.name === 'string' && ref.name) entry.name = ref.name;
  slot.entries.delete(attachmentId);
  slot.entries.set(attachmentId, entry);
  while (slot.entries.size > MAX_IDS_PER_SESSION) {
    const oldest = slot.entries.keys().next().value;
    if (oldest === undefined) break;
    slot.entries.delete(oldest);
  }
}

/**
 * 这个 id 是不是我们为这条会话下发过的；是就带上当时的完整引用（少 `attachmentId` 与时间戳）。
 */
function lookup(sessionId, attachmentId, now = nowMs()) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (typeof attachmentId !== 'string' || !attachmentId) return null;
  const slot = SESSIONS.get(sessionId);
  if (!slot) return null;
  if (now - slot.at > TTL_MS) {
    SESSIONS.delete(sessionId);
    return null;
  }
  const hit = slot.entries.get(attachmentId);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) {
    slot.entries.delete(attachmentId);
    return null;
  }
  const { at: _at, ...ref } = hit;
  return ref;
}

/** 打开一条只读流（调用方自己负责在连接关掉时 destroy）。 */
function openObject(attachmentId) {
  const target = objectPathOf(attachmentId);
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { path: target, size: stat.size, stream: fs.createReadStream(target) };
  } catch {
    return null;
  }
}

/**
 * 试一次「直接从盘上流给手机」：写成功返回 true，不该走或走不了返回 false。
 *
 * 三个前提缺一不可：这条请求带信封（协议 v2 才走分块）、这个 id 是我们为这条会话下发过的、
 * 对象文件确实还在。任一不满足就交给调用方走原来那条宿主接口 —— 老插件、老会话、明文会话
 * 的行为因此一个字都不变。
 */
async function streamIfRemembered(req, res, sessionId, attachmentId) {
  const opened = req && req.__dshE2ee;
  if (!opened || !opened.keys || !opened.req) return false;
  const known = lookup(sessionId, attachmentId);
  if (!known) return false;
  const object = openObject(attachmentId);
  if (!object) return false;
  res.writeHead(200, chunksHeaders({
    'x-dsh-content-type': known.mediaType,
    'x-dsh-file-size': String(object.size),
  }));
  res.on('close', () => object.stream.destroy());
  await pipeEncrypted(req, res, object.stream);
  return true;
}

/**
 * 从盘上这份附件对象量出它的真实元数据（类型 / 字节数 / 宽高）。
 *
 * 宿主取附件时会读同一份对象文件、用 sharp 探一遍，再跟我们递过去的引用**逐字段比对**：
 * 类型、字节数、宽高任一对不上就回 `Stored attachment metadata does not match its reference.`
 * （400）。所以引用不能瞎填占位值，必须和盘上那份字节对上。
 *
 * 附件存的是**归一化后**的字节（携带 EXIF 的图会被重编码、朝向烘进像素），因此文件头读出来的
 * 就是宿主 `probeImage` 会量到的同一组数；`imageSizeOf` 本就按 EXIF 5–8 对调，口径一致。
 * 读不出（不是位图 / 文件不在）回 null，由调用方决定怎么回。
 */
function probeObject(attachmentId) {
  const target = objectPathOf(attachmentId);
  if (!target) return null;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  let fd = null;
  let head;
  try {
    fd = fs.openSync(target, 'r');
    const length = Math.min(stat.size, HEAD_BYTES);
    head = Buffer.alloc(length);
    fs.readSync(fd, head, 0, length, 0);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关不上就算了，元数据已经读到 */ }
    }
  }
  const mediaType = sniffMediaType(head);
  const size = imageSizeOf(head);
  if (!mediaType || !size || !(size.width > 0) || !(size.height > 0)) return null;
  return { mediaType, bytes: stat.size, width: size.width, height: size.height };
}

/**
 * 给宿主取附件接口拼一份完整 `ImageAttachmentRef`。
 *
 * 记过账的用记下的整份引用；没记到的（过期 / 超上限 / 插件重启后没重新登记 / 排队条里透传的图）
 * 就从盘上那份对象现量一遍 —— 宿主校验要的就是盘上这份字节的真实元数据，占位值一定对不上。
 * 对象文件不在或量不出时回 null（调用方回 404），不再拿假引用去碰宿主的那条校验。
 */
function refFor(sessionId, attachmentId) {
  const known = lookup(sessionId, attachmentId);
  if (known && Number.isFinite(known.bytes) && Number.isFinite(known.width) && Number.isFinite(known.height)) {
    return { attachmentId, ...known };
  }
  const probed = probeObject(attachmentId);
  if (probed) {
    return { attachmentId, ...probed, ...(known && typeof known.name === 'string' ? { name: known.name } : {}) };
  }
  return known ? { attachmentId, ...known } : null;
}

/** 测试用：清空记账。 */
function reset() {
  SESSIONS.clear();
}

/**
 * 只从盘上那份对象文件头量宽高，**不问宿主、不搬字节**（批量那一档用）。
 *
 * 量不出来（对象文件不在 / 不是位图）回 null，调用方退回问宿主那条路。这条比 `refFor`
 * 便宜的地方在于：它连「和盘上字节对得上的引用」都不拼 —— 宿主那条校验只在真要取字节
 * 或要宿主自己量的时候才用得上。
 */
function localDims(attachmentId) {
  const probed = probeObject(attachmentId);
  if (!probed) return null;
  return { width: probed.width, height: probed.height };
}

module.exports = {
  MAX_IDS_PER_SESSION,
  MAX_SESSIONS,
  TTL_MS,
  objectPathOf,
  remember,
  lookup,
  refFor,
  localDims,
  openObject,
  streamIfRemembered,
  reset,
};

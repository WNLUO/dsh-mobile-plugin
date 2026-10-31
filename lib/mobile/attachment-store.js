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

/** 一个会话最多记多少个附件 id（会话里几千张图也不该无限涨）。 */
const MAX_IDS_PER_SESSION = 4096;
/** 最多记多少个会话（滚动淘汰最久没登记的）。 */
const MAX_SESSIONS = 64;
/** 记账多久算新鲜：超过这个时间没再被引用过，就当手机手里那份已经过期了。 */
const TTL_MS = 30 * 60 * 1000;

/** sessionId -> { at, entries: Map<attachmentId, { mediaType, at }> } */
const SESSIONS = new Map();

/** 内容哈希是 64 位小写十六进制；别的形状一律不认（顺带挡住路径穿越）。 */
const OBJECT_ID = /^[0-9a-f]{64}$/;

function nowMs() {
  return Date.now();
}

/**
 * 附件 id → 宿主附件库里的绝对路径。
 *
 * 形状不对（不是 64 位小写十六进制）直接回 null：这条路径要拼进 `createReadStream`，
 * 校验放在这里、而不是靠调用方记得先校验。
 */
function objectPathOf(attachmentId) {
  if (typeof attachmentId !== 'string' || !OBJECT_ID.test(attachmentId)) return null;
  const root = path.join(dshHome(), 'attachments', 'v1', 'objects');
  return path.join(root, attachmentId.slice(0, 2), attachmentId.slice(2));
}

/** 记账：这个附件我们刚在 `sessionId` 的消息里下发过（手机接下来就可能来取字节）。 */
function remember(sessionId, attachmentId, mediaType) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (typeof attachmentId !== 'string' || !OBJECT_ID.test(attachmentId)) return;
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
  slot.entries.delete(attachmentId);
  slot.entries.set(attachmentId, {
    at,
    mediaType: typeof mediaType === 'string' && mediaType ? mediaType : 'application/octet-stream',
  });
  while (slot.entries.size > MAX_IDS_PER_SESSION) {
    const oldest = slot.entries.keys().next().value;
    if (oldest === undefined) break;
    slot.entries.delete(oldest);
  }
}

/** 这个 id 是不是我们为这条会话下发过的；是就带上当时的媒体类型。 */
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
  return { mediaType: hit.mediaType };
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

/** 测试用：清空记账。 */
function reset() {
  SESSIONS.clear();
}

module.exports = {
  MAX_IDS_PER_SESSION,
  MAX_SESSIONS,
  TTL_MS,
  objectPathOf,
  remember,
  lookup,
  openObject,
  streamIfRemembered,
  reset,
};

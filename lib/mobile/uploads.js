'use strict';

/**
 * 移动端文件分片上传：把手机分享进来的文件落到宿主机固定收件目录。
 *
 * 四步：begin（登记文件名，拿 uploadId 与片大小）→ chunk（按 index 顺序追加）→
 * finish（落盘成 `<收件根>/<日期>/<文件名>`，重名自动加后缀）→ abort（放弃）。
 *
 * 为什么分片，而不是一次 POST 传完：
 *   - 一次传完会把「能传多大的文件」变成一条运维配置 —— 中转的
 *     `MAX_BODY_BYTES`（dsh-mobile-server/lib/config.js）默认 50MB，插件自己的
 *     readJsonBody 默认只有 256KB。分片后单请求最大只有 2MB，与这些上限无关。
 *   - 手机侧网络不稳，分片能只重传坏掉的那一片，而不是整个文件。
 *
 * 为什么片内容走 base64 而不是原始字节：隧道协议本身支持原始字节
 * （lib/relay/protocol.js 的 httpBody 帧），但 App 侧没有任何「发二进制 body」的
 * 先例，RN 的 fetch 对 ArrayBuffer body 的支持也随版本变；图片通道本来就以 base64
 * 走 JSON，这里沿用同一条确定能用的路。代价是 33% 膨胀（单片 2MB → 约 2.73MB），
 * 仍远低于任何一层上限。
 *
 * 顺序与幂等：chunk 只接受「下一片」，重复送达同一片按重传处理（回当前 received，
 * 不再追加），跳号直接 409 —— 客户端因此不需要在重试前先问进度。
 *
 * 落盘根目录固定 `~/.dsh/mobile-inbox`（收件专目录，与工作区解耦，工作区被删也不
 * 影响已收到的文件）。`DSH_MOBILE_INBOX` 可覆盖，只给测试用。
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { sendJson, readJsonBody } = require('../shared/http-util');

// 片大小的**起步值** 256KB（base64 后约 341KB）：客户端一次请求的硬预算是 8s
// （`app/src/api/core.ts` 的 REQUEST_TIMEOUT_MS），一上来就给大片的机器会在慢速上行
// 网络上撞超时。客户端从这一档起步、按实测周期自己往上爬，爬到 `CHUNK_MAX_BYTES` 为止 ——
// 局域网里能一路放大，公网上爬两下就停住。所以 begin 回的是「起步值 + 上限」两个数，
// 不是「就传这么大」。
const CHUNK_BYTES = 256 * 1024;
// 片大小的上限（原始字节）：base64 后约 2.73MB，仍在下面 8MB 的请求体预算内。
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 单片请求体上限（**明文**字节）：4MB base64 后约 5.33MB，再按 §8.3(9) 的 4/3 信封
 * 放大到 11MB —— 按线上长度直接卡 8MB 等于悄悄砍掉四分之一的可用额度。
 */
const CHUNK_MAX_BODY = Math.ceil(8 * 1024 * 1024 * 4 / 3);
/** 文件名上限（按字符算，避开各文件系统的字节上限差异）。 */
const NAME_MAX_CHARS = 120;
/** 暂存残片的最长寿命：手机上传中断后没人来 abort 的清理依据。 */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/** 分片必须是标准 base64：Node 的 Buffer.from 会静默丢弃非法字符，光靠解码判不出坏片。 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 刚落盘的上传：uploadId → { path, name, bytes, at }。
 *
 * 存在的理由：`session/send` 以前只认内联 base64 的图片块，一张 4MB 照片线上要
 * 7MB 左右，而那条请求的预算只有 8 秒 —— 大图必超时。现在图片先走分片上传（每片都
 * 落在预算内），再在 send 里用 uploadId 换字节。这张表就是那个「换」的凭据。
 *
 * 只在内存里、30 分钟过期、条数封顶：过期之后手机重传一次就行，不留长期文件索引。
 */
const finishedUploads = new Map();
const FINISHED_TTL_MS = 30 * 60 * 1000;
const FINISHED_MAX = 64;

function rememberFinishedUpload(uploadId, record) {
  if (!uploadId) return;
  finishedUploads.set(uploadId, { ...record, at: Date.now() });
  if (finishedUploads.size > FINISHED_MAX) {
    const oldest = [...finishedUploads.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, finishedUploads.size - FINISHED_MAX);
    for (const [key] of oldest) finishedUploads.delete(key);
  }
}

/**
 * 按 uploadId 取刚落盘的上传。过期 / 不存在返回 null。
 *
 * @returns {{ path: string, name: string, bytes: number } | null}
 */
function resolveFinishedUpload(uploadId) {
  const id = String(uploadId || '');
  const record = finishedUploads.get(id);
  if (!record) return null;
  if (Date.now() - record.at > FINISHED_TTL_MS) {
    finishedUploads.delete(id);
    return null;
  }
  return { path: record.path, name: record.name, bytes: record.bytes };
}

/** 进行中的上传：uploadId → { name, stagingPath, received, bytes, expiresAt, expiryTimer }。 */
const uploads = new Map();

function removeUpload(uploadId, job) {
  if (uploads.get(uploadId) !== job) return false;
  uploads.delete(uploadId);
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = null;
  return true;
}

async function expireUpload(uploadId, job) {
  if (uploads.get(uploadId) !== job) return;
  const remaining = job.expiresAt - Date.now();
  if (remaining > 0) {
    job.expiryTimer = setTimeout(() => { void expireUpload(uploadId, job); }, remaining);
    job.expiryTimer.unref?.();
    return;
  }
  if (!removeUpload(uploadId, job)) return;
  try { await fsp.unlink(job.stagingPath); } catch { /* 暂存文件可能已由磁盘清扫移除 */ }
}

function scheduleUploadExpiry(uploadId, job) {
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = setTimeout(() => { void expireUpload(uploadId, job); }, Math.max(0, job.expiresAt - Date.now()));
  job.expiryTimer.unref?.();
}

/** 清理过期上传状态及其暂存文件；传入 now 便于测试 TTL 边界。 */
async function sweepExpiredUploads(now = Date.now()) {
  await Promise.all([...uploads].map(async ([uploadId, job]) => {
    if (job.expiresAt > now || !removeUpload(uploadId, job)) return;
    try { await fsp.unlink(job.stagingPath); } catch { /* 暂存文件可能已由磁盘清扫移除 */ }
  }));
}

/** 收件根目录。每次取用都重算，好让测试用环境变量分派。 */
function inboxRoot() {
  const override = process.env.DSH_MOBILE_INBOX;
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'mobile-inbox');
}

/**
 * 清成一个能安全当作文件名的名字：去掉路径成分、文件系统保留字符与控制字符，
 * 压掉连续空白，掐掉前导点（避免生成隐藏文件），并限长（保住扩展名）。
 */
function sanitizeName(raw) {
  const base = path.basename(String(raw == null ? '' : raw).replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return '未命名文件';
  if (cleaned.length <= NAME_MAX_CHARS) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  return cleaned.slice(0, NAME_MAX_CHARS - ext.length) + ext;
}

/** 本地日期 yyyy-mm-dd（收件目录按天分堆，`os` 本地时区更贴近「今天收到的」）。 */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 在 dir 下给 name 找一个不冲突的落点（`名字-1.ext`、`名字-2.ext`…）。 */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || '未命名文件';
  for (let i = 0; i < 200; i += 1) {
    const candidate = path.join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * 清掉过期残片；尽力而为，失败不影响本次上传。
 *
 * 返回删掉了几个、腾了多少字节 —— `begin` 那条路不看它（`void` 掉），但收件目录的清理
 * 与占用读数要拿它报数，所以别改成只在内部记账。
 *
 * **这条清扫只在 `begin` 时跑**：手机不再上传的那台机器上，残片就一直躺着（实测过：
 * 一份 12MB 的 `.part` 从 10-20 睡到今天）。所以 `mobile/inbox-clean.js` 的清理与启动
 * 收尾也会调它，TTL 判据只有这一份。
 */
async function sweepStaging(stagingDir) {
  let entries;
  try {
    entries = await fsp.readdir(stagingDir, { withFileTypes: true });
  } catch {
    return { deleted: 0, bytes: 0 };
  }
  const cutoff = Date.now() - STAGING_TTL_MS;
  const removed = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.part')) return null;
    const target = path.join(stagingDir, entry.name);
    try {
      const stat = await fsp.stat(target);
      if (stat.mtimeMs >= cutoff) return null;
      await fsp.unlink(target);
      return stat.size;
    } catch {
      // 已被别人清掉，或者删不掉：都不算这次腾出来的量。
      return null;
    }
  }));
  const sizes = removed.filter((size) => typeof size === 'number');
  return { deleted: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

function fail(res, status, code, message) {
  return sendJson(res, status, { ok: false, error: { code, message } });
}

/** POST /api/mobile/v1/upload/begin → { ok, uploadId, chunkSize }。 */
async function handleUploadBegin(_ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return fail(res, 400, 'bad-request', '需要 { name }');
  }
  const stagingDir = path.join(inboxRoot(), '.staging');
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
  } catch (error) {
    return fail(res, 500, 'inbox-unavailable', `收件目录不可用：${error.message}`);
  }
  void sweepStaging(stagingDir);
  void sweepExpiredUploads();

  const uploadId = crypto.randomUUID();
  const stagingPath = path.join(stagingDir, `${uploadId}.part`);
  try {
    await fsp.writeFile(stagingPath, Buffer.alloc(0));
  } catch (error) {
    return fail(res, 500, 'inbox-unavailable', `无法建立暂存文件：${error.message}`);
  }
  const job = {
    name: sanitizeName(body.name),
    stagingPath,
    received: 0,
    bytes: 0,
    expiresAt: Date.now() + STAGING_TTL_MS,
    expiryTimer: null,
  };
  uploads.set(uploadId, job);
  scheduleUploadExpiry(uploadId, job);
  // chunkSize 是起步值、maxChunkSize 是天花板：客户端从前者开始按实测周期往上爬。
  sendJson(res, 200, { ok: true, uploadId, chunkSize: CHUNK_BYTES, maxChunkSize: CHUNK_MAX_BYTES });
}

/** POST /api/mobile/v1/upload/chunk { uploadId, index, data } → { ok, received }。 */
async function handleUploadChunk(_ctx, req, res) {
  const body = await readJsonBody(req, CHUNK_MAX_BODY);
  if (!body) return fail(res, 413, 'too-large', '分片过大或不是合法 JSON');

  const job = uploads.get(String(body.uploadId == null ? '' : body.uploadId));
  if (!job) return fail(res, 404, 'unknown-upload', '上传会话不存在或已结束');

  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'bad-request', 'index 必须是非负整数');
  if (typeof body.data !== 'string') return fail(res, 400, 'bad-request', 'data 必须是 base64 字符串');
  if (index < job.received) return sendJson(res, 200, { ok: true, received: job.received });
  if (index > job.received) {
    return fail(res, 409, 'out-of-order', `期望分片 ${job.received}，收到 ${index}`);
  }

  const chunk = Buffer.from(body.data, 'base64');
  if (!BASE64_RE.test(body.data) || body.data.length % 4 !== 0) {
    return fail(res, 400, 'bad-request', 'data 不是合法 base64');
  }
  try {
    await fsp.appendFile(job.stagingPath, chunk);
  } catch (error) {
    removeUpload(String(body.uploadId), job);
    return fail(res, 500, 'inbox-unavailable', `写入暂存文件失败：${error.message}`);
  }
  job.received += 1;
  job.bytes += chunk.length;
  job.expiresAt = Date.now() + STAGING_TTL_MS;
  scheduleUploadExpiry(String(body.uploadId), job);
  sendJson(res, 200, { ok: true, received: job.received });
}

/** POST /api/mobile/v1/upload/finish { uploadId } → { ok, path, name, bytes }。 */
async function handleUploadFinish(_ctx, req, res) {
  const body = await readJsonBody(req);
  const uploadId = String((body && body.uploadId) || '');
  const job = uploads.get(uploadId);
  if (!job) return fail(res, 404, 'unknown-upload', '上传会话不存在或已结束');
  removeUpload(uploadId, job);

  const dir = path.join(inboxRoot(), today());
  try {
    await fsp.mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, job.name);
    await fsp.rename(job.stagingPath, target);
    // 记住这一份：发送图片时用它把「分片上传的字节」换回内联块，见 resolveFinishedUpload。
    rememberFinishedUpload(uploadId, { path: target, name: path.basename(target), bytes: job.bytes });
    sendJson(res, 200, { ok: true, path: target, name: path.basename(target), bytes: job.bytes, uploadId });
  } catch (error) {
    try { await fsp.unlink(job.stagingPath); } catch { /* 已经不在了 */ }
    return fail(res, 500, 'inbox-unavailable', `落盘失败：${error.message}`);
  }
}

/** POST /api/mobile/v1/upload/abort { uploadId } → { ok }。 */
async function handleUploadAbort(_ctx, req, res) {
  const body = await readJsonBody(req);
  const uploadId = String((body && body.uploadId) || '');
  const job = uploads.get(uploadId);
  if (job) {
    removeUpload(uploadId, job);
    try { await fsp.unlink(job.stagingPath); } catch { /* 已经不在了 */ }
  }
  sendJson(res, 200, { ok: true });
}

/** 一张图片的明文上限：超过就按「传太大」拒，而不是把宿主内存撑爆。 */
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const UPLOAD_EXPIRED_MESSAGE = '这张图片的上传已过期，请重新发送';

/**
 * 把 content 里带 `uploadId` 的图片块补成内联 base64。
 *
 * 宿主的 `session.prompt` 只认 `{type:'image', mediaType, data}`，所以这一步要在宿主
 * 那一跳之前完成：手机到宿主这一段只传 uploadId，字节早就在分片上传时落盘了。
 *
 * @returns {Promise<string|null>} 有块补不上就回一句给用户看的话，全补上了回 null。
 */
async function inlineUploadedImageBlocks(content) {
  for (const block of content) {
    if (!block || block.type !== 'image') continue;
    if (typeof block.data === 'string' && block.data) continue;
    const record = resolveFinishedUpload(block.uploadId);
    if (!record) return UPLOAD_EXPIRED_MESSAGE;
    try {
      const bytes = await fsp.readFile(record.path);
      if (!bytes.length || bytes.length > MAX_IMAGE_UPLOAD_BYTES) return UPLOAD_EXPIRED_MESSAGE;
      block.data = bytes.toString('base64');
      if (!block.name) block.name = record.name;
    } catch {
      return UPLOAD_EXPIRED_MESSAGE;
    }
  }
  return null;
}

module.exports = {
  handleUploadBegin,
  handleUploadChunk,
  handleUploadFinish,
  handleUploadAbort,
  sanitizeName,
  inboxRoot,
  sweepStaging,
  sweepExpiredUploads,
  STAGING_TTL_MS,
  CHUNK_BYTES,
  CHUNK_MAX_BYTES,
  resolveFinishedUpload,
  inlineUploadedImageBlocks,
};

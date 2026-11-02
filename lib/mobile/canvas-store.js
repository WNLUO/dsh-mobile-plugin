'use strict';

/**
 * 无限画布的库（`/api/mobile/v1/canvas/*`）。
 *
 * 为什么要有它：画布整个活在 App 的 WebView 里，项目和素材全在页面的 IndexedDB 中 ——
 * 清一次缓存、换一台手机就没了，桌面端也看不见。这个模块把「库」搬到宿主机上，App 负责
 * 把本机那份推上来、把远端那份拉下去，桌面端以后读的是同一份。
 *
 * 存两样东西，各管一件事：
 *  · **清单**（每个域一份 JSON）：项目图、资产行、工作台记录这些「结构」，加上一份
 *    `files: [{storageKey, hash, mimeType, bytes}]` —— 结构里引用了哪些字节、各是哪一份。
 *  · **字节**（`objects/<哈希前两位>/<其余>`）：按内容哈希落盘，只增不改。同一个 storageKey
 *    在手机上是不可变的（键是随机串），所以判「要不要传」只看远端清单里有没有这个键。
 *
 * 清单永远在字节之后写：先传缺的文件、再写清单。写清单这一步会逐个 stat 文件，缺一个就
 * 整份拒绝（`missing-file`）—— 一份指向不存在字节的清单在手机上表现为「画布能打开、图全是
 * 坏的」，而且它会把下一次同步判成「已同步」，坏得无声无息。
 *
 * 能力面：只有一个固定目录，**客户端给不了任何路径**，也只会拿到哈希。文件名是 64 位十六
 * 进制（不是哈希形状的一律不认，顺带挡住路径穿越），与分片上传那条通道同一口径。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { dshHome } = require('../shared/paths.js');
const { writeEncryptedFile, encryptedLengthOf } = require('./session-file.js');

/**
 * 四个域与画布自己的同步引擎一一对应（`app/vendor/canvas-src` 的 app-sync）。
 *
 * 域是清单的分片，不是权限：每个域一份文件，谁变了推谁，别把整库塞进一份 JSON。
 */
const DOMAINS = new Set(['canvas', 'assets', 'image-workbench', 'video-workbench']);

/** 清单请求体上限（**明文**字节）：与分片上传同一个 8MB 预算，够装几万个节点。 */
const MAX_MANIFEST_BYTES = Math.ceil(8 * 1024 * 1024 * 4 / 3);
/** 一份清单最多认多少个文件条目：再多也传不完，早报错比传到一半失败好。 */
const MAX_FILES = 20000;
/** 单份字节的上限：与「会话文件」同一条口径，超过的整份传不回来。 */
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
/** 内容哈希：64 位小写十六进制。别的形状一律不认（这一条同时挡住路径穿越）。 */
const HASH_RE = /^[0-9a-f]{64}$/;
/** storageKey 只当清单里的键用、不拼路径，但仍然要求是干净的字符串。 */
const STORAGE_KEY_MAX = 300;
/** 清单版本号取内容哈希的前 16 位：同一份内容算出同一个号，不需要另存一个自增计数。 */
const REVISION_CHARS = 16;

/** 库根：插件自己的数据目录，`DSH_MOBILE_CANVAS` 只给测试用。 */
function rootDir() {
  return process.env.DSH_MOBILE_CANVAS || path.join(dshHome(), 'storages', 'mobile-plugin', 'canvas');
}

/** 某个域的清单文件。 */
function manifestPath(domain) {
  return path.join(rootDir(), `manifest-${domain}.json`);
}

/** 字节区根。 */
function objectsRoot() {
  return path.join(rootDir(), 'objects');
}

/**
 * 哈希 → 盘上路径。形状不对回 null：这个值要拼进文件路径，校验放在这里，不靠调用方记得。
 */
function objectPathOf(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
  return path.join(objectsRoot(), hash.slice(0, 2), hash.slice(2));
}

/** 域 → 规范值；不认识回 null。 */
function domainOf(value) {
  const domain = typeof value === 'string' ? value.trim() : '';
  return DOMAINS.has(domain) ? domain : null;
}

/** 内容 → 版本号（内容变了才对不上，所以不需要另记时间）。 */
function revisionOf(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, REVISION_CHARS);
}

/**
 * 读某个域的清单。没有回 null；盘上有但读不懂**如实抛**，不当成「没有」——
 * 当成没有会让手机把本机那份推上来，把远端那份直接盖掉（那是最不该发生的静默失败）。
 */
async function readManifest(domain) {
  let text;
  try {
    text = await fsp.readFile(manifestPath(domain), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw Object.assign(new Error(`读画布清单失败：${error.message}`), { code: 'canvas-store-unavailable' });
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.domain !== domain) throw new Error('形状不对');
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`画布清单已损坏（${domain}）：${error.message}`), { code: 'manifest-corrupt' });
  }
}

/** 哈希对应的字节在不在盘上（清单落盘之前要逐个确认）。 */
async function objectExists(hash) {
  const target = objectPathOf(hash);
  if (!target) return false;
  try {
    const info = await fsp.stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * 校验并规范化一份要写进来的清单。
 *
 * @returns {{ status: number, code: string, message: string, missing?: string[] } | { files: Array<object>, data: unknown }}
 */
function normalizePayload(body) {
  const domain = domainOf(body.domain);
  if (!domain) return { status: 400, code: 'bad-domain', message: 'domain 只能是 canvas / assets / image-workbench / video-workbench' };
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return { status: 400, code: 'bad-data', message: '需要 { data }（一个对象）' };
  }
  const rawFiles = body.files === undefined ? [] : body.files;
  if (!Array.isArray(rawFiles)) return { status: 400, code: 'bad-files', message: 'files 必须是数组' };
  if (rawFiles.length > MAX_FILES) {
    return { status: 413, code: 'too-many-files', message: `一份清单最多 ${MAX_FILES} 个文件` };
  }
  // 同一个 storageKey 只留最后一条：清单是整份替换的，重复条目只会在下发时变成两行。
  const byKey = new Map();
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object') return { status: 400, code: 'bad-files', message: 'files 里每一项都得是对象' };
    const storageKey = typeof item.storageKey === 'string' ? item.storageKey : '';
    if (!storageKey || storageKey.length > STORAGE_KEY_MAX || /[\u0000-\u001f\u007f]/.test(storageKey)) {
      return { status: 400, code: 'bad-files', message: 'storageKey 必须是 1..300 个可见字符' };
    }
    if (!HASH_RE.test(String(item.hash || ''))) {
      return { status: 400, code: 'bad-files', message: `文件 ${storageKey} 的 hash 不是 64 位十六进制` };
    }
    const bytes = Number(item.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_OBJECT_BYTES) {
      return { status: 400, code: 'bad-files', message: `文件 ${storageKey} 的字节数不合法` };
    }
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.slice(0, 120) : 'application/octet-stream';
    byKey.set(storageKey, { storageKey, hash: String(item.hash), mimeType, bytes });
  }
  return { files: [...byKey.values()], data: body.data };
}

/**
 * 写清单：先确认每个哈希都在盘上，再整份原子替换。
 *
 * 为什么逐个 stat：清单是「库里有哪些字节」的账，账上有一笔盘上没有的单子，手机下次同步会
 * 因为「清单里有」而不再上传，那张图标就一直坏着。
 */
async function writeManifest(domain, data, files) {
  const missing = [];
  for (const file of files) {
    if (!(await objectExists(file.hash))) missing.push(file.storageKey);
  }
  if (missing.length) {
    const shown = missing.slice(0, 5).join('、');
    return {
      status: 409,
      code: 'missing-file',
      message: `这些文件还没传上来：${shown}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`,
      missing,
    };
  }
  const revision = revisionOf({ data, files });
  const manifest = {
    app: 'infinite-canvas',
    version: 1,
    domain,
    revision,
    updatedAt: new Date().toISOString(),
    data,
    files,
  };
  const target = manifestPath(domain);
  const tmp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.writeFile(tmp, JSON.stringify(manifest), 'utf8');
    // 原子替换：手机随时可能来读，读到的要么是上一份、要么是这一份。
    await fsp.rename(tmp, target);
  } catch (error) {
    try { await fsp.unlink(tmp); } catch { /* 已经不在了 */ }
    throw Object.assign(new Error(`写画布清单失败：${error.message}`), { code: 'canvas-store-unavailable' });
  }
  return { revision, updatedAt: manifest.updatedAt, files: files.length };
}

/** 一份文件的 sha256（流式，不把整份读进内存）。 */
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 把一份刚落进暂存区的字节收进库里，回它的哈希。
 *
 * 分片上传（`uploads.js`）传完一份画布素材就交给这里：算哈希 → 落进 objects。同内容的文件
 * 已经在库里就直接丢暂存的那份 —— 画布里的图经常是同一张被引用了好几次，哈希天然去重。
 *
 * @returns {Promise<{ hash: string, bytes: number }>}
 */
async function storeUploadedFile(stagingPath) {
  const info = await fsp.stat(stagingPath);
  if (info.size > MAX_OBJECT_BYTES) {
    const error = Object.assign(new Error('这份文件太大，画布库装不下'), { code: 'too-large', status: 413 });
    throw error;
  }
  const hash = await sha256OfFile(stagingPath);
  const target = objectPathOf(hash);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (await objectExists(hash)) {
    try { await fsp.unlink(stagingPath); } catch { /* 已经不在了 */ }
    return { hash, bytes: info.size };
  }
  try {
    await fsp.rename(stagingPath, target);
  } catch {
    // 跨设备（暂存根被 `DSH_MOBILE_INBOX` 挪到别的盘）时 rename 会 EXDEV：复制一份再删。
    await fsp.copyFile(stagingPath, target);
    try { await fsp.unlink(stagingPath); } catch { /* 已经不在了 */ }
  }
  return { hash, bytes: info.size };
}

/**
 * GET /api/mobile/v1/canvas/manifest?domain=canvas&rev=<版本号>
 *
 * 带 `rev` 且与盘上那份一致时只回一句 `unchanged` —— 画布每开一次就同步一次，稳态那一发
 * 不该把整份项目图再传一遍（跟会话列表那条条件刷同一个口径）。
 */
async function handleCanvasManifestGet(_ctx, req, res) {
  const query = new URL(req.url || '/', 'http://x').searchParams;
  const domain = domainOf(query.get('domain'));
  if (!domain) return sendJson(res, 400, { ok: false, error: { code: 'bad-domain', message: 'domain 只能是 canvas / assets / image-workbench / video-workbench' } });
  let manifest;
  try {
    manifest = await readManifest(domain);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: (error && error.code) || 'canvas-store-unavailable', message: String(error && error.message) } });
  }
  if (!manifest) return sendJson(res, 200, { ok: true, domain, revision: null, empty: true, files: [] });
  const rev = String(query.get('rev') || '');
  if (rev && rev === manifest.revision) {
    return sendJson(res, 200, { ok: true, domain, revision: manifest.revision, updatedAt: manifest.updatedAt, unchanged: true });
  }
  sendJson(res, 200, {
    ok: true,
    domain,
    revision: manifest.revision,
    updatedAt: manifest.updatedAt,
    data: manifest.data,
    files: Array.isArray(manifest.files) ? manifest.files : [],
  });
}

/**
 * POST /api/mobile/v1/canvas/manifest { domain, data, files }
 *
 * 整份替换、不做字段级合并：合并是客户端的事（它手上有本机那份，也有刚拉下去的远端那份）。
 * 宿主只负责「存下来、版本号算清楚、缺字节就拒绝」。
 */
async function handleCanvasManifestSave(_ctx, req, res) {
  const body = await readJsonBody(req, MAX_MANIFEST_BYTES);
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体不是合法 JSON，或超过体积上限' } });
  }
  const normalized = normalizePayload(body);
  if (normalized.status) {
    return sendJson(res, normalized.status, { ok: false, error: { code: normalized.code, message: normalized.message, ...(normalized.missing ? { missing: normalized.missing } : {}) } });
  }
  let result;
  try {
    result = await writeManifest(domainOf(body.domain), normalized.data, normalized.files);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: (error && error.code) || 'canvas-store-unavailable', message: String(error && error.message) } });
  }
  if (result.status) {
    return sendJson(res, result.status, { ok: false, error: { code: result.code, message: result.message, ...(result.missing ? { missing: result.missing } : {}) } });
  }
  sendJson(res, 200, { ok: true, domain: domainOf(body.domain), revision: result.revision, updatedAt: result.updatedAt, files: result.files });
}

/**
 * POST /api/mobile/v1/canvas/file { hash } → 那份字节。
 *
 * 按哈希取、不按路径：客户端构造不出一个能读到别的东西的请求。响应形状与 `/session/file`
 * 逐字节同形（含协议 v2 的分块信封与 `content-length`）—— 手机那边用的是同一个原生下载器，
 * 换一个形状就要在 App 里再写一条下载路。
 */
async function handleCanvasFile(_ctx, req, res) {
  const body = await readJsonBody(req);
  const hash = body && typeof body.hash === 'string' ? body.hash.trim().toLowerCase() : '';
  const target = objectPathOf(hash);
  if (!target) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { hash }（64 位十六进制）' } });
  }
  let info;
  try {
    info = await fsp.stat(target);
  } catch {
    return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '这份字节不在电脑上了' } });
  }
  if (!info.isFile()) {
    return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '这份字节不在电脑上了' } });
  }

  const header = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' };
  const opened = req && req.__dshE2ee;
  if (opened && opened.keys && opened.req) {
    res.writeHead(200, {
      ...header,
      'content-type': 'application/x-dsh-e2ee-chunks',
      'content-length': String(encryptedLengthOf(info.size)),
      'x-dsh-file-size': String(info.size),
      'x-dsh-proto': '2',
      'x-dsh-content-type': 'application/octet-stream',
    });
    await writeEncryptedFile(req, res, target, opened);
    return;
  }

  res.writeHead(200, { ...header, 'content-length': String(info.size) });
  if (info.size === 0) return res.end();
  const stream = fs.createReadStream(target);
  res.on('close', () => stream.destroy());
  try {
    await pipeline(stream, res);
  } catch {
    // 头已经发出去了，改不了状态码，只能断开让对端按截断处理（与会话文件那条一致）。
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

module.exports = {
  DOMAINS,
  MAX_OBJECT_BYTES,
  rootDir,
  objectPathOf,
  objectExists,
  readManifest,
  writeManifest,
  storeUploadedFile,
  handleCanvasManifestGet,
  handleCanvasManifestSave,
  handleCanvasFile,
};

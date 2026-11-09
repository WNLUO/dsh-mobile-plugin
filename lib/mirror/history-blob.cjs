'use strict';

/**
 * 加密历史 blob 的信封、组帧与文件 blob 的取材（宿主侧）。
 *
 * 宿主离线时手机要能翻会话正文：电脑用一把「实例历史密钥」（HK）把正文封成密文 blob 推到
 * 中转，中转只存密文、永不持钥、永不解密；手机用自己那份 HK 解开。**能力面不扩**——只多
 * 一条只读的 blob 拉取路径，不暴露 shell / 系统设置 / 任意文件写。
 *
 * 这一层负责「算字节」与「决定哪些内容该进 blob」：
 *  - 信封口径与 `app/src/services/viewmodels/history-blob.ts` 一字不差：AES-256-GCM，
 *    `nonce(12) || 密文 || tag(16)`，AAD `dsh-history-v1|<scope>|<key>`，外层
 *    `{v:1, z:0, n:b64url(nonce), c:b64url(密文+tag)}`；`z` 恒 0 表示未压缩。
 *  - 中转的 `blobPut` 帧里 `cipher` 是**信封 JSON 的 base64url**（中转只当不透明字节）。
 *  - 两个 scope：
 *    - `messages`：明文是 `{sessionId, seq, updatedAt, messages:[...]}`（JSON）。
 *    - `file`：明文是**文件原始字节**（不套 JSON），上限 2MB。
 *
 * **file 的 key 口径（生产端与 App 消费端必须同一个）**：一律是 64 位小写 sha256 十六进制。
 *  1. 附件（历史消息里的图片等，带 `attachmentId`）：`attachmentId` 形如 `sha256:<64hex>`，
 *     key 就是那段 `<64hex>` —— 也就是附件对象在宿主附件库里的文件名。App 手上的图片条目
 *     本来就有 `attachmentId`，去掉 `sha256:` 前缀即得。
 *  2. 交付文件（`deliverables/presented` 的 `files[].path`，投影到消息的 `presentedFiles`）：
 *     key 是**声明里那个 path 字符串原样**的 sha256 hex（`\` 归一成 `/`，其余不加工）。
 *     刻意不相对化：App 手上 `presentedFiles[].path` 就是同一个字符串，两边直接对同一个
 *     输入算哈希，不会因为会话 cwd 变了、或一边绝对一边相对而错开。
 *
 * 为什么用 sha256 而不是直接拿路径当 key：路径里有 `/`、中文、`..`，拼进
 * `/blob/<scope>/<key>` 与 AAD 都要额外转义，而 sha256 hex 恒定 64 字符、URL 安全。
 *
 * 必须是 .cjs：包根是 type=module，而 lib/mirror/ 没有自己的 `{"type":"commonjs"}`。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { seal, open, b64url, unb64url, NONCE_BYTES } = require('../shared/e2ee.js');
const attachmentStore = require('../mobile/attachment-store.js');

const AAD_PREFIX = 'dsh-history-v1';
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;

/** 文件 blob 的明文上限：信封 base64 后约 2.7MB，进帧再 base64 约 3.6MB，稳在默认 8MB 帧内。 */
const FILE_MAX_PLAIN_BYTES = 2 * 1024 * 1024;
/**
 * messages blob 的封顶（按 `cipher` 的 base64url 长度算）。
 *
 * 中转对单 blob 有上限，超了它要么拒要么截；快照本身没有体积概念，所以裁剪放在生产端：
 * 封完超了就从**最旧**的消息开始丢，N 递减到装得下为止。手机离线看到的是「最近 N 条」，
 * 与「blob 只有最近一页」这条契约一致。
 */
const MESSAGES_MAX_CIPHER_BYTES = Math.floor(3.5 * 1024 * 1024);

/** 信封 AAD：`dsh-history-v1|<scope>|<key>`。App 侧同一串，差一个字节都解不开。 */
const aadFor = (scope, key) => `${AAD_PREFIX}|${scope}|${key}`;

/** HK 归一成 32 字节 Buffer：接受 base64url 串本身或已是 32 字节的 Buffer。 */
function keyBytes(hk) {
  const buf = Buffer.isBuffer(hk) ? hk : unb64url(hk);
  if (buf.length !== KEY_BYTES) throw new Error('history key must be 32 bytes');
  return buf;
}

/**
 * 封一段字节成信封 JSON 字符串。
 *
 * @param {string|Buffer} hk  实例历史密钥（base64url 或 32 字节）
 * @param {string} scope      `messages` | `file`
 * @param {string} key        sessionId / fileKey
 * @param {Buffer} plain      明文字节
 * @returns {string} 信封 JSON
 */
function sealBytes(hk, scope, key, plain) {
  const buf = keyBytes(hk);
  const sealed = seal(buf, Buffer.from(plain), aadFor(scope, key));
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    z: 0,
    n: b64url(sealed.subarray(0, NONCE_BYTES)),
    c: b64url(sealed.subarray(NONCE_BYTES)),
  });
}

/**
 * 封一个 JSON 明文成信封 JSON 字符串。
 *
 * @param {string|Buffer} hk     实例历史密钥（base64url 或 32 字节）
 * @param {string} scope         `messages` | `file`
 * @param {string} key           sessionId / fileKey
 * @param {object} plainObj      明文内容（会被 JSON 序列化）
 * @returns {string} 信封 JSON
 */
function sealHistoryBlob(hk, scope, key, plainObj) {
  return sealBytes(hk, scope, key, Buffer.from(JSON.stringify(plainObj), 'utf8'));
}

/** 解一封信封 JSON 回明文对象。认证不过抛错，绝不返回半截明文。 */
function openHistoryBlob(hk, scope, key, envelopeJson) {
  const buf = keyBytes(hk);
  const envelope = typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
  if (!envelope || envelope.v !== ENVELOPE_VERSION) throw new Error('unsupported history envelope version');
  if (typeof envelope.n !== 'string' || typeof envelope.c !== 'string') throw new Error('bad history envelope');
  const sealed = Buffer.concat([unb64url(envelope.n), unb64url(envelope.c)]);
  const plain = open(buf, sealed, aadFor(scope, key));
  return JSON.parse(plain.toString('utf8'));
}

/** 解一封 `file` 信封回原始字节。 */
function openFileBlob(hk, key, envelopeJson) {
  const buf = keyBytes(hk);
  const envelope = typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
  if (!envelope || envelope.v !== ENVELOPE_VERSION) throw new Error('unsupported history envelope version');
  if (typeof envelope.n !== 'string' || typeof envelope.c !== 'string') throw new Error('bad history envelope');
  const sealed = Buffer.concat([unb64url(envelope.n), unb64url(envelope.c)]);
  return open(buf, sealed, aadFor('file', key));
}

/** 信封 JSON → `blobPut.cipher`（base64url）。 */
const envelopeCipher = (envelopeJson) => b64url(Buffer.from(envelopeJson, 'utf8'));

/**
 * 这个会话该不该进 blob。
 *
 * blob 里装的一律是 HK 密文，所以**没有「这个会话是明文会话」这回事**：真正的门是「设备手上
 * 有没有 HK」—— HK 只经协议 v2 的封包交付，老设备拿不到就解不开，推过去也只是不透明字节。
 * 曾经这里拿 `body.proto` 判 proto1，而镜像消息快照根本不带协议标记，那条判据永远为假，
 * 等于一段永远不会生效的死代码；别再加回来。
 *
 * 唯一保留的钩子是「会话**显式**标记为未加密」：字段真存在且明确说了才跳过（现在没有任何
 * 生产端会写它）。缺省一律入 blob。
 */
function isBlobEligible(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.encrypted === false) return false;
  return Array.isArray(body.items);
}

/** 从载荷的会话清单里取这个会话的 updatedAt（取不到就 0）。 */
function sessionUpdatedAt(payload, sessionId) {
  const items = payload && payload.sessions && Array.isArray(payload.sessions.items) ? payload.sessions.items : [];
  const row = items.find((entry) => entry && String(entry.sessionId) === String(sessionId));
  const at = row && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
  return at;
}

/**
 * 一条 messages blob 的内容指纹（判「要不要重封重推」用）。
 *
 * 取语义内容：消息水位、条数、updatedAt、最后一条的 id/seq。不含时间戳之外的易变值，
 * 同一份正文永远同一个指纹。**只在推送成功之后才记**，失败的那条下一轮还会重试。
 */
function messagesBlobFingerprint(sessionId, body, updatedAt) {
  const items = Array.isArray(body && body.items) ? body.items : [];
  const lastSeq = body && Number.isFinite(body.lastSeq) ? body.lastSeq : 0;
  const last = items.length ? items[items.length - 1] : null;
  const tail = last && (last.id || (Number.isFinite(last.seq) ? last.seq : '')) || '';
  return `${sessionId}:${lastSeq}:${items.length}:${updatedAt}:${tail}`;
}

/**
 * 封一条 messages blob，超过单 blob 上限就从最旧的消息开始裁。
 *
 * 裁剪比例按「当前体积 / 上限」估一个 keep 数，再逐次收敛；每次重封都从头算，不做增量。
 * 消息只有 1 条还超限（单条巨大正文）就照发那一条 —— 少了它这条会话就整条离线不可读，
 * 而一条消息的体积是宿主自己的事，不在这里替它截断正文。
 */
function buildMessagesBlobPut(hk, sessionId, body, updatedAt, digestList, maxBytes = MESSAGES_MAX_CIPHER_BYTES) {
  const all = Array.isArray(body.items) ? body.items : [];
  let keep = all.length;
  let frame = null;
  for (;;) {
    const items = keep >= all.length ? all : all.slice(all.length - keep);
    const plain = { sessionId, seq: Number.isFinite(body.lastSeq) ? body.lastSeq : 0, updatedAt, messages: items };
    const cipher = envelopeCipher(sealHistoryBlob(hk, 'messages', sessionId, plain));
    frame = { scope: 'messages', key: sessionId, creds: digestList, cipher };
    if (cipher.length <= maxBytes || keep <= 1) break;
    // 每次至少丢一条，按超出的比例估下一档，避免逐条试。
    const ratio = maxBytes / cipher.length;
    const next = Math.max(1, Math.floor(keep * ratio * 0.95));
    keep = Math.min(keep - 1, next);
  }
  return frame;
}

/**
 * 由一份镜像载荷算出要发的 `blobPut` 帧（scope=messages）。
 *
 * **没有 HK 就一条都不发**（返回空数组）：开关关 / 还没生成密钥的机器，转发行为一个字节
 * 都不变。`creds` 复用镜像里那份设备凭据摘要（`{hash, expiresAt?}[]`），这里只取 `hash`
 * 那串 sha256 hex —— 中转拿它做拉取鉴权。
 *
 * 这是「整份载荷一次算完」的批量入口（测试与一次性补推用）；逐轮增量推送走
 * `buildMessagesBlobPut`，才谈得上限帧数与按条判重。
 *
 * @param {object} payload  镜像推送载荷（含 messages / sessions）
 * @param {string} hk       实例历史密钥（缺失/空串 → 不推）
 * @param {Array<{hash: string}>} creds  当前有效设备凭据摘要
 * @returns {Array<{scope: string, key: string, creds: string[], cipher: string}>}
 */
function buildBlobPuts(payload, hk, creds) {
  if (!hk) return [];
  const digestList = digestListOf(creds);
  const messages = payload && payload.messages && typeof payload.messages === 'object' ? payload.messages : {};
  const frames = [];
  for (const [sessionId, body] of Object.entries(messages)) {
    if (!isBlobEligible(body)) continue;
    frames.push(buildMessagesBlobPut(hk, sessionId, body, sessionUpdatedAt(payload, sessionId), digestList));
  }
  return frames;
}

/** 设备凭据摘要 → 只留 sha256 hex 串（中转按它做拉取鉴权）。 */
function digestListOf(creds) {
  if (!Array.isArray(creds)) return [];
  return creds
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.hash))
    .filter((hash) => typeof hash === 'string' && hash);
}

/* ── file scope：从镜像消息引用里取材 ───────────────────────────────── */

/** 附件 id 的形状：`sha256:<64 位小写十六进制>`（与宿主 attachment-local 的 ID_PATTERN 同口径）。 */
const ATTACHMENT_ID = /^sha256:([0-9a-f]{64})$/;

/** 附件 id → file blob 的 key（64 位十六进制）；形状不对回 null。 */
function fileKeyOfAttachment(attachmentId) {
  if (typeof attachmentId !== 'string') return null;
  const match = ATTACHMENT_ID.exec(attachmentId);
  return match ? match[1] : null;
}

/** 工作区相对路径（`/` 归一）→ file blob 的 key（sha256 hex）。 */
function fileKeyOfPath(declared) {
  const raw = typeof declared === 'string' ? declared.trim() : '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw.split('\\').join('/'), 'utf8').digest('hex');
}

/** 一条消息项里引用的附件 id（图片投影成 `images:[{attachmentId,...}]`）。 */
function attachmentIdsOf(item) {
  const out = [];
  const images = item && Array.isArray(item.images) ? item.images : [];
  for (const image of images) {
    if (image && typeof image.attachmentId === 'string' && image.attachmentId) out.push(image.attachmentId);
  }
  return out;
}

/**
 * 一份镜像载荷里所有该封 `file` blob 的来源（按 key 去重）。
 *
 * 只认两处：消息里带 `attachmentId` 的图片、以及消息上挂的 `presentedFiles`（交付声明）。
 * 来源里带上会话 id 与 cwd，读字节与后续删除都靠它。
 *
 * @returns {Array<{key:string, sessionId:string, kind:'attachment'|'path', attachmentId?:string, path?:string, cwd?:string}>}
 */
function collectFileBlobSources(payload) {
  const cwdBySession = new Map();
  const rows = payload && payload.sessions && Array.isArray(payload.sessions.items) ? payload.sessions.items : [];
  for (const row of rows) {
    if (row && row.sessionId) cwdBySession.set(String(row.sessionId), typeof row.cwd === 'string' ? row.cwd : '');
  }
  const out = new Map();
  const messages = payload && payload.messages && typeof payload.messages === 'object' ? payload.messages : {};
  for (const [sessionId, body] of Object.entries(messages)) {
    if (!isBlobEligible(body)) continue;
    const cwd = cwdBySession.get(String(sessionId)) || '';
    for (const item of body.items) {
      for (const attachmentId of attachmentIdsOf(item)) {
        const key = fileKeyOfAttachment(attachmentId);
        if (key) out.set(key, { key, sessionId: String(sessionId), kind: 'attachment', attachmentId });
      }
      const presented = item && Array.isArray(item.presentedFiles) ? item.presentedFiles : [];
      for (const file of presented) {
        const key = fileKeyOfPath(file && file.path);
        if (key) out.set(key, { key, sessionId: String(sessionId), kind: 'path', path: file.path, cwd });
      }
    }
  }
  return [...out.values()];
}

/** 来源 → 盘上的绝对路径；取不到回 null。 */
function fileSourcePath(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.kind === 'attachment') return attachmentStore.objectPathOf(source.attachmentId);
  if (source.kind === 'path') {
    const declared = typeof source.path === 'string' ? source.path.trim() : '';
    if (!declared) return null;
    if (path.isAbsolute(declared)) return path.resolve(declared);
    if (!source.cwd) return null;
    return path.resolve(source.cwd, declared);
  }
  return null;
}

/** 来源的当前体积/修改时间（判重与 2MB 上限用）；不在盘上回 null。 */
function statFileSource(source) {
  const target = fileSourcePath(source);
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** file blob 的内容指纹：体积 + 修改时间，变了才重读重封。 */
const fileBlobFingerprint = (key, stat) => `${key}:${stat.size}:${Math.floor(stat.mtimeMs)}`;

/** 读来源的原始字节；超过 2MB 或读不到回 null（调用方只记一行日志）。 */
function readFileSource(source, maxBytes = FILE_MAX_PLAIN_BYTES) {
  const target = fileSourcePath(source);
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

/** 封一条 file blob（明文是原始字节）→ `blobPut` 帧。 */
function buildFileBlobPut(hk, source, bytes, digestList) {
  const cipher = envelopeCipher(sealBytes(hk, 'file', source.key, bytes));
  return { scope: 'file', key: source.key, creds: digestList, cipher };
}

module.exports = {
  AAD_PREFIX,
  ENVELOPE_VERSION,
  FILE_MAX_PLAIN_BYTES,
  MESSAGES_MAX_CIPHER_BYTES,
  aadFor,
  sealBytes,
  sealHistoryBlob,
  openHistoryBlob,
  openFileBlob,
  envelopeCipher,
  isBlobEligible,
  digestListOf,
  sessionUpdatedAt,
  messagesBlobFingerprint,
  buildMessagesBlobPut,
  buildBlobPuts,
  fileKeyOfAttachment,
  fileKeyOfPath,
  collectFileBlobSources,
  statFileSource,
  fileBlobFingerprint,
  readFileSource,
  buildFileBlobPut,
};

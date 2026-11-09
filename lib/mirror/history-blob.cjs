'use strict';

/**
 * 加密历史 blob 的信封与组帧（宿主侧）。
 *
 * 宿主离线时手机要能翻会话正文：电脑用一把「实例历史密钥」（HK）把正文封成密文 blob 推到
 * 中转，中转只存密文、永不持钥、永不解密；手机用自己那份 HK 解开。**能力面不扩**——只多
 * 一条只读的 blob 拉取路径，不暴露 shell / 系统设置 / 任意文件写。
 *
 * 这一层只负责「算字节」与「决定哪些会话该进 blob」：
 *  - 信封口径与 `app/src/services/viewmodels/history-blob.ts` 一字不差：AES-256-GCM，
 *    `nonce(12) || 密文 || tag(16)`，AAD `dsh-history-v1|<scope>|<key>`，外层
 *    `{v:1, z:0, n:b64url(nonce), c:b64url(密文+tag)}`；`z` 恒 0 表示未压缩。
 *  - 中转的 `blobPut` 帧里 `cipher` 是**信封 JSON 的 base64url**（中转只当不透明字节）。
 *  - **只做 `messages` 一档**：推上去的是会话正文，附件与交付文件不在内（那要另算字节流、
 *    配额与分段）。`sealHistoryBlob` / `openHistoryBlob` 认 `file` 这个 scope 只是为将来
 *    留口，今天没有生产者，别把「正文能离线看」读成「文件也能」。
 *
 * 必须是 .cjs：包根是 type=module，而 lib/mirror/ 没有自己的 `{"type":"commonjs"}`。
 */

const { seal, open, b64url, unb64url, NONCE_BYTES } = require('../shared/e2ee.js');

const AAD_PREFIX = 'dsh-history-v1';
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;

/** 信封 AAD：`dsh-history-v1|<scope>|<key>`。App 侧同一串，差一个字节都解不开。 */
const aadFor = (scope, key) => `${AAD_PREFIX}|${scope}|${key}`;

/** HK 归一成 32 字节 Buffer：接受 base64url 串本身或已是 32 字节的 Buffer。 */
function keyBytes(hk) {
  const buf = Buffer.isBuffer(hk) ? hk : unb64url(hk);
  if (buf.length !== KEY_BYTES) throw new Error('history key must be 32 bytes');
  return buf;
}

/**
 * 封一个 JSON 明文成信封 JSON 字符串。
 *
 * @param {string|Buffer} hk     实例历史密钥（base64url 或 32 字节）
 * @param {string} scope         `messages` | `file`
 * @param {string} key           sessionId / fileId
 * @param {object} plainObj      明文内容（会被 JSON 序列化）
 * @returns {string} 信封 JSON
 */
function sealHistoryBlob(hk, scope, key, plainObj) {
  const buf = keyBytes(hk);
  const plain = Buffer.from(JSON.stringify(plainObj), 'utf8');
  const sealed = seal(buf, plain, aadFor(scope, key));
  const envelope = {
    v: ENVELOPE_VERSION,
    z: 0,
    n: b64url(sealed.subarray(0, NONCE_BYTES)),
    c: b64url(sealed.subarray(NONCE_BYTES)),
  };
  return JSON.stringify(envelope);
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

/** 信封 JSON → `blobPut.cipher`（base64url）。 */
const envelopeCipher = (envelopeJson) => b64url(Buffer.from(envelopeJson, 'utf8'));

/**
 * 这个会话该不该进 blob。
 *
 * 老会话（proto 1）一律不入 blob：它们走的是明文老通道，手机上也没有对应的 HK 消费路径。
 * 消息快照本身不带协议标记，所以只有明确标了 `proto === 1` 才判为老会话；缺省（现状）
 * 按 v2 处理，既有会话不会因为这一条被判掉。
 */
function isBlobEligible(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.proto === 1 || body.proto === '1') return false;
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
 * 由一份镜像载荷算出要发的 `blobPut` 帧（scope=messages）。
 *
 * **没有 HK 就一条都不发**（返回空数组）：开关关 / 还没生成密钥的机器，转发行为一个字节
 * 都不变。`creds` 复用镜像里那份设备凭据摘要（`{hash, expiresAt?}[]`），这里只取 `hash`
 * 那串 sha256 hex —— 中转拿它做拉取鉴权。
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

/** 单条 messages blob 的上限：超过就从最旧的消息开始裁（见 `buildMessagesBlobPut`）。 */
const MESSAGES_MAX_CIPHER_BYTES = 8 * 1024 * 1024;

/**
 * 一条 messages blob 的内容指纹（判「要不要重封重推」用）。
 *
 * 取语义内容：消息水位、条数、updatedAt、最后一条的 id/seq。不含易变值，同一份正文永远
 * 同一个指纹。**只在推送成功之后才记**，失败的那条下一轮还会重试。
 */
function messagesBlobFingerprint(sessionId, body, updatedAt) {
  const items = Array.isArray(body && body.items) ? body.items : [];
  const lastSeq = body && Number.isFinite(body.lastSeq) ? body.lastSeq : 0;
  const last = items.length ? items[items.length - 1] : null;
  const tail = (last && (last.id || (Number.isFinite(last.seq) ? last.seq : ''))) || '';
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


module.exports = {
  AAD_PREFIX,
  ENVELOPE_VERSION,
  MESSAGES_MAX_CIPHER_BYTES,
  aadFor,
  sealHistoryBlob,
  openHistoryBlob,
  envelopeCipher,
  isBlobEligible,
  digestListOf,
  sessionUpdatedAt,
  messagesBlobFingerprint,
  buildMessagesBlobPut,
  buildBlobPuts,
};

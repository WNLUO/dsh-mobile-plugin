'use strict';

/**
 * 链路加密（协议 v2）的字节级原语。App 侧有一份逐字节等价实现（`services/e2ee.ts`），
 * 两边的正确性靠同一份测试向量保证（`test/e2ee-vectors.json`），不靠互相阅读代码。
 *
 * 这一层只做「算字节」，不认识路由、不认识业务：信封放在哪里、什么时候加解密，由
 * `http/routing.js`（宿主侧）与 `services/http.ts`（App 侧）负责。
 *
 * 算法只用三样，且都是两端现成的：AES-256-GCM、HKDF-SHA256、HMAC-SHA256。
 *
 * **AEAD 用 AES-256-GCM 而不是 ChaCha20-Poly1305**（2026-10-24 改）：桌面宿主跑在
 * Electron 里，那份 Node 链接的是 BoringSSL，`crypto.getCiphers()` 里根本没有
 * `chacha20-poly1305`（实测 `createCipheriv` 直接 `Unknown cipher`，`openssl 0.0.0`）。
 * 换过来之前，每一条协议 v2 的请求在宿主侧都会在解封那一步抛错 —— 表现成扫码配对
 * 一律「配对码错误」、已配对设备全线 401，而两端的离线测试（用真实 node:crypto）
 * 全绿，因为测试进程的 Node 是带 chacha 的那一种。
 * 不引 HPKE、不引新依赖 —— 理由（Node 不暴露 `crypto.hpke`，App 侧也没有
 * 现成的 X25519，而二维码里那张一次性票据已经解决了「怎么秘密交付密钥」）。
 */

const crypto = require('node:crypto');

const PROTO_VERSION = 2;
/** 线上信封里的 `v`。与 `X-Dsh-Proto` 同值，但要分开取：前者是信封形状，后者是会话属性。 */
const ENVELOPE_VERSION = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/**
 * AEAD 算法名。
 *
 * **必须是两端 Node / BoringSSL 都认的那一个**：宿主侧跑在 Electron 里（BoringSSL，
 * 没有 chacha20-poly1305），App 侧跑 `@noble/ciphers`。AES-256-GCM 两边都在，
 * 且实测密文逐字节一致（`test/e2ee-vectors.json` 的重算就是这条证据）。
 */
const AEAD = 'aes-256-gcm';

/* ── 编码 ───────────────────────────────────────────────────────────── */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (text) => {
  // Buffer 的 base64 解码是宽容的（坏字符会被跳过），所以先按字符集挡一道：
  // 一个畸形串静默解成一段字节，最后表现为「认证标签不过」，很难查。
  const value = String(text || '');
  if (value !== '' && !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error('bad base64url');
  return Buffer.from(value, 'base64url');
};
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (text) => {
  const value = String(text || '');
  if (value !== '' && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('bad base64');
  return Buffer.from(value, 'base64');
};

/* ── 密钥派生 ───────────────────────────────────────────────────────── */

function hkdf32(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), KEY_BYTES));
}

/**
 * 二维码里那张一次性票据 → 配对密钥。
 *
 * `salt` 取实例号，把两张不同宿主的二维码绑死在各自的机器上：换个实例号就算同一张票据，
 * 派出来的密钥也不同。
 */
function derivePairKey(ticket, instanceId) {
  return hkdf32(ticket, Buffer.from(String(instanceId), 'utf8'), 'dsh-pair-v2');
}

/**
 * 设备主密钥 → 三把方向/用途分开的密钥。
 *
 * **上下行必须分开**：两个方向各自随机产 nonce，而 AEAD 的 keystream 只由「密钥 + nonce」
 * 决定、AAD 不参与（实测：同 key 同 nonce、只换 AAD，正文密文逐字节相同）。共用一把时
 * 两个方向一旦撞 nonce，两条消息的正文直接 XOR 掉。签名用第三把，不和加密共用。
 */
function deriveSessionKeys(deviceKey) {
  return {
    up: hkdf32(deviceKey, Buffer.alloc(0), 'dsh-v2|up'),
    down: hkdf32(deviceKey, Buffer.alloc(0), 'dsh-v2|down'),
    sig: hkdf32(deviceKey, Buffer.alloc(0), 'dsh-v2|sig'),
  };
}

/* ── AEAD ──────────────────────────────────────────────────────────── */

/** 封：`nonce(12) || 密文 || tag(16)`。 */
const sealWithNonce = (key, nonce, plain, aad) => {
  const cipher = crypto.createCipheriv(AEAD, key, nonce, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([Buffer.from(nonce), cipher.update(Buffer.from(plain)), cipher.final(), cipher.getAuthTag()]);
};

/** 封（自己产 nonce）。 */
const seal = (key, plain, aad) => sealWithNonce(key, crypto.randomBytes(NONCE_BYTES), plain, aad);

/** 解：入参是 `nonce || 密文 || tag`。认证不过抛错，绝不返回半截明文。 */
function open(key, sealed, aad) {
  const buf = Buffer.from(sealed);
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const nonce = buf.subarray(0, NONCE_BYTES);
  const body = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(AEAD, key, nonce, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ── AAD / 签名口径 ─────────────────────────────────────────────────── */

const pairAad = (instanceId) => `pair|v2|${instanceId}`;
const upAad = (method, path) => `v2|up|${method}|${path}`;
const downAad = (method, path, ts, nonce) => `v2|down|${method}|${path}|${ts}|${nonce}`;
const sseAad = (path, ts, nonce, seq) => `v2|down|sse|${path}|${ts}|${nonce}|${seq}`;
const fileAad = (path, nonce, seq) => `v2|down|file|${path}|${nonce}|${seq}`;
const paramsAad = (ts, nonce) => `v2|params|${ts}|${nonce}`;

/**
 * 签名的规范串。**全部按线上原样**，不做任何规范化：
 *
 *   `v2 \n METHOD \n PATH \n QUERY \n TS \n NONCE \n HEX(sha256(body))`
 *
 * `PATH` 从 `API_BASE` 起算（中转会把部署前缀剥掉再交给宿主，按完整路径签必然对不上）。
 * `QUERY` 带 `?`、按实际发出的顺序，不排序：它必须和真发出去的那串一致。
 * 摘要用小写十六进制 64 字符，不是 base64。
 */
function canonicalString({ method, path, query, ts, nonce, bodyBytes }) {
  const digest = crypto.createHash('sha256').update(bodyBytes || Buffer.alloc(0)).digest('hex');
  return ['v2', String(method || 'GET').toUpperCase(), path, query || '', String(ts), nonce, digest].join('\n');
}

const sign = (kSig, canonical) => b64url(crypto.createHmac('sha256', kSig).update(Buffer.from(canonical, 'utf8')).digest());

function verifySignature(kSig, canonical, presented) {
  let got;
  try {
    got = unb64url(presented);
  } catch {
    return false;
  }
  if (got.length !== 32) return false;
  const want = crypto.createHmac('sha256', kSig).update(Buffer.from(canonical, 'utf8')).digest();
  return crypto.timingSafeEqual(want, got);
}

module.exports = {
  PROTO_VERSION,
  ENVELOPE_VERSION,
  NONCE_BYTES,
  TAG_BYTES,
  KEY_BYTES,
  b64url,
  unb64url,
  b64,
  unb64,
  derivePairKey,
  deriveSessionKeys,
  seal,
  sealWithNonce,
  open,
  pairAad,
  upAad,
  downAad,
  sseAad,
  fileAad,
  paramsAad,
  canonicalString,
  sign,
  verifySignature,
};

'use strict';

/**
 * 信封里的**明文压缩**：封之前压、解之后解。
 *
 * 为什么压的是明文而不是「封好的信封」：信封是 base64 密文，密文没有可压缩的余量
 * （实测同一份 58KB 消息 JSON：明文 gzip → 16KB，密文再 gzip → 77KB，几乎不掉）。
 * 所以压缩必须发生在 `seal()` 之前、`open()` 之后，压缩结果直接作为 AEAD 的明文。
 *
 * 收益只在 JSON / 文本上：实测 200 行 JSON 掉到 28%，一百多 KB 的会话列表掉到一成；
 * 而已经压过的字节（图片、zip、视频）压完基本不变，所以**不达阈值不压** —— 小响应
 * 加上 gzip 头反而会变大（22 字节的 `{ok:true,items:[]}` 压完 42 字节）。
 *
 * 协商：宿主只在请求头 `x-dsh-accept-enc` 里认到 `g` 时才压响应。老 App 不带这个头，
 * 于是「新插件 + 老 App」与「老插件 + 新 App」两个组合都不会碰到解不开的东西。
 * 解压一侧不做版本判断：信封里带 `z` 就已经表明这一份是压过的。
 */

const zlib = require('node:zlib');

/** 小于这个字节数不压：gzip 的头与 CPU 换不回那点字节。 */
const PLAIN_GZIP_MIN_BYTES = 1024;

/** 线上信封里 `z` 字段的取值。只认这一个 —— 将来加压缩算法要换代号，不能悄悄改语义。 */
const PLAIN_Z_GZIP = 'g';

/** 请求头：客户端声明「这一头能解压响应的明文」。头名与信封的 `z` 是两个层次，别混用。 */
const ACCEPT_ENC_HEADER = 'x-dsh-accept-enc';

const acceptsPlainGzip = (acceptEnc) =>
  typeof acceptEnc === 'string' && /\bg\b/.test(acceptEnc);

/**
 * 按需把明文压成 gzip。
 *
 * @param {Buffer} plain 将要交给 AEAD 的明文
 * @param {string|undefined} acceptEnc 请求头原值（`undefined` = 对方没声明，一律不压）
 * @returns {{ payload: Buffer, z?: string }} `z` 只在真的压了时出现
 */
function compressPlain(plain, acceptEnc) {
  const raw = Buffer.isBuffer(plain) ? plain : Buffer.from(plain == null ? '' : plain);
  if (raw.length < PLAIN_GZIP_MIN_BYTES || !acceptsPlainGzip(acceptEnc)) return { payload: raw };
  let gz;
  try {
    gz = zlib.gzipSync(raw);
  } catch {
    // 压不动就发明文：一次压缩失败不该让整条响应消失。
    return { payload: raw };
  }
  // 极端情况下（已压过的字节）gzip 反而更大，那种情况不如不压。
  if (gz.length >= raw.length) return { payload: raw };
  return { payload: gz, z: PLAIN_Z_GZIP };
}

/**
 * 按信封里的 `z` 把明文解回来。
 *
 * 认不出的 `z` 一律抛错，不猜：猜错的表现是「拿到一段乱码再 JSON.parse 失败」，
 * 那种错误码会指向业务而不是信封。
 *
 * @param {Buffer} payload 刚解封出来的明文
 * @param {unknown} z 信封上的 `z` 字段
 * @returns {Buffer}
 */
function decompressPlain(payload, z) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (z === undefined || z === null || z === '') return buf;
  if (z === PLAIN_Z_GZIP) return zlib.gunzipSync(buf);
  throw new Error(`unknown plain compression: ${String(z)}`);
}

module.exports = {
  PLAIN_GZIP_MIN_BYTES,
  PLAIN_Z_GZIP,
  ACCEPT_ENC_HEADER,
  acceptsPlainGzip,
  compressPlain,
  decompressPlain,
};

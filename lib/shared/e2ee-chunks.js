'use strict';

/**
 * 分块信封的写出口（协议 v2，§8.3(6)）—— 会话文件、会话日志 ZIP、会话图片附件共用这一份。
 *
 * 块形状：`[4 字节大端长度][12 字节 nonce][密文 + 16 字节 tag]`，长度字段写的是「密文 + tag」
 * 这一段（不含 nonce 与长度字段本身）。AAD 绑这条请求的路径、请求 nonce 与块序号 —— 块序号
 * 让中转既不能把别的文件的字节搬进来，也不能重排或截断而不被察觉。
 *
 * 为什么要一个共用模块：这是跨端**逐字对齐**的那一层，手机那边是同一个原生解盘口在读
 * （`DSHCipher.openFile`）。三条下载各写一遍，等于给自己留三个漂移点，而漂了不会有报错，
 * 只会换来「文件打不开」。
 */

const e2ee = require('./e2ee');
const { signedPath } = require('./e2ee-request');

/** 一块的明文字节数。与 App 侧 `FILE_CHUNK_BYTES` 同值。 */
const FILE_CHUNK_BYTES = 64 * 1024;

/** 分块信封的 content-type：App 靠它判「这份字节要解，别当普通文件存」。 */
const E2EE_CHUNKS_TYPE = 'application/x-dsh-e2ee-chunks';

/**
 * 分块信封的响应头。
 *
 * **不给 content-length**：这一份是边收边加密的流，总长要等上游收完才知道；而 App 那条原生
 * 下载器只认 EOF、不靠长度判完成（要看长度的是 blob-util 那条老路，已经不用了）。
 */
function chunksHeaders(extra = {}) {
  return {
    'content-type': E2EE_CHUNKS_TYPE,
    'cache-control': 'no-store',
    'x-dsh-proto': '2',
    ...extra,
  };
}

/** 写一块：`[4 字节长度][nonce][密文+tag]`。 */
function writeChunk(res, key, block, aad) {
  const sealed = Buffer.from(e2ee.seal(key, block, aad));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(sealed.length - e2ee.NONCE_BYTES, 0);
  res.write(Buffer.concat([head, sealed]));
}

/**
 * 把一个可读流按块加密写进 `res`（调用方已经把状态码与头写完了）。
 *
 * 块边界要自己攒（`pending` 不到一块就等下一段）。**空内容也要写一块**，否则 App 分不清
 * 「这份是空的」与「一个字节都没收到」。出错时只能断开连接 —— 头已经发出去了，改不了状态码。
 */
async function pipeEncrypted(req, res, source) {
  const opened = req && req.__dshE2ee;
  if (!opened || !opened.keys || !opened.req) throw new Error('这条请求没有信封');
  const path = signedPath(req);
  const requestNonce = opened.req.nonce;
  let seq = 0;
  let pending = Buffer.alloc(0);
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    for await (const chunk of source) {
      if (closed) break;
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (pending.length >= FILE_CHUNK_BYTES) {
        const block = pending.subarray(0, FILE_CHUNK_BYTES);
        pending = pending.subarray(FILE_CHUNK_BYTES);
        seq += 1;
        writeChunk(res, opened.keys.down, block, e2ee.fileAad(path, requestNonce, seq));
      }
    }
    if (!closed) {
      seq += 1;
      writeChunk(res, opened.keys.down, pending, e2ee.fileAad(path, requestNonce, seq));
      res.end();
    }
  } catch {
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

module.exports = { FILE_CHUNK_BYTES, E2EE_CHUNKS_TYPE, chunksHeaders, writeChunk, pipeEncrypted };

'use strict';

/**
 * 会话日志导出（GET /api/mobile/v1/session-log）。
 *
 * 桌面端的导出走宿主 web 服务器的 `GET /api/session.export`，由浏览器下载管理器
 * 落盘（见 @deepseek-ai/dsh-session-log-export/lib/client.js）。那个端点绑定在宿主
 * 的 127.0.0.1 上，手机既直连不到、也没有 `<a download>`，所以这里由插件代取并
 * 原样转发宿主 `apiProxy.downloads.sessionLog` 的 application/zip 流。
 *
 * 0.2.x 的兼容桥没有这条端点（host-bridge.js 的 `downloads.sessionLog` 直接回
 * `host-unsupported`），所以这一代宿主上本路由只能如实回 502；等宿主把导出能力重新
 * 暴露出来，上面这段转发才真的走得到。
 *
 * 与桌面客户端保持同一口径：`includeDescendants` 缺省即 true —— 导出的是「当前会话
 * + 子会话 + 附件」的整棵会话树，而不是单个会话。
 *
 * **封过包的请求回分块信封，明文请求照旧回 zip**（2026-10-30）。判据是 `req.__dshE2ee`：
 * 它由移动端守卫在解封请求时挂上，只有带 `X-Dsh-Proto: 2` 的请求才有 —— 也就是说这一档
 * 只对新 App 生效，老 App 一个字都不用改。为什么要加这一档：守卫对「v2 凭据 + 明文请求」
 * 一律回 `e2ee-required`，而这条导出一直是绕开传输内核直发的明文请求，于是它在按 v2 配对的
 * 手机上从来就没走到下载这一步。封了包之后，**响应也得跟着封** —— 会话树里是整段对话与附件，
 * 明文 zip 等于把这条链路唯一的加密出口又打开一次。分块格式与 `session-file.js` 共用一套
 * （`[4 字节长度][nonce][密文+tag]`，AAD 绑路径 / 请求 nonce / 块序号），App 那边用同一个
 * 原生解密口读，两处口径因此只有一份。
 */

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { sendJson } = require('../shared/http-util.js');
const { signedPath } = require('../shared/e2ee-request');

/** 与 `session-file.js` 的 `FILE_CHUNK_BYTES` 同值。 */
const FILE_CHUNK_BYTES = 64 * 1024;

/** 分块信封的 content-type：App 靠它判「这份字节要解」，与文件下载同一个字面量。 */
const E2EE_CHUNKS_TYPE = 'application/x-dsh-e2ee-chunks';

/**
 * 与桌面 sessionLogZipFilename 同口径的下载文件名。
 * @param {string} sessionId 会话 id（可能含路径分隔符等，需折叠成安全字符）
 * @returns {string} dsh-session-<安全 id>.zip
 */
function sessionLogZipFilename(sessionId) {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;
}

/**
 * 导出会话日志 ZIP 并写回响应。
 * @param {object} ctx 插件上下文（用 ctx.apiProxy.downloads）
 * @param {object} req node:http IncomingMessage
 * @param {object} res node:http ServerResponse
 */
async function handleSessionLog(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  }
  // 与宿主 sessionLogQuerySchema 同口径：只接受 true/false/缺省。拼错的取值宁可
  // 报错也不能按缺省放过去 —— 否则一次笔误就悄悄少导出了子会话。
  const raw = url.searchParams.get('includeDescendants');
  if (raw !== null && raw !== 'true' && raw !== 'false') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'includeDescendants 只接受 true 或 false' } });
  }
  const includeDescendants = raw !== 'false';

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let upstream;
  try {
    upstream = await ctx.apiProxy.downloads.sessionLog(
      { sessionId, ...(includeDescendants ? { includeDescendants: true } : {}) },
      ac.signal,
    );
  } catch (error) {
    if (ac.signal.aborted) return;
    return sendJson(res, 502, { ok: false, error: { code: 'export-failed', message: String(error?.message || error) } });
  }
  if (!upstream || !upstream.ok) {
    const status = Number(upstream?.status) || 502;
    // 宿主的失败体是纯文本原因（404 session not found / 500 未准备好 / 501 后端不
    // 支持原始产物）。原样透出，否则移动端只会看到一个没有信息量的状态码。
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 300); } catch { /* 读取失败按状态码报 */ }
    return sendJson(res, status === 200 ? 502 : status, {
      ok: false,
      error: { code: 'export-failed', message: detail || `会话日志导出失败：HTTP ${status}` },
    });
  }

  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/zip',
    'content-disposition': upstream.headers.get('content-disposition') || `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
    'cache-control': 'no-store',
    'content-encoding': 'identity',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['content-length'] = length;

  const opened = req && req.__dshE2ee;
  if (opened && opened.keys && opened.req && upstream.body) {
    // **不给 content-length**：加密后的长度要等上游收完才知道（这一份是边收边加密的流），
    // 而 App 那条原生下载器只认 EOF、不靠长度判完成。真类型单独给一条头，解密之后按它
    // 认「这是一份 zip」。
    res.writeHead(200, {
      'content-type': E2EE_CHUNKS_TYPE,
      'content-disposition': headers['content-disposition'],
      'cache-control': 'no-store',
      'x-dsh-proto': '2',
      'x-dsh-content-type': headers['content-type'],
    });
    await pipeEncrypted(req, res, Readable.fromWeb(upstream.body));
    return;
  }

  res.writeHead(200, headers);
  if (!upstream.body) return res.end();
  try {
    // 边收边写，不在插件进程里整包缓冲：会话树的附件可能很大，缓冲等于把宿主的
    // 导出体积搬进内存。
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // 已经写出 200 与部分字节，改不了状态码，只能断开让客户端按截断处理。
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/**
 * 边收边加密写出去（格式与 `session-file.js` 的 `writeEncryptedFile` 逐字节一致）。
 *
 * 与那份的差别只有来源：那边读盘上的文件、这边读上游的响应流，所以块边界要自己攒
 * （`pending` 不到一块就等下一段）。空导出也给一块，否则 App 分不清「这份是空的」与
 * 「一个字节都没收到」。
 */
async function pipeEncrypted(req, res, source) {
  const e2ee = require('../shared/e2ee');
  const opened = req.__dshE2ee;
  const path0 = signedPath(req);
  const requestNonce = opened.req.nonce;
  let seq = 0;
  let pending = Buffer.alloc(0);
  let closed = false;
  res.on('close', () => { closed = true; });
  // 整段都在 try 里：状态码已经发出去了，此后任何一步抛错都只能断开连接。
  try {
    for await (const chunk of source) {
      if (closed) break;
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (pending.length >= FILE_CHUNK_BYTES) {
        const block = pending.subarray(0, FILE_CHUNK_BYTES);
        pending = pending.subarray(FILE_CHUNK_BYTES);
        seq += 1;
        writeBlock(res, e2ee, opened.keys.down, block, e2ee.fileAad(path0, requestNonce, seq));
      }
    }
    if (!closed) {
      seq += 1;
      writeBlock(res, e2ee, opened.keys.down, pending, e2ee.fileAad(path0, requestNonce, seq));
      res.end();
    }
  } catch {
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/** 写一块：`[4 字节长度][nonce][密文+tag]`，长度写的是「密文 + tag」那一段。 */
function writeBlock(res, e2ee, key, block, aad) {
  const sealed = Buffer.from(e2ee.seal(key, block, aad));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(sealed.length - e2ee.NONCE_BYTES, 0);
  res.write(Buffer.concat([head, sealed]));
}

module.exports = { handleSessionLog, sessionLogZipFilename };

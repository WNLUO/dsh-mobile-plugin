'use strict';

/**
 * 交付文件的字节（POST /api/mobile/v1/session/file）。
 *
 * 轮尾那张「交付文件」卡在桌面上点一下就打开；手机上没有那条路，App 必须先取回字节。
 *
 * 三条边界：
 * 1. 放行面 = 本会话工作区里的文件 ∪ 本会话 present 声明过的路径。前者判「解析后的落点是否
 *    在 cwd 之下」，`../x` 落在外面就退回白名单，不在声明里就 403；后者是字符串全等的显式
 *    声明，用于工作区之外的文件。放开工作区不等于能读这台电脑上的任意文件。
 * 2. 相对路径按会话工作区解析：cwd 取自会话列表摘要；没有 cwd 的会话只能走 present 白名单。
 * 3. 流式回写，不在插件进程里缓冲：几十 MB 的录屏不该整包躺在内存里。
 *
 * 两种失败分开：两条口子都不认就 403（`outside-workspace`），认了但盘上没了回 404（`missing`）。
 */

const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { signedPath } = require('../shared/e2ee-request');
const { FILE_CHUNK_BYTES, writeChunk } = require('../shared/e2ee-chunks.js');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { cwdOf } = require('./session-cwd.js');
const { presentedPathsOf } = require('./history-derive.js');

/** 单文件上限：手机内存与中转链路都不适合再大的东西（超出如实报 413）。 */
const SESSION_FILE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 找声明时读的历史窗口。宿主 history 按**消息条数**取尾页；交付声明挂在消息上，
 * 所以窗口要盖得住「用户还能滚到的那几屏」。取不到更早的声明就回 403，让 App 说清。
 */
const PRESENTED_WINDOW_MESSAGES = 600;

/** 扩展名 → 内容类型：App 用不到全部，但 `<video>` / `<img>` 这类要看它。 */
const MEDIA_TYPES = Object.freeze({
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html',
});

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'csv', 'tsv', 'html', 'htm', 'css',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini',
  'conf', 'sql', 'xml', 'svg', 'patch', 'diff',
]);

/** 取扩展名（小写、不含点）；没有扩展名回空串。 */
function extensionOf(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot <= 0 || dot === filePath.length - 1) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

/** 回给响应的内容类型：认得出的按表，认不出的按扩展名落 text/* 或 octet-stream。 */
function mediaTypeOf(filePath) {
  const ext = extensionOf(filePath);
  if (MEDIA_TYPES[ext]) return MEDIA_TYPES[ext];
  if (TEXT_EXTENSIONS.has(ext)) {
    // json / csv / html 在表里已经定死了，走到这里的是其余纯文本。
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

/**
 * content-disposition 的文件名：头里只能放 ASCII，中文名按 RFC 5987 的 `filename*`
 * 另给一份。App 侧并不读它（卡片上本来就有文件名），留着是为了别人抓包时能认出是哪份。
 */
function dispositionOf(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 一条会话里 present 声明过的全部路径（历史窗口内）。 */
async function declaredPathsOf(ctx, sessionId) {
  const { value, error } = unwrap(await callSessions(ctx, 'history', {
    sessionId,
    maxMessages: PRESENTED_WINDOW_MESSAGES,
  }));
  if (error) throw Object.assign(new Error(error.message || '读会话历史失败'), { code: error.code });
  return presentedPathsOf((value && value.events) || []);
}

/**
 * 落点在不在工作区里。
 *
 * `path.relative` 出来是空的（就是 cwd 本身）或者以 `..` 开头（爬出去了）都算不在，
 * 这样 `../x`、`a/../../x` 这些写法一并挡住 —— 判的是**解析后的真实落点**，不是输入字符串，
 * 所以「看起来没写过 ..」最终指到外面的路径同样过不去。
 */
function isInsideWorkspace(cwd, target) {
  if (!cwd) return false;
  const rel = path.relative(path.resolve(cwd), target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * POST { sessionId, path } → 该文件的原始字节。
 *
 * @param {object} ctx 插件上下文
 * @param {object} req node:http IncomingMessage
 * @param {object} res node:http ServerResponse
 */
async function handleSessionFile(ctx, req, res) {
  const body = await readJsonBody(req);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const declared = body && typeof body.path === 'string' ? body.path : '';
  if (!sessionId || !declared) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, path }' } });
  }

  // 先把落点算出来：工作区那一侧判的是**解析后的真实路径**，不是输入字符串。
  const cwd = await cwdOf(ctx, sessionId);
  let target = path.isAbsolute(declared) ? path.resolve(declared) : '';
  if (!target && cwd) target = path.resolve(cwd, declared);

  // 工作区里的文件直接放行，一次历史都不读 —— 这是正文里点的链接走的那条路。
  if (!target || !isInsideWorkspace(cwd, target)) {
    // 工作区之外只剩交付声明这一条口子（绝对路径、或 cwd 变了的老会话）。
    let declaredPaths;
    try {
      declaredPaths = await declaredPathsOf(ctx, sessionId);
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        error: { code: 'history-failed', message: String((error && error.message) || error) },
      });
    }
    if (!declaredPaths.has(declared)) {
      return sendJson(res, 403, {
        ok: false,
        error: { code: 'outside-workspace', message: '这个路径不在本会话的工作区里，手机上打不开' },
      });
    }
    if (!target) {
      return sendJson(res, 409, {
        ok: false,
        error: { code: 'no-cwd', message: '这条会话没有工作区目录，没法解析相对路径' },
      });
    }
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '文件已经不在这台电脑上了' } });
  }
  if (!info.isFile()) {
    return sendJson(res, 400, { ok: false, error: { code: 'not-a-file', message: '这条路径不是一个文件' } });
  }
  if (info.size > SESSION_FILE_MAX_BYTES) {
    return sendJson(res, 413, {
      ok: false,
      error: { code: 'too-large', message: '这个文件太大，手机这边不支持整份取回' },
    });
  }

  const name = path.basename(target);
  const header = {
    'content-type': mediaTypeOf(target),
    'content-disposition': dispositionOf(name),
    'cache-control': 'no-store',
  };

  // 协议 v2：分块信封（§8.3(6)）。
  //
  // 套一次性 AEAD 意味着宿主得先把整份读进内存 —— 单文件上限 512MB，那条路不能走。
  // 所以改成固定分块流式写：宿主仍然边读边发，内存占用还是一块的大小；App 那边按长度字段
  // 切块、逐块解即可，不需要流式解密栈。
  const opened = req && req.__dshE2ee;
  if (opened && opened.keys && opened.req) {
    res.writeHead(200, {
      ...header,
      'content-type': 'application/x-dsh-e2ee-chunks',
      // **给长度，不发分块**（2026-10-30）：加密后这份响应有多长是算得出来的（见
      // `encryptedLengthOf`），而不给长度的代价很具体 —— 客户端只能「流到哪儿算哪儿」地判
      // 收没收完，Android 那个原生下载器更是按「实收字节数 == content-length」判，
      // 分块响应在它那儿一律判成 `Download interrupted.`，手机上就是「点开文件说网络断了」。
      // 长度顺带还是这份分块信封自己的完整性凭据：被截断的字节数一定对不上。
      'content-length': String(encryptedLengthOf(info.size)),
      // 原文件的字节数：中转有时会把 `content-length` 吞掉（改成分块），而客户端要靠它
      // 判「这份到底收全没有」—— 分块信封自己的认证判不出「正好在块边界被截断」那种。
      'x-dsh-file-size': String(info.size),
      'x-dsh-proto': '2',
      // 真实类型单独给：App 解密之后要拿它决定怎么预览。
      'x-dsh-content-type': header['content-type'],
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
    // 已经写出 200，改不了状态码，只能断开让对端按截断处理（与会话日志导出一致）。
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/**
 * 按块加密写出去（§8.3(6)）。
 *
 * 每块形状：`[4 字节大端长度][12 字节 nonce][密文 + 16 字节 tag]`，长度字段写的是
 * **「密文 + tag」的长度**（不含 nonce 与长度字段本身）。块大小 64KB，最后一块可以更短。
 *
 * AAD 绑这条请求的路径、请求 nonce 与块序号 —— 块序号让中转不能把别的文件（或这一份的
 * 别的块）的字节搬进来，也不能重排或截断而让 App 察觉不到。
 */
async function writeEncryptedFile(req, res, target, opened) {
  const e2ee = require('../shared/e2ee');
  const requestNonce = opened.req.nonce;
  let seq = 0;
  let pending = Buffer.alloc(0);
  let closed = false;
  res.on('close', () => { closed = true; });
  // **整段都在 try 里**：调用点已经 `writeHead(200)` 过了，此后任何一步抛错都改不了状态码，
  // 而 `sendJson` 再想写一个 500 只会撞上「头已发出」被静默吞掉 —— 响应就永远不结束，
  // 手机上表现成「下载中」一直转、首字节等到超时。所以只能主动断开，让对端按截断处理。
  try {
    const path0 = signedPath(req);
    const stream = fs.createReadStream(target, { highWaterMark: FILE_CHUNK_BYTES });
    for await (const chunk of stream) {
      if (closed) break;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FILE_CHUNK_BYTES) {
        const block = pending.subarray(0, FILE_CHUNK_BYTES);
        pending = pending.subarray(FILE_CHUNK_BYTES);
        seq += 1;
        writeChunk(res, opened.keys.down, block, e2ee.fileAad(path0, requestNonce, seq));
      }
    }
    // 尾块（可能不足一块）；空文件也给一块，否则 App 拿不到「这是个空文件」的确认。
    if (!closed) {
      seq += 1;
      writeChunk(res, opened.keys.down, pending, e2ee.fileAad(path0, requestNonce, seq));
    }
    if (!closed) res.end();
  } catch {
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

/** 一块除明文字节之外还带多少：`[4 字节长度][12 字节 nonce][16 字节 tag]`。 */
const FILE_BLOCK_OVERHEAD = 4 + 12 + 16;

/**
 * 一份文件按块加密之后在网上会有多少字节。
 *
 * 块数 = `floor(size / FILE_CHUNK_BYTES)` 个满块 + **永远存在的那一块尾块**（空文件也要一块）：
 * 这个数在写之前就得用（响应头的 `content-length`），所以它必须与写块那份逐字对得上 —— 后果
 * 不对称：算少了对端读不满、算多了对端一直等，两种都是「文件打不开」。
 */
function encryptedLengthOf(size) {
  const plain = Math.max(0, Number(size) || 0);
  return plain + (Math.floor(plain / FILE_CHUNK_BYTES) + 1) * FILE_BLOCK_OVERHEAD;
}

module.exports = {
  handleSessionFile,
  SESSION_FILE_MAX_BYTES,
  FILE_CHUNK_BYTES,
  writeEncryptedFile,
  encryptedLengthOf,
};

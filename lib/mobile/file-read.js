'use strict';

/**
 * 按路径读文件（POST /api/mobile/v1/file/read）：右栏文件浏览器「点开一个文件」。
 *
 * 与 `/session/file` 的分工：那条服务的是**交付**（卡片、正文里的文件链接），放行面是
 * 「本会话工作区 ∪ 本轮 present 声明过的路径」；右栏能一路翻到别的已登记工作区，手里的
 * 就是一串路径，所以这条按 `allowed-zone.js` 判：宿主已登记的工作区 ∪ 当前会话的项目目录。
 *
 * 三条边界：
 * 1. `path` 必须是绝对路径 —— 这条路由没有可信的解析基准，相对路径直接 400，不去猜谁当基准。
 *    判定用的是 resolve 之后的落点，`..` 爬出允许区一律不认（403 `outside-allowed`）。
 * 2. 认出允许区之后的失败分开报：盘上没有 404 `missing`、不是普通文件 400 `not-a-file`、
 *    超过 512MB 413 `too-large`。码与文案跟 `/session/file` 同一套，App 那边一套分支就够。
 * 3. 字节流式回写，不在插件进程里缓冲。协议 v2 的分块信封**直接调 `/session/file` 那个写入
 *    函数**：两边抄一份形状必然漂，而漂了的症状是「手机上永远下载中」，没有报错。
 */

const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { sendJson, readJsonBody } = require('../shared/http-util');
const { allowedRoots, inAllowedZone } = require('./allowed-zone.js');
const { writeEncryptedFile, SESSION_FILE_MAX_BYTES } = require('./session-file.js');

/**
 * 扩展名 → 内容类型。与 `session-file.js` 那张表逐条相同：两条路给同一个文件必须给出同一个
 * `content-type`，否则 App 那边「按类型决定怎么预览」的分支会看端点选，等于多一种行为。
 */
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

/** 回给响应的内容类型：认得出的按表，认不出的按扩展名落文本或 octet-stream。 */
function mediaTypeOf(filePath) {
  const ext = extensionOf(filePath);
  if (MEDIA_TYPES[ext]) return MEDIA_TYPES[ext];
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * `content-disposition` 的文件名：头里只能放 ASCII，中文名按 RFC 5987 另给一份
 * `filename*`。App 不读它（文件名它自己有），留着是给别人抓包时认人用的。
 */
function dispositionOf(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * POST { path（绝对）, sessionId? } → 该文件的原始字节。
 *
 * @param {object} ctx 插件上下文
 * @param {object} req node:http IncomingMessage
 * @param {object} res node:http ServerResponse
 */
async function handleFileRead(ctx, req, res) {
  const body = await readJsonBody(req);
  const declared = body && typeof body.path === 'string' ? body.path.trim() : '';
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!declared) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { path }（绝对路径）' } });
  }
  if (!path.isAbsolute(declared)) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-request', message: 'path 必须是绝对路径' },
    });
  }
  const target = path.resolve(declared);

  let roots;
  try {
    roots = await allowedRoots(ctx, sessionId);
  } catch (error) {
    // 宿主那句原话回给手机：这条路上「没取到」与「你没有这个目录」必须分得开。
    return sendJson(res, 502, {
      ok: false,
      error: {
        code: (error && error.code) || 'workspace-list-failed',
        message: String((error && error.message) || error),
      },
    });
  }
  if (!inAllowedZone(roots, target)) {
    return sendJson(res, 403, {
      ok: false,
      error: { code: 'outside-allowed', message: '这个文件不在能看的范围里（只放行工作区目录和这条会话的项目目录）' },
    });
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

  const header = {
    'content-type': mediaTypeOf(target),
    'content-disposition': dispositionOf(path.basename(target)),
    'cache-control': 'no-store',
  };

  // 协议 v2：与 `/session/file` 逐字节同形（`x-dsh-content-type` 带明文类型、chunked，
  // 真实类型单独给一份让 App 解密后决定怎么预览）。
  const opened = req && req.__dshE2ee;
  if (opened && opened.keys && opened.req) {
    res.writeHead(200, {
      ...header,
      'content-type': 'application/x-dsh-e2ee-chunks',
      'transfer-encoding': 'chunked',
      'x-dsh-proto': '2',
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
    // 头已经发出去了，改不了状态码，只能断开让对端按截断处理。
    try { res.destroy(); } catch { /* 连接已关闭 */ }
  }
}

module.exports = { handleFileRead, mediaTypeOf };

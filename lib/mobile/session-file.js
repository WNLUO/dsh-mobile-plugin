'use strict';

/**
 * 交付文件的字节（POST /api/mobile/v1/session/file）。
 *
 * 轮尾那张「交付文件」卡在桌面上点一下就用系统默认程序打开；手机上没有那条路 ——
 * 文件在电脑上，宿主只给了路径，App 必须先取回字节。这条路由就是那条通道。
 *
 * 三条边界同时成立：
 *
 *  1. **只认本会话 present 声明过的路径**：`deliverables/presented` 是模型显式交出来的
 *     那份清单，App 卡片上的每一格都来自它。别把它放宽成「会话工作区里的任意文件」——
 *     移动 API 不暴露任意读，与它不暴露 shell / 任意写入是同一条边界。路径按**字符串
 *     全等**比对声明，所以不存在穿越。
 *  2. **相对路径按会话工作区解析**：声明里既可能是 `src/x.png` 也可能是绝对路径，
 *     相对的那一种只能相对 cwd 解析（cwd 取自会话列表摘要，与 /session 同一个来源）。
 *  3. **流式回写、不在插件进程里缓冲**：几十 MB 的录屏不该整包躺在内存里，与会话日志
 *     导出同一个理由。
 *
 * 取不到时两种失败要分得开：不在声明里回 403（`not-presented`），声明里有、盘上没了
 * 回 404（`missing`）—— 前者是「这一格不该出现」，后者是「文件被挪走了」，文案不同。
 */

const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
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

/** 会话的工作区目录（相对路径的解析基准）。取不到就回空串，由调用方决定怎么办。 */
async function cwdOf(ctx, sessionId) {
  try {
    const { value } = unwrap(await callSessions(ctx, 'list', {}));
    const items = (value && value.items) || [];
    const row = items.find((item) => item && item.sessionId === sessionId);
    return row && typeof row.cwd === 'string' ? row.cwd : '';
  } catch {
    return '';
  }
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
      error: { code: 'not-presented', message: '这个文件不在本会话的交付声明里' },
    });
  }

  let target;
  if (path.isAbsolute(declared)) {
    target = declared;
  } else {
    const cwd = await cwdOf(ctx, sessionId);
    if (!cwd) {
      return sendJson(res, 409, {
        ok: false,
        error: { code: 'no-cwd', message: '这条会话没有工作区目录，没法解析相对路径' },
      });
    }
    target = path.join(cwd, declared);
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
  res.writeHead(200, {
    'content-type': mediaTypeOf(target),
    'content-length': String(info.size),
    'content-disposition': dispositionOf(name),
    'cache-control': 'no-store',
  });
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

module.exports = { handleSessionFile, SESSION_FILE_MAX_BYTES };

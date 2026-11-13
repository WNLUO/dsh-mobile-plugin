'use strict';

/**
 * 把这一轮的回答直接落成文件：`POST /api/mobile/v1/session/write-body`。
 *
 * 由来：右栏那三条写路由（`file-ops.js` 的 create / rename / delete）只够建一个空文件、
 * 改个名字、删掉；要「把这段回答存成 .md」就只能先在电脑上开个文件再自己贴进去。这条补的是
 * 最后那一格：**带正文落盘**。
 *
 * 四条口径：
 * 1. **不做二次模型调用**。正文由 App 原样带上来（当前这轮的回答），插件不摘要、不重排、
 *    不换格式 —— 手机上看到的字和文件里的字必须逐字一致，否则「落成文件」就是另写一份。
 * 2. **落点判定与三条写路由同一份**：`file-ops.js` 的 `preparePath`（允许区 = 宿主已登记的
 *    工作区 ∪ 这条会话的项目目录，`realpath` 挡软链逃逸），落盘走同一段 `writeContentAt`
 *    （按项目串行、判重、拒符号链接与目录）。不另抄一份，能力面没有放宽。
 * 3. **相对路径按会话工作区解析**：App 从右栏进来时手上是绝对路径；从对话里进来时只有一个
 *    文件名，这时用会话自己的 cwd 拼。没有 cwd 又没有绝对路径就 409，让界面说清「这条会话
 *    没有目录」。
 * 4. **`format` 只定类型，不改字**。`markdown` / `text` 决定回包里的 `mediaType`（App 拿它
 *    挑默认扩展名与打开方式），正文怎么写进盘就是传上来的样子；也**不**替调用方补扩展名 ——
 *    路径是调用方选好的那一个，插件不偷偷改名。
 *
 * 与 `file/create` 的关系：那条是「新建一个空文件 / 覆盖成给定内容」的通用写入口，这条是
 * 「回答落成文件」这一个动作的成形 handler（字段更少、正文必填、带格式）。两者共用落点与
 * 落盘实现，差别只在请求形状。
 */

const path = require('node:path');

const { readJsonBody } = require('../shared/http-util');
const { cwdOf } = require('./session-cwd.js');
const { FILE_MAX_CONTENT_BYTES, preparePath, sendError, writeContentAt } = require('./file-ops.js');

/** 请求体上限：正文就是那一段回答，比落盘上限多给一圈给其余几格与 JSON 转义。 */
const BODY_MAX_BYTES = FILE_MAX_CONTENT_BYTES + 64 * 1024;

/** 格式 → 内容类型。`format` 只在这一格起作用（见文件头第 4 条）。 */
const MEDIA_TYPE_BY_FORMAT = Object.freeze({
  markdown: 'text/markdown; charset=utf-8',
  text: 'text/plain; charset=utf-8',
});

/** 没给 `format` 时按纯文本：markdown 的渲染与扩展名是调用方显式选的，不替它猜。 */
const DEFAULT_FORMAT = 'text';

/**
 * POST /api/mobile/v1/session/write-body
 * body { sessionId, path（绝对，或相对会话工作区）, content, format?, overwrite? }
 *
 * @param {object} ctx 插件上下文
 * @param {object} req node:http IncomingMessage
 * @param {object} res node:http ServerResponse
 */
async function handleSessionWriteBody(ctx, req, res) {
  const body = (await readJsonBody(req, BODY_MAX_BYTES)) || {};
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return sendError(res, 400, 'bad-request', '需要 { sessionId, path, content }');
  }

  const declared = typeof body.path === 'string' ? body.path.trim() : '';
  if (!declared) {
    return sendError(res, 400, 'bad-request', '需要落成的路径（绝对路径，或相对会话工作区）');
  }

  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null) {
    return sendError(res, 400, 'invalid-content', 'content 必须是字符串');
  }

  const format = body.format === undefined || body.format === null ? DEFAULT_FORMAT : body.format;
  if (!Object.prototype.hasOwnProperty.call(MEDIA_TYPE_BY_FORMAT, format)) {
    return sendError(res, 400, 'invalid-format', 'format 只能是 markdown 或 text');
  }

  // 相对路径按这条会话的项目目录解析：没有 cwd 就拼不出来，也不能拿插件进程的 cwd 顶替。
  let absolute = declared;
  if (!path.isAbsolute(absolute)) {
    const cwd = await cwdOf(ctx, sessionId);
    if (!cwd || !path.isAbsolute(cwd)) {
      return sendError(res, 409, 'no-cwd', '这条会话没有工作区目录，落点要给绝对路径');
    }
    absolute = path.resolve(cwd, declared);
  }

  const prepared = await preparePath(ctx, { path: absolute, sessionId }, res);
  if (!prepared) return;

  await writeContentAt(prepared, body, content, res, {
    format,
    mediaType: MEDIA_TYPE_BY_FORMAT[format],
  });
}

module.exports = {
  MEDIA_TYPE_BY_FORMAT,
  DEFAULT_FORMAT,
  handleSessionWriteBody,
};

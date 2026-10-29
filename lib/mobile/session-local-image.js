'use strict';

/**
 * 正文图的字节（POST /api/mobile/v1/session/local-image）。
 *
 * 正文里那张图在历史投影时已经被登记成一个短编号（见 `local-images.js`），手机画到它时
 * 拿着编号来取字节。**这不是「按路径读文件」**：只认登记表里的编号，构造一个编号读不到
 * 任何别的文件 —— 能力面与附件那条 `session/attachment` 同一个口径。
 *
 * 只认 `id`、不认 sessionId：授权依据是「这张图在投影这条会话时被登记过」，而不是调用方
 * 自报的会话号。登记表是进程级的，同一个编号从哪条会话取都一样（本来就是同一份文件）。
 *
 * 回 base64 JSON 而不是流：正文图都是单张位图、上限 2.5MB，与附件那条一致；大文件
 * （视频 / 交付物）走 `session/file` 的流式那条，别混。
 */

const fs = require('node:fs/promises');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { localImageOf } = require('./local-images.js');

async function handleSessionLocalImage(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.id !== 'string' || !body.id) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { id }' } });
  }
  const entry = localImageOf(body.id);
  // 插件重启、或那条记录被挤出登记表：如实 404，让 App 把重试按钮的失败说清楚。
  if (!entry) {
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这张图没有登记，或登记已失效' } });
  }
  let data;
  try {
    data = await fs.readFile(entry.filePath);
  } catch {
    return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '图片文件已经不在了' } });
  }
  sendJson(res, 200, {
    ok: true,
    mediaType: entry.mediaType,
    data: data.toString('base64'),
    ...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {}),
  });
}

module.exports = { handleSessionLocalImage };

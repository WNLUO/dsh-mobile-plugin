// 媒体任务只读快照与已收存原件的受控取字节口；不接受任意路径。
'use strict';
const { stat } = require('node:fs/promises');
const { sendJson, readJsonBody } = require('../../shared/http-util.js');
const { sendFileBytes, dispositionOf, SESSION_FILE_MAX_BYTES } = require('../session-file.js');
const { publicTask } = require('./contract.js');
const PARAM_MAX = 200;
function mediaRoutes(service) {
  async function handleTasks(_ctx, req, res) {
    const sessionId = (new URL(req.url, 'http://x').searchParams.get('sessionId') || '').trim();
    if (!sessionId || sessionId.length > PARAM_MAX) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 sessionId' } });
    try { sendJson(res, 200, { ok: true, ...service.snapshot(sessionId) }); }
    catch (error) { sendJson(res, 500, { ok: false, error: { code: 'media-store', message: String(error.message || error) } }); }
  }
  async function handleFile(_ctx, req, res) {
    const body = await readJsonBody(req);
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
    if (!sessionId || !taskId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, taskId }' } });
    let task;
    try { task = service.get(sessionId, taskId); }
    catch (error) { return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: String(error.message || error) } }); }
    const file = body?.variant === 'preview' ? task.preview : task.original;
    if (!file || !file.filePath) return sendJson(res, 404, { ok: false, error: { code: 'not-ready', message: '这份媒体还没有收存完成' } });
    let info;
    try { info = await stat(file.filePath); }
    catch { return sendJson(res, 404, { ok: false, error: { code: 'missing', message: '收存的媒体文件已经不在了' } }); }
    if (!info.isFile()) return sendJson(res, 400, { ok: false, error: { code: 'not-a-file', message: '这份媒体不是普通文件' } });
    if (info.size > SESSION_FILE_MAX_BYTES) return sendJson(res, 413, { ok: false, error: { code: 'too-large', message: '媒体文件太大，手机这边不支持整份取回' } });
    await sendFileBytes(req, res, { target: file.filePath, size: info.size,
      header: { 'content-type': file.mediaType || 'application/octet-stream', 'content-disposition': dispositionOf(file.name || 'media'), 'cache-control': 'no-store' },
      rawOffset: body && body.offset });
  }
  return { handleTasks, handleFile };
}
module.exports = { mediaRoutes, publicTask };

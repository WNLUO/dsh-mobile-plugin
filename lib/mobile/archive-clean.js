'use strict';

/**
 * 移动端「清理所有已归档的对话」：按宿主归档集合确定清理范围，把它们排进待删队列。
 *
 * 以 workspace.list 的 archivedSessionIds 为清理范围，不用可能过时的列表状态缩小范围；
 * 请求必须显式带 confirm: true —— 磁盘删除不可恢复，手机端「少点一次」不值得把它变成滑一下就没了的动作。
 *
 * **这里不删磁盘**：只把 id 排进 session-cleanup.cjs 的待删队列，日志留到宿主下次启动时删
 * （见那个文件的 deleteQueuedArchivedSessions）。宿主没有「删除会话」接口，进程活着的时候
 * 它随时可能去打开那些文件 —— 文件不在就是一次未捕获的 ENOENT，宿主整个退出、桌面端闪退
 * （2026-10-20 真机现场）。本进程只把 id 压进删除集，让手机列表立刻看不到它们。
 *
 * 也**不擦宿主的归档集合**：进程里擦会把桌面端快照里那些其实已经没有日志的行放回正常列表。
 * 归档集合的收尾同样在宿主启动时做，见 pruneOrphanedArchivedSessionsOnce。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { canonicalDeviceKey, rememberDeletedSessionIds } = require('./session-cache.js');
const { invalidateSessionList } = require('./sessions.js');
const { unwrap } = require('./envelope.js');
const { queueArchivedClearIds } = require('../session-cleanup.cjs');

/**
 * POST /api/mobile/v1/workspace/clear-archived（token）
 * body: { confirm: true } → { ok: true, deleted: N }。confirm 不为 true 一律 400。
 *
 * deleted = 这次被排进队列、手机上立刻消失的条数（含盘上早就没有数据的那些）；日志要到
 * 宿主下次启动才真正从磁盘上消失。
 */
async function handleClearArchived(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  if (!body || body.confirm !== true) {
    sendJson(res, 400, { ok: false, error: { code: 'confirm-required', message: '清理已归档会话不可恢复，请求需要带 confirm: true' } });
    return;
  }
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    // 归档集合是清理范围的唯一依据；列表摘要里的 running / blank 可能过时，也不应缩小「全部归档」的范围。
    const workspaceResponse = unwrap(await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} }));
    if (workspaceResponse.error) {
      return { status: 400, body: { ok: false, error: { ...workspaceResponse.error, message: `workspace.list 失败：${workspaceResponse.error.message || workspaceResponse.error.code || '未知错误'}` } } };
    }
    const archivedIds = Array.isArray(workspaceResponse.value?.archivedSessionIds) ? workspaceResponse.value.archivedSessionIds : [];
    const selected = archivedIds.filter((id) => typeof id === 'string' && id);
    if (selected.length === 0) return { status: 200, body: { ok: true, deleted: 0 } };
    // 排不进队列就整次失败（路由回 500）：回「已清理」却没排上，重启之后它们原样回来。
    queueArchivedClearIds(selected);
    // 宿主那份快照可能还带着它们，先在本进程压住：手机列表与归档列表立刻看不到。
    rememberDeletedSessionIds(ctx, selected);
    // 不立刻失效的话，最长 10 秒还能点到已删的行。
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, deleted: selected.length } };
  });
  sendJson(res, outcome.status, outcome.body);
}

module.exports = { handleClearArchived };

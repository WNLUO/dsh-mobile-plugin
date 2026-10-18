'use strict';

/**
 * 移动端「清理所有已归档的对话」：按宿主归档集合确定清理范围，并删掉它们的日志。
 *
 * 以 workspace.list 的 archivedSessionIds 为清理范围，不用可能过时的列表状态缩小范围；
 * 请求必须显式带 confirm: true —— 磁盘删除不可恢复，手机端「少点一次」不值得把它变成滑一下就没了的动作。
 *
 * 删除动作不重写：读日志 header.id → 删会话目录 + 投影缓存只在 session-cleanup.cjs 里存在
 * （见地图 A3-17），这里只是把它的触发面从 agent 工具扩到移动端路由。
 *
 * **这里不擦宿主的归档集合**（只把删掉的 id 记进本进程的删除集，挡住手机端列表里可能
 * 还没失效的旧快照）。进程里擦集合会把桌面端那份会话列表快照里、其实已经删掉的行放回
 * 正常列表——桌面端用户看到的就是「清理完它们又回来了，重启 DSH 才真的消失」。归档集合
 * 的收尾放在宿主启动时做，见 session-cleanup.cjs 的 pruneOrphanedArchivedSessionsOnce。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { canonicalDeviceKey, rememberDeletedSessionIds, deletedSessionIdsOf } = require('./session-cache.js');
const { invalidateSessionList } = require('./sessions.js');
const { unwrap } = require('./envelope.js');
const { deleteSessionData, sessionIdsWithoutAnyData } = require('../session-cleanup.cjs');

/**
 * POST /api/mobile/v1/workspace/clear-archived（token）
 * body: { confirm: true } → { ok: true, deleted: N }。confirm 不为 true 一律 400。
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
    const removed = await deleteSessionData(selected);
    // 删的是列表里可见的行：手机端正开着列表，宿主那份快照可能还带着它们，先在本进程压住。
    // 盘上已经没有数据的归档 id 一并压住：上一次删到一半抛错时，已删的那批没记进删除集，
    // 宿主的进程内清单却还挂着它们 —— 不补记的话再点清理只回 0，手机上永远清不掉。
    const already = deletedSessionIdsOf(ctx);
    const cleared = new Set(removed);
    for (const id of sessionIdsWithoutAnyData(selected)) if (!already.has(id)) cleared.add(id);
    rememberDeletedSessionIds(ctx, cleared);
    // 不立刻失效的话，最长 10 秒还能点到已删的行。
    invalidateSessionList(ctx);
    return { status: 200, body: { ok: true, deleted: cleared.size } };
  });
  sendJson(res, outcome.status, outcome.body);
}

module.exports = { handleClearArchived };

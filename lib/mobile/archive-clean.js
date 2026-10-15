'use strict';

/**
 * 移动端「清理所有已归档的对话」：按宿主归档集合确定清理范围，并交由落地函数删除。
 *
 * 以 workspace.list 的 archivedSessionIds 为清理范围，不用可能过时的列表状态缩小范围；
 * 请求必须显式带 confirm: true —— 磁盘删除不可恢复，手机端「少点一次」不值得把它变成滑一下就没了的动作。
 *
 * 删除动作不重写：读日志 header.id → 删会话目录 + 投影缓存 → 擦归档集合这套只在 session-cleanup.cjs
 * 里存在（见地图 A3-17），这里只是把它的触发面从 agent 工具扩到移动端路由。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const {
  canonicalDeviceKey,
  rememberDeletedSessionIds,
  pendingUnarchiveSessionIdsOf,
  clearPendingUnarchiveSessionIds,
} = require('./session-cache.js');
const { invalidateSessionList } = require('./sessions.js');
const { unwrap } = require('./envelope.js');
const { deleteSessionData, forgetArchivedSessions } = require('../session-cleanup.cjs');

/**
 * POST /api/mobile/v1/workspace/clear-archived（token）
 * body: { confirm: true } → { ok: true, deleted: N, unarchiveFailedSessionIds }。confirm 不为 true 一律 400。
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
    if (selected.length === 0) return { status: 200, body: { ok: true, deleted: 0, archivedSessionIds: archivedIds } };
    // 顺序是**先删日志、再擦归档集合**。删日志才是用户要的那件事，擦集合只是收尾。
    //
    // 反过来（先擦后删）曾导致用户报的现象：擦归档是逐条 RPC，中途任何一条失败或链路超时，
    // 日志一份没删、名字却已经从归档集合里消失——会话退回普通列表，看着像「清理只是把它
    // 移出了归档」，必须重启桌面端才恢复。先删就没这个窗口：日志没了就是**真的清理掉了**，
    // 立刻生效、不必等桌面端重启；擦集合失败最多在「已归档」里留一行点不开的死行，
    // 重试一次即可，不会让操作白做。
    //
    // 擦集合是 best-effort：它失败**不**让整条清理报错（日志已经删成功，报错等于骗用户）。
    const removed = await deleteSessionData(selected);
    rememberDeletedSessionIds(ctx, removed);
    const pendingUnarchive = pendingUnarchiveSessionIdsOf(ctx);
    const retryable = [...new Set(selected)].filter((id) => pendingUnarchive.has(id));
    const failedToUnarchive = await forgetArchivedSessions(ctx, retryable, 'mobile');
    const failed = new Set(failedToUnarchive);
    clearPendingUnarchiveSessionIds(ctx, retryable.filter((id) => !failed.has(id)));
    // 删的是列表里可见的行：手机端正开着列表，不立刻失效最长 10 秒还能点到死行。
    invalidateSessionList(ctx);
    // 只从返回的归档集合中移除宿主确认已取消归档的 ID；失败项保留为重试候选。
    const cleared = new Set(retryable.filter((id) => !failed.has(id)));
    return {
      status: 200,
      body: {
        ok: true,
        deleted: removed.length,
        archivedSessionIds: archivedIds.filter((id) => !cleared.has(id)),
        unarchiveFailedSessionIds: failedToUnarchive,
      },
    };
  });
  sendJson(res, outcome.status, outcome.body);
}

module.exports = { handleClearArchived };

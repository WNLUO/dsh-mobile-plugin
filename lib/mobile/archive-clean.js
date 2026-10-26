'use strict';

/**
 * 移动端「清理所有已归档的对话」：按宿主归档集合确定范围，把它们排进待删队列。
 *
 * 范围取 workspace.list 的 archivedSessionIds，不用可能过时的列表状态缩小范围；请求必须
 * 显式带 confirm: true，磁盘删除不可恢复。
 *
 * 这里不删磁盘，也不擦宿主的归档集合：只把 id 排进 session-cleanup.cjs 的待删队列，由宿主
 * 下次启动时删。活着的宿主随时可能去打开那些文件，文件不在就是一次未捕获的 ENOENT，会带走
 * 整个进程。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { canonicalDeviceKey, rememberDeletedSessionIds } = require('./session-cache.js');
const { invalidateSessionList } = require('./sessions.js');
const { unwrap } = require('./envelope.js');
const { collectStats } = require('./stats-collect.cjs');
const { queueArchivedClearIds } = require('../session-cleanup.cjs');

/**
 * 清理前这次补采的预算。
 *
 * 统计页只给 1.5 秒是为了别让用户转好久；清理是不可恢复的删除，值得多等几秒把账补全，
 * 但不能超过 App 单发请求的 8 秒总预算，否则手机先报超时、这边照旧执行。
 *
 * 这次补采跳过「最后一句」预览：那一步要读会话日志，是整轮最重的一趟。删日志前先把数字
 * 记住，比给即将消失的卡片多留一行摘要重要。
 */
const CLEAR_ARCHIVED_COLLECT_BUDGET_MS = 6_000;

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
    // 清理之前先把这批会话的用量最后采一次：之后再读它们的统计就没了（日志要删），
    // 而统计账本要保留历史 —— 漏掉这一刀，最后一段用量会凭空消失。
    // 采不上不挡清理：统计偏旧好过用户点不动这个按钮。
    try {
      await collectStats(ctx, {
        sessionIds: selected,
        force: true,
        budgetMs: CLEAR_ARCHIVED_COLLECT_BUDGET_MS,
        skipPreview: true,
      });
    } catch {
      /* 旁路 */
    }
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

module.exports = { handleClearArchived, CLEAR_ARCHIVED_COLLECT_BUDGET_MS };

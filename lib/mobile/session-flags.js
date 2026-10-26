'use strict';

/**
 * 会话行的两条共享判定：**哪些会话算这条设备的会话**、**它是不是在等人回话**。
 *
 * 抽出来的理由：`/sessions`（完整列表）与 `/monitor`（后台提醒的状态位视图）都要这两条，
 * 而两份各写一遍的坏处不是多写几行，是判据会分叉 —— 表现成「侧栏里根本没有这条会话，
 * 手机却为它响了一声」，或者「归档掉的会话还在后台提醒你」，从现象看不出是同一条判据
 * 分家。所以让两条路由问同一个函数。
 *
 * 依赖方向：本文件只依赖 envelope / approvals / questions，**不** require sessions.js
 * （否则 sessions.js 引它就成了环，见 module-split.test.cjs 的查环）。
 */

const { unwrap } = require('./envelope.js');
const approvals = require('./approvals.js');
const questions = require('./questions.js');

/**
 * 宿主的两个会话集合（同一次 `workspace.list` 快照里拿到）：
 *
 * - `archivedSessionIds`：已归档的会话。`sessions.list` 自身不过滤归档，移动端必须自己读，
 *   否则「归档」写成功了、列表却照旧把那一行发回手机。
 * - `pinnedSessionIds`：已置顶的会话。摘要里没有置顶字段，不读这份快照就画不出置顶标记、
 *   也排不到工作区最前。
 *
 * 两个集合合并成一次 RPC：同源同一次快照，而会话列表每 10 秒重建一次。取不到时都回空 ——
 * 宁可多显示几行，也不能因为一次 RPC 抖动让整个列表变空。
 */
async function workspaceSessionFlags(ctx) {
  try {
    const resp = await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} });
    const value = unwrap(resp).value;
    const idSetOf = (field) => new Set(
      value && Array.isArray(value[field]) ? value[field].filter(id => typeof id === 'string') : [],
    );
    return { archived: idSetOf('archivedSessionIds'), pinned: idSetOf('pinnedSessionIds') };
  } catch {
    return { archived: new Set(), pinned: new Set() };
  }
}

/**
 * 「这条会话是不是在等人回话」以及等的是什么。
 *
 * 宿主摘要里带就用它的（0.1.x / 桌面口径）；0.2.x 的宿主摘要**不带**这个字段（桌面上
 * 那个标记是桌面客户端自己算的），这时用两道桥的账 —— 少了这一条，手机在列表页连黄点
 * 都不会亮，后台也不会为「等你审批」响一声。审批优先：一次 turn 里审批总是挡在提问前面。
 */
function pendingInteractionOf(sessionId, summary) {
  const reported = summary && summary.pendingInteraction;
  if (reported === 'approval' || reported === 'plan-review' || reported === 'question') return reported;
  if (approvals.hasPending(sessionId)) return 'approval';
  return questions.pendingKind(sessionId);
}

module.exports = { workspaceSessionFlags, pendingInteractionOf };

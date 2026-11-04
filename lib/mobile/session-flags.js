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
 * 两个集合合并成一次 RPC：同源同一次快照，而会话列表每 10 秒重建一次。
 *
 * 取不到时两个集合都回空，另外带一个 `known: false`。调用方据此分两种口径：
 *
 * - **列表**（`/sessions`）按空集合画：宁可多显示几行，也不能因为一次 RPC 抖动让整个侧栏变空。
 * - **提醒**（`/monitor`）不许把「不知道」当成「没有归档」：那样一次抖动就会让已归档的会话
 *   重新进监控视图，被当成刚跑完再响一遍。所以那条路由另外用一本账（[archivedSessionIds]），
 *   记着最近一次真读到的归档集合，读不到就沿用它。
 */
async function workspaceSessionFlags(ctx) {
  try {
    const resp = await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} });
    const value = unwrap(resp).value;
    // 集合被人当成 Set 传过（宿主与本仓库两个来源形状不一样，dsh-devmap 专门归一化过），
    // 所以数组与 Set 都收：只认 `Array.isArray` 会让那一类宿主上的归档过滤恒失效。
    const idSetOf = (field) => {
      const raw = value && value[field];
      const list = Array.isArray(raw) ? raw : (raw instanceof Set ? [...raw] : null);
      return list ? new Set(list.filter(id => typeof id === 'string')) : null;
    };
    const archived = idSetOf('archivedSessionIds');
    // 判据只看归档那一格：置顶是画图用的，缺了顶多个图钉，不值得让它把归档判断一起拖死。
    const pinned = idSetOf('pinnedSessionIds') ?? new Set();
    if (!archived) return { archived: new Set(), pinned, known: false };
    return { archived, pinned, known: true };
  } catch {
    return { archived: new Set(), pinned: new Set(), known: false };
  }
}

/**
 * `/monitor` 用的归档集合：**只认读到的**，读不到就沿用上一次读到的那一份。
 *
 * 为什么不跟列表一样 fail-open：这条视图的作用是决定「要不要在后台叫醒人」，而它的判据是
 * 「这个会话还在不在清单里」。一次读不到就按空集合画，已归档的会话会重新进清单 —— 原生那边
 * 刚因为它消失而清了基线，于是它成了「第一次见到」，只要那一轮结束在十分钟内就再响一遍
 * （延迟多久取决于宿主的 RPC 超时，反复抖动就会反复响）。列表那边空一下只是多显示几行，
 * 这边空一下是半夜多叮一声，两种代价不是一个量级。
 *
 * 也刻意**不**回 5xx：README 那条规矩是「一拍什么都没取到就退回完整清单」，而这条 RPC
 * 在 0.2.0 宿主要现开 `workspace.follow` 取首帧（8 秒预算），失败率不低 —— 每失败一拍就
 * 让整个后台提醒哑掉，代价比偶尔多滤错一条大得多。沿用旧账的最坏结果是「刚归档的会话还在
 * 清单里挂一会儿」，而它挂着的那些拍，这条会话的 `completed` 还会按已读水位判，不会凭空响。
 *
 * 一本账都没有（进程刚起来就问不到）时退回空集合 —— 那时候原生手上也没有基线，
 * 首拍见到什么都只建基线、不提醒，所以空集合不会凭空造出一次提醒。
 */
const archivedSessionIds = { ids: null };

async function archivedSessionIdsForMonitor(ctx) {
  const { archived, known } = await workspaceSessionFlags(ctx);
  if (known) {
    archivedSessionIds.ids = archived;
    return archived;
  }
  return archivedSessionIds.ids ?? archived;
}

/** 仅供守卫重置进程内那本归档账。 */
function resetArchivedSessionIdsForTest() {
  archivedSessionIds.ids = null;
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

/**
 * 这条会话挂着的卡**本身**（推送帧原样），拿不到就 undefined。
 *
 * 给 `/monitor` 用：手机上那张「等你回答 / 等你审批」的卡只有一条来路 —— 实时流重新
 * 接上时插件的补发。回前台那条重连一旦落空（退避中、宿主把流收了、网络还没被采纳），
 * 卡就缺到用户切一次会话为止。后台轮询顺手把卡的内容一起带回去，回前台问原生就能取到，
 * 不必等网络。审批优先，与 `pendingInteractionOf` 同序 —— 两处判据分家会让「黄点写着
 * 审批、卡片却是提问」。
 *
 * 摘要自己带了 `pendingInteraction`（0.1.x / 桌面口径）时没帧可给：那时候的卡是宿主
 * 直接推的，本桥手上没有。
 */
function pendingCardOf(sessionId, summary) {
  const reported = summary && summary.pendingInteraction;
  if (reported === 'approval' || reported === 'plan-review' || reported === 'question') return undefined;
  return approvals.pendingCardOf(sessionId) || questions.pendingCardOf(sessionId);
}

module.exports = {
  workspaceSessionFlags,
  archivedSessionIdsForMonitor,
  resetArchivedSessionIdsForTest,
  pendingInteractionOf,
  pendingCardOf,
};

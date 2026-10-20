'use strict';

/**
 * GET /api/mobile/v1/monitor —— 安卓后台提醒服务专用的「状态位」视图（只读）。
 *
 * 为什么单开一条：那条前台服务活在 JS 之外（App 退到后台、进程被系统回收，只有它还在），
 * 所以「这一轮跑完了 / 跑挂了 / 停下来等你回话」只能由它自己定时去问。它此前问的是完整
 * 会话清单（`?fresh=1`），而那份清单为了画侧栏还捎着**最后一条消息预览** —— 预览要为最近
 * 20 个会话各读一次 history。后台每 8 秒白读 20 次日志，只为判断「completed 翻没翻」。
 *
 * 这条只回监控需要的那几格：在不在跑、刚完成没有、在等谁回话、上一轮是不是跑挂的、标题。
 * 并支持 `?rev=` 条件刷新：状态位与上次一模一样时回一句 `unchanged`，连 items 都不带
 * （稳态下这一发是几十字节）。
 *
 * 完成态仍以 completion 状态机为准，与 `/sessions` 用同一本账：常态下这里**不读 history**，
 * 只有「跑过、现在不在跑、结局还没定」的那几条才读一次 —— 那是唯一能把 failedTurn 折出来
 * 的地方（事件流漏帧时全靠它，见 completion.js 的坑）。
 *
 * 刻意不进 `/sessions`：那边一旦按调用方分叉视图，镜像推送与 App 的写后刷新也会跟着
 * 受影响，而这两条都要求「一份完整清单」。分路由比加参数安全。
 */

const { sendJson } = require('../shared/http-util');
const { stableRevision, unchangedListBody } = require('../shared/list-revision.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { listTitle } = require('./history-derive.js');
const {
  canonicalDeviceKey, deletedSessionIdsOf, completionGenerationOf,
} = require('./session-cache.js');
const { updateCompletionStates, confirmCompletionFromHistory } = require('./completion.js');
const { sessionPreviewFor } = require('./session-preview.js');
const { workspaceSessionFlags, pendingInteractionOf } = require('./session-flags.js');

/**
 * 一条会话在监控视图里的那几格。
 *
 * 字段名与完整清单**逐字一致**（sessionId / title / running / completed / pendingInteraction /
 * lastTurnError），因为原生那边解析的是同一套字段：换名字就得同步改 Kotlin，而那段代码
 * 在 App 之外，改错一次是「后台永远不提醒」这种看不见的故障。
 */
function monitorItem(summary, state) {
  const item = {
    sessionId: summary.sessionId,
    title: listTitle(summary),
    running: summary.running === true,
    completed: state ? state.completed === true : false,
  };
  const pending = pendingInteractionOf(summary.sessionId, summary);
  if (pending) item.pendingInteraction = pending;
  if (state && state.failure) item.lastTurnError = state.failure;
  return item;
}

/**
 * 状态位视图：一次宿主 list + 归档集合，**零次 history 读取**（除非有刚跑完还没定结局的）。
 *
 * 返回 `{ items, revision }`；宿主列表形状不对时返回 `{ degraded: true }`，宿主报错时返回
 * `{ error }` —— 两种都由调用方照 `/sessions` 的口径回，别在这里编一个空清单：空清单会被
 * 原生当成「所有会话都没了」，基线一清，下一轮就为所有正在跑的会话重新报一次完成。
 */
async function buildMonitorState(ctx, deviceKey) {
  const { value, error } = unwrap(await callSessions(ctx, 'list', {}, 'mobile'));
  if (error) return { error };
  const summaries = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
  if (summaries === null) return { degraded: true };

  const generation = completionGenerationOf(ctx, deviceKey);
  const deleted = deletedSessionIdsOf(ctx);
  const { archived } = await workspaceSessionFlags(ctx);
  const live = summaries.filter((s) => s && typeof s.sessionId === 'string' && s.sessionId
    && !deleted.has(s.sessionId) && !archived.has(s.sessionId));

  // 状态机跟着这份清单走：归档 / 删除的会话在这里被踢掉，与完整列表同一口径。
  const states = updateCompletionStates(ctx, live, deviceKey);

  // 结局还没定的那几条：跑过、现在不在跑、既没完成也没失败。常态下这个集合是空的。
  const unsettled = live.filter((s) => {
    if (s.running) return false;
    const state = states.get(s.sessionId);
    return state && state.wasRunning === true && state.running !== true
      && state.completed !== true && !state.failure;
  });
  if (unsettled.length > 0) {
    await Promise.all(unsettled.map(async (summary) => {
      try {
        const preview = await sessionPreviewFor(ctx, summary);
        if (!preview.events.length) return;
        // 读到这些历史的这一刻，别处可能刚发起一次写后刷新（它会 bump 代次）；
        // 用旧快照去确认结局等于把「还在跑的一轮」写成已完成。
        if (completionGenerationOf(ctx, deviceKey) !== generation) return;
        confirmCompletionFromHistory(states.get(summary.sessionId), preview.events, false, ctx, summary.sessionId);
      } catch {
        // 这一轮没读到就原样留着：判定条件（没完成、没失败）下一轮仍然成立，会再试。
      }
    }));
  }

  const items = live.map((summary) => monitorItem(summary, states.get(summary.sessionId)));
  // 按 id 排序后再算指纹：宿主是按 updatedAt 排的，聊一句话顺序就换，指纹会跟着每轮都变，
  // 条件刷新等于白做。监控视图不关心顺序。
  items.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return { items, revision: stableRevision(items) };
}

/** GET /api/mobile/v1/monitor?rev=…（token） */
async function handleMonitor(ctx, req, res) {
  const deviceKey = canonicalDeviceKey(req);
  const url = new URL(req.url, 'http://x');
  const rev = (url.searchParams.get('rev') || '').trim();

  let built;
  try {
    built = await buildMonitorState(ctx, deviceKey);
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'monitor-failed', message: (error && error.message) || '监控视图构建失败' },
    });
  }
  if (built.error) return sendJson(res, 400, { ok: false, error: built.error });
  if (built.degraded) {
    // 与 /sessions 同一个码：中转见到 5xx 会退回上一份好副本，手机那侧因此是「没收到新东西」
    // 而不是「一台会话都没有」。
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'host-session-list-degraded', message: '宿主会话列表形状异常：响应里没有 items 数组' },
    });
  }

  const body = { ok: true, generatedAt: Date.now(), revision: built.revision, items: built.items };
  sendJson(res, 200, unchangedListBody(body, rev) || body);
}

module.exports = { handleMonitor, buildMonitorState, monitorItem };

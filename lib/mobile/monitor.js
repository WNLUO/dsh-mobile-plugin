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
 * （稳态下这一发是几十字节）。再带上 `?wait=秒` 时，条件刷新的那一发**先挂住**，等状态位
 * 真的变了才回 —— 安卓后台服务靠它把「定时去问」变成「一有变化立刻送到」。
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
const { listSignal } = require('../shared/list-signal.js');
const { sessionSignal } = require('../shared/session-signal.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { listTitle } = require('./history-derive.js');
const {
  canonicalDeviceKey, deletedSessionIdsOf, completionGenerationOf,
} = require('./session-cache.js');
const { updateCompletionStates, confirmCompletionFromHistory } = require('./completion.js');
const { lastTurnOf } = require('./session-last-turn.js');
const { sessionPreviewFor } = require('./session-preview.js');
const { workspaceSessionFlags, pendingInteractionOf } = require('./session-flags.js');

/**
 * 一条会话在监控视图里的那几格。
 *
 * 字段名与完整清单**逐字一致**（sessionId / title / running / completed / pendingInteraction /
 * lastTurnError），因为原生那边解析的是同一套字段：换名字就得同步改 Kotlin，而那段代码
 * 在 App 之外，改错一次是「后台永远不提醒」这种看不见的故障。
 */
function monitorItem(summary, state, fact) {
  const running = summary.running === true;
  // 完成/失败优先用**上一轮事实**（`session-last-turn`），不再等 `state.completed`。
  //
  // 为什么：那个按设备记账的完成态要靠「这一次真的读回了 history」才折得出来，而
  // 「刚跑完」那一刻宿主的镜像推送早把同一份预览按新指纹写进缓存了 —— 监控这一侧
  // 拿到的是缓存命中（events 为空）、永远折不出来，`completed` 就一直 false，后台
  // 一条提醒都不会响（2026-10-25 真机：宿主日志里全是「preview cache-hit」）。
  // 事实那本账由 turn/end 事件当场记下，不依赖预览缓存，所以拿它判完成。
  //
  // 已读水位仍然生效：这一轮结束在「这台手机读过」之前就不算提醒。
  const clearedAt = typeof state?.clearedAt === 'number' ? state.clearedAt : null;
  const settledForThisDevice = fact != null && (clearedAt === null || fact.endedAt > clearedAt);
  const completed = fact
    ? (!running && fact.status === 'completed' && settledForThisDevice)
    : (state ? state.completed === true : false);
  const item = {
    sessionId: summary.sessionId,
    title: listTitle(summary),
    running,
    completed,
  };
  const pending = pendingInteractionOf(summary.sessionId, summary);
  if (pending) item.pendingInteraction = pending;
  const failure = fact
    ? (fact.status === 'failed' && settledForThisDevice
      ? { turn: fact.turn, code: fact.code ?? null, message: fact.message ?? null }
      : null)
    : (state && state.failure ? state.failure : null);
  if (failure) item.lastTurnError = failure;
  // 上一轮事实整份透给原生：它按「轮次前进」判完成 / 失败，比 completed 翻面可靠
  // （两次轮询之间跑完一整轮时 completed 可能一直是 true）。字段与列表那条同源。
  if (fact) {
    item.lastTurn = {
      turn: fact.turn,
      endedAt: fact.endedAt,
      status: fact.status,
      ...(fact.status === 'failed' ? { code: fact.code ?? null, message: fact.message ?? null } : {}),
    };
  }
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
  // 子代理会话不参与后台提醒：它们是主轮内部的执行单元，App 侧栏也不列；把它们算进来
  // 会在后台弹一堆「子代理跑完了」（2026-10-26 真机日志里四十多个 UUID 会话都是这种）。
  const live = summaries.filter((s) => s && typeof s.sessionId === 'string' && s.sessionId
    && s.origin !== 'subagent'
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
        if (!preview.events.length) {
          return;
        }
        // 读到这些历史的这一刻，别处可能刚发起一次写后刷新（它会 bump 代次）；
        // 用旧快照去确认结局等于把「还在跑的一轮」写成已完成。
        if (completionGenerationOf(ctx, deviceKey) !== generation) {
          return;
        }
        const before = states.get(summary.sessionId)?.completed;
        confirmCompletionFromHistory(states.get(summary.sessionId), preview.events, false, ctx, summary.sessionId);
      } catch (error) {
        // 这一轮没读到就原样留着：判定条件（没完成、没失败）下一轮仍然成立，会再试。
      }
    }));
  }

  const items = live.map((summary) => monitorItem(
    summary,
    states.get(summary.sessionId),
    lastTurnOf(ctx, summary.sessionId),
  ));
  // 按 id 排序后再算指纹：宿主是按 updatedAt 排的，聊一句话顺序就换，指纹会跟着每轮都变，
  // 条件刷新等于白做。监控视图不关心顺序。
  items.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return { items, revision: stableRevision(items) };
}

/** 一次挂起的上限。手机侧每次挂 20 秒，再长没有意义：断线重连比占着一条连接便宜。 */
const WAIT_MAX_MS = 25_000;

/**
 * 挂在「有东西变了」的信号上，最多等 timeoutMs。
 *
 * 只有两条总线会唤醒它：清单变了（list-signal）、某个会话的正文水位涨了（session-signal）
 * —— 一轮跑完、跑挂、开始等你回话，都会至少踩中其中一条。两条都是模块级单例，生产端在
 * 镜像推送链上，不需要认识这条请求。
 *
 * 为什么用总线而不是自己轮着算一遍：这里的等待必须是**事件驱动**的，自己定时重算就成了
 * 换了个地方的轮询，而这条接口存在的全部理由就是让手机不必轮询。
 */
function waitForChange(timeoutMs, res) {
  return new Promise((resolve) => {
    let settled = false;
    let releaseList = () => {};
    let releaseSession = () => {};
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseList();
      releaseSession();
      resolve();
    }
    releaseList = listSignal.onBump(finish);
    releaseSession = sessionSignal.onBump(finish);
    // 手机切网 / 进程被杀时连接会断，没必要再替它挂满整个窗口。
    if (res && typeof res.once === 'function') res.once('close', finish);
  });
}

/** 算一次监控视图，把「宿主出错 / 形状异常」也收成一个可下发的响应。 */
async function buildMonitorView(ctx, deviceKey) {
  let built;
  try {
    built = await buildMonitorState(ctx, deviceKey);
  } catch (error) {
    return {
      status: 500,
      body: { ok: false, error: { code: 'monitor-failed', message: (error && error.message) || '监控视图构建失败' } },
    };
  }
  if (built.error) return { status: 400, body: { ok: false, error: built.error } };
  if (built.degraded) {
    // 与 /sessions 同一个码：中转见到 5xx 会退回上一份好副本，手机那侧因此是「没收到新东西」
    // 而不是「一台会话都没有」。
    return {
      status: 500,
      body: { ok: false, error: { code: 'host-session-list-degraded', message: '宿主会话列表形状异常：响应里没有 items 数组' } },
    };
  }
  return { status: 200, body: { ok: true, generatedAt: Date.now(), revision: built.revision, items: built.items } };
}

/**
 * GET /api/mobile/v1/monitor?rev=…[&wait=秒]（token）
 *
 * `wait` 是实时那条路：带上它，且状态位与 `rev` 一字不差时，这次请求**先不回**，
 * 挂到有变化（或挂满）才回。安卓那条前台服务在后台就挂着它，于是「一轮跑完」到
 * 「手机响」只差一次本地网络往返，不再等下一拍轮询。
 *
 * 只挂一次：醒来之后不管变没变都如实回（变没变由 revision 说了算），由手机自己决定
 * 要不要再挂。这样这里没有循环、没有重试，断线也不会在宿主侧留下一个转不停的请求。
 */
async function handleMonitor(ctx, req, res) {
  const deviceKey = canonicalDeviceKey(req);
  const url = new URL(req.url, 'http://x');
  const rev = (url.searchParams.get('rev') || '').trim();
  const waitSeconds = Number(url.searchParams.get('wait') || 0) || 0;
  // 没有 rev 就不挂：那不是「确认一下有没有变」，而是「给我一份完整状态」，立刻回。
  const waitMs = rev ? Math.max(0, Math.min(WAIT_MAX_MS, Math.round(waitSeconds * 1000))) : 0;

  const first = await buildMonitorView(ctx, deviceKey);
  if (first.status !== 200) {
    return sendJson(res, first.status, first.body);
  }
  const unchanged = unchangedListBody(first.body, rev);
  if (!unchanged) return sendJson(res, 200, first.body);
  if (waitMs <= 0) return sendJson(res, 200, unchanged);

  // 头必须在挂起**之前**发出去。走中转那条路上，「等响应头」只有 7 秒
  // （lib/relay/tunnel.js 的 UPSTREAM_HEADER_TIMEOUT_MS），不先发头，这次挂起会被
  // 当成死请求掐掉，手机收到的是一次网络错误而不是一次「没变化」。发完头再等，
  // 中转那边看的是「响应空转 30 秒」，20 秒的挂起正好在它之内。
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', vary: 'accept-encoding' });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  await waitForChange(waitMs, res);
  // 手机在这段时间里断了（切网 / 进程被杀）：别为一个没人收的响应再算一遍。
  if (res.destroyed || res.writableEnded) return;
  const again = await buildMonitorView(ctx, deviceKey);
  const body = again.status === 200 ? (unchangedListBody(again.body, rev) || again.body) : again.body;
  // 头已经出去了，不能再走 sendJson（它会再写一次头）：这里只补正文。
  try { res.end(JSON.stringify(body)); } catch { /* 连接已断开 */ }
}

module.exports = { handleMonitor, buildMonitorState, monitorItem };

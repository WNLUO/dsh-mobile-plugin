'use strict';

/**
 * GET /api/mobile/v1/monitor —— 安卓后台提醒服务专用的「状态位」视图（只读）。
 *
 * 那条前台服务活在 JS 之外，只能自己定时来问「这一轮跑完了 / 跑挂了 / 停下来等你回话」。
 * 它此前问完整清单，而清单为了画侧栏还捎着最后一条消息预览，后台每 8 秒白读 20 次 history。
 *
 * 这条只回监控需要的那几格，支持 `?rev=` 条件刷新（状态位没变就回 unchanged）与 `?wait=秒`
 * （条件不满足时先挂住，真变了才回），让安卓服务不必轮询。完成态仍以 completion 状态机为准，
 * 常态下不读 history，只有「跑过、不在跑、结局还没定」的那几条才读一次。
 *
 * 刻意不进 `/sessions`：那边一旦按调用方分叉视图，镜像推送与写后刷新都会受影响。
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
const { pendingFailedTurns } = require('./recent-failures.js');
const { sessionPreviewFor } = require('./session-preview.js');
const { archivedSessionIdsForMonitor, pendingInteractionOf, pendingCardOf } = require('./session-flags.js');
const { withActiveParents } = require('./session-active.js');

/**
 * 一条会话在监控视图里的那几格。
 *
 * 字段名与完整清单**逐字一致**（sessionId / title / running / completed / pendingInteraction /
 * lastTurnError），因为原生那边解析的是同一套字段：换名字就得同步改 Kotlin，而那段代码
 * 在 App 之外，改错一次是「后台永远不提醒」这种看不见的故障。
 *
 * 另有两个可选字段：`lastMessage` 只给可能要提醒的那几条带上一句「这一轮跑出了什么」，
 * 供原生完成提醒的横幅正文用；`pendingCard` 是**等你处理的那张卡本身**（与实时流推的帧
 * 一字不差），只在那几条待处理的条目上带 —— 手机回前台时先问原生要它，就不必等流重新
 * 接上才有卡（见 `session-flags.js` 的 pendingCardOf）。拿不到都不出字段。
 */
function monitorItem(summary, state, fact) {
  const running = summary.running === true;
  // 完成/失败优先用**上一轮事实**（`session-last-turn`），不再等 `state.completed`。
  //
  // 为什么：那个按设备记账的完成态要靠「这一次真的读回了 history」才折得出来，而
  // 「刚跑完」那一刻宿主的镜像推送早把同一份预览按新指纹写进缓存了 —— 监控这一侧
  // 拿到的是缓存命中（events 为空）、永远折不出来，`completed` 就一直 false，后台
  // 一条提醒都不会响。事实那本账由 turn/end 事件当场记下，不依赖预览缓存。
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
  if (pending) {
    item.pendingInteraction = pending;
    // 卡的内容跟着一起走：它在上面这个判据之外没有第二条路能到手机上（推送只在流接入时
    // 补发一次）。进指纹是名正言顺的 —— 换一道新题就是真的变了，原生那一拍该被唤醒。
    const card = pendingCardOf(summary.sessionId, summary);
    if (card) item.pendingCard = card;
  } else {
    // **显式写 null**：原生那头靠「这一格在不在」判「这台宿主认不认识它」，并据此决定
    // 要不要把「看过了、没有挂起」记成账。不在就永远是「不知道」，回前台也就永远撤不掉
    // 那张已经在电脑上答掉的旧卡。待处理但没有帧可给（0.1.x 摘要自带口径）时仍然不写，
    // 那格含义是「不知道」，不是「没有」。
    item.pendingCard = null;
  }
  const failure = fact
    ? (fact.status === 'failed' && settledForThisDevice
      ? { turn: fact.turn, code: fact.code ?? null, message: fact.message ?? null }
      : null)
    : (state && state.failure ? state.failure : null);
  if (failure) item.lastTurnError = failure;
  // 上一轮事实整份透给原生：它按「轮次前进」判完成 / 失败，比 completed 翻面可靠
  // （两次轮询之间跑完一整轮时 completed 可能一直是 true）。字段与列表那条同源。
  if (fact) {
    // 离线期间跑坏过、且还没被任何一端读过的那几轮：只给最新一轮的话，「先失败、后又跑
    // 成功」的那次失败在补投时收不到，而失败恰恰最该让人知道。判据与 readAt 同一个与设备
    // 无关的水位；没有就不出字段（老 App 忽略它）。
    const failedTurns = pendingFailedTurns(fact.failedTurns, fact.readAt);
    item.lastTurn = {
      turn: fact.turn,
      endedAt: fact.endedAt,
      status: fact.status,
      // 这一轮是不是**已经有人读过了**（桌面 / 另一台手机 / 这台都算）。与设备无关的
      // 事实，跟着事实走；上面那个 `completed` 用的是按设备的 `clearedAt`，而桌面点开
      // 只看 `/api/relay/desktop-read`，它不动那个水位 —— 后台把「已经看过的这一轮」
      // 弹出来之后，只有这个水位能让它自己消失（见原生那条撤销）。
      ...(typeof fact.readAt === 'number' && fact.readAt > 0 ? { readAt: fact.readAt } : {}),
      ...(fact.status === 'failed' ? { code: fact.code ?? null, message: fact.message ?? null } : {}),
      ...(failedTurns.length > 0 ? { failedTurns } : {}),
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
async function buildMonitorState(ctx, deviceKey, extraItems = null) {
  const { value, error } = unwrap(await callSessions(ctx, 'list', {}, 'mobile'));
  if (error) return { error };
  const rawSummaries = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
  if (rawSummaries === null) return { degraded: true };
  // 与 /sessions 同一条判据：主轮跑完、子代理还在跑的那一段，宿主报的是不在跑。
  // 这里要顶起来，否则后台会在子代理还在干活时就弹「已完成」——而侧栏那一行（走上面的
  // /sessions）还是「进行中」，两处对同一时刻给出两种答案。顶起来必须在剔掉子会话**之前**
  // 做：子会话就是判据的原料。
  const summaries = withActiveParents(rawSummaries);

  const generation = completionGenerationOf(ctx, deviceKey);
  const deleted = deletedSessionIdsOf(ctx);
  // 归档集合用「记住上一次真读到的那份」那个口径，不用列表那条 fail-open：
  // 这一条决定要不要在后台叫醒人，一次读不到就按「没归档」画会让已归档的会话重新进清单、
  // 被当成刚跑完再响一遍（见 session-flags.js 的 archivedSessionIdsForMonitor）。
  const archived = await archivedSessionIdsForMonitor(ctx);
  // 子代理会话不参与后台提醒：它们是主轮内部的执行单元，App 侧栏也不列；把它们算进来
  // 会在后台弹一堆「子代理跑完了」。
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
  // 可能要提醒的那几条补一句「这一轮跑出了什么」：只在完成 / 失败 / 待回话的条目上取，
  // 走 sessionPreviewFor 的缓存；常态（全在跑 / 全闲且已读）一条 history 都不读。
  // 必须在排序与算指纹**之前**补好，否则正文变了却算不出新 rev，手机不会被唤醒。
  const summariesById = new Map(live.map((s) => [s.sessionId, s]));
  await Promise.all(items.map(async (item) => {
    if (item.completed !== true && !item.lastTurnError && !item.pendingInteraction) return;
    const summary = summariesById.get(item.sessionId);
    if (!summary) return;
    try {
      const last = (await sessionPreviewFor(ctx, summary)).lastMessage;
      // 只有 assistant 的话值得进通知：用户自己说的在横幅里没有信息量。
      if (last && last.role === 'assistant' && typeof last.text === 'string' && last.text !== '') {
        item.lastMessage = { role: last.role, text: last.text.slice(0, 200) };
      }
    } catch {
      // 拿不到预览就整个字段不出，老 App 会忽略它。
    }
  }));
  // CLI 会话（`cli-*`）的监控条目由适配层按同一套字段给（见 mobile/cli/mobile.js 的
  // monitorItems）：它们是 ACP 子进程、不在宿主的会话清单里，但「在跑 / 刚完成 /
  // 等你审批」这三件事对后台提醒是一回事。注入成一个取值器，这里不认识 CLI 的任何细节。
  if (typeof extraItems === 'function') {
    try {
      const extra = extraItems();
      if (Array.isArray(extra) && extra.length > 0) items.push(...extra);
    } catch {
      // 适配层取不出来的话就当没有 CLI 会话：后台提醒照旧为宿主会话工作。
    }
  }
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
async function buildMonitorView(ctx, deviceKey, extraItems = null) {
  let built;
  try {
    built = await buildMonitorState(ctx, deviceKey, extraItems);
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
async function handleMonitor(ctx, req, res, extraItems = null) {
  const deviceKey = canonicalDeviceKey(req);
  const url = new URL(req.url, 'http://x');
  const rev = (url.searchParams.get('rev') || '').trim();
  const waitSeconds = Number(url.searchParams.get('wait') || 0) || 0;
  // 没有 rev 就不挂：那不是「确认一下有没有变」，而是「给我一份完整状态」，立刻回。
  const waitMs = rev ? Math.max(0, Math.min(WAIT_MAX_MS, Math.round(waitSeconds * 1000))) : 0;

  const first = await buildMonitorView(ctx, deviceKey, extraItems);
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
  const again = await buildMonitorView(ctx, deviceKey, extraItems);
  const body = again.status === 200 ? (unchangedListBody(again.body, rev) || again.body) : again.body;
  // 头已经出去了，不能再走 sendJson（它会再写一次头）：这里只补正文。
  try { res.end(JSON.stringify(body)); } catch { /* 连接已断开 */ }
}

module.exports = { handleMonitor, buildMonitorState, monitorItem };

'use strict';

/**
 * 移动端会话 API 的会话列表与新建会话。
 *
 * 这个文件一度是一千九百多行的单体，HTTP 路由、宿主 RPC、缓存、事件派生全混在一起；现在
 * 按域拆开：envelope（信封拆解）、rpc（窄接口封装）、session-cache（按 ctx 隔离的状态表）、
 * attachments、completion、session-models、session-search、session-send、session-snapshot、
 * session-mirror、session-goal、session-presets、session-preview、session-list-shortcut。
 *
 * 剩下的就是列表：GET /sessions（10 秒缓存 + fresh 绕过 + 完成态确认 + `?rev=` 条件刷新）、
 * 单会话摘要、正文水位探针、统计、新建会话、排队消息动作。本文件继续转出各子模块的导出，
 * 所以 lib/mobile 下的 import 路径一行都不用改。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { isFreshRequest } = require('../shared/fresh-request');
const { listRevision, unchangedListBody } = require('../shared/list-revision.js');
const { listSignal: sharedListSignal } = require('../shared/list-signal.js');
// 正文水位信号：session/head 探针直接读它的快照，**不**为了「看起来有值」去现读历史。
const { sessionSignal } = require('../shared/session-signal.js');
const { listShortcut, rememberListBuild } = require('./session-list-shortcut.js');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { listTitle, deriveMessages, lastMessageOf, promptErrorObject, MODEL_UNAVAILABLE_ERROR } = require('./history-derive.js');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const {
  canonicalDeviceKey, sessionListResponseState, invalidateSessionList, deletedSessionIdsOf,
  completionGenerationOf, bumpCompletionGeneration,
  completionStateOf, sessionModelsStateOf, invalidateSessionModels, sendIdempotencyStateOf,
} = require('./session-cache.js');
const { resolveEventAttachments } = require('./attachments.js');
const { updateCompletionStates, confirmCompletionFromHistory } = require('./completion.js');
const { lastTurnOf } = require('./session-last-turn.js');
const { eventSeqOf, buildMessagesSnapshot, buildStatsSnapshot, statsProjections, handleMessages } = require('./session-snapshot.js');
const { buildModelsSnapshot, handleModels, handleSelectModel } = require('./session-models.js');
const { buildSingleSessionMirror, buildMirrorWarmSnapshots } = require('./session-mirror.js');
const { promptOnce, handleSend, handleCommands, handleSessionRead, handleSessionAttachment, handleStop,
  handleRename, handleFork } = require('./session-send.js');
const { handleSessionSearch } = require('./session-search.js');
const { handleAgentPresets } = require('./session-presets.js');
const { handleGoalAction } = require('./session-goal.js');
const { workspaceSessionFlags, pendingInteractionOf } = require('./session-flags.js');
// 行首时钟：这一条会话还有没有活动的自动化任务（一次任务目录查询喂满整份列表）。
const { activeScheduleSessions } = require('./session-schedule-mark.js');
// 预览（lastMessage 补全）与它自己的重读节流：只读日志、不发写，单列一个子模块。
const { HISTORY_FOR_ENRICH, sessionPreviewFor } = require('./session-preview.js');

const SESSIONS_PREVIEW_LIMIT = 20;  // 仅为最近/运行中的会话补最后消息预览
const SESSION_LIST_CACHE_MS = 10000;  // 会话列表增料缓存（降低手机轮询对桌面的冲击）

/**
 * GET /api/mobile/v1/session/head?sessionId=…&parentSessionId=…&mode=…（token）
 *
 * 「这条会话的正文到哪个水位了」——App 进对话前先问一句，跟本地缓存水位一比就知道要不要
 * 重新拉全量历史。几十字节换几兆。
 *
 * `seq` 取 `sessionSignal.peek(sessionId)`：镜像推送每轮都会 bump，语义正是「快照里真正
 * 装上的消息的最大 seq」，与 App 的缓存水位同一个 seq 空间。
 *
 * `known` = `seq > 0`。**信号里没有时如实回 `known:false`**（插件刚重启、还没轮到推这个
 * 会话），让 App 退回全量拉取；绝不为了「看起来有值」现读一次历史——那样这个探针本身
 * 就变成了它要省掉的那次请求。
 *
 * 子代理（带 parentSessionId）直接回 `{seq:0, known:false}`：镜像里刻意不存子会话正文
 * （见 dev-map A3-14 的「子会话的正文刻意不进镜像」），没有水位可言。
 */
async function handleSessionHead(_ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const parentSessionId = url.searchParams.get('parentSessionId');
  if (parentSessionId !== null && parentSessionId !== '') {
    return sendJson(res, 200, { ok: true, seq: 0, known: false });
  }
  const seq = sessionSignal.peek(sessionId);
  sendJson(res, 200, { ok: true, seq, known: seq > 0 });
}

/** GET /api/mobile/v1/sessions（token） */
async function handleSessions(ctx, req, res) {
  const deviceKey = canonicalDeviceKey(req);
  let generation = completionGenerationOf(ctx, deviceKey);
  const cache = sessionListResponseState(ctx, deviceKey);
  const now = Date.now();
  // 写操作之后的刷新带 ?fresh=1：跳过这层 10s 缓存、在途构建与宿主 list 的合流，直接按最新状态重建。
  const wantFresh = isFreshRequest(req.url);
  // 「只看已归档」筛选带 ?archived=1（见 buildSessionsResponse 的 archivedOnly）：它返回的
  // 是同一批会话的**另一个子集**，不能与默认视图共用这份 10 秒缓存——否则 App 点完
  // 「筛选已归档会话」后，最长 10 秒内拿到的还是那份不含归档行的默认列表。
  // 与 fresh 的区别：它只绕开这层缓存，不需要作废在途构建，也不 bump 朝代号（没有写入）。
  const url = new URL(req.url, 'http://x');
  const archivedOnly = url.searchParams.get('archived') === '1';
  // 条件刷新（?rev=<上次的 revision>）：内容没变就只回一句 unchanged，不带 items。
  // fresh=1（写后刷新必须拿到真数据）与 archived=1（归档子集不是同一份内容）一律不走。
  const rev = (url.searchParams.get('rev') || '').trim();
  const revEligible = !wantFresh && !archivedOnly;
  // 只有新客户端显式带分页参数时才切片；旧客户端不带参数仍拿到完整归档列表。
  const hasPaging = archivedOnly && (url.searchParams.has('offset') || url.searchParams.has('limit'));
  const parsedOffset = Number(url.searchParams.get('offset') ?? 0);
  const parsedLimit = Number(url.searchParams.get('limit') ?? 50);
  const page = hasPaging ? {
    offset: Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0,
    limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(200, Math.floor(parsedLimit))) : 50,
  } : null;
  const bypassCache = wantFresh || archivedOnly;
  if (wantFresh) {
    // 顺手作废更早发起的构建：它们手里的数据是写入之前的，若在新结果之后才落地会把旧列表又写回缓存。
    cache.value = null;
    cache.updatedAt = 0;
    generation = bumpCompletionGeneration(ctx, deviceKey);
  }
  // 条件刷新的转换点：拿到**最终要回的 body**之后才判，且只在上面那两条短路条件
  // （rev 缺失/为空、fresh=1、archived=1）都不成立时才认。unchanged 响应本身不写缓存、
  // 也不进在途构建的合流判定——它只是同一份内容的一句话说清。
  const respond = (status, body) => {
    const unchanged = status === 200 && revEligible ? unchangedListBody(body, rev) : null;
    return sendJson(res, status, unchanged || body);
  };

  // ── 构建前短路（`rev` 命中且清单确实没变）──
  //
  // 手机 15 秒问一次，而「构建这份列表」要几百毫秒（读宿主列表 + 折预览 + 算 revision）。
  // 大多数轮次清单根本没变，答案就是几十字节的 `unchanged` —— 那就没必要先把它建出来。
  // 判据三样一起看，缺一不可：
  //   ① 客户端手上的 revision 与上次构建出来的完全相同；
  //   ② 清单变更信号没有涨过（镜像推送调度器每 500ms 比一次内容哈希，见 list-signal）；
  //   ③ 这台设备的完成态代号没变（completed / 失败态按设备算，信号里看不出来）。
  // 只在**真有观众**（设备级 SSE 或轮询订阅着）时才信任信号：没有观众时推送调度器会
  // 停止空转构建，信号不再前进，那时宁可老实重建。
  if (!bypassCache && rev && sharedListSignal.watching()) {
    const short = listShortcut(cache, rev, generation);
    if (short) return respond(200, short);
  }

  if (!bypassCache && cache.value && now - cache.updatedAt < SESSION_LIST_CACHE_MS) {
    return respond(200, cache.value);
  }

  if (!bypassCache && cache.promise) {
    const response = await cache.promise;
    return respond(response.status, response.body);
  }

  // 变更信号（镜像推送调度器先看见清单变了）会调 dropSessionListCache 丢掉这层缓存，
  // 但「丢掉」挡不住**已经在飞**的那次构建：它手里是变更之前的数据，落地后会在缓存里
  // 再活 10 秒。用缓存自带的朝代号兜住（见 session-cache.js 的 dropSessionListCache）。
  const epoch = cache.droppedAt || 0;
  const promise = buildSessionsResponse(ctx, deviceKey, generation, wantFresh, archivedOnly, page);
  cache.promise = promise;
  try {
    const response = await promise;
    if (response.status === 200 && completionGenerationOf(ctx, deviceKey) === generation
      && (cache.droppedAt || 0) === epoch) {
      // 含「运行中」行的清单不进 10 秒缓存：这些行的 completed / lastTurnError 要等预览
      // 把 turn/end 折出来才定稿，缓存会把「刚失败 / 刚跑完」的那一份多留一整个轮询
      // 周期。15 秒轮询本来就跨过 10 秒窗口，这层缓存的收益只体现在突发刷新上。
      const hasRunning = Array.isArray(response.body && response.body.items)
        && response.body.items.some((item) => item && item.running);
      if (!hasRunning && !archivedOnly) {
        cache.value = response.body;
        cache.updatedAt = Date.now();
      }
    }
    if (response.status === 200) rememberListBuild(cache, response.body, completionGenerationOf(ctx, deviceKey));
    return respond(response.status, response.body);
  } finally {
    if (cache.promise === promise) cache.promise = null;
  }
}

async function buildSessionsResponse(ctx, deviceKey = 'legacy', generation = completionGenerationOf(ctx, deviceKey), fresh = false, archivedOnly = false, page = null) {
  const { value, error } = unwrap(await callSessions(ctx, 'list', {}, 'mobile', undefined, { fresh }));
  if (error) return { status: 400, body: { ok: false, error } };
  // 形状不对 = 没取到，不是「你一个会话都没有」。旧实现 `(value.items || [])` 把
  // 任何缺 items 的响应变成 200 空列表：下游（App 提交、镜像推送、中转响应缓存）
  // 都会把它当权威数据，把好的会话清单整个覆盖掉。
  // 用 500 而不是 400：中转对 >=500 的小响应会退回上一份好副本（stale:true），
  // 手机上因此表现为「短暂用旧列表」而不是「列表清空」。
  const summaries = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
  if (summaries === null) {
    return {
      status: 500,
      body: {
        ok: false,
        error: { code: 'host-session-list-degraded', message: '宿主会话列表形状异常：响应里没有 items 数组' },
      },
    };
  }
  // 归档会话在这里剔除，与桌面端侧边栏行为一致：宿主 sessions.list 自己不过滤归档，
  // 「哪些会话已归档」只存在于 workspaceRegistry.archivedSessionIds（见 workspaceSessionFlags）。
  // 清理时已删日志的 ID 也要压住：宿主 list 或 workspace.list 的短暂旧快照不能让它们复活。
  // archivedOnly（App 的「只看已归档」筛选视图）反过来只保留归档里的那些行：默认视图藏
  // 它们，筛选视图正是为了把它们找回来（查看 / 取消归档）。
  const deleted = deletedSessionIdsOf(ctx);
  const { archived, pinned } = await workspaceSessionFlags(ctx);
  // 行首那只时钟的判据：这一条会话还有没有活动的自动化任务（见 session-schedule-mark.js）。
  // 与置顶 / 归档同一个位置取，一次目录查询喂满整份列表，别在渲染层逐行发请求。
  const scheduled = await activeScheduleSessions(ctx);
  const allSummaries = summaries.filter((item) => item && !deleted.has(item.sessionId)
    && (archivedOnly === archived.has(item.sessionId)));
  // 状态跟踪覆盖完整列表，不能受预览补全上限影响。
  const completionStatesForContext = updateCompletionStates(ctx, allSummaries, deviceKey);
  // 设备无关的「上一轮事实」台账：预览读回 history 时顺手记进去（见下面的折叠）。
  // 列表完整返回：侧边栏分组依赖全部会话（工作区 sessionIds 排序 + 未分组兜底），
  // 截断会让工作区/项目下的会话凭空消失。标题直接取 list 摘要的 title 投影
  // （与桌面端侧栏同一来源，正式 session/title 事件折叠，绝不用对话正文冒充标题），
  // 该项是廉价字段；history 仅用于补「最后消息预览」，属于重活，见下方预览子集。
  const rows = allSummaries.map((s) => {
    const completionState = completionStatesForContext.get(s.sessionId);
    const fact = lastTurnOf(ctx, s.sessionId);
    // 待处理标记：判据与后台监控共用一份（见 session-flags.js），别再在这里写第二份。
    const pendingInteraction = pendingInteractionOf(s.sessionId, s);
    const base = {
      sessionId: s.sessionId,
      title: listTitle(s),
      running: !!s.running,
      ...(pendingInteraction ? { pendingInteraction } : {}),
      completed: !!completionState?.completed,
      // 上一轮以错误收尾（由 completion.js 从 history 的 turn/end reason.kind 折出）。
      // 侧栏据此画红点：completed 只说「跑完了、待阅读」，说不了「跑挂了」。字段只在
      // 真有失败时出现，旧 App 忽略未知字段、行为不变。
      ...(completionState?.failure ? { lastTurnError: completionState.failure } : {}),
      // 上一轮的**设备无关事实**：这一轮什么时候结束、成没成。上面那两个（completed /
      // lastTurnError）是「这台设备还没看过」的提醒，而列表同时还要喂镜像快照 ——
      // 快照全局一份、给所有设备读，按设备算的提醒在里面永远是同一台假设备的结论。
      // App 因此改成拿这一格 + 本机已读水位自己算点，见文件头与 completion.js。
      ...(fact ? { lastTurn: fact } : {}),
      blank: !!s.blank,
      cwd: s.cwd || null,
      // 会话定档的 Agent 预设（宿主 session.list 摘要里带，用来显示会话当前预设）。
      ...(typeof s.agentPreset === 'string' && s.agentPreset ? { agentPreset: s.agentPreset } : {}),
      // 置顶来自 workspace.list 的 pinnedSessionIds（宿主 session.list 摘要里没有这个字段），
      // 与归档同源同一份快照。App 侧栏据此把这条排到工作区最前、并在行尾画图钉标记。
      // 和归档一样只在真置顶时出现：旧 App 忽略未知字段，行为不变。
      ...(pinned.has(s.sessionId) ? { pinned: true } : {}),
      // 这一条会话还排着活动的自动化任务：App 侧栏在行首画那只时钟（桌面
      // SessionScheduleMark 同口径）。只在真有任务时出现，旧 App 忽略未知字段。
      ...(scheduled.has(s.sessionId) ? { scheduled: true } : {}),
      updatedAt: s.updatedAt || 0,
      lastMessage: null,
      ...(s.origin === 'subagent' ? { origin: s.origin } : {}),
      ...(typeof s.parentSessionId === 'string' ? { parentSessionId: s.parentSessionId } : {}),
    };
    return { summary: s, base };
  });
  // 有分页时只为当前页补预览，避免每翻一页都给不可见会话重复读历史。
  const pageRows = page ? rows.slice(page.offset, page.offset + page.limit) : rows;
  // 预览子集：运行中优先（完成边沿确认不能缺），其次最近活跃；数量受
  // SESSIONS_PREVIEW_LIMIT 限制，避免会话多时每次列表请求都全量读历史日志。
  const previewCandidates = pageRows
    .slice()
    .sort((a, b) =>
      (b.summary.running ? 1 : 0) - (a.summary.running ? 1 : 0)
      || (b.summary.updatedAt || 0) - (a.summary.updatedAt || 0))
    .slice(0, SESSIONS_PREVIEW_LIMIT);
  await Promise.all(previewCandidates.map(async ({ summary: s, base }) => {
    try {
      const preview = await sessionPreviewFor(ctx, s);
      const events = preview.events;
      const completionState = completionStatesForContext.get(s.sessionId);
      if (completionGenerationOf(ctx, deviceKey) === generation) {
        confirmCompletionFromHistory(completionState, events, !!s.running, ctx, s.sessionId);
      }
      // Only expose completion after the matching turn/end and final
      // assistant/message are both present in the same history snapshot.
      base.completed = !!completionState?.completed;
      // 失败标记同样只在这一步之后才知道（上面构造行时它还是上一份快照的值）。
      // 必须在这里同步一次：否则「失败被折出来的那一次响应」里 completed 已经是
      // false、lastTurnError 却还缺着，侧栏会出现一个什么都不显示的间隔（既不是进行中、
      // 也没有红点），要等下一轮轮询才亮 —— 那正是这个补丁要消灭的「静默」。
      if (completionState?.failure) base.lastTurnError = completionState.failure;
      else delete base.lastTurnError;
      // 事实那一格同理：它通常在这一步才第一次算出来。
      const foldedFact = lastTurnOf(ctx, s.sessionId);
      if (foldedFact) base.lastTurn = foldedFact;
      else delete base.lastTurn;
      base.lastMessage = preview.lastMessage;
    } catch {
      // 预览失败不影响标题与行数据。
    }
  }));
  const allItems = rows.map((r) => r.base);
  const items = page ? allItems.slice(page.offset, page.offset + page.limit) : allItems;
  const generatedAt = Date.now();
  return {
    status: 200,
    body: {
      ok: true,
      items,
      hasMore: page ? page.offset + items.length < allItems.length : false,
      // 数据新鲜度：App 把这两个字段连同快照一起存下来，就能把「这份数据是谁在什么
      // 时候给的」显示给用户，而不是只给一个「刚刚同步过」的客户端时间。revision 是
      // 内容指纹（跨插件重启稳定），App 也用它判断一次变更信号是否真的带来了新内容。
      generatedAt,
      revision: listRevision(allItems),
      // 显式空态：形状降级在上面的 500 分支里已被挡掉，能走到这里说明宿主回了一份
      // 合法清单 —— 「空」在这一点上是可断言的契约，不再需要 App 连续两次空去猜。
      // 下游（空清单守卫 / 中转缓存 / App 的空态判定）据此放行真实的「清空」。
      emptyConfirmed: allItems.length === 0,
    },
  };
}

/** GET /api/mobile/v1/session?sessionId=…（token） */
async function handleSession(ctx, req, res) {
  const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const { value, error } = unwrap(await callSessions(ctx, 'history', { sessionId, maxMessages: HISTORY_FOR_ENRICH }));
  if (error) return sendJson(res, 400, { ok: false, error });
  const events = (value && value.events) || [];
  const messages = deriveMessages(events);
  const last = lastMessageOf(messages);
  // 标题与 cwd 从会话列表摘要取（标题用 title 投影，与桌面端一致；
  // history 的 30 条窗口可能截掉标题事件，不能作为标题来源）。
  // blank / agentPreset 同源：App 据此决定 Agent 预设芯片是「可切」还是「已锁死」。
  let cwd = null;
  let title = '';
  let blank = false;
  let agentPreset;
  try {
    const list = unwrap(await callSessions(ctx, 'list', {}));
    const s = (list.value && list.value.items || []).find((x) => x.sessionId === sessionId);
    if (s) {
      if (typeof s.cwd === 'string' && s.cwd) cwd = s.cwd;
      title = listTitle(s);
      blank = !!s.blank;
      if (typeof s.agentPreset === 'string' && s.agentPreset) agentPreset = s.agentPreset;
    }
  } catch { /* cwd/title/blank/agentPreset 可选 */ }
  sendJson(res, 200, {
    ok: true,
    session: {
      sessionId,
      cwd,
      title,
      blank,
      ...(agentPreset === undefined ? {} : { agentPreset }),
      lastSeq: events.length ? (eventSeqOf(events[events.length - 1]) ?? 0) : 0,
      lastMessage: last ? { role: last.role, text: last.text.slice(0, 200), at: last.time } : null,
    },
  });
}

/**
 * GET /api/mobile/v1/session/stats?sessionId=…（token）
 * 透传宿主 session.history 尾页的 projections（tokenUsage / sessionStats /
 * contextPressure / contextBreakdown），供移动端渲染上下文占用圆环与统计行。
 */
async function handleStats(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const stats = await statsProjections(ctx, sessionId);
  if (!stats.ok) return sendJson(res, 400, { ok: false, error: stats.error });
  sendJson(res, 200, { ok: true, projections: stats.projections });
}

/**
 * POST /api/mobile/v1/session/new（token）{ workspaceId? | cwd? } → { ok, sessionId }
 * 新建一个空白会话。优先 workspaceId：宿主把新会话 attach 到该项目（workspace）
 * 的 sessionIds 账上，桌面端侧栏项目下立即可见；无 workspaceId 时回退 cwd
 * （不传则归属其默认/未分组工作区）。
 * 走宿主 apiProxy 的 session.create（接受 workspaceId 或 cwd，二者不能同时给）。
 */
async function handleNew(ctx, req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  // 新建会话是**非幂等**写：同一发请求被重投一次就会凭空多一个会话。requestId 由
  // App 在构造请求头时生成一次，内核换通道重投复用同一个 init（同一个头），重投于是
  // 命中这里、直接拿回第一次的 sessionId（见 mobile/idempotency.js）。
  const outcome = await withIdempotency(ctx, canonicalDeviceKey(req), requestIdOf(req, body), async () => {
    let payload = {};
    const workspaceId = body && typeof body.workspaceId === 'string' && body.workspaceId.trim()
      ? body.workspaceId.trim()
      : '';
    if (workspaceId) {
      payload.workspaceId = workspaceId;
    } else if (body && typeof body.cwd === 'string' && body.cwd.trim()) {
      payload.cwd = body.cwd.trim();
    }
    // 宿主 session.create 接受 agentPreset：新建时直接定档，省掉「先建再 select」的
    // 两步（select 只在会话还没开跑时生效，新建后立刻 select 同样可行但多一次 RPC）。
    if (body && typeof body.agentPreset === 'string' && body.agentPreset.trim()) {
      payload.agentPreset = body.agentPreset.trim();
    }
    const { value, error } = unwrap(await callSessions(ctx, 'create', payload));
    if (error) return { status: 400, body: { ok: false, error } };
    const sessionId = value && typeof value.sessionId === 'string' ? value.sessionId : null;
    if (!sessionId) {
      return { status: 500, body: { ok: false, error: { code: 'internal', message: '新建会话未返回 sessionId' } } };
    }
    // 新建的会话要立刻出现在列表里，否则手机端最长 10 秒看不到它。
    invalidateSessionList(ctx);
    return {
      status: 200,
      body: {
        ok: true,
        sessionId,
        cwd: payload.cwd || null,
        ...(value && typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
      },
    };
  });
  sendJson(res, outcome.status, outcome.body);
}

/**
 * POST /api/mobile/v1/session/queue/update（token）{ sessionId, itemId, action }
 * 排队消息条动作透传：edit(content) / remove / steer（插话发送，仅运行中）。
 * action: { kind:'edit', content:[{type:'text',text}] } | { kind:'remove' } | { kind:'steer' }。
 */
async function handleQueueUpdate(ctx, req, res) {
  const body = await readJsonBody(req, 256 * 1024);
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
  const itemId = body && typeof body.itemId === 'string' ? body.itemId : '';
  const action = body && body.action;
  if (!sessionId || !itemId || !action || typeof action.kind !== 'string') {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { sessionId, itemId, action }' } });
  }
  const { value, error } = unwrap(await callSessions(ctx, 'updateQueue', { sessionId, itemId, action }));
  if (error) return sendJson(res, 400, { ok: false, error });
  sendJson(res, 200, { ok: true, ...(value || {}) });
}

// 下面这一组从 session-cache.js 转出：它们此前是本文件的模块级 WeakMap 访问器，
// 而 sessions.js 是 mobile/ 下被引用最多的模块（测试与其它 handler 都从这里取）。
// 换实现不改路径。

// 下面这一组从各子模块转出：它们此前全是 sessions.js 的实现，而 sessions.js 是
// mobile/ 下被引用最多的模块（其它 handler 与测试都从这里取）。换实现不改路径。

module.exports = {
  // 本文件自己的
  buildSessionsResponse,
  SESSIONS_PREVIEW_LIMIT,
  handleSessions,
  handleSession,
  handleSessionHead,
  handleStats,
  handleNew,
  handleQueueUpdate,
  // 子模块转出
  unwrap,
  callSessions,
  promptOnce,
  promptErrorObject,
  MODEL_UNAVAILABLE_ERROR,
  buildMessagesSnapshot,
  buildStatsSnapshot,
  buildSingleSessionMirror,
  buildMirrorWarmSnapshots,
  buildModelsSnapshot,
  resolveEventAttachments,
  // 状态表访问器（实现在 session-cache.js / rpc.js）
  sendIdempotencyStateOf,
  completionStateOf,
  sessionModelsStateOf,
  invalidateSessionModels,
  invalidateSessionList,
  // 纯派生（实现在 history-derive.js）
  listTitle,
  deriveMessages,
  // handler
  handleMessages,
  handleSend,
  handleCommands,
  handleSessionRead,
  handleSessionAttachment,
  handleStop,
  handleRename,
  handleFork,
  handleModels,
  handleSelectModel,
  handleSessionSearch,
  handleAgentPresets,
  handleGoalAction,
};

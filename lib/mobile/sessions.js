'use strict';

/**
 * 移动端会话 API 的**会话列表**与**新建会话**。
 *
 * 本文件一度是 1964 行的单体，HTTP 路由、宿主 RPC、缓存、事件派生全混在一起；而且
 * 它是 lib/mobile 下被引用最多的模块——stream / credentials / skills / subagents /
 * workspaces / host-settings 全都从它取 unwrap、callSessions、缓存访问器，于是它成了
 * 事实上的公共工具库，谁都不好动。现在按域拆开：
 *
 *   envelope.js        信封拆解（unwrap / envelopeValue），唯一的实现
 *   rpc.js             对宿主 apiProxy 的窄接口封装（callSessions / callAgentPresets）
 *   session-cache.js   按 ctx 隔离的八张状态表，全部 WeakMap 集中在这里
 *   attachments.js     图片附件还原
 *   completion.js      完成提醒状态机
 *   session-models.js  模型目录与切模型
 *   session-search.js  正文检索
 *   session-send.js    发消息 / slash 命令 / 读 / 停 / 改名 / 分叉
 *   session-snapshot.js 消息与统计快照（镜像与分页共用）
 *   session-mirror.js  镜像整帧构建
 *   session-goal.js    目标条动作
 *   session-presets.js Agent 预设目录
 *
 * 剩下的就是列表：GET /sessions（10 秒缓存 + fresh 绕过 + 完成态确认）、GET /session、
 * GET /session/stats、新建会话、排队消息动作。**本文件继续从各子模块转出导出**，
 * 所以 lib/mobile 下所有 import 路径一行都不用改。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { isFreshRequest } = require('../shared/fresh-request');
const { listRevision } = require('../shared/list-revision.js');
const { withIdempotency, requestIdOf } = require('./idempotency.js');
const { listTitle, deriveMessages, lastMessageOf, promptErrorObject, MODEL_UNAVAILABLE_ERROR } = require('./history-derive.js');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const {
  canonicalDeviceKey, sessionListResponseState, invalidateSessionList,
  sessionPreviewStateOf, sessionPreviewInFlightStateOf, sessionPreviewClockOf,
  completionGenerationOf, bumpCompletionGeneration,
  completionStateOf, sessionModelsStateOf, invalidateSessionModels, sendIdempotencyStateOf,
} = require('./session-cache.js');
const { resolveEventAttachments } = require('./attachments.js');
const { updateCompletionStates, confirmCompletionFromHistory } = require('./completion.js');
const { buildMessagesSnapshot, buildStatsSnapshot, statsProjections, handleMessages } = require('./session-snapshot.js');
const { safeModelsValue, buildModelsSnapshot, handleModels, handleSelectModel } = require('./session-models.js');
const { buildSingleSessionMirror, buildMirrorWarmSnapshots } = require('./session-mirror.js');
const {
  promptOnce, handleSend, handleCommands, handleSessionRead,
  handleStop, handleRename, handleFork,
} = require('./session-send.js');
const { handleSessionSearch } = require('./session-search.js');
const { handleAgentPresets } = require('./session-presets.js');
const { handleGoalAction } = require('./session-goal.js');

const HISTORY_FOR_ENRICH = 10;      // 补标题/预览时拉取的消息条数（低到足够取最后一条预览，避免每次重活）
const SESSIONS_PREVIEW_LIMIT = 20;  // 仅为最近/运行中的会话补最后消息预览
const SESSION_LIST_CACHE_MS = 10000;  // 会话列表增料缓存（降低手机轮询对桌面的冲击）
/**
 * 运行中会话的预览重读下限。
 *
 * 运行中的会话 updatedAt 几乎每轮都在变，`sessionPreviewFingerprint` 于是每轮都变，
 * 10 秒的列表缓存一到期就要为每个运行中会话重读一次 history（HISTORY_FOR_ENRICH 条）。
 * 一轮生成里手机侧 15s 轮询会反复撞上「指纹变了但预览内容其实没变」的中间态。
 * 这里给运行中会话单独加一个更短的窗口：窗口内复用上一次预览，不重读日志。
 * 非运行中的会话仍走指纹判定（它们的 updatedAt 不变，指纹不变，本来就不会重读）。
 */
const RUNNING_PREVIEW_MIN_INTERVAL_MS = 3000;

/**
 * 宿主的两个**会话集合**（同一次 `workspace.list` 快照里拿到）：
 *
 *   - `archivedSessionIds`：已归档的会话。桌面端侧边栏据此把它们藏起来，而
 *     `sessions.list` 自身**不过滤**归档，所以移动端必须自己读这个集合：此前完全没读，
 *     App 的「归档会话」写是写成功了（宿主确实把 id 记进了 archivedSessionIds），列表却
 *     照旧把那一行发回手机，用户看到的就是一次毫无反馈的空操作。
 *   - `pinnedSessionIds`：已置顶的会话（宿主侧「最近置顶的在前」）。桌面端也只从这份
 *     快照读置顶，`sessions.list` 的摘要里没有置顶字段，所以移动端同样要自己读，
 *     否则 App 既画不出置顶标记、也排不到工作区最前。
 *
 * 两个集合合并成一次 RPC：它们同源同一次快照，而会话列表每 10 秒就会重建一次，
 * 分两次 `workspace.list` 等于平白给手机多塞一轮往返。
 *
 * 取不到时两个集合都回空（失败放开）：宁可多显示几行、少几个置顶，也不能因为一次
 * RPC 抖动让整个会话列表凭空变空。
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

function sessionPreviewFingerprint(summary) {
  return `${summary.updatedAt || 0}:${summary.running ? 'running' : 'idle'}:${summary.blank ? 'blank' : 'content'}`;
}

/** Read one preview at most once per unchanged session revision. */
async function sessionPreviewFor(ctx, summary) {
  const sessionId = summary.sessionId;
  const fingerprint = sessionPreviewFingerprint(summary);
  const cached = sessionPreviewStateOf(ctx).get(sessionId);
  if (cached?.fingerprint === fingerprint) return { events: [], lastMessage: cached.lastMessage };

  const inFlight = sessionPreviewInFlightStateOf(ctx);
  const existing = inFlight.get(sessionId);
  if (existing?.fingerprint === fingerprint) return existing.promise;

  // 运行中会话的节流（见 RUNNING_PREVIEW_MIN_INTERVAL_MS）：窗口内复用上一次预览，
  // 不为「updatedAt 又动了一下」再读一遍日志。返回空 events 与 cache-hit 分支一致
  // ——完成态确认只在真正读回历史时进行，本轮不复用它的边沿判定。
  const clock = sessionPreviewClockOf(ctx);
  if (cached && summary.running && Date.now() - (clock.get(sessionId) || 0) < RUNNING_PREVIEW_MIN_INTERVAL_MS) {
    return { events: [], lastMessage: cached.lastMessage };
  }
  clock.set(sessionId, Date.now());

  const promise = Promise.resolve(callSessions(ctx, 'history', {
    sessionId,
    maxMessages: HISTORY_FOR_ENRICH,
  })).then((response) => {
    const h = unwrap(response);
    if (h.error) return { events: [], lastMessage: null };
    const events = (h.value && h.value.events) || [];
    const messages = deriveMessages(events);
    const last = lastMessageOf(messages);
    const lastMessage = last ? { role: last.role, text: last.text.slice(0, 200), at: last.time } : null;
    sessionPreviewStateOf(ctx).set(sessionId, { fingerprint, lastMessage });
    return { events, lastMessage };
  }).finally(() => {
    if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, { fingerprint, promise });
  return promise;
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
  const archivedOnly = new URL(req.url, 'http://x').searchParams.get('archived') === '1';
  const bypassCache = wantFresh || archivedOnly;
  if (wantFresh) {
    // 顺手作废更早发起的构建：它们手里的数据是写入之前的，若在新结果之后才落地会把旧列表又写回缓存。
    cache.value = null;
    cache.updatedAt = 0;
    generation = bumpCompletionGeneration(ctx, deviceKey);
  }
  if (!bypassCache && cache.value && now - cache.updatedAt < SESSION_LIST_CACHE_MS) {
    return sendJson(res, 200, cache.value);
  }

  if (!bypassCache && cache.promise) {
    const response = await cache.promise;
    return sendJson(res, response.status, response.body);
  }

  // 变更信号（镜像推送调度器先看见清单变了）会调 dropSessionListCache 丢掉这层缓存，
  // 但「丢掉」挡不住**已经在飞**的那次构建：它手里是变更之前的数据，落地后会在缓存里
  // 再活 10 秒。用缓存自带的朝代号兜住（见 session-cache.js 的 dropSessionListCache）。
  const epoch = cache.droppedAt || 0;
  const promise = buildSessionsResponse(ctx, deviceKey, generation, wantFresh, archivedOnly);
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
    return sendJson(res, response.status, response.body);
  } finally {
    if (cache.promise === promise) cache.promise = null;
  }
}

async function buildSessionsResponse(ctx, deviceKey = 'legacy', generation = completionGenerationOf(ctx, deviceKey), fresh = false, archivedOnly = false) {
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
  // archivedOnly（App 的「只看已归档」筛选视图）反过来只保留归档里的那些行：默认视图藏
  // 它们，筛选视图正是为了把它们找回来（查看 / 取消归档）。
  const { archived, pinned } = await workspaceSessionFlags(ctx);
  const allSummaries = archivedOnly
    ? summaries.filter(s => s && archived.has(s.sessionId))
    : summaries.filter(s => s && !archived.has(s.sessionId));
  // 状态跟踪覆盖完整列表，不能受预览补全上限影响。
  const completionStatesForContext = updateCompletionStates(ctx, allSummaries, deviceKey);
  // 列表完整返回：侧边栏分组依赖全部会话（工作区 sessionIds 排序 + 未分组兜底），
  // 截断会让工作区/项目下的会话凭空消失。标题直接取 list 摘要的 title 投影
  // （与桌面端侧栏同一来源，正式 session/title 事件折叠，绝不用对话正文冒充标题），
  // 该项是廉价字段；history 仅用于补「最后消息预览」，属于重活，见下方预览子集。
  const rows = allSummaries.map((s) => {
    const completionState = completionStatesForContext.get(s.sessionId);
    const base = {
      sessionId: s.sessionId,
      title: listTitle(s),
      running: !!s.running,
      ...(s.pendingInteraction === 'approval' || s.pendingInteraction === 'plan-review' || s.pendingInteraction === 'question'
        ? { pendingInteraction: s.pendingInteraction }
        : {}),
      completed: !!completionState?.completed,
      // 上一轮以错误收尾（由 completion.js 从 history 的 turn/end reason.kind 折出）。
      // 侧栏据此画红点：completed 只说「跑完了、待阅读」，说不了「跑挂了」。字段只在
      // 真有失败时出现，旧 App 忽略未知字段、行为不变。
      ...(completionState?.failure ? { lastTurnError: completionState.failure } : {}),
      blank: !!s.blank,
      cwd: s.cwd || null,
      // 会话定档的 Agent 预设（宿主 session.list 摘要里带，用来显示会话当前预设）。
      ...(typeof s.agentPreset === 'string' && s.agentPreset ? { agentPreset: s.agentPreset } : {}),
      // 置顶来自 workspace.list 的 pinnedSessionIds（宿主 session.list 摘要里没有这个字段），
      // 与归档同源同一份快照。App 侧栏据此把这条排到工作区最前、并在行尾画图钉标记。
      // 和归档一样只在真置顶时出现：旧 App 忽略未知字段，行为不变。
      ...(pinned.has(s.sessionId) ? { pinned: true } : {}),
      updatedAt: s.updatedAt || 0,
      lastMessage: null,
      ...(s.origin === 'subagent' ? { origin: s.origin } : {}),
      ...(typeof s.parentSessionId === 'string' ? { parentSessionId: s.parentSessionId } : {}),
    };
    return { summary: s, base };
  });
  // 预览子集：运行中优先（完成边沿确认不能缺），其次最近活跃；数量受
  // SESSIONS_PREVIEW_LIMIT 限制，避免会话多时每次列表请求都全量读历史日志。
  const previewCandidates = rows
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
        confirmCompletionFromHistory(completionState, events, !!s.running);
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
      base.lastMessage = preview.lastMessage;
    } catch {
      // 预览失败不影响标题与行数据。
    }
  }));
  const items = rows.map((r) => r.base);
  const generatedAt = Date.now();
  return {
    status: 200,
    body: {
      ok: true,
      items,
      // 数据新鲜度：App 把这两个字段连同快照一起存下来，就能把「这份数据是谁在什么
      // 时候给的」显示给用户，而不是只给一个「刚刚同步过」的客户端时间。revision 是
      // 内容指纹（跨插件重启稳定），App 也用它判断一次变更信号是否真的带来了新内容。
      generatedAt,
      revision: listRevision(items),
      // 显式空态：形状降级在上面的 500 分支里已被挡掉，能走到这里说明宿主回了一份
      // 合法清单 —— 「空」在这一点上是可断言的契约，不再需要 App 连续两次空去猜。
      // 下游（空清单守卫 / 中转缓存 / App 的空态判定）据此放行真实的「清空」。
      emptyConfirmed: items.length === 0,
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
    // 创建响应携带宿主当前选择；APP 可立即显示，完整目录仍可后台刷新。
    let models;
    try {
      const result = unwrap(await callSessions(ctx, 'models', { sessionId }));
      if (!result.error) models = safeModelsValue(result.value);
    } catch { /* 模型目录不可用时仍允许创建会话 */ }
    // 新建的会话要立刻出现在列表里，否则手机端最长 10 秒看不到它。
    invalidateSessionList(ctx);
    return {
      status: 200,
      body: {
        ok: true,
        sessionId,
        cwd: payload.cwd || null,
        ...(value && typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
        ...(models?.current ? { models } : {}),
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
  handleStop,
  handleRename,
  handleFork,
  handleModels,
  handleSelectModel,
  handleSessionSearch,
  handleAgentPresets,
  handleGoalAction,
};

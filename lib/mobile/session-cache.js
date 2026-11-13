'use strict';

/**
 * 会话侧的按 ctx 隔离状态：十九张表，一个入口。
 *
 * 这些表此前全是 sessions.js 的模块级 WeakMap。它们之所以必须按 ctx 隔离，是因为
 * 它们的值属于**宿主进程状态**（某个会话正在跑、某个列表刚构建完、某条发送已经
 * 幂等过），不同宿主 / 测试上下文混在一起会互相污染。
 *
 * 抽出来是为了让「哪些东西是模块级可变状态」这件事有个明确的名字和位置。此前它们
 * 和会话 handler 混在一个 1400 行文件里，读代码时得先分清哪行是状态、哪行是逻辑。
 * 抽完之后形状很干净：**每个访问器都保证返回的是那个表里给 ctx（或 ctx+device）
 * 建好的那个 Map/状态对象，调用方拿到就能直接用，不需要再判空。**
 *
 * 依赖方向：session-cache.js 不依赖任何上层模块，是叶子。
 */

// Model responses are derived metadata only. They are never populated with credentials
// or provider secrets, and the key includes the requesting device and session.
const sessionModelsCache = new WeakMap();
const MAX_SESSION_MODEL_CACHE_ENTRIES = 256;

const sessionListResponseCache = new WeakMap();
const deletedSessionState = new WeakMap();
const mirrorHistoryCache = new WeakMap();
// Cache only the derived last-message preview. The full history stays outside
// the cache so repeated mobile list refreshes do not re-read/decompress logs.
const sessionPreviewCache = new WeakMap();
const sessionPreviewInFlight = new WeakMap();
// 上一次真正重读该会话 history 补预览的时间（运行中会话的节流用，见 sessions.js）。
const sessionPreviewClock = new WeakMap();
// 完成提醒属于宿主进程状态：按 ctx 隔离，避免不同宿主/测试上下文互相污染。
const completionStates = new WeakMap();
const completionGenerations = new WeakMap();
// 「上一轮什么时候结束、成没成」——会话自己的事实，**不分设备**。
// 与 completionStates 的分工见 completion.js 的文件头：那个是「哪台手机还没看过」，
// 这个只回答「上一轮发生了什么」，所以它必须设备无关：镜像快照是全局一份、给所有设备读。
const lastTurnFacts = new WeakMap();
// Prevent duplicate prompt calls when a mobile request is retried after a timeout.
const sendIdempotency = new WeakMap();
// 写操作（新建/改名/归档/分叉）的 requestId 重放表：同一次写在换通道重投后不再执行第二遍。
// 与 sendIdempotency 分开是因为键与生命周期不同（那边按 sessionId+clientMessageId，
// 成功之后留到进程结束；这里是每次写各自的 requestId、只活在重投窗口里）。
const writeIdempotency = new WeakMap();

// 工作区列表的条件刷新短路：上次构建留下的 revision / 生成时刻 / 当时的信号代号。
// 与 sessionListResponseCache 同一类东西（列表刚构建完的那份是谁），只是按工作区算。
const workspaceShortcutStates = new WeakMap();

// 输出 token 用满之后「这一轮已经替用户代发过『继续』」的记账（见 mobile/auto-continue.js）。
// 只用来挡事件流重连的重放；续了几次由会话历史数出来，不放这里。
const autoContinueTurns = new WeakMap();

// 直播过程副本：还没落盘的那一轮里，推理增量、工具参数增量与工具结果先在内存里留一份，
// 用户点开「正在读取文件」那一步时由 `/session/step` 就地答（见 mobile/live-steps.js）。
// 它属于宿主进程状态（这一轮跑到哪了），所以按 ctx 隔离，和上面那些表放在一起。
const liveStepTurns = new WeakMap();

// 同一会话上「谁在往直播副本里写」。同一条会话可能同时挂着不止一条流（同一个聊天页开了
// 两屏、或重连时旧连接还没断干净），只让一个写入者累加，否则每段推理会被接两遍（见
// live-steps.js 的文件头）。按 ctx 隔离的理由同上 —— 它是这一轮的进程状态。
const liveStepWriters = new WeakMap();

// 同一会话上开着的各条流的摘钩表：写入者把算好的清单增量广播给其余屏（见 live-steps.js
// 的 attachLiveSteps / broadcastLiveSteps）。
const liveStepSinks = new WeakMap();

// 直播中的工作流运行：这一轮收到的 `tool-workflow/*` 事件攒成一份、折成运行→阶段→成员
// （见 workflow-live.js）。与上面的直播过程副本同一类状态：属于宿主进程里「这一轮跑到哪」，
// 所以按 ctx 隔离、按会话分桶。
const workflowLiveStates = new WeakMap();

// 隔离工作树的自动回收节流（见 worktree-lifecycle.js）：上次跑的时刻与在途标记。
// 收尾那一发挂在会话列表刷新上，是热点路径 —— 每台宿主各一份，不能跨 ctx 串。
const isolationSweepStates = new WeakMap();

// 交付声明补格的账（见 presented-file-stats.js）：这一台宿主上「`deriveMessages` 交回来的
// 数组 → 那次补齐的结果（可能还在飞）」。**下面那层按数组引用认**：派生缓存对同一份输入交回
// 的就是同一个数组，于是「同指纹第二次调用」连 stat 都不用发；换一份输入就是新数组，自然重算。
const presentedFileStats = new WeakMap();

/** 设备维度：同一个 ctx 下多台手机各自一份，缺省用 'legacy'（未带 x-dsh-device 的调用）。 */
function canonicalDeviceKey(req, fallback = 'legacy') {
  const value = req?.headers?.['x-dsh-device'];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sessionModelsStateOf(ctx, deviceKey, sessionId) {
  let state = sessionModelsCache.get(ctx);
  if (!state) { state = new Map(); sessionModelsCache.set(ctx, state); }
  const key = `${deviceKey}\0${sessionId}`;
  let entry = state.get(key);
  if (!entry) {
    while (state.size >= MAX_SESSION_MODEL_CACHE_ENTRIES) state.delete(state.keys().next().value);
    entry = { value: null, fetchedAt: 0, promise: null };
  } else {
    // Treat accesses as recent so active sessions survive the bounded eviction.
    state.delete(key);
  }
  state.set(key, entry);
  return entry;
}

function invalidateSessionModels(ctx, req, sessionId) {
  const deviceKey = canonicalDeviceKey(req);
  const state = sessionModelsCache.get(ctx);
  state?.delete(`${deviceKey}\0${sessionId}`);
}

/**
 * 这台设备上**所有**会话的模型目录一起作废。
 *
 * 模型目录是设备级的（同一台宿主的渠道清单不随会话变），缓存却按 `设备 + 会话` 存。
 * 渠道增删之后只清一条的话，其余会话在 TTL 内继续回旧目录——症状是「刚加的渠道，
 * 在这个会话里有、换一个会话又没了」。
 */
function dropSessionModelsForDevice(ctx, req) {
  const deviceKey = canonicalDeviceKey(req);
  const state = sessionModelsCache.get(ctx);
  if (!state) return;
  const prefix = `${deviceKey}\0`;
  for (const key of [...state.keys()]) {
    if (key.startsWith(prefix)) state.delete(key);
  }
}

function sessionListResponseState(ctx, deviceKey = 'legacy') {
  let byDevice = sessionListResponseCache.get(ctx);
  if (!byDevice) {
    byDevice = new Map();
    sessionListResponseCache.set(ctx, byDevice);
  }
  let state = byDevice.get(deviceKey);
  if (!state) {
    // droppedAt 是这份缓存的「朝代」：dropSessionListCache 每次丢弃内容就 +1，
    // 于是变更前发起的那次构建落地时能看出自己的数据已经过时（见 handleSessions）。
    state = { value: null, updatedAt: 0, promise: null, droppedAt: 0 };
    byDevice.set(deviceKey, state);
  }
  return state;
}

function sessionCleanupStateOf(ctx) {
  let state = deletedSessionState.get(ctx);
  if (!state) {
    state = { deleted: new Set() };
    deletedSessionState.set(ctx, state);
  }
  return state;
}

function rememberDeletedSessionIds(ctx, sessionIds) {
  const state = sessionCleanupStateOf(ctx);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== 'string' || !sessionId) continue;
    state.deleted.add(sessionId);
  }
}

function deletedSessionIdsOf(ctx) {
  return sessionCleanupStateOf(ctx).deleted;
}

function sessionPreviewStateOf(ctx) {
  let state = sessionPreviewCache.get(ctx);
  if (!state) {
    state = new Map();
    sessionPreviewCache.set(ctx, state);
  }
  return state;
}

function sessionPreviewInFlightStateOf(ctx) {
  let state = sessionPreviewInFlight.get(ctx);
  if (!state) {
    state = new Map();
    sessionPreviewInFlight.set(ctx, state);
  }
  return state;
}

/** 运行中会话上一次补预览的时间戳表（按 ctx 隔离，见 sessions.js 的节流）。 */
function sessionPreviewClockOf(ctx) {
  let state = sessionPreviewClock.get(ctx);
  if (!state) {
    state = new Map();
    sessionPreviewClock.set(ctx, state);
  }
  return state;
}

/** 镜像用的历史缓存：按 ctx 一张 Map，key 自带 LRU 淘汰。 */
function mirrorHistoryStateOf(ctx) {
  let cache = mirrorHistoryCache.get(ctx);
  if (!cache) { cache = new Map(); mirrorHistoryCache.set(ctx, cache); }
  return cache;
}

function completionStateOf(ctx, deviceKey = 'legacy') {
  let byDevice = completionStates.get(ctx);
  if (!byDevice) {
    byDevice = new Map();
    completionStates.set(ctx, byDevice);
  }
  let states = byDevice.get(deviceKey);
  if (!states) {
    states = new Map();
    byDevice.set(deviceKey, states);
  }
  return states;
}

function completionStateMapsOf(ctx) {
  return [...(completionStates.get(ctx)?.values() || [])];
}

/**
 * 会话「上一轮结局」的设备无关台账：`sessionId → { turn, endedAt, kind, error }`。
 *
 * 它存在的理由是**镜像快照要给所有设备读**：快照是全局一份，没法按「现在是谁在问」
 * 去算「你看过没有」。所以列表只带这一份事实（这一轮什么时候结束的、成没成），
 * 「读过没有」由 App 自己按设备存的水位去比。详见 completion.js 的文件头。
 */
function lastTurnFactsOf(ctx) {
  let facts = lastTurnFacts.get(ctx);
  if (!facts) { facts = new Map(); lastTurnFacts.set(ctx, facts); }
  return facts;
}

/**
 * 标记「这条会话读过了」：记一个水位，把当前的完成 / 失败提醒清掉，返回清掉的条数。
 *
 * 不删条目：删掉之后重建的条目会丢掉水位，「读过的轮次」会在下一次 history 折叠里重新点亮。
 * 水位才是「这个时刻之前的轮次不算数」的唯一凭据。
 */
function markCompletionRead(ctx, deviceKey, sessionId, at = Date.now()) {
  const state = completionStates.get(ctx)?.get(deviceKey)?.get(sessionId);
  if (!state) return 0;
  const had = state.completed === true || !!state.failure;
  state.clearedAt = at;
  state.completed = false;
  state.failure = undefined;
  // 已读要压过「本进程看见过它跑」这一条（见 completion.js 的 baselineOf）：
  // 否则同一轮会在下一次列表折叠里又亮回来。
  state.wasRunning = false;
  return had ? 1 : 0;
}

/**
 * 清掉某个会话在**所有**设备维度上的完成提醒，返回真正清掉过的设备数。
 *
 * 用于**桌面端说「我读过了」**——读一次就是读过了，不该只清某台设备。手机上点开
 * 走 markCompletionRead 只清自己那台（每台手机各有一份，互不干扰）。
 */
function clearCompletionForAllDevices(ctx, sessionId, at = Date.now()) {
  const byDevice = completionStates.get(ctx);
  if (!byDevice) return 0;
  let cleared = 0;
  for (const deviceKey of byDevice.keys()) cleared += markCompletionRead(ctx, deviceKey, sessionId, at);
  return cleared;
}

/**
 * 工作区列表短路的记忆体：客户端 rev、上次生成时刻、当时的信号 revision、上次构建时刻。
 * 与其它表同样按 ctx 隔离 —— 不同宿主的工作区快照互不相干。
 */
function workspaceShortcutStateOf(ctx) {
  let state = workspaceShortcutStates.get(ctx);
  if (!state) {
    state = { lastRevision: '', lastGeneratedAt: 0, lastSignalRevision: '', lastBuiltAt: 0 };
    workspaceShortcutStates.set(ctx, state);
  }
  return state;
}

/**
 * 「这一轮已经替用户代发过『继续』」的记账：sessionId → 轮次。
 *
 * 只挡事件流重连的重放（同一轮会到两条 `turn/end`），不做次数上限 —— 次数由会话历史里
 * 连续的代发消息数出来，见 `mobile/auto-continue.js` 的文件头。
 */
function autoContinueTurnsOf(ctx) {
  let turns = autoContinueTurns.get(ctx);
  if (!turns) {
    turns = new Map();
    autoContinueTurns.set(ctx, turns);
  }
  return turns;
}

/**
 * 隔离工作树回收的节流状态：`{ lastAt, running }`。
 *
 * 与其它访问器同一口径 —— 保证返回的一定是给这个 ctx 建好的那个对象，调用方拿到直接用。
 */
function isolationSweepStateOf(ctx) {
  let state = isolationSweepStates.get(ctx);
  if (!state) {
    state = { lastAt: 0, running: false };
    isolationSweepStates.set(ctx, state);
  }
  return state;
}

/**
 * 交付声明补格的账：这一台宿主上「`deriveMessages` 交回来的数组 → 那次补齐的结果
 * （可能还在飞的 promise）」。
 *
 * 桶内键是**数组引用**而不是会话 id：派生缓存对同一份输入交回的就是同一个数组，于是同一
 * 指纹的第二次调用直接命中，一次 stat 都不再发；换一份输入本来就是新数组，自然重算。
 * 桶有上限（派生缓存每个会话也只留几条版本），删掉的是最旧的那一条。
 */
const PRESENTED_STATS_MAX_ENTRIES = 128;

function presentedFileStatsOf(ctx, messages) {
  const bucket = presentedFileStats.get(ctx);
  if (!bucket) return undefined;
  const hit = bucket.get(messages);
  if (hit === undefined) return undefined;
  // 读到就挪到末尾：按使用序淘汰，别把正在看的那条会话挤掉。
  bucket.delete(messages);
  bucket.set(messages, hit);
  return hit;
}

/** 记下这一次补齐（`pending` 是在飞的 promise 或已算好的结果）。 */
function rememberPresentedFileStats(ctx, messages, pending) {
  let bucket = presentedFileStats.get(ctx);
  if (!bucket) {
    bucket = new Map();
    presentedFileStats.set(ctx, bucket);
  }
  bucket.delete(messages);
  bucket.set(messages, pending);
  while (bucket.size > PRESENTED_STATS_MAX_ENTRIES) bucket.delete(bucket.keys().next().value);
  return pending;
}

/** 忘掉一次补齐（超时 / 失败时用：下一发同指纹要能再试一次）。 */
function forgetPresentedFileStats(ctx, messages) {
  const bucket = presentedFileStats.get(ctx);
  if (bucket) bucket.delete(messages);
}

function completionGenerationOf(ctx, deviceKey) {
  let generations = completionGenerations.get(ctx);
  if (!generations) {
    generations = new Map();
    completionGenerations.set(ctx, generations);
  }
  return generations.get(deviceKey) || 0;
}

function bumpCompletionGeneration(ctx, deviceKey) {
  const next = completionGenerationOf(ctx, deviceKey) + 1;
  completionGenerations.get(ctx).set(deviceKey, next);
  return next;
}

function sendIdempotencyStateOf(ctx) {
  let state = sendIdempotency.get(ctx);
  if (!state) {
    state = new Map();
    sendIdempotency.set(ctx, state);
  }
  return state;
}

/**
 * 同一个投递 id 在一次会话里只真正跑一次：成功之后记录留到进程结束，失败立刻释放。
 *
 * 要防的是「请求超时、但那一发其实已经交给宿主了」这一档：App 会拿着同一个
 * clientMessageId 再发一次（内核重试或用户手点重试），第二次必须拿到第一次的结果，
 * 而不是让模型 / 子代理把同一句话再说一遍。
 *
 * **失败不占位**：`run` 回的信封不是成功（宿主明确拒绝，如 model-unavailable /
 * agent-busy）就当场删掉记录 —— 一次瞬时错误不能被固化成「这个 id 永远只回这一句错」；
 * 同理 `run` 抛错（传输层失败）也删。两条都必须是「真的再试一次」，否则活的路径只剩
 * 用户重开 App。
 *
 * @param {object} ctx 插件上下文（状态按 ctx 隔离）
 * @param {string} key 投递身份：主会话 `sessionId:clientMessageId`，子代理额外加前缀
 * @param {() => Promise<object>} run 真正发一次，回宿主信封（`{ result: { ok, value | error } }`）
 */
function promptOnceFor(ctx, key, run) {
  const state = sendIdempotencyStateOf(ctx);
  const existing = state.get(key);
  if (existing) return existing.promise;

  const promise = Promise.resolve().then(run);
  const record = { promise };
  state.set(key, record);
  const release = () => { if (state.get(key) === record) state.delete(key); };
  promise.then(
    (response) => {
      // 留下的这条记录就是「这一发已经交给宿主了」的回执；宿主明确拒绝（信封 ok 不为真）
      // 就当场释放 —— 一次业务错误不能被固化成「这个 id 永远只回这一句」。这里只看收没
      // 收下，不拆错误信封（拆信封在 envelope.js，本文件是零依赖的叶子）。
      const accepted = Boolean(response && response.result && response.result.ok === true);
      if (!accepted) release();
    },
    release,
  );
  return promise;
}

/** 写操作幂等表（实现在 mobile/idempotency.js，这里只保证按 ctx 隔离）。 */
function writeIdempotencyStateOf(ctx) {
  let state = writeIdempotency.get(ctx);
  if (!state) {
    state = new Map();
    writeIdempotency.set(ctx, state);
  }
  return state;
}

/**
 * 丢弃会话列表缓存（含正在构建的那一次）。
 *
 * `/sessions` 的完整响应缓存 10 秒，本意是压住手机轮询对桌面的冲击；但凡是改变列表内容的
 * 动作都必须立刻丢掉它，否则 App 在自己刚做完的动作上看到的是最长 10 秒前的旧数据。
 *
 * 只清 `value` 不够：正有一次构建在飞时，它读的是变更前的历史，落地后会把旧数据写回缓存。
 * 所以连 `promise` 一起清，并用 completion generation 兜住。
 *
 * @param {object} ctx
 * @param {string} [deviceKey] 只清这一台设备的缓存；缺省清掉该 ctx 下所有设备。
 */
function invalidateSessionList(ctx, deviceKey) {
  const byDevice = sessionListResponseCache.get(ctx);
  if (!byDevice) return;
  const keys = deviceKey === undefined ? [...byDevice.keys()] : [deviceKey];
  for (const key of keys) {
    const state = byDevice.get(key);
    if (!state) continue;
    state.value = null;
    state.updatedAt = 0;
    state.promise = null;
    bumpCompletionGeneration(ctx, key);
  }
}

/**
 * 丢弃会话列表缓存，但不抬 completion generation。
 *
 * 与 invalidateSessionList 的分工：那个用于「写操作刚发生」，必须连在飞构建与完成态一起
 * 作废；这个用于「宿主的清单内容变了，镜像推送调度器先看见了」。后者每 500ms 就会发生一次，
 * 若也抬 generation，`confirmCompletionFromHistory` 就再也执行不到，侧栏 completed / 红点会
 * 彻底不亮。
 *
 * 所以在飞构建靠状态自带的「朝代」（droppedAt）作废：建构建前记下朝代，落地时发现变了就不
 * 把旧内容写回缓存。
 *
 * @param {object} ctx
 * @param {string} [deviceKey] 只丢这一台设备的缓存；缺省丢掉该 ctx 下所有设备。
 */
function dropSessionListCache(ctx, deviceKey) {
  const byDevice = sessionListResponseCache.get(ctx);
  if (!byDevice) return;
  const keys = deviceKey === undefined ? [...byDevice.keys()] : [deviceKey];
  for (const key of keys) {
    const state = byDevice.get(key);
    if (!state) continue;
    state.value = null;
    state.updatedAt = 0;
    state.droppedAt = (state.droppedAt || 0) + 1;
  }
}

/** 直播过程副本的容器：`ctx → Map<sessionId, turn>`，换一轮就地覆盖（见 live-steps.js）。 */
function liveStepTurnOf(ctx) {
  let state = liveStepTurns.get(ctx);
  if (!state) {
    state = new Map();
    liveStepTurns.set(ctx, state);
  }
  return state;
}

/** 直播副本的写入者登记表：`ctx → Map<sessionId, writerId>`（见 live-steps.js）。 */
function liveStepWriterOf(ctx) {
  let state = liveStepWriters.get(ctx);
  if (!state) {
    state = new Map();
    liveStepWriters.set(ctx, state);
  }
  return state;
}

/** 同一会话上各条流的清单接收器：`ctx → Map<sessionId, Set<sink>>`（见 live-steps.js）。 */
function liveStepSinkOf(ctx) {
  let state = liveStepSinks.get(ctx);
  if (!state) {
    state = new Map();
    liveStepSinks.set(ctx, state);
  }
  return state;
}

/** 直播中的工作流运行：`ctx → Map<sessionId, { entries, runs }>`（见 workflow-live.js）。 */
function workflowLiveOf(ctx) {
  let state = workflowLiveStates.get(ctx);
  if (!state) {
    state = new Map();
    workflowLiveStates.set(ctx, state);
  }
  return state;
}

module.exports = {
  canonicalDeviceKey,
  liveStepTurnOf,
  liveStepWriterOf,
  liveStepSinkOf,
  workflowLiveOf,
  sessionModelsStateOf,
  invalidateSessionModels,
  dropSessionModelsForDevice,
  sessionListResponseState,
  invalidateSessionList,
  rememberDeletedSessionIds,
  deletedSessionIdsOf,
  dropSessionListCache,
  sessionPreviewStateOf,
  sessionPreviewInFlightStateOf,
  sessionPreviewClockOf,
  mirrorHistoryStateOf,
  completionStateOf,
  completionStateMapsOf,
  lastTurnFactsOf,
  markCompletionRead,
  clearCompletionForAllDevices,
  completionGenerationOf,
  workspaceShortcutStateOf,
  autoContinueTurnsOf,
  isolationSweepStateOf,
  presentedFileStatsOf,
  rememberPresentedFileStats,
  forgetPresentedFileStats,
  bumpCompletionGeneration,
  sendIdempotencyStateOf,
  promptOnceFor,
  writeIdempotencyStateOf,
};
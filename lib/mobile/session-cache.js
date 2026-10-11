'use strict';

/**
 * 会话侧的按 ctx 隔离状态：十一张表，一个入口。
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
// Prevent duplicate prompt calls when a mobile request is retried after a timeout.
const sendIdempotency = new WeakMap();
// 写操作（新建/改名/归档/分叉）的 requestId 重放表：同一次写在换通道重投后不再执行第二遍。
// 与 sendIdempotency 分开是因为键与生命周期不同（那边按 sessionId+clientMessageId，60s）。
const writeIdempotency = new WeakMap();

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

/**
 * 清掉某个会话在**所有**设备维度上的完成提醒，返回真正清掉的设备数。
 *
 * 与 handleSessionRead 里那句 `completionStateOf(ctx, deviceKey).delete(...)` 的区别：
 * 那个只清「刚点开的那台手机」自己的提醒（每台手机各有一份，互不干扰）；这个用于
 * **桌面端说「我读过了」**——读一次就是读过了，不该只清某台设备。
 *
 * 清掉（而不是标记成已读）是刻意的：重建出来的条目 `wasRunning` 为 false，历史折叠
 * （completion.js 的 confirmCompletionFromHistory）会因此拒绝确认，于是**之后**完成的
 * 轮次照样能重新亮起来 —— 「新一轮完成压过更早的已读」这条语义就落在这里。
 */
function clearCompletionForAllDevices(ctx, sessionId) {
  const byDevice = completionStates.get(ctx);
  if (!byDevice) return 0;
  let cleared = 0;
  for (const states of byDevice.values()) {
    if (states.delete(sessionId)) cleared += 1;
  }
  return cleared;
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
 * `/sessions` 的完整响应会缓存 SESSION_LIST_CACHE_MS（10 秒），本意是压住手机轮询对
 * 桌面的冲击。但凡是**改变列表内容**的动作都必须立刻把它丢掉，否则 App 在自己刚做完
 * 的动作上看到的是最长 10 秒前的旧数据——真机上「重命名会话」保存后侧栏那一行纹丝不
 * 动、「归档会话」按下去那一行照旧留着，看着都像没生效（宿主的标题其实早就改了）。
 *
 * 只清 `value` 不够：若此刻正有一次构建在飞，它读的是变更前的历史，落地后会把旧数据
 * 又写回缓存。所以连 `promise` 一起清，并用 completion generation 兜住（与
 * handleSessionRead 同款守卫，见那里的注释）。
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
 * 丢弃会话列表缓存，但**不抬 completion generation**。
 *
 * 与 invalidateSessionList 的分工：那个用于「写操作刚发生」，必须连在飞构建与完成态
 * 一起作废；这个用于「宿主的清单内容变了，我（镜像推送调度器）先看见了」。后者在生成期
 * 每 500ms 就会发生一次（会话的 updatedAt 一直在动），如果也抬 generation，
 * buildSessionsResponse 里那句 `completionGenerationOf(...) === generation` 就永远不成立，
 * `confirmCompletionFromHistory` 再也执行不到 —— 侧栏的 completed / 红点会彻底不亮。
 *
 * 所以在飞构建靠状态自带的「朝代」（droppedAt）而不是 generation 来作废：handleSessions
 * 建构建前记下朝代，落地时发现朝代变了就不把旧内容写回缓存。这样既不需要抬 generation，
 * 又不会出现「变更前发起的那次构建在变更后落地，把旧列表按新时间戳缓存 10 秒」。
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

module.exports = {
  canonicalDeviceKey,
  sessionModelsStateOf,
  invalidateSessionModels,
  sessionListResponseState,
  invalidateSessionList,
  dropSessionListCache,
  sessionPreviewStateOf,
  sessionPreviewInFlightStateOf,
  sessionPreviewClockOf,
  mirrorHistoryStateOf,
  completionStateOf,
  clearCompletionForAllDevices,
  completionGenerationOf,
  bumpCompletionGeneration,
  sendIdempotencyStateOf,
  writeIdempotencyStateOf,
};
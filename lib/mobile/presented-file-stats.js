'use strict';

/**
 * 交付声明补格：把 `deliverables/presented` 里每一份的 size / mtime 一起带上。
 *
 * 轮尾那张「交付文件卡」的第二行要写「1.2 MB · 今天 14:32」。电脑这边本来就知道文件在哪，
 * 所以在**投影交付声明时顺手量一下**，手机端一条额外请求都不用发。
 *
 * 三条硬约束，改的时候别破：
 *
 * 1. **放行面复用 `createSessionFileScope`**（经 `session-artifacts.js` 的 `inspectPaths`）：
 *    能 stat 的路径 = 本来就能下载的那一批（本会话工作区 ∪ 本会话声明过）。这里一次也**不**
 *    直接 `fs.stat` 任意路径 —— 那等于把移动 API 的读口子开到整台机器上。
 * 2. **不许拖慢 `/session/messages`**：只在出现交付声明的路径上做、并发封在
 *    `ARTIFACT_STAT_CONCURRENCY`（8），整批还有总预算，超时就当没补。开屏与轮询是主路径，
 *    网络盘上一条 stat 卡住也不能把整页消息一起钉住。
 * 3. **失败一律静默降级**：denied / missing / stat 抛错 / 超时 → 该条就只有 path
 *    （+description），不抛错、不改 HTTP 状态码、不影响这一页的其它内容。
 *
 * 缓存都不落盘（与 `session-artifacts.js` 同一个口径，见 A1-139 的坑），分两层：
 *  - 投影那一路：`deriveMessages` 的结果本来就在 `derived-cache` 里按事件指纹缓存，同一份
 *    结果第二次出来是**同一个数组引用**，所以这里按那个引用记账（表住在 `session-cache.js`，
 *    模块级可变状态只许在那儿）—— 同指纹的第二次调用一次 stat 都不发。补齐后的数组是新的，
 *    缓存里那份保持只读不变。
 *  - 实时流那一路：按 `callId` 记一条在飞 / 已完成的 promise，同一帧重发不重复 stat。
 */

const {
  inspectPaths,
  ARTIFACT_STAT_CONCURRENCY,
} = require('./session-artifacts.js');
const {
  presentedFileStatsOf,
  rememberPresentedFileStats,
  forgetPresentedFileStats,
} = require('./session-cache.js');

/**
 * 投影那一路的整批预算。
 *
 * 一页里的交付文件通常在个位数到十几个，局域网盘上批量 stat 是个位数毫秒；1500ms 是给
 * 「网络盘 / 文件被别的进程占着」留的余量，到点就放弃补齐照常返回 —— 那两格字值不了更长。
 */
const PRESENTED_STAT_BUDGET_MS = 1500;

/**
 * 实时流那一帧的预算。
 *
 * **远小于投影那一路**，因为它卡的是帧顺序而不是一页响应：`deliverables/presented` 要排在
 * 收尾正文之后发出去，后面的帧才跟着走。弱网 + 长任务下，晚两格字比晚一整帧糟得多 ——
 * 超时就发未补的版本，绝不 await 到底。
 */
const PRESENTED_FRAME_STAT_BUDGET_MS = 400;

/**
 * 跑一批 stat，但最多等 `budgetMs`。
 *
 * 超时回 `null`（调用方据此发未补的版本）。已经开始的那批不取消：它自己会跑完，结果丢掉就是。
 * `inspectPaths` 内部逐条兜住，所以这里不该有异常冒出来 —— 真冒出来也按「没补」处理。
 *
 * @returns {Promise<Array|null>}
 */
function statWithinBudget(ctx, sessionId, paths, budgetMs) {
  if (paths.length === 0) return Promise.resolve([]);
  if (!(budgetMs > 0)) return Promise.resolve(null);
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    // 定时器不该拖住进程退出（与 stream.js 的 keepAlive 同一条理由）。
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const work = inspectPaths(ctx, sessionId, paths).catch(() => null);
  return Promise.race([work, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 把 `rows` 里的 size/mtime 盖回文件对象；没量到的保持原样。 */
function applyStats(files, rows) {
  const byPath = new Map();
  for (const row of rows) {
    if (row && row.status === 'ok') byPath.set(row.path, row);
  }
  if (byPath.size === 0) return files;
  return files.map((file) => {
    const row = byPath.get(file.path);
    if (!row) return file;
    return { ...file, size: row.size, mtime: row.mtime };
  });
}

/**
 * 一批消息上的交付声明要不要补格：收集去重后的路径。
 *
 * @param {unknown[]} messages `deriveMessages` 的输出
 */
function presentedPathsIn(messages) {
  const paths = [];
  const seen = new Set();
  for (const item of messages) {
    if (!item || !Array.isArray(item.presentedFiles)) continue;
    for (const file of item.presentedFiles) {
      if (!file || typeof file.path !== 'string' || file.path === '') continue;
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      paths.push(file.path);
    }
  }
  return paths;
}

/**
 * 给 `deriveMessages` 的输出补上交付文件的 size / mtime。
 *
 * 返回**新的**消息数组（只有带 `presentedFiles` 的那几条是新的对象），没补到任何一条时原样
 * 返回入参 —— 调用方可以按引用判断「有没有变化」。`messages` 本身是 `derived-cache` 交回来
 * 的那份，**不许就地改**（见 `shared/derived-cache.js`）。
 *
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @param {unknown[]} messages `deriveMessages` 出来的消息
 * @param {{budgetMs?: number}} [options]
 * @returns {Promise<unknown[]>}
 */
function withPresentedFileStats(ctx, sessionId, messages, options = {}) {
  if (!sessionId || !Array.isArray(messages) || messages.length === 0) return Promise.resolve(messages);
  return statsRowsFor(ctx, sessionId, messages, options)
    .then((rows) => applyRows(messages, rows));
}

/**
 * 这一批消息要量哪些路径，量到的那些行按「消息数组」记账。
 *
 * 记的键是 `messages` 引用本身：`deriveMessages` 的缓存对同一份事件交回同一个数组，所以
 * 同一指纹的第二次调用在这里直接命中，一次 stat 都不再发。
 */
function statsRowsFor(ctx, sessionId, messages, options = {}) {
  const paths = presentedPathsIn(messages);
  if (paths.length === 0) return Promise.resolve([]);
  const cached = presentedFileStatsOf(ctx, messages);
  if (cached) return cached;
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : PRESENTED_STAT_BUDGET_MS;
  const pending = statWithinBudget(ctx, sessionId, paths, budgetMs).then((rows) => {
    // 超时：**不记账**。这一发只是没等到，下一发同指纹还能再试一次。
    if (rows === null) {
      forgetPresentedFileStats(ctx, messages);
      return [];
    }
    return rows;
  }).catch(() => {
    forgetPresentedFileStats(ctx, messages);
    return [];
  });
  rememberPresentedFileStats(ctx, messages, pending);
  return pending;
}

/** 把量到的那些行盖回消息里的 `presentedFiles`；一条都没盖上时原样返回入参。 */
function applyRows(messages, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return messages;
  let changed = false;
  const next = messages.map((item) => {
    if (!item || !Array.isArray(item.presentedFiles) || item.presentedFiles.length === 0) return item;
    const files = applyStats(item.presentedFiles, rows);
    if (files === item.presentedFiles) return item;
    changed = true;
    return { ...item, presentedFiles: files };
  });
  return changed ? next : messages;
}

/**
 * 实时流那一帧的补格器（**一条流一份**）。
 *
 * `deliverables/presented` 在流里就是原样转发的一帧，事件本身不带 size/mtime。这里按
 * `callId` 记账：同一帧重复到达（回放 + 实时交界、或者宿主重发）不再 stat 一遍；超过这一帧的
 * 小预算就发未补的版本，帧顺序优先。
 *
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @param {{budgetMs?: number}} [options]
 */
function createPresentedStats(ctx, sessionId, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : PRESENTED_FRAME_STAT_BUDGET_MS;
  /** 帧身份 → 量到的那些行（这一条流自己的小账，不进上面那张按引用的表）。 */
  const done = new Map();
  /** 帧身份 → 在飞的那一趟（同一帧并发到达时合并，别各 stat 一遍）。 */
  const inFlight = new Map();

  /** 帧身份：有 `callId` 就用它，没有就按路径清单认（一轮里也就一两帧）。 */
  const keyOf = (data, files) => {
    if (typeof data.callId === 'string' && data.callId !== '') return `c:${data.callId}`;
    return `p:${files.map((file) => file.path).join('\u0000')}`;
  };

  /**
   * 给一帧 `deliverables/presented` 补 size / mtime。
   *
   * 回**新的**事件对象（`data.files` 换掉），任何失败 / 超时都原样回入参。
   */
  async function enrich(event) {
    if (!event || event.type !== 'deliverables/presented') return event;
    const data = event.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.files) || data.files.length === 0) return event;
    const files = data.files.filter((file) => file && typeof file.path === 'string' && file.path !== '');
    if (files.length === 0) return event;
    const key = keyOf(data, files);
    const settled = done.get(key);
    if (settled !== undefined) {
      if (!settled) return event;
      return { ...event, data: { ...data, files: applyStats(data.files, settled) } };
    }
    let pending = inFlight.get(key);
    if (!pending) {
      const paths = [...new Set(files.map((file) => file.path))];
      pending = statWithinBudget(ctx, sessionId, paths, budgetMs)
        .then((rows) => {
          // 超时 / 整批失败：这一帧发未补的版本，且不记账 —— 下一帧同样的 key 允许再试。
          if (rows === null) done.delete(key);
          else done.set(key, rows);
          return rows;
        })
        .catch(() => {
          done.delete(key);
          return null;
        })
        .finally(() => { inFlight.delete(key); });
      inFlight.set(key, pending);
    }
    const rows = await pending;
    if (rows === null) return event;
    return { ...event, data: { ...data, files: applyStats(data.files, rows) } };
  }

  return { enrich };
}

module.exports = {
  withPresentedFileStats,
  createPresentedStats,
  PRESENTED_STAT_BUDGET_MS,
  PRESENTED_FRAME_STAT_BUDGET_MS,
  ARTIFACT_STAT_CONCURRENCY,
};

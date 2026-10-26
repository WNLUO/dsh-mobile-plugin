'use strict';

/**
 * 统计采集：把宿主每条会话的累计用量读出来，和水位一比，增量记进账本。
 *
 * 不重放会话事件：手机要的是「按天看个大概」，重放整条日志是每秒都在烧的开销。所以走水位差
 * （宿主累计值 − 账本水位 = 这次入账的量），零依赖，代价是入账日期取「插件看到增量的那一天」，
 * 跨零点的一轮会落在后一天。首采会把历史全量入账，日期取它最后一次活动的日期，算一次性回填。
 *
 * 采集是按需的（打开统计页 / 下拉刷新 / 清理已归档前补一刀），没有后台定时器。
 *
 * 清理前那次补采（`skipPreview`）不读「最后一句」：那一步要读会话日志，是整轮最重的一趟，
 * 而删除不可恢复、时间又卡在请求预算里。宁可让首次见到的会话卡片少一行摘要。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { sessionPreviewFor } = require('./session-preview.js');
const ledger = require('./stats-ledger.cjs');

/** 同一条会话两次采集之间的最小间隔（打开页面时的重复请求直接复用上一轮结果）。 */
const COLLECT_INTERVAL_MS = 60_000;

/** 并发读投影的条数：宿主那侧是内存里读缓存，四条并行不会把它压住。 */
const CONCURRENCY = 4;

/**
 * 这一轮先扫「最近还在动」的会话，再按「最久没采过」补老账。
 *
 * 只按最后活动时间倒序扫会让最老的那批永远排在队尾、永远采不到。所以队列分两段：近 7 天有
 * 动作的优先（它们才是数字在变的那批），其余按 `collectedAt` 升序 —— 采过的会把时间推到当下、
 * 自动排到队尾，每一轮的预算接着上一轮往下走，不需要额外持久化游标。
 */
const RECENT_WINDOW_MS = 7 * 86400_000;

/**
 * 一次采集的时间预算。
 *
 * 手机上点开统计页时，插件会当场把每条会话的累计用量读一遍；一百多条会话串起来能拖到
 * 十几秒（每条两趟宿主调用），用户看到的就是「点统计，转好久」。
 * 所以给这一趟设上限：到点就停，把**已经采到的**那部分记进账本先回给手机，剩下的等
 * 下一次打开 / 下拉刷新接着采 —— 水位差是累积的，采一半不会算错，只是数字暂时偏小。
 */
const DEFAULT_BUDGET_MS = 1500;

const num = ledger.num;

function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\/+$/, '');
}

/** 宿主会话列表：拿不到就当没有（清空或报错都不该把账本弄乱）。 */
async function listSessions(ctx) {
  try {
    const { value } = unwrap(await callSessions(ctx, 'list', {}, 'mobile'));
    const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null);
    if (items === null) return null;
    return items.filter((item) => item && typeof item.sessionId === 'string' && item.sessionId);
  } catch {
    return null;
  }
}

/** cwd → 项目展示名。宿主没给可用的工作区表就返回空表，卡片上就不显示项目名。 */
async function workspaceNames(ctx) {
  const byCwd = new Map();
  try {
    const { value } = unwrap(await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} }));
    const workspaces = value && Array.isArray(value.workspaces) ? value.workspaces : [];
    for (const workspace of workspaces) {
      if (!workspace || typeof workspace !== 'object') continue;
      const cwd = normalizePath(workspace.cwd);
      const name = typeof workspace.name === 'string' ? workspace.name : '';
      if (cwd && name) byCwd.set(cwd, name);
    }
  } catch {
    /* 拿不到项目名不影响数字 */
  }
  return byCwd;
}

/** 一条会话的投影（tokenUsage / sessionStats / contextBreakdown）；读不到返回 null。 */
async function readProjections(ctx, sessionId) {
  const controller = new AbortController();
  try {
    const { value } = unwrap(await callSessions(ctx, 'projections', { sessionId }, 'mobile', controller.signal));
    const values = value && value.values && typeof value.values === 'object' ? value.values : null;
    return values;
  } catch {
    return null;
  }
}

/** 宿主那份累计用量 → 账本口径。缺哪项就当 0，不猜。 */
function hostUsageOf(projections) {
  const usage = ledger.emptyUsage();
  if (!projections || typeof projections !== 'object') return usage;
  const token = projections.tokenUsage;
  if (token && typeof token === 'object') {
    usage.uncachedInputTokens = num(token.uncachedInputTokens);
    usage.cacheReadTokens = num(token.cacheReadTokens);
    usage.cacheWriteTokens = num(token.cacheWriteTokens);
    usage.outputTokens = num(token.outputTokens);
  }
  const stats = projections.sessionStats;
  if (stats && typeof stats === 'object') {
    usage.turns = num(stats.turns);
    usage.steps = num(stats.steps);
    usage.llmMs = num(stats.llmMs);
    usage.toolMs = num(stats.toolMs);
  }
  return usage;
}

/**
 * 增量：宿主累计减水位。累计值比水位还小只可能是会话日志被重写 / 换了宿主，
 * 这时按新值全额入账（宁可多记一次，也不要从此永远少记）。
 */
function diffUsage(host, watermark) {
  const delta = ledger.emptyUsage();
  for (const key of Object.keys(delta)) {
    const current = num(host[key]);
    const previous = watermark ? num(watermark[key]) : 0;
    delta[key] = current >= previous ? current - previous : current;
  }
  return delta;
}

function hasDelta(usage) {
  return Object.values(usage).some((value) => value > 0);
}

/**
 * 采集串行化：同一时刻只跑一轮。
 *
 * 水位法在**两个请求同时进来**时会重复记账（先把同一份增量各记一遍，之后水位才对上，
 * 多出来的量就永久留在按天账上）—— 打开统计页又立刻下拉刷新、或者清理已归档和打开页面
 * 撞在一起，都能走到这条路上。串行而不是合并：清理前那次定向补采要的是它自己那几条，
 * 直接复用统计页那一轮等于那几条根本没采。
 */
let tail = Promise.resolve();

function collectStats(ctx, options = {}) {
  const run = tail.then(
    () => collectOnce(ctx, options),
    () => collectOnce(ctx, options),
  );
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 采一轮。
 *
 * `sessionIds` 给了就只采那几条（清理前补采用），否则采整份列表；
 * `force` 跳过 60 秒的最小间隔（用户手动刷新时要真读一次）；
 * `skipPreview` 不读「最后一句」摘要（清理前补采用，见文件头）。
 */
async function collectOnce(ctx, options = {}) {
  const now = Date.now();
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
  const deadline = now + budgetMs;
  const skipPreview = options.skipPreview === true;
  const book = ledger.readLedger();
  const items = await listSessions(ctx);
  if (items === null) return book;

  const wanted = Array.isArray(options.sessionIds) ? new Set(options.sessionIds) : null;
  const names = await workspaceNames(ctx);

  // 消失检测只在「采整份列表」时做：定向补采拿到的是子集，凭它判「会话没了」会误标。
  if (!wanted) {
    const liveIds = new Set(items.map((item) => item.sessionId));
    for (const [sessionId, record] of Object.entries(book.sessions)) {
      if (!liveIds.has(sessionId)) record.gone = true;
    }
  }

  // 队列分两段：近 7 天有动作的优先（数字在变的就是它们），其余的按「最久没采过」排 ——
  // 采完一轮会把 `collectedAt` 推到当下，自动沉到队尾，于是预算每次都接着上一轮往下走。
  const recentSince = now - RECENT_WINDOW_MS;
  const targets = items
    .filter((item) => !wanted || wanted.has(item.sessionId))
    .sort((a, b) => {
      const recentA = num(a.updatedAt) >= recentSince;
      const recentB = num(b.updatedAt) >= recentSince;
      if (recentA !== recentB) return recentA ? -1 : 1;
      if (recentA) return num(b.updatedAt) - num(a.updatedAt);
      const collectedA = book.sessions[a.sessionId] ? num(book.sessions[a.sessionId].collectedAt) : 0;
      const collectedB = book.sessions[b.sessionId] ? num(book.sessions[b.sessionId].collectedAt) : 0;
      return collectedA - collectedB;
    });
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      // 预算到点就停手：剩下的等下一次（水位法不会漏，只会晚）。
      if (Date.now() > deadline) return;
      const summary = targets[index];
      const sessionId = summary.sessionId;
      const record = book.sessions[sessionId];
      if (!options.force && record && record.collectedAt && now - record.collectedAt < COLLECT_INTERVAL_MS) {
        // 还没到下一次采集的点：只把可能变了的名字补上，数字一个字不动。
        if (typeof summary.title === 'string' && summary.title) record.title = summary.title;
        record.gone = false;
        continue;
      }

      const projections = await readProjections(ctx, sessionId);
      if (!projections) continue;

      const host = hostUsageOf(projections);
      const watermark = record ? record.watermark : null;
      const delta = diffUsage(host, watermark);
      const firstSight = watermark === null;
      // 首采：历史量一次性入账，日期取这条会话最后一次活动那天（见文件头）。
      // 之后再有的增量一律记在「今天」—— 也就是这次观测到的日期。
      const lastActiveAt = num(summary.updatedAt) || now;

      const cwd = normalizePath(summary.cwd);
      const workspaceName = cwd ? names.get(cwd) : undefined;

      if (hasDelta(delta) || firstSight) {
        // 最后一条消息的摘要只在真有增量时去读（它是日志，属于重活）：
        // 卡片上那一行「最后一句说了什么」比什么都更能让人认出这是哪条会话。
        // 清理前补采跳过这一步，把有限的时间预算全留给「多采几条会话的数字」。
        let lastText = '';
        if (!skipPreview) {
          try {
            const preview = await sessionPreviewFor(ctx, summary);
            const text = preview && preview.lastMessage && preview.lastMessage.text;
            if (typeof text === 'string') lastText = text.slice(0, ledger.LAST_TEXT_MAX);
          } catch {
            /* 读不到就不显示那一行 */
          }
        }
        ledger.applyDelta(book, {
          sessionId,
          at: firstSight ? lastActiveAt : now,
          delta: firstSight ? host : delta,
          title: typeof summary.title === 'string' ? summary.title : '',
          cwd,
          workspaceName,
          lastText,
        });
      }

      const saved = book.sessions[sessionId];
      if (saved) {
        saved.watermark = host;
        saved.collectedAt = now;
        saved.gone = false;
        // 上下文构成是**这条会话**的快照：跟着记录走，页面才能说清「这是哪条会话的构成」。
        // 以前全局只留一份、每轮被最后读完的那条覆盖（四条并发，谁后回是谁），
        // 于是卡片上的构成跟用户此刻在用的那条毫无关系。
        const breakdown = projections.contextBreakdown;
        if (breakdown && typeof breakdown === 'object') {
          saved.composition = {
            systemTokens: num(breakdown.systemTokens),
            toolsTokens: num(breakdown.toolsTokens),
            messageTokens: num(breakdown.messageTokens),
            at: now,
          };
        }
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  ledger.trim(book);
  ledger.saveLedger(book);
  return book;
}

module.exports = {
  COLLECT_INTERVAL_MS,
  DEFAULT_BUDGET_MS,
  collectStats,
  hostUsageOf,
  diffUsage,
};

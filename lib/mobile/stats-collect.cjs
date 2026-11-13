'use strict';

/**
 * 统计采集：按会话**事件流**折叠出「按真实发生时间」的用量，记进账本。
 *
 * 为什么不再读投影水位差：投影只有「这条会话到现在花了多少」，日期只能取「插件看到增量的
 * 那一天」（跨零点的一轮就落到后一天），模型也只能取「采集这一刻的选择」。事件流里每条
 * `assistant/message` 都带 usage 与毫秒时间戳、`request/header` 带那次请求用的模型，于是
 * 日期与模型都能按真实发生的那次请求归因（与桌面 dsh-context 同源）。
 *
 * 折叠是纯函数（`foldSessionEvents`）：喂一段事件、给个游标，回「按天用量 + 按天模型用量 +
 * 新游标」，守卫可以直接喂假事件，不用起宿主。
 *
 * 增量的代价靠两条兜住：每条会话在账本里记一个 `lastSeq`（已折到的事件序号），每轮只折
 * `seq > lastSeq` 的新事件；再加上宿主摘要的 `updatedAt`，一点没动的会话连事件都不读。
 *
 * 首采 / 升级 / 断层：老账本没有 `lastSeq`（升级前是水位差口径），或者一次跨了太多事件、靠
 * `beforeSeq` 往旧翻也补不齐时，用「窗口里能翻到的事件」重折一遍并**重置**这条会话的数字
 * （不叠加，见 `stats-ledger.resetSessionUsage`），再拿「宿主累计 − 已折叠量」得差额，把翻
 * 不到的更老那段记进记录的 `history`（没有日期：只进累计与 `all` 档，不进按天账、不进热力）。
 *
 * 采集分三条路进来：宿主定期（`PERIODIC_INTERVAL_MS` + `PERIODIC_BUDGET_MS`，只读真有变动的
 * 会话，**这是主路**）、统计页 / 下拉刷新顺带叫醒的一轮（`DEFAULT_BUDGET_MS`，回包不等它）、
 * 删除前补采（`DELETING_COLLECT_BUDGET_MS`）。定期那一轮标成 `periodic`：只要有短预算的请求
 * 那一轮要进来，它就在检查点收手（每条会话开始前、以及翻页途中各问一次），手机不排队。
 *
 * 模型维度（`book.models`）现在按 `request/header` 的真实归因记：同一个 step 的 header
 * 出现在该 step 的 `assistant/message` 之前，按事件顺序维护「当前模型」即可。窗口开头
 * 那几步的 header 可能落在窗口外，此时沿用记录上已知的模型（读不到就不猜，记成空）。
 *
 * `cacheWriteTokens` 事件里没有，恒 0。
 */

const fs = require('node:fs');
const path = require('node:path');

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { sessionPreviewFor } = require('./session-preview.js');
const { dshHome } = require('../shared/paths');
const ledger = require('./stats-ledger.cjs');
const { requestModelOf } = require('./request-model.cjs');

/** 同一条会话两次采集之间的最小间隔（打开页面时的重复请求直接复用上一轮结果）。 */
const COLLECT_INTERVAL_MS = 60_000;

/**
 * 老记录补模型的重试间隔。
 *
 * 升级前记过的会话可能没有模型这一栏，之后一直没动静就一直补不上；而统计页的成本按模型桶
 * 折算，缺一条就少一整块钱。补法是读一次宿主的当前模型（很便宜的读），读不到也把尝试时间
 * 记下，一天最多问一次，否则空闲那几轮会被几百条老记录拖成每轮几百次宿主调用。
 */
const MODEL_BACKFILL_RETRY_MS = 24 * 3600_000;

/** 并发处理的会话条数：事件与投影都是宿主内存里的读，四条并行不会把它压住。 */
const CONCURRENCY = 4;

/**
 * 这一轮先扫「最近还在动」的会话，再按「最久没采过」补老账。
 *
 * 只按最后活动时间倒序扫会让最老的那批永远排在队尾、永远采不到，所以队列分两段：近 7 天有
 * 动作的优先，其余按 `collectedAt` 升序 —— 采过的会排到队尾，每一轮的预算接着上一轮往下走。
 */
const RECENT_WINDOW_MS = 7 * 86400_000;

/**
 * 一次采集的时间预算（统计页 / 下拉刷新那一发顺带叫醒的那一轮）。
 *
 * **回包不等它**（见 `stats.js` 的 `wakeCollect`）：请求拿到的是账本现状，采集在后台往前挪
 * 一点算一点。所以这里不需要为「一条会话都没读完」负责 —— 事件游标是接着走的，采一半不会
 * 算错，下一轮（同一页面的下一次刷新，或宿主那轮 5 分钟的定期）接着采。
 */
const DEFAULT_BUDGET_MS = 1500;

/**
 * 删除会话之前那次补采的预算。
 *
 * 删除不可恢复，值得多等几秒把账补全，但不能超过 App 单发请求的 8 秒总预算。两条删除路径共用
 * 这一个数，改预算别只改一处。
 */
const DELETING_COLLECT_BUDGET_MS = 6_000;

/**
 * 宿主侧定期采集的间隔。
 *
 * 一轮的开销靠 `seenUpdatedAt` 兜住：一点没动的会话连事件都不读。事件口径下这条比水位法更
 * 重要 —— 读事件流比读投影贵，靠它把空闲那几轮压成「一次列表调用」。
 */
const PERIODIC_INTERVAL_MS = 5 * 60_000;

/**
 * 宿主侧定期采集那一轮的时间预算。
 *
 * 与统计页那 1.5 秒是两回事：定期这一轮没人等它，唯一的约束是别把下一轮（5 分钟后）挤掉。
 * 25 秒让几百条会话的积压能一轮扫完；长预算会挡住请求路径，所以标成 `periodic`，见 `collectStats`。
 */
const PERIODIC_BUDGET_MS = 25_000;

/** 一轮折叠读的尾部事件窗（条）：400 条够覆盖多步（一步约 5 条事件），一次 RPC 能取到。 */
const HISTORY_FOLD_WINDOW = 400;

/** 补断层时最多用 `beforeSeq` 往旧翻几页：防止一条病态长会话把一轮预算吃干。 */
const HISTORY_PAGE_LIMIT = 20;
/**
 * 定期采集一轮里，单条会话最多往旧翻几页。
 *
 * 首次采集（没有游标）会把每条会话都当成重算，最多翻 `HISTORY_PAGE_LIMIT` 页、每页 400 条；
 * 64 条会话的机器上，这就是几千次宿主历史读，而它跑在宿主自己的定时器里（25 秒预算、
 * 每 5 分钟一轮），装好插件之后能连着好几分钟把宿主压住 —— issue #12 里那台就是被这一段
 * 叠上隧道抖动压到 400% 的。
 *
 * 定期那一轮不需要一次翻到底：游标会记住读到哪儿，下一轮接着往前翻，几轮之后自然收敛。
 * 真有人打开统计页（短预算轮）仍用完整的上限，那一刻用户在看数字，值得为它多翻。
 */
const PERIODIC_PAGE_LIMIT = 3;

const num = ledger.num;
const billedOf = ledger.billedOf;

/** 会话日志文件名（与 `session-cleanup.cjs` 同一套：`session.v4.jsonl.zstd` 这类）。 */
const CANONICAL_LOG_FILENAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;

/**
 * 会话 id → 磁盘上那份日志的绝对路径（宿主拿会话 id 当目录名）。
 *
 * **为什么要走一次盘**：跳过判据原先只看摘要的 `updatedAt`，而那个字段是宿主侧的「最后一次
 * 提示时间」，日志在它之后还会继续写（一轮的 `assistant/message`、工具结果、子代理回包都晚
 * 于最后一次用户输入）。2026-11-13 在真账本上核对：1134 条活会话里有 779 条的
 * `seenUpdatedAt` 停在最后提示那一刻，其中 393 条的日志在那之后仍在增长 —— 它们被当成「一
 * 点没动」跳过，那一截用量永远记不上。按会话统计下来，账本只覆盖了日志真实用量的七成上下。
 *
 * 走的是 `readdir` + `stat`，不是读日志：实测 1814 个日志目录整棵树 51ms、逐条 stat 10ms，
 * 而它换掉的是「几十条会话各读一次事件流」那笔更贵的开销，一轮只做一次。
 */
function sessionLogIndex() {
  const index = new Map();
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!CANONICAL_LOG_FILENAME.test(entry.name)) continue;
      const sessionId = path.basename(directory);
      if (!index.has(sessionId)) index.set(sessionId, file);
    }
  };
  visit(path.join(dshHome(), 'sessions'));
  return index;
}

/** 日志的成长指纹（字节数 + 修改时刻）；拿不到就 null，调用方按「读不到就不跳过」处理。 */
function logStampOf(file) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtime: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

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

/**
 * cwd → 项目展示名。宿主 `workspace.list` 的形状是「数组或 `{ items }`」，条目上目录叫
 * `path`、展示名是 `title`（与 App 侧那份 `Workspace` 同一套）。
 */
async function workspaceNames(ctx) {
  const byPath = new Map();
  try {
    const { value } = unwrap(await ctx.apiProxy.workspace.list({ rpcId: 'mobile', method: 'workspace.list', payload: {} }));
    const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []);
    for (const workspace of items) {
      if (!workspace || typeof workspace !== 'object') continue;
      const dir = normalizePath(workspace.path);
      const name = typeof workspace.title === 'string' ? workspace.title : '';
      if (dir && name) byPath.set(dir, name);
    }
  } catch {
    /* 拿不到项目名不影响数字 */
  }
  return byPath;
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
 *
 * 事件折叠上线后它不再是**主**数据源，只留给「翻不到的历史差额」对账与老测试使用。
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

/**
 * 「宿主累计 − 已折叠量」的差额（逐项取非负）。与 `diffUsage` 的差别：宿主比已折叠量还小时
 * 只可能是日志被重写 / 事件比投影多，此时不补（补了会把量记重）；`diffUsage` 那套「倒退按新值
 * 全额入账」在这里会把已经折进来的量再算一遍。
 */
function missingUsage(host, folded) {
  const gap = ledger.emptyUsage();
  for (const key of Object.keys(gap)) gap[key] = Math.max(0, num(host[key]) - num(folded[key]));
  return gap;
}

/**
 * 会话标题：宿主列表摘要里的 `projections.values.title`。
 *
 * 摘要顶层的 `title` 是不存在的字段（以前照着它读，几百条记录的标题全是空串）；这里只取投影
 * 里那个真标题，取不到就留空，由 App 用目录末段兜底。
 */
function titleOf(summary) {
  const projected = summary && summary.projections && summary.projections.values
    ? summary.projections.values.title
    : '';
  return typeof projected === 'string' ? projected : '';
}

/**
 * 这条会话此刻的渠道 + 模型（`session.models` 的 `current`），读不到返回 null。
 *
 * 展示名要另外去 `groups` 里对：宿主 `current` 只给 id，页面那块模型卡得画「渠道名 / 模型名」。
 * 对不上（模型已从目录里消失、渠道被卸载）就留空串，归属仍按 id 记。任何异常都返回 null：
 * 统计是旁路，不能因为这条读失败就把整轮记账丢掉。
 */
async function readSessionModel(ctx, sessionId) {
  try {
    const { value, error } = unwrap(await callSessions(ctx, 'models', { sessionId }));
    if (error || !value || typeof value !== 'object') return null;
    const current = value.current;
    if (!current || typeof current !== 'object') return null;
    const selection = ledger.sanitizeModelSelection({ provider: current.provider, model: current.model });
    if (!selection) return null;
    const groups = Array.isArray(value.groups) ? value.groups : [];
    const group = groups.find((item) => item && item.id === selection.provider);
    const models = group && Array.isArray(group.models) ? group.models : [];
    const entry = models.find((item) => item && item.id === selection.model);
    return ledger.sanitizeModelSelection({
      ...selection,
      providerName: group ? group.name : '',
      modelName: entry ? entry.name : '',
    });
  } catch {
    return null;
  }
}

/**
 * 老记录补模型：这条会话在「模型维度」上线之前就记过量、之后一直没动静，模型卡里永远没有它
 * 那一份。只做一件事：读一次宿主的当前模型，把这条会话的**累计量**复制进模型桶（与升级那次
 * 回填同一口径）。读不到也把尝试时间记下 —— 试过这件事本身要落盘。
 *
 * @returns 账本有没有改动（改了就落盘）。
 */
async function backfillModel(ctx, book, sessionId, record, at) {
  if (!record || record.gone || record.model) return false;
  if (billedOf(record.billed) <= 0) return false;
  const tried = num(record.modelTriedAt);
  if (tried > 0 && at - tried < MODEL_BACKFILL_RETRY_MS) return false;
  record.modelTriedAt = at;
  const model = await readSessionModel(ctx, sessionId);
  if (model) {
    ledger.applyModelBackfill(book, {
      model,
      usage: record.billed,
      daily: record.daily,
      at: num(record.lastAt) || at,
    });
    record.model = model;
  }
  return true;
}

/* --------------------------------------------------------------------------------------------
 * 事件折叠（纯函数）
 * ------------------------------------------------------------------------------------------ */

/** 事件时间（毫秒），没有就 null。 */
function timeOf(event) {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null;
}

/** 事件序号：安全非负整数才算数。 */
function seqOf(event) {
  return event && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : null;
}

/** history 的事件条目两种形状都认：`{ event }` 包一层，或裸事件。 */
function eventBodyOf(entry) {
  return entry && entry.event ? entry.event : entry;
}

/** `request/header` 带的模型（`data.header.config` 里的 provider/model）。 */
function headerModelOf(event) {
  return ledger.sanitizeModelSelection(requestModelOf(event));
}

/** `tool/result` 指向的那次 `tool/call` 的 id。 */
function toolCallIdOf(event) {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.toolCallId === 'string' && data.toolCallId) return data.toolCallId;
  const message = data.message;
  if (message && typeof message === 'object') {
    if (typeof message.toolCallId === 'string' && message.toolCallId) return message.toolCallId;
    const source = message.source;
    if (source && typeof source.callId === 'string' && source.callId) return source.callId;
  }
  return null;
}

/** 事件 usage → 账本四桶（缺项按 0，cacheWrite 事件里没有恒 0）。 */
function tokensOfEventUsage(usage) {
  return {
    uncachedInputTokens: num(usage.inputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    outputTokens: num(usage.outputTokens),
  };
}

/** 把 `usageByDay` 汇总成一份总量（不含 requests，便于与宿主累计对账）。 */
function totalOfDays(usageByDay) {
  const total = ledger.emptyUsage();
  for (const bucket of Object.values(usageByDay)) {
    for (const key of Object.keys(total)) total[key] += num(bucket[key]);
  }
  return total;
}

/**
 * 把一段会话事件按真实发生时间折叠成账本口径的按天用量。
 *
 * 纯函数：不读盘、不碰账本。`events` 可以是宿主 history 的任意形状（`{ event }` 或裸事件），
 * 内部按 seq 升序扫；`previous.lastSeq` 之前的事件只用来重建上下文（当前模型、step 起点），
 * 不重复记账。
 *
 * 归属规则：
 *  - `assistant/message` 有 usage：四桶 + `steps`/`requests` 各 +1，日期取事件时间，模型取
 *    「当前模型」（按顺序维护，`request/header` 更新它；窗口外的 header 由 `previous.model` 兜底）。
 *  - `turn/start`：`turns` +1，日期取事件时间。
 *  - 耗时按 step 结算：`llmMs = step 窗 − 工具耗时`、`toolMs = 该 step 内工具调用耗时之和`。
 *    这样 `activeMs = llmMs + toolMs` 仍约等于 step 时间窗，两个字段又各自有意义。
 *    工具耗时按 `tool/call → tool/result`（callId 对上）算；没闭合 / 跨出 step 窗的按 0 兜。
 *  - `cacheWriteTokens` 恒 0（事件里没有）。
 *
 * @returns {{
 *   usageByDay: Object<string, object>,      // day → {四桶, turns, steps, llmMs, toolMs, requests}
 *   modelUsageByDay: Object<string, object>, // day → { modelKey: {provider, providerName, model, modelName, usage} }
 *   dayLastAt: Object<string, number>,       // day → 该日最后一个事件时间
 *   total: object,                           // 折叠出的用量总量（不含 requests）
 *   lastSeq: number, oldestSeq: number|null, firstAt: number|null, lastAt: number|null,
 *   model: object|null,                      // 折叠结束时认到的模型
 * }}
 */
function foldSessionEvents(events, previous = {}) {
  // 默认 -1：一条会话还没折过时，seq 0 的那条也要算进来（真机的 seq 从 0 起）。
  const since = Number.isSafeInteger(previous.lastSeq) ? previous.lastSeq : -1;
  const usageByDay = {};
  const modelUsageByDay = {};
  const dayLastAt = {};
  const stepStarts = new Map(); // "turn:step" → startTime
  const stepEnds = new Map();   // "turn:step" → { time, seq }
  const toolMsByStep = new Map();
  const calls = new Map();      // callId → { time, key }
  const turnDays = new Map();   // turn → 该 turn 首事件的日期（turns 记在这里）
  const turnModel = new Map();  // turn → 该 turn 第一次 assistant/message 时的模型
  let currentModel = ledger.sanitizeModelSelection(previous.model);
  let lastSeq = since;
  let oldestSeq = null;
  let firstAt = null;
  let lastAt = null;

  const dayBucket = (day) => usageByDay[day] || (usageByDay[day] = { ...ledger.emptyUsage(), requests: 0 });
  const modelBucket = (day, model) => {
    const byModel = modelUsageByDay[day] || (modelUsageByDay[day] = {});
    const modelKey = ledger.modelKeyOf(model.provider, model.model);
    if (!modelKey) return null;
    return byModel[modelKey] || (byModel[modelKey] = {
      provider: model.provider,
      providerName: model.providerName,
      model: model.model,
      modelName: model.modelName,
      usage: { ...ledger.emptyUsage(), requests: 0 },
    });
  };
  const touchDay = (day, time) => {
    if (time === null) return;
    if (!(day in dayLastAt) || time > dayLastAt[day]) dayLastAt[day] = time;
    if (firstAt === null || time < firstAt) firstAt = time;
    if (lastAt === null || time > lastAt) lastAt = time;
  };

  const ordered = (Array.isArray(events) ? events : [])
    .map(eventBodyOf)
    .filter((event) => event && typeof event === 'object')
    .sort((a, b) => (seqOf(a) ?? Infinity) - (seqOf(b) ?? Infinity));

  for (const event of ordered) {
    const seq = seqOf(event);
    const time = timeOf(event);
    if (seq !== null) {
      if (oldestSeq === null || seq < oldestSeq) oldestSeq = seq;
      if (seq > lastSeq) lastSeq = seq;
    }
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const turn = typeof data.turn === 'number' ? data.turn : null;
    const step = typeof data.step === 'number' ? data.step : null;
    const key = turn !== null && step !== null ? `${turn}:${step}` : null;
    // 只把游标之后的事件记进账；之前的只用来重建上下文。
    const account = seq !== null && seq > since;

    switch (event.type) {
      case 'request/header': {
        const model = headerModelOf(event);
        if (model) currentModel = model;
        break;
      }
      case 'step/start':
        if (key && time !== null) stepStarts.set(key, time);
        break;
      case 'step/end':
        if (key && time !== null) stepEnds.set(key, { time, seq });
        break;
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : null;
        if (callId && time !== null) calls.set(callId, { time, key });
        break;
      }
      case 'tool/result': {
        if (!account) break; // 结果已经在上一次的窗口里计过耗时了
        const callId = toolCallIdOf(event);
        const call = callId ? calls.get(callId) : null;
        if (call && time !== null && time >= call.time) {
          const targetKey = call.key || key;
          if (targetKey) toolMsByStep.set(targetKey, (toolMsByStep.get(targetKey) || 0) + (time - call.time));
          calls.delete(callId);
        }
        break;
      }
      case 'turn/start': {
        if (!account || time === null || turn === null) break;
        const day = ledger.dayKeyOf(time);
        turnDays.set(turn, day);
        touchDay(day, time);
        break;
      }
      case 'assistant/message': {
        const usage = data.usage;
        if (!account || !usage || typeof usage !== 'object' || time === null) break;
        const day = ledger.dayKeyOf(time);
        const tokens = tokensOfEventUsage(usage);
        const bucket = dayBucket(day);
        bucket.uncachedInputTokens += tokens.uncachedInputTokens;
        bucket.cacheReadTokens += tokens.cacheReadTokens;
        bucket.cacheWriteTokens += tokens.cacheWriteTokens;
        bucket.outputTokens += tokens.outputTokens;
        bucket.steps += 1;
        bucket.requests += 1; // 一条 assistant/message 就是一次真实请求
        touchDay(day, time);
        if (turn !== null && turnDays.has(turn) && !turnModel.has(turn) && currentModel) {
          turnModel.set(turn, currentModel);
        }
        if (currentModel) {
          const modelBucketEntry = modelBucket(day, currentModel);
          if (modelBucketEntry) {
            modelBucketEntry.usage.uncachedInputTokens += tokens.uncachedInputTokens;
            modelBucketEntry.usage.cacheReadTokens += tokens.cacheReadTokens;
            modelBucketEntry.usage.cacheWriteTokens += tokens.cacheWriteTokens;
            modelBucketEntry.usage.outputTokens += tokens.outputTokens;
            modelBucketEntry.usage.steps += 1;
            modelBucketEntry.usage.requests += 1;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 耗时按 step 结算：只有 step/end 落在游标之后的 step 才记（之前的已经记过）。
  for (const [key, start] of stepStarts) {
    const end = stepEnds.get(key);
    if (!end || end.time < start) continue;
    if (end.seq === null || !(end.seq > since)) continue;
    const day = ledger.dayKeyOf(start);
    const bucket = dayBucket(day);
    const span = end.time - start;
    const toolMs = Math.min(span, Math.max(0, toolMsByStep.get(key) || 0));
    bucket.toolMs += toolMs;
    bucket.llmMs += Math.max(0, span - toolMs);
    touchDay(day, end.time);
  }

  // turns 按 turn/start 计数，归到该 turn 首事件所在日；模型维度跟着该 turn 第一次
  // assistant/message 认到的模型走（turn/start 比 header 早，那一步还不知道模型）。
  for (const [turn, day] of turnDays) {
    dayBucket(day).turns += 1;
    const model = turnModel.get(turn);
    if (model) {
      const modelBucketEntry = modelBucket(day, model);
      if (modelBucketEntry) modelBucketEntry.usage.turns += 1;
    }
  }

  return {
    usageByDay,
    modelUsageByDay,
    dayLastAt,
    total: totalOfDays(usageByDay),
    lastSeq,
    oldestSeq,
    firstAt,
    lastAt,
    model: currentModel,
  };
}

/* --------------------------------------------------------------------------------------------
 * 读历史窗口
 * ------------------------------------------------------------------------------------------ */

/** 读一页会话历史；`beforeSeq` 省略读尾部。读不到返回 null（当这条这轮没采到）。 */
async function readHistoryPage(ctx, sessionId, beforeSeq, maxMessages) {
  const payload = { sessionId, maxMessages };
  if (Number.isSafeInteger(beforeSeq) && beforeSeq > 0) payload.beforeSeq = beforeSeq;
  const controller = new AbortController();
  try {
    const { value, error } = unwrap(await callSessions(ctx, 'history', payload, 'mobile', controller.signal));
    if (error) return null;
    const events = value && Array.isArray(value.events) ? value.events : [];
    return { events, hasMore: !!(value && value.hasMore) };
  } catch {
    return null;
  }
}

/** 事件数组里最小的序号（没有就 null）。 */
function oldestSeqOf(events) {
  let oldest = null;
  for (const entry of events) {
    const seq = seqOf(eventBodyOf(entry));
    if (seq !== null && (oldest === null || seq < oldest)) oldest = seq;
  }
  return oldest;
}

/** 事件数组里最大的序号（没有就 null）：这一轮到底读到了日志的哪个位置。 */
function newestSeqOf(events) {
  let newest = null;
  for (const entry of events) {
    const seq = seqOf(eventBodyOf(entry));
    if (seq !== null && (newest === null || seq > newest)) newest = seq;
  }
  return newest;
}

/**
 * 读够折叠需要的事件：先读尾部 `HISTORY_FOLD_WINDOW` 条；`lastSeq` 在窗口之外（跨了一大段，
 * 或首采要尽量往前翻）就用 `beforeSeq` 往旧翻，最多 `pageLimit` 页、且不越过本轮预算。
 * 按 seq 去重后返回，附带 `oldest` 与「按预算/上限停手时是否还有更老的没读」(truncated)。
 *
 * `pageLimit` 缺省是 `HISTORY_PAGE_LIMIT`（有人在等数字时的那一档）；定期采集传
 * `PERIODIC_PAGE_LIMIT`，靠游标一轮轮往前补齐。
 *
 * @returns {{events: object[], oldest: number|null, truncated: boolean}|null}
 */
async function readHistoryWindow(ctx, sessionId, lastSeq, deadline, shouldYield, pageLimit = HISTORY_PAGE_LIMIT) {
  const first = await readHistoryPage(ctx, sessionId, null, HISTORY_FOLD_WINDOW);
  if (first === null) return null;
  let events = first.events.slice();
  let hasMore = first.hasMore;
  let oldest = oldestSeqOf(events);
  let pages = 0;
  let truncated = false;

  // 什么时候还要往旧翻：首采/重算时尽量往前翻（hasMore 就在翻）；增量时翻到盖住 lastSeq 为止
  // —— 窗口是连续的尾部，最老序号 <= lastSeq 就说明 seq > lastSeq 的全在手里了。
  const needOlder = () => (lastSeq > 0 ? oldest !== null && oldest > lastSeq : hasMore);
  while (hasMore && oldest !== null && oldest > 0 && pages < pageLimit && needOlder()) {
    if (Date.now() > deadline) { truncated = true; break; }
    // 让位也要在**翻页途中**问一次：一条会话的首采能翻到二十页，只在「每条会话开始前」
    // 看一眼的写法，等于让手机排在一条会话后面等好几秒（现场就是那次超时）。
    if (shouldYield && shouldYield()) { truncated = true; break; }
    const older = await readHistoryPage(ctx, sessionId, oldest, HISTORY_FOLD_WINDOW);
    if (older === null || older.events.length === 0) break;
    const olderOldest = oldestSeqOf(older.events);
    if (olderOldest === null || olderOldest >= oldest) break; // 翻不动了，别死循环
    events = older.events.concat(events);
    oldest = olderOldest;
    hasMore = older.hasMore;
    pages += 1;
  }
  if (hasMore && oldest !== null && oldest > 0 && needOlder() && pages >= pageLimit) truncated = true;

  // 按 seq 去重（分页边界可能带回同一条），保留后读到的。
  const seen = new Set();
  const deduped = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const body = eventBodyOf(events[index]);
    const seq = seqOf(body);
    if (seq !== null) {
      if (seen.has(seq)) continue;
      seen.add(seq);
    }
    deduped.push(events[index]);
  }
  deduped.reverse();
  return { events: deduped, oldest, newest: newestSeqOf(deduped), truncated };
}

/**
 * 采集串行化：同一时刻只跑一轮。
 *
 * 两个请求同时进来若并发折叠同一条会话，`lastSeq` 会在两边各自读到旧值、把同一段事件记两遍。
 * 「定期那一轮」（`periodic`）可以被请求路径插队：它的预算有 25 秒，而手机点开统计页只等
 * 1.5 秒，排在它后面就等于转圈 25 秒。做法是一个「有几条短预算在等」的计数，定期轮在每轮
 * 检查点上问一句，有人在等就收手（事件游标不会漏，采到一半下一轮接着采）。
 */
let tail = Promise.resolve();
/** 正在等（或正在跑）的「短预算」轮次条数：定期那一轮见它大于 0 就让位，见 `collectOnce`。 */
let urgent = 0;

function collectStats(ctx, options = {}) {
  const urgentRound = options.periodic !== true;
  if (urgentRound) urgent += 1;
  const run = tail.then(
    () => collectOnce(ctx, options),
    () => collectOnce(ctx, options),
  );
  const settle = () => {
    if (urgentRound) urgent -= 1;
  };
  run.then(settle, settle);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 采一轮。
 *
 * `sessionIds` 给了就只采那几条（清理前补采用），否则采整份列表；
 * `force` 跳过 60 秒的最小间隔（用户手动刷新时要真读一次）；
 * `skipPreview` 不读「最后一句」摘要（清理前补采用）；
 * `periodic` 是宿主侧定期那一轮：有人要短预算时它在下一个检查点让位。
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
  // 这一轮有没有真改过账本：定期采集在空闲时应当一个字节都不写。
  let touched = false;
  // 会话 id → 日志路径：跳过判据要问「磁盘上那份还在长吗」（见下面的 `logStampOf`）。
  // 一轮建一次：整棵目录 enumerate + 逐条 stat，实测不到一百毫秒，比它换掉的「几十条会话
  // 各读一次事件流」便宜得多。定向补采也照建 —— 那一路只有几条会话，但判据本身要用到它。
  const logFiles = sessionLogIndex();

  // 消失检测只在「采整份列表」时做：定向补采拿到的是子集，凭它判「会话没了」会误标。
  if (!wanted) {
    const liveIds = new Set(items.map((item) => item.sessionId));
    for (const [sessionId, record] of Object.entries(book.sessions)) {
      if (!liveIds.has(sessionId) && !record.gone) {
        record.gone = true;
        touched = true;
      }
    }
  }

  // 队列分两段：近 7 天有动作的优先，其余的按「最久没采过」排 —— 采完一轮会把 `collectedAt`
  // 推到当下，自动沉到队尾，于是预算每次都接着上一轮往下走。
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

  /**
   * 定期那一轮什么时候该收手：有短预算轮在等就立刻让位。
   *
   * 除了每条会话开始前，**翻页途中也问一次**（传进 `readHistoryWindow`）：一条会话的首采能
   * 翻到 `HISTORY_PAGE_LIMIT` 页，只按会话粒度让位等于让手机等一整条会话。
   */
  const shouldYield = options.periodic === true ? () => urgent > 0 : null;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      // 预算到点就停手：剩下的等下一次（事件游标不会漏，只会晚）。
      if (Date.now() > deadline) return;
      // 定期那一轮遇到有人在等短预算就让位。
      if (options.periodic === true && urgent > 0) return;

      const summary = targets[index];
      const sessionId = summary.sessionId;
      const record = book.sessions[sessionId];
      const title = titleOf(summary);
      /** 名字补上 / 重新出现在列表里：这两件都要落盘，数字一个不动。 */
      const renameIfNeeded = () => {
        if (title && title !== record.title) {
          record.title = title;
          touched = true;
        }
        if (record.gone) {
          record.gone = false;
          touched = true;
        }
      };
      if (!options.force && record && record.collectedAt && now - record.collectedAt < COLLECT_INTERVAL_MS) {
        renameIfNeeded();
        if (await backfillModel(ctx, book, sessionId, record, now)) touched = true;
        continue;
      }
      // **「没变动」不能只看摘要的 `updatedAt`**（2026-11-10 修正）：那个字段是宿主侧的
      // 最后提示时间，会话日志在它之后还会继续写（一轮的 assistant/message、工具结果、
      // 子代理回包都晚于最后一次用户输入）。真机实测：2562 条记录里 974 条的
      // `seenUpdatedAt` 落后日志写入时间超过一分钟，最长的差了两天多，尾部用量因此永远
      // 采不到 —— 账本整体只有真实用量的六成多。
      //
      // 现在只在**两个判据同时成立**时才跳过：摘要 `updatedAt` 没往前走，**且**这条会话的
      // 事件游标已经追上了它日志里的最后一个事件序号。游标是权威：`lastSeq` 追到尾部就
      // 说明真没有新事件可折，那一次读历史就是白花预算。任一不成立就照常读一轮，由
      // `readHistoryWindow` 自己按游标增量折叠（读不到新事件时它一条也不记，成本可控）。
      //
      // `seenSeq` 由上一轮采集写下（见下面 `saved.seenSeq`），缺省 0 表示「还没有可信的
      // 游标对账」，这种情况一律不跳过。
      //
      // **2026-11-13 起再加一条：磁盘上那份日志必须没长过**。前面两个判据都是宿主自己报的
      // 数，而它们在真机上会一起骗人：摘要 `updatedAt` 停在最后一次用户输入，游标也只追到
      // 上一轮读到的位置 —— 两边一致、日志却一直在写，于是这条会话被永久跳过。指纹用
      // 「字节数 + 修改时刻」（拿不到就当长过，宁可多读一轮），记在 `seenLogSize` /
      // `seenLogMtime` 上，与这一轮读到的内容同一次落盘。
      const stamp = logStampOf(logFiles.get(sessionId));
      const logUnchanged = stamp !== null
        && num(record && record.seenLogSize) === stamp.size
        && num(record && record.seenLogMtime) === stamp.mtime;
      const seqCaughtUp = record
        && num(record.seenSeq) > 0
        && num(record.lastSeq) >= num(record.seenSeq);
      if (!options.force && seqCaughtUp && logUnchanged && record.seenUpdatedAt
        && num(summary.updatedAt) <= num(record.seenUpdatedAt)) {
        renameIfNeeded();
        if (await backfillModel(ctx, book, sessionId, record, now)) touched = true;
        continue;
      }

      const previousLastSeq = record ? num(record.lastSeq) : 0;

      // 读事件窗口：先读尾部，够不着游标再用 beforeSeq 往旧翻（见 readHistoryWindow）。
      // 定期那一轮少翻几页（见 PERIODIC_PAGE_LIMIT）：游标会记住读到哪儿，下一轮接着往前，
      // 几轮之后自然收敛。有人在等数字的短预算轮仍用完整上限。
      const pageLimit = options.periodic === true ? PERIODIC_PAGE_LIMIT : HISTORY_PAGE_LIMIT;
      const window = await readHistoryWindow(ctx, sessionId, previousLastSeq, deadline, shouldYield, pageLimit);
      if (window === null) continue;

      const projections = await readProjections(ctx, sessionId);
      const host = hostUsageOf(projections);

      // 首采/升级（没有游标）或断层补不齐 → 重算：清零这条会话的旧口径数字，按窗口里能翻到
      // 的事件重折一遍，翻不到的更老那截走 history（undated）。不做叠加，避免重复计。
      const gap = previousLastSeq > 0 && window.oldest !== null && window.oldest > previousLastSeq;
      const resync = previousLastSeq === 0 || gap;
      if (resync && record) ledger.resetSessionUsage(book, sessionId);

      const fold = foldSessionEvents(window.events, {
        lastSeq: resync ? -1 : previousLastSeq,
        model: record ? record.model : null,
      });

      // 模型展示名：折叠给的是 id，页面模型卡要「渠道名 / 模型名」；读一次宿主当前选择补名字
      // （会话中途换过模型的，只记 id，名字由 App 兜底）。读不到就不带名字，归属仍按 id 记。
      const currentModel = Object.keys(fold.modelUsageByDay).length > 0
        ? await readSessionModel(ctx, sessionId)
        : null;
      const modelNameOf = (bucket) => (
        currentModel && currentModel.provider === bucket.provider && currentModel.model === bucket.model
          ? currentModel
          : bucket
      );

      const cwd = normalizePath(summary.cwd);
      const workspaceName = cwd ? names.get(cwd) : undefined;

      // 最后一句摘要：只在真有新事件（或重算）时读，属于日志里的重活。清理前补采跳过这一步。
      let lastText = '';
      if (!skipPreview && (resync || Object.keys(fold.usageByDay).length > 0)) {
        try {
          const preview = await sessionPreviewFor(ctx, summary);
          const text = preview && preview.lastMessage && preview.lastMessage.text;
          if (typeof text === 'string') lastText = text.slice(0, ledger.LAST_TEXT_MAX);
        } catch {
          /* 读不到就不显示那一行 */
        }
      }

      // 逐日把折叠结果记进账本：每一条带显式 `date`（事件真实发生日），identity 一并带上。
      for (const [day, usageOfDay] of Object.entries(fold.usageByDay)) {
        ledger.applyDelta(book, {
          sessionId,
          date: day,
          at: fold.dayLastAt[day] || num(summary.updatedAt) || now,
          delta: usageOfDay,
          requests: num(usageOfDay.requests),
          title,
          cwd,
          workspaceName,
          lastText,
        });
      }
      // 按模型、按天记进模型桶（与按天账同一个日期；展示名尽量补上）。
      for (const [day, byModel] of Object.entries(fold.modelUsageByDay)) {
        for (const bucket of Object.values(byModel)) {
          const named = modelNameOf(bucket);
          ledger.applyModelUsage(book, {
            model: {
              provider: named.provider,
              providerName: named.providerName,
              model: named.model,
              modelName: named.modelName,
            },
            day,
            at: fold.dayLastAt[day] || num(summary.updatedAt) || now,
            usage: bucket.usage,
          });
        }
      }
      const saved = book.sessions[sessionId] || (book.sessions[sessionId] = ledger.emptySession(num(summary.updatedAt) || now));
      // 对账「翻不到的历史差额」：账本里 `billed = 事件折叠量 + history`（history 是没有日期的
      // 那截）。`folded = billed − history` 就是到目前为止真正按事件折出来的量；宿主累计比它多
      // 出来的那一截，说明还有翻不到的事件 —— 记进 history。这样每次都能收敛到宿主口径，而且
      // 早先算进 history、后来才翻到的那批事件不会重复计（folded 涨多少，history 就自动退多少）。
      if (projections) {
        const folded = ledger.emptyUsage();
        for (const key of Object.keys(folded)) folded[key] = Math.max(0, num(saved.billed[key]) - num(saved.history[key]));
        const historyUsage = missingUsage(host, folded);
        for (const key of Object.keys(saved.billed)) {
          saved.billed[key] = Math.max(0, num(saved.billed[key]) + (num(historyUsage[key]) - num(saved.history[key])));
        }
        saved.history = historyUsage;
      }
      // 没有任何增量时 applyDelta 没跑到，身份字段在这里补齐（数字一个不动）。
      if (title && title !== saved.title) { saved.title = title; }
      if (cwd && cwd !== saved.cwd) { saved.cwd = cwd; }
      if (workspaceName && workspaceName !== saved.workspaceName) { saved.workspaceName = workspaceName; }
      if (lastText && lastText !== saved.lastText) { saved.lastText = lastText; }
      if (fold.firstAt && (!saved.firstAt || fold.firstAt < saved.firstAt)) saved.firstAt = fold.firstAt;
      if (fold.lastAt && fold.lastAt > saved.lastAt) saved.lastAt = fold.lastAt;
      // 一条事件都翻不到时（纯历史档）至少让记录带上会话最后活动时间，别落到 1970。
      const fallbackAt = num(summary.updatedAt) || now;
      if (!saved.firstAt) saved.firstAt = fallbackAt;
      if (!saved.lastAt) saved.lastAt = fallbackAt;
      // 这一刻认到的模型落在这条会话上（会话换过模型的话，下一次折叠就从新模型接着认）。
      if (fold.model) {
        saved.model = currentModel
          && currentModel.provider === fold.model.provider
          && currentModel.model === fold.model.model
          ? currentModel
          : fold.model;
      }
      saved.lastSeq = Math.max(num(saved.lastSeq), fold.lastSeq);
      // 这一轮**真的读到了事件流的什么位置**：把窗口里最大的 seq 记下来，下一轮拿它和
      // `lastSeq` 对账（见上面那个跳过判据）。`truncated` 时不算数 —— 预算到点、翻页没翻完，
      // 那个位置不代表日志尾部，凭它记下等于把「没读完」当成「读完了」。
      if (!window.truncated) saved.seenSeq = Math.max(num(saved.seenSeq), num(window.newest));
      // 这一轮那份日志的指纹：下一轮拿它和磁盘对账，没长过才允许跳过。
      // 与 `seenSeq` 同一条规矩 —— 预算到点、翻页没翻完时那个位置不代表尾部，指纹也不记
      // （记了就等于把「没读完」当成「读完了」）。
      //
      // 用的是**读之前**取的那一份（见上面 `const stamp`）。读的途中日志若又写了，指纹会
      // 偏小，下一轮一对不上就再读一次 —— 偏保守的方向是多读一轮，而不是漏一段量。反过来
      // 读完之后再取指纹就会把那批没折进去的事件算进「没长过」，那才是真的丢数。
      if (!window.truncated && stamp) {
        saved.seenLogSize = stamp.size;
        saved.seenLogMtime = stamp.mtime;
      }
      // 宿主累计只作诊断与差额对账用，按天记账不看它。
      saved.watermark = host;
      saved.collectedAt = now;
      saved.gone = false;
      // 记下这一次读到的 `updatedAt`：下一轮它没变就不用再读事件。
      saved.seenUpdatedAt = num(summary.updatedAt) || now;
      // 上下文构成是这条会话的快照，跟着记录走。
      const breakdown = projections && projections.contextBreakdown;
      if (breakdown && typeof breakdown === 'object') {
        saved.composition = {
          systemTokens: num(breakdown.systemTokens),
          toolsTokens: num(breakdown.toolsTokens),
          messageTokens: num(breakdown.messageTokens),
          at: now,
        };
      }
      // 走到这里 `collectedAt`/`seenUpdatedAt` 至少变了，落盘一次。
      touched = true;
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 一点没改就别写盘：定期采集空闲时要真的不花钱。
  if (touched) {
    ledger.trim(book);
    ledger.saveLedger(book);
  }
  return book;
}

module.exports = {
  COLLECT_INTERVAL_MS,
  DEFAULT_BUDGET_MS,
  DELETING_COLLECT_BUDGET_MS,
  PERIODIC_INTERVAL_MS,
  PERIODIC_BUDGET_MS,
  HISTORY_FOLD_WINDOW,
  HISTORY_PAGE_LIMIT,
  collectStats,
  hostUsageOf,
  diffUsage,
  missingUsage,
  foldSessionEvents,
  titleOf,
  readSessionModel,
};

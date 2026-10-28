'use strict';

/**
 * 统计采集：把宿主每条会话的累计用量读出来，和水位一比，增量记进账本。
 *
 * 不重放会话事件：手机要的是「按天看个大概」，重放整条日志是每秒都在烧的开销。所以走水位差
 * （宿主累计值 − 账本水位 = 这次入账的量），零依赖，代价是入账日期取「插件看到增量的那一天」，
 * 跨零点的一轮会落在后一天。首采会把历史全量入账，日期取它最后一次活动的日期，算一次性回填。
 *
 * 采集分三条路进来：打开统计页 / 下拉刷新（`DEFAULT_BUDGET_MS`）、宿主侧每几分钟自己跑一轮
 * （`PERIODIC_INTERVAL_MS`，只会读真有变动的会话）、以及删除会话之前的那一刀补采。
 *
 * 清理前那次补采（`skipPreview`）不读「最后一句」：那一步要读会话日志，是整轮最重的一趟，
 * 而删除不可恢复、时间又卡在请求预算里。宁可让首次见到的会话卡片少一行摘要。
 *
 * 模型维度（`book.models`）是**近似**，写清楚省得以后有人当账本该有的精度去用：增量记在
 * 「采集到它的这一刻这条会话正在用的模型」名下（`readSessionModel`）。水位法只认观测点，
 * 会话中途换模型、而换模型到下一次采集之间的量分不开了，整段归到换后的那个 —— 这与首采
 * 回填记在「最后活动那天」是同一种近似。想要真按模型拆，得让宿主按模型累计用量，那是另一
 * 件事（现在的投影只有会话级累计）。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { sessionPreviewFor } = require('./session-preview.js');
const { listTitle } = require('./history-derive.js');
const ledger = require('./stats-ledger.cjs');

/** 同一条会话两次采集之间的最小间隔（打开页面时的重复请求直接复用上一轮结果）。 */
const COLLECT_INTERVAL_MS = 60_000;

/**
 * 老记录补模型的重试间隔。
 *
 * 「模型维度」上线之前记过的会话没有模型这一栏，之后再没动静就一直补不上 —— 而统计页的成本
 * 是按模型桶折算的，缺一条就少一整块钱。补法是读一次宿主的当前模型（很便宜的读），顺手做在
 * 跳过分支里；读不到（会话没了 / 渠道卸了）也把尝试时间记下，一天最多问一次，否则空闲那几轮
 * 会被几百条老记录拖成每轮几百次宿主调用，把「没变动就不花钱」那条设计作废。
 */
const MODEL_BACKFILL_RETRY_MS = 24 * 3600_000;

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

/**
 * 删除会话之前那次补采的预算。
 *
 * 统计页那 1.5 秒是为了别让用户转好久；删除是不可恢复的，值得多等几秒把账补全，但不能
 * 超过 App 单发请求的 8 秒总预算。两条删除路径（手机那个「清理已归档」按钮、agent 的
 * 删除工具）共用这一个数，改预算别只改一处。
 */
const DELETING_COLLECT_BUDGET_MS = 6_000;

/** 宿主侧定期采集的间隔。
 *
 * 以前只在「有人打开统计页 / 下拉刷新 / 点清理」时采，水位差就把「上次观测到现在」的整段
 * 用量记在**观测到它的那一天**：连着几天没打开页面，那几天的量全压到最后一天，按天图上是
 * 一片空白加一根尖柱。定期跑一轮之后，归属误差从「几天」收到「几分钟」，顺带把「清理前
 * 没采到的那一截」一起收掉。一轮的开销靠 `seenUpdatedAt` 兜住：一点没动的会话连投影都不读。
 */
const PERIODIC_INTERVAL_MS = 5 * 60_000;

const num = ledger.num;
const billedOf = ledger.billedOf;

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
 * cwd → 项目展示名。
 *
 * 宿主 `workspace.list` 的形状是「数组或 `{ items }`」，条目上目录叫 `path`、展示名是
 * `title`（与 App 侧那份 `Workspace` 同一套）。以前按 `{ workspaces }` + `cwd` / `name`
 * 读，三个字段一个都对不上，真机上卡片从来就没有过项目名——而这条取不到的错是静默的。
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
 * 会话标题：宿主列表摘要里的 title 投影（与 `/sessions` 那条列表同一份来源，见 `listTitle`）。
 *
 * 摘要顶层的 `title` 是不存在的字段（以前照着它读，于是账本里几百条记录的标题全是空串，
 * 卡片只能退到目录名兜底）。这里只取投影里那个真标题：取不到就留空，由 App 用目录末段兜底。
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
 * 对不上（模型已从目录里消失、渠道被卸载）就留空串，归属仍按 id 记 —— 名字对不上不等于这条
 * 用量没有主，而且账本读盘也不拿展示名当有效性判据（见 `sanitizeModelSelection`）。
 *
 * 任何异常都返回 null：统计是旁路，不能因为这条读失败就把整轮记账丢掉。
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
 * 老记录补模型：这条会话在「模型维度」上线之前就记过量、之后一直没动静，模型卡里永远没有
 * 它那一份 —— 而统计页的成本是按模型桶折算的，缺一条就少一整块钱。
 *
 * 只做一件事：读一次宿主的当前模型（不碰投影、不碰水位），把这条会话的**累计量**复制进模型桶，
 * 与升级当天那次回填同一个口径（`record.model` 一旦有了，之后的增量就照常记）。读不到也把
 * 尝试时间记下 —— 试过这件事本身要落盘，否则下一轮还会为同一条再问一次。
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
    ledger.applyModelUsage(book, {
      model,
      day: ledger.dayKeyOf(num(record.lastAt) || at),
      usage: record.billed,
    });
    record.model = model;
  }
  return true;
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
  // 这一轮有没有真改过账本：定期采集在空闲时应当一个字节都不写（见 PERIODIC_INTERVAL_MS）。
  let touched = false;

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
        // 还没到下一次采集的点：只把可能变了的名字补上，数字一个字不动。
        renameIfNeeded();
        if (await backfillModel(ctx, book, sessionId, record, now)) touched = true;
        continue;
      }
      // 宿主摘要的 `updatedAt` 与上次读到的一模一样 = 这条一点没动过，水位差必然是 0。
      // 定期采集每几分钟一轮，靠这一条把空闲那几轮压成「一次列表调用」。
      if (!options.force && record && record.seenUpdatedAt && num(summary.updatedAt) <= num(record.seenUpdatedAt)) {
        renameIfNeeded();
        if (await backfillModel(ctx, book, sessionId, record, now)) touched = true;
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

      // 模型只在「这一轮真会往模型表里记东西」时才去读：三种情形 —— 首采（全量要挂到模型
      // 名下）、有增量、以及老账本里那条会话已经有量却还没有模型（升级当天的回填）。
      // 其余轮次一条都不读，否则定期采集每 5 分钟就给每条会话多一趟宿主调用。
      const needsModel = firstSight || hasDelta(delta) || Boolean(record && !record.model && billedOf(record.billed) > 0);
      const model = needsModel ? await readSessionModel(ctx, sessionId) : null;
      // 老账本回填：这条会话在升级前记过累计量，但它没有模型维度，模型卡会是 0 —— 把它那条
      // 会话的累计量一次性复制进模型桶。日期与会话最后一次活动那天一致（同一条近似）。
      // 首采不在这里做：首采的 delta 就是全量，已经跟着 applyDelta 记进模型桶了，再补一次会翻倍。
      if (model && record && !record.model && billedOf(record.billed) > 0 && !firstSight) {
        ledger.applyModelUsage(book, {
          model,
          day: ledger.dayKeyOf(num(record.lastAt) || lastActiveAt),
          usage: record.billed,
        });
        touched = true;
      }

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
          title,
          cwd,
          workspaceName,
          lastText,
          model,
        });
        touched = true;
      }

      const saved = book.sessions[sessionId];
      if (saved) {
        // 这一刻的模型落在这条会话的记录上：它换过模型的话，下一次增量就记到新模型名下
        // （这一轮的量仍按「采集这一刻」归，见文件头）。
        if (model) saved.model = model;
        saved.watermark = host;
        saved.collectedAt = now;
        saved.gone = false;
        // 记下这一次读到的那条会话 `updatedAt`：下一轮它没变就不用再读投影（见文件头的间隔说明）。
        saved.seenUpdatedAt = num(summary.updatedAt) || now;
        touched = true;
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

  // 一点没改就别写盘：定期采集空闲时要真的不花钱，而整份 JSON 每次重写一遍不是免费的。
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
  collectStats,
  hostUsageOf,
  diffUsage,
  titleOf,
  readSessionModel,
};

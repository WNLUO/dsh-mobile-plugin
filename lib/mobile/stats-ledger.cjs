'use strict';

/**
 * 统计账本：按天累计的用量 + 每条会话的累计与身份（`$DSH_HOME/mobile-stats.json`）。
 *
 * 为什么要有这一份、以及它为什么不寄在会话日志上：用户会归档会话、也会清理已归档的
 * 会话，清理删的是日志本身。统计如果每次现算，清理之后那部分用量就凭空消失（还常常
 * 表现为「今天的使用量突然掉了一半」）。所以采集一旦读到增量就落进这个文件，之后会话
 * 在不在都不影响历史数字 —— 那张会话卡片只会被标成「已清理」。
 *
 * 口径（与桌面插件 dsh-context 的每日账本一致，但只保留手机用得着的部分）：
 * - 一天的账落在那**一天完成观测**的日期上（宿主本地日期，`YYYY-MM-DD`）；
 * - 计费 token = 未命中输入 + 缓存读 + 缓存写 + 输出，四个桶分开存，合并多台设备时
 *   才可能按同一口径重算计费量与命中率；
 * - 会话卡片保留最近 `MAX_SESSIONS` 条（按最后活动时间），更老的会话从卡片里消失，
 *   但它们的量**仍然留在按天的账上**（总量不会因为裁剪而缩水）。卡片退场只是不再展示
 *   （`retired`），水位留着 —— 水位一丢，这条会话下次再有动作就会被当成首采、把整段
 *   历史重记一遍，按天的账凭空多出一截。
 *
 * 这个文件只做纯数据（读写 + 折算），不碰网络；采集在 stats-collect.cjs，路由在 stats.js。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../shared/paths');

/** 账本格式版本：将来改结构时据此决定是丢弃还是迁移。 */
const VERSION = 1;

/** 会话卡片的条数上限（按最后活动时间保留最近的）。 */
const MAX_SESSIONS = 200;

/**
 * 退场卡片（已不在最近 200 条里、只留水位与身份）的条数上限。
 *
 * 退场记录不展示，存在只为「它再活过来时别重记一遍历史」；每条一百来字节，
 * 留这么多足够覆盖一台机器几年的会话，再老的真删掉。
 */
const MAX_RETIRED = 2000;

/** 按天的账保留天数（约三年；一天一百多字节，超出的从最老的开始裁）。 */
const MAX_DAYS = 1100;

/**
 * 每条会话自己那份「按天用量」保留多少天。
 *
 * 它存在只为回答「这张卡片在这个范围里用了多少」：页面的三档范围最大 30 天，
 * 再留一倍余量足够；更老的日期按天的总账仍然还在，只是卡片不再按那条会话拆得开。
 * 不封顶的话，两百条会话 × 三年就是一份几十 MB 的 JSON，每次采集都要整份读写。
 */
const MAX_DAILY_DAYS = 62;

/**
 * 热力图最多给多少天（52 周）。
 *
 * 页面按自己量到的宽度决定画几周（手机 8 周、iPad 横屏三十周上下），宿主这边一律给满 ——
 * 只给 56 天的话宽屏想多画也没有数据；只给 26 周则 iPad 那张卡摊到 26 周之后右边还剩
 * 一格多的空白，白改一场。
 */
const HEATMAP_DAYS = 52 * 7;

/** 每张会话卡片上留的最后一条消息摘要长度：卡片一行装得下的大致字数。 */
const LAST_TEXT_MAX = 120;

/** 用量字段：四个 token 桶 + 轮次/步数/耗时。顺序即写盘顺序，便于人工比对。 */
const USAGE_KEYS = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'turns',
  'steps',
  'llmMs',
  'toolMs',
];

function emptyUsage() {
  const usage = {};
  for (const key of USAGE_KEYS) usage[key] = 0;
  return usage;
}

function emptyDay() {
  return { ...emptyUsage(), requests: 0 };
}

function emptyLedger() {
  return { version: VERSION, updatedAt: 0, days: {}, sessions: {}, composition: null };
}

/** 账本文件：`$DSH_HOME/mobile-stats.json`（DSH_HOME 在调用时解析，便于测试注入）。 */
function stateFile() {
  return path.join(paths.dshHome(), 'mobile-stats.json');
}

/** 内存缓存；null = 还没读过盘。 */
let cached = null;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 宿主本地日期 `YYYY-MM-DD`。 */
function dayKeyOf(at) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 日期字符串按日历加减（用 UTC 解析/格式化，避开夏令时与本地时区偏移）。 */
function addDays(day, delta) {
  const [year, month, date] = day.split('-').map((part) => Number(part));
  const base = Date.UTC(year, month - 1, date);
  const shifted = new Date(base + delta * 86400000);
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const shiftedDay = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${shiftedMonth}-${shiftedDay}`;
}

/** 范围起点（含）；`all` 返回 null，表示不设下限。 */
function startDayOf(range, now) {
  const today = dayKeyOf(now);
  if (range === '7d') return addDays(today, -6);
  if (range === '30d') return addDays(today, -29);
  return null;
}

function sanitizeUsage(source) {
  const usage = emptyUsage();
  if (!source || typeof source !== 'object') return usage;
  for (const key of USAGE_KEYS) usage[key] = num(source[key]);
  return usage;
}

/** 上下文构成快照：三条都缺或全 0 就当没有（别在卡片上画一个 0 的环）。 */
function readComposition(source) {
  if (!source || typeof source !== 'object') return null;
  const composition = {
    systemTokens: num(source.systemTokens),
    toolsTokens: num(source.toolsTokens),
    messageTokens: num(source.messageTokens),
  };
  if (composition.systemTokens + composition.toolsTokens + composition.messageTokens <= 0) return null;
  return { ...composition, at: num(source.at) };
}

function sanitizeLedger(raw) {
  if (!raw || typeof raw !== 'object') return emptyLedger();
  if (raw.version !== VERSION) return emptyLedger();
  const ledger = emptyLedger();
  ledger.updatedAt = num(raw.updatedAt);

  if (raw.days && typeof raw.days === 'object') {
    for (const [day, value] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue;
      ledger.days[day] = { ...sanitizeUsage(value), requests: num(value.requests) };
    }
  }

  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sessionId, value] of Object.entries(raw.sessions)) {
      if (!sessionId || !value || typeof value !== 'object') continue;
      const daily = {};
      if (value.daily && typeof value.daily === 'object') {
        for (const [day, usageOfDay] of Object.entries(value.daily)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !usageOfDay || typeof usageOfDay !== 'object') continue;
          daily[day] = sanitizeUsage(usageOfDay);
        }
      }
      const billed = sanitizeUsage(value.billed);
      // 老账本（2026-10-24 之前）没有每条会话的按天用量：把它的历史量记在它最后一次
      // 活动那天。这跟「首采回填」是同一条近似，也是一次性回填 —— 之后就只记增量。
      if (Object.keys(daily).length === 0 && billedOf(billed) > 0) {
        daily[dayKeyOf(num(value.lastAt) || Date.now())] = { ...billed };
      }
      ledger.sessions[sessionId] = {
        title: typeof value.title === 'string' ? value.title : '',
        workspaceName: typeof value.workspaceName === 'string' ? value.workspaceName : '',
        lastText: typeof value.lastText === 'string' ? value.lastText.slice(0, LAST_TEXT_MAX) : '',
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
        firstAt: num(value.firstAt),
        lastAt: num(value.lastAt),
        collectedAt: num(value.collectedAt),
        gone: value.gone === true,
        // 退场 = 这条卡片已经不在最近 MAX_SESSIONS 里，只留水位与身份。
        retired: value.retired === true,
        billed,
        // 这条会话自己那份按天用量：卡片上的数字要跟着页面范围走（见 `rangeUsageOf`）。
        daily,
        // 最后一次观测到的上下文构成：跟着会话走，不再全局只留一份。
        composition: readComposition(value.composition),
        // 水位是「宿主那边这条会话的累计值」，缺省为 null 表示还没采过（首采全量入账）。
        watermark: value.watermark && typeof value.watermark === 'object' ? sanitizeUsage(value.watermark) : null,
      };
    }
  }

  if (raw.composition && typeof raw.composition === 'object') {
    // 老账本只有一份全局构成（每轮被最后读完的那条覆盖）。留着当兜底：
    // 没有任何一条会话带自己的构成时才用它。
    ledger.composition = {
      systemTokens: num(raw.composition.systemTokens),
      toolsTokens: num(raw.composition.toolsTokens),
      messageTokens: num(raw.composition.messageTokens),
    };
  }
  return ledger;
}

/** 读账本（首次读盘，之后走内存；坏文件当空账本，不阻断统计页）。 */
function readLedger() {
  if (cached !== null) return cached;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    raw = null;
  }
  cached = sanitizeLedger(raw);
  return cached;
}

/** 原子写：先写临时文件再 rename，写一半断电也不会留下半份 JSON。 */
function saveLedger(ledger) {
  cached = ledger;
  ledger.updatedAt = Date.now();
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 落盘失败只影响「重启后还在不在」：内存里这份仍然对当前进程有效，统计页照常能看。
  }
}

/** 测试与「换个 DSH_HOME 重读」用。 */
function forgetLedger() {
  cached = null;
}

/**
 * 裁剪：会话卡片按最后活动时间保留最近的。
 *
 * 超出的卡片**不删记录、只标退场**（`retired`）：水位与身份留着，那条会话以后再活跃
 * 就不会被当成首采、把整段历史重记一遍。退场记录自己也封顶，最老的先删。
 */
function trim(ledger) {
  const sessionIds = Object.keys(ledger.sessions);
  if (sessionIds.length > MAX_SESSIONS) {
    // 已经在退场里的不参与排位：它们本来就该往后排，重新算一遍只会来回抖动。
    const live = sessionIds.filter((id) => ledger.sessions[id].retired !== true);
    const retired = sessionIds.filter((id) => ledger.sessions[id].retired === true);
    if (live.length > MAX_SESSIONS) {
      live.sort((a, b) => num(ledger.sessions[b].lastAt) - num(ledger.sessions[a].lastAt));
      for (const id of live.slice(MAX_SESSIONS)) ledger.sessions[id].retired = true;
    }
    // 退场池按最后活动时间留最新的那一批，其余真删。
    const pool = [...retired, ...live.slice(MAX_SESSIONS)];
    if (pool.length > MAX_RETIRED) {
      pool.sort((a, b) => num(ledger.sessions[b].lastAt) - num(ledger.sessions[a].lastAt));
      for (const id of pool.slice(MAX_RETIRED)) delete ledger.sessions[id];
    }
  }
  // 每条会话自己那份按天用量也有上限：它只服务「这张卡片在这个范围里用了多少」，
  // 最老的那些日子从它自己的账上裁掉，按天的总账不动。
  for (const record of Object.values(ledger.sessions)) {
    if (!record.daily) continue;
    const own = Object.keys(record.daily).sort();
    if (own.length > MAX_DAILY_DAYS) {
      for (const day of own.slice(0, own.length - MAX_DAILY_DAYS)) delete record.daily[day];
    }
  }
  const days = Object.keys(ledger.days).sort();
  if (days.length > MAX_DAYS) {
    for (const day of days.slice(0, days.length - MAX_DAYS)) delete ledger.days[day];
  }
}

/** 账本里一条会话记录的初始形状（`applyDelta` 与读盘兜底共用一份）。 */
function emptySession(at) {
  return {
    title: '',
    workspaceName: '',
    lastText: '',
    cwd: '',
    firstAt: at,
    lastAt: 0,
    collectedAt: 0,
    gone: false,
    retired: false,
    billed: emptyUsage(),
    daily: {},
    composition: null,
    watermark: null,
  };
}

/**
 * 把一次采集到的增量记进账本（纯函数，原地改并返回它）。
 *
 * `entry.date` 只在「首采回填」时传：一条会话第一次被采到时，它历史上有多少量我们都
 * 不知道发生在哪天，只能记到它最后一次活动的那天 —— 记到今天会让今天凭空多出一大截，
 * 记到创建那天又会让所有历史堆在最早一天。两者都是近似，取「最后活动日」更接近直觉。
 */
function applyDelta(ledger, entry) {
  const sessionId = entry.sessionId;
  const delta = sanitizeUsage(entry.delta);
  const at = num(entry.at) || Date.now();
  const date = entry.date || dayKeyOf(at);

  const day = ledger.days[date] || (ledger.days[date] = emptyDay());
  for (const key of USAGE_KEYS) day[key] += delta[key];
  // 模型请求数按「步」的增量记：宿主没给独立的请求计数字段，而一步对应一次请求，
  // 与 dsh-context 的 requests 口径差不到一条结算的距离。
  day.requests += delta.steps;

  const record = ledger.sessions[sessionId] || (ledger.sessions[sessionId] = emptySession(at));
  for (const key of USAGE_KEYS) record.billed[key] += delta[key];
  // 这条会话自己那份按天用量：卡片的数字要跟页面范围走，所以增量在「记哪一天」这件事上
  // 必须和按天的总账记在同一个日期上（首采回填也是同一天）。
  const ownDay = record.daily[date] || (record.daily[date] = emptyUsage());
  for (const key of USAGE_KEYS) ownDay[key] += delta[key];
  record.lastAt = Math.max(record.lastAt, at);
  if (!record.firstAt) record.firstAt = at;
  // 退场的卡片又有了新用量：回到列表里来（水位一直在，所以这次只记增量）。
  record.retired = false;
  if (entry.title) record.title = entry.title;
  if (entry.cwd) record.cwd = entry.cwd;
  if (entry.workspaceName) record.workspaceName = entry.workspaceName;
  // 最后一句只留一行的长度：卡片底那行是给人认「这是哪条会话」的，不是正文存档。
  if (typeof entry.lastText === 'string' && entry.lastText) {
    record.lastText = entry.lastText.slice(0, LAST_TEXT_MAX);
  }
  return ledger;
}

/** 会话卡片上的计费量：四个桶之和。 */
function billedOf(usage) {
  return num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens);
}

/**
 * 一条会话在 [startDay, today] 里的用量。
 *
 * `startDay` 为 null（`all`）时直接用记录里的累计值 —— 累计值是权威，而它那份按天用量
 * 只保留最近 `MAX_DAILY_DAYS` 天。
 */
function usageInRange(record, startDay, today) {
  const billed = record.billed || emptyUsage();
  if (!startDay) return sanitizeUsage(billed);
  const usage = emptyUsage();
  const daily = record.daily || {};
  for (const [day, value] of Object.entries(daily)) {
    if (day < startDay || day > today) continue;
    for (const key of USAGE_KEYS) usage[key] += num(value[key]);
  }
  return usage;
}

/**
 * 按范围折算成 App 要的总览（纯函数）。
 *
 * 逐日序列会把范围内**每一天都列出来**（没有活动的补 0）：柱状图靠它保持等距，
 * 由页面决定怎么省略日期标签。
 *
 * 三块口径必须对得上（2026-10-24 改）：`kpi` 是范围内总量，`sessions` 里的每张卡片是
 * **这条会话在同一个范围里**的用量，`retired` / `untracked` 把不在卡片上的那部分明说出来 ——
 * 卡片加起来永远解释不了总量，是这个页面被读成「数据对不上」的根源。
 */
function summarize(ledger, range, now) {
  const today = dayKeyOf(now);
  const startDay = startDayOf(range, now);
  const allDays = Object.keys(ledger.days).sort();
  const firstDay = startDay || allDays[0] || today;

  const days = [];
  for (let cursor = firstDay; ; cursor = addDays(cursor, 1)) {
    const source = ledger.days[cursor] || emptyDay();
    days.push({
      day: cursor,
      uncachedInputTokens: num(source.uncachedInputTokens),
      cacheReadTokens: num(source.cacheReadTokens),
      cacheWriteTokens: num(source.cacheWriteTokens),
      outputTokens: num(source.outputTokens),
      requests: num(source.requests),
      turns: num(source.turns),
    });
    if (cursor >= today) break;
  }

  const kpi = {
    sessions: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    activeMs: 0,
    days: 0,
  };
  for (const point of days) {
    const source = ledger.days[point.day] || emptyDay();
    kpi.uncachedInputTokens += num(source.uncachedInputTokens);
    kpi.cacheReadTokens += num(source.cacheReadTokens);
    kpi.cacheWriteTokens += num(source.cacheWriteTokens);
    kpi.outputTokens += num(source.outputTokens);
    kpi.turns += num(source.turns);
    kpi.steps += num(source.steps);
    kpi.llmMs += num(source.llmMs);
    kpi.toolMs += num(source.toolMs);
    if (point.requests > 0 || point.turns > 0) kpi.days += 1;
  }
  kpi.activeMs = kpi.llmMs + kpi.toolMs;
  const rangeBilled = billedOf(kpi);

  // 热力图给足最近 52 周（364 天）：手机上只画得下 8 周，iPad 横屏能摊到三十周上下 ——
  // 窗口由页面按自己的宽度截最后几周，宿主这边一律给满，否则宽屏想多画也没有数据。
  const heatmap = [];
  for (let offset = HEATMAP_DAYS - 1; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const source = ledger.days[day];
    heatmap.push({ day, tokens: source ? billedOf(source) : 0 });
  }

  const sessions = [];
  let retiredSessions = 0;
  let retiredBilled = 0;
  // 构成快照取「最近有动作的那条会话」：每轮只在不是同一条时换，不再被并发读完的最后一条覆盖。
  let composition = null;
  let compositionSession = null;
  for (const [sessionId, record] of Object.entries(ledger.sessions)) {
    const usage = usageInRange(record, startDay, today);
    if (record.retired === true) {
      // 退场记录只留水位，不上卡片：它的量早就记在按天的账上了。范围里有量时在汇总行报个数。
      const billed = billedOf(usage);
      if (billed > 0) {
        retiredSessions += 1;
        retiredBilled += billed;
      }
      continue;
    }
    if (record.composition && num(record.lastAt) > num(compositionSession && compositionSession.lastAt)) {
      composition = {
        systemTokens: num(record.composition.systemTokens),
        toolsTokens: num(record.composition.toolsTokens),
        messageTokens: num(record.composition.messageTokens),
      };
      compositionSession = { lastAt: num(record.lastAt), sessionId, title: record.title || '' };
    }
    const billedTokens = billedOf(usage);
    // 范围内一个 token、一轮都没有的会话不上卡片：切到「近 7 天」时老会话不该占着位置。
    if (billedTokens === 0 && num(usage.turns) === 0) continue;
    sessions.push({
      sessionId,
      title: record.title || '',
      ...(record.workspaceName ? { workspaceName: record.workspaceName } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(record.lastText ? { lastText: record.lastText } : {}),
      billedTokens,
      turns: num(usage.turns),
      lastAt: num(record.lastAt),
      ...(record.gone ? { gone: true } : {}),
    });
  }
  sessions.sort((a, b) => {
    const goneA = a.gone ? 1 : 0;
    const goneB = b.gone ? 1 : 0;
    if (goneA !== goneB) return goneA - goneB;
    if (b.billedTokens !== a.billedTokens) return b.billedTokens - a.billedTokens;
    return b.lastAt - a.lastAt;
  });
  kpi.sessions = sessions.length;

  // 卡片 + 退场合计之后仍然少的那一截：老版本把整条记录删掉过（水位与明细都没了），
  // 按天的账上却还留着那些天。明说出来，别让用户自己拿计算器发现差额。
  // 只报量、不报条数 —— 那些会话连记录都没了，条数是编不出来的。
  const tracked = sessions.reduce((sum, row) => sum + row.billedTokens, 0) + retiredBilled;
  const untrackedBilled = Math.max(0, rangeBilled - tracked);

  // 没有任何一条会话带自己的构成时（升级前的老账本），退回那份全局快照。
  if (!composition && ledger.composition) composition = { ...ledger.composition };

  return {
    generatedAt: now,
    range,
    kpi,
    days,
    heatmap,
    ...(composition ? { composition } : {}),
    ...(compositionSession ? { compositionSessionId: compositionSession.sessionId } : {}),
    retired: { sessions: retiredSessions, tokens: retiredBilled },
    untrackedBilled,
    sessions,
  };
}

module.exports = {
  VERSION,
  MAX_SESSIONS,
  MAX_RETIRED,
  MAX_DAYS,
  MAX_DAILY_DAYS,
  HEATMAP_DAYS,
  LAST_TEXT_MAX,
  stateFile,
  readLedger,
  saveLedger,
  forgetLedger,
  applyDelta,
  summarize,
  trim,
  dayKeyOf,
  addDays,
  startDayOf,
  emptyUsage,
  billedOf,
  usageInRange,
  num,
};

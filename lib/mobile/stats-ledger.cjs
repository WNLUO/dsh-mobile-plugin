'use strict';

/**
 * 统计账本：按天累计的用量 + 每条会话的累计与身份（`$DSH_HOME/mobile-stats.json`）。
 *
 * 它不寄在会话日志上：用户会清理已归档的会话，删的就是日志本身；统计每次现算的话，清理之后
 * 那部分用量会凭空消失。一旦读到增量就落进这个文件，之后会话在不在都不影响历史数字。
 *
 * 口径（与桌面 dsh-context 的每日账本一致，只保留手机用得着的部分）：一天的账落在「观测到
 * 增量」的宿主本地日期上；计费 token = 未命中输入 + 缓存读 + 缓存写 + 输出，四个桶分开存；
 * 每条会话一条记录，范围内有量的都上卡片 —— 卡片条数就是页面那个「会话」数字，所以
 * **不按展示需要裁剪**（裁了那个数字就变成上限值了，不再是真的条数）。
 *
 * 第三张表是模型维度 `models`：按「渠道 + 模型」攒量，服务统计页那块「模型用量」。它账的是
 * 同一个增量 —— 也就是说这里没有「按模型拆过一遍」的原始数据，模型名取自**采集那一刻**这条
 * 会话正在用的那个选择（见 stats-collect.cjs 文件头），会话中途换模型的那一段整体归到换后的
 * 那个名下。这是水位法本来就有的近似，不是这里另加的简化。
 *
 * 只做纯数据（读写 + 折算），不碰网络；采集在 stats-collect.cjs，路由在 stats.js。
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../shared/paths');
const { identifyVendor, vendorLogoOf } = require('./model-vendors.js');

/** 账本格式版本：将来改结构时据此决定是丢弃还是迁移。 */
const VERSION = 1;

/**
 * 账本里会话记录的条数上限（按最后活动时间删最老的）。
 *
 * 这是**文件存储**的兜底，不是统计口径：页面上那个「会话」数字就是这条记录的条数，按展示
 * 需要裁到两百就会变成一个永远不动的上限值。所以档位抬到一台机器几年也用不完 —— 一台机器
 * 一天最多新增百来条（子代理各算一条），四千条约等于一个月的重度使用；真要顶到，删的也是
 * 最老的整条记录，按天的总账不受影响。
 */
const MAX_RECORDS = 4000;

/** 按天的账保留天数（约三年；一天一百多字节，超出的从最老的开始裁）。 */
const MAX_DAYS = 1100;

/**
 * 每条会话自己那份「按天用量」保留多少天。
 *
 * 它存在只为回答「这张卡片在这个范围里用了多少」：页面的三档范围最大 30 天，
 * 再留一倍余量足够；更老的日期按天的总账仍然还在，只是卡片不再按那条会话拆得开。
 * 不封顶的话，几千条会话 × 三年就是一份几十 MB 的 JSON，每次采集都要整份读写。
 * 超过这个窗口没再动过的记录会被 `trim` 瘦身（明细、最后一句、上下文构成一起丢掉）。
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

/**
 * 模型标识的落盘上限（与 `session-models.js` 下发目录时那份截断一致）。
 *
 * 渠道 / 模型的 id 与展示名由宿主给，长度不可控；账本每次采集都要整份读写，一条几百 KB 的
 * 名字会把文件撑成没法解释的大小。id 与目录同一套上限，两边的 id 才拼得出同一个桶名。
 */
const MODEL_PROVIDER_MAX = 256;
const MODEL_NAME_MAX = 512;

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
  return { version: VERSION, updatedAt: 0, days: {}, sessions: {}, models: {}, composition: null };
}

function textOf(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * 模型名 → 桶名。任一为空都算「不知道是哪个模型」，返回空串表示不要建桶。
 *
 * 别把空的那半拼成 `\u0000` 之后当垃圾筒：宿主读不到当前模型、或某个插件不上报渠道时，
 * 所有那类用量都会挤进同一个 `\u0000xxx` 桶，页面上一条「模型」指向不存在的东西。
 */
function modelKeyOf(provider, model) {
  return provider && model ? `${provider}\u0000${model}` : '';
}

/**
 * 模型选择的清洗：provider / model 缺一个才算没有，展示名缺了留空串。
 *
 * 展示名不算有效性判据：目录里那条模型下架了、渠道被卸载了，都只是「名字对不上」，这条用量
 * 该记在哪个渠道哪个模型名下仍然是确定的。以前把「展示名齐不齐」当成归属是否有效的判据，
 * 于是这种记录一重启读盘就变回「没有模型」，下一轮又触发一次老账本回填，同一段累计量在
 * 模型桶里翻倍。
 *
 * 展示名按「非空才覆盖」的规矩用，空串不能把已经记下的名字擦掉。
 */
function sanitizeModelSelection(source) {
  if (!source || typeof source !== 'object') return null;
  const provider = textOf(source.provider, MODEL_PROVIDER_MAX);
  const model = textOf(source.model, MODEL_NAME_MAX);
  if (!provider || !model) return null;
  return {
    provider,
    providerName: textOf(source.providerName, MODEL_NAME_MAX),
    model,
    modelName: textOf(source.modelName, MODEL_NAME_MAX),
  };
}

function emptyModelBucket(selection) {
  return {
    provider: selection.provider,
    providerName: selection.providerName,
    model: selection.model,
    modelName: selection.modelName,
    billed: emptyUsage(),
    daily: {},
    lastAt: 0,
  };
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

/**
 * `YYYY-MM-DD` → 那天本地零点的毫秒数。
 *
 * 模型桶只有「记在哪一天」，没有更细的时刻（增量是按会话水位差算的，采集那一刻才知道量，
 * 不知道它具体花在哪几分钟）。老账本回填那一笔只有日期，`lastAt` 只能落到那天零点上 ——
 * 它只用于「计费量相同」时的排序，差半天不要紧。
 */
function dayStartAt(day) {
  const [year, month, date] = day.split('-').map((part) => Number(part));
  return new Date(year, month - 1, date).getTime();
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
      // 更早的账本没有每条会话的按天用量：把它的历史量记在它最后一次活动那天。
      // 这跟「首采回填」是同一条近似，也是一次性回填 —— 之后就只记增量。
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
        // 上一次读到的那条会话 `updatedAt`：定期采集靠它跳过「一点没动」的会话。
        seenUpdatedAt: num(value.seenUpdatedAt),
        billed,
        // 这条会话自己那份按天用量：卡片上的数字要跟着页面范围走（见 `rangeUsageOf`）。
        daily,
        // 最后一次观测到的上下文构成：跟着会话走，不再全局只留一份。
        composition: readComposition(value.composition),
        // 采集那一刻这条会话用的渠道 + 模型。升级前的老记录没有这一栏，当没有。
        model: sanitizeModelSelection(value.model),
        // 水位是「宿主那边这条会话的累计值」，缺省为 null 表示还没采过（首采全量入账）。
        watermark: value.watermark && typeof value.watermark === 'object' ? sanitizeUsage(value.watermark) : null,
      };
    }
  }

  // 模型维度。老账本没有这张表是正常的（升级前没记过），按空处理 —— 别因为它缺字段就把
  // 整份账本当坏的丢掉，那是 `version` 的事。
  if (raw.models && typeof raw.models === 'object') {
    for (const value of Object.values(raw.models)) {
      const selection = sanitizeModelSelection(value);
      if (!selection) continue;
      const key = modelKeyOf(selection.provider, selection.model);
      if (!key) continue;
      const daily = {};
      if (value.daily && typeof value.daily === 'object') {
        for (const [day, usageOfDay] of Object.entries(value.daily)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !usageOfDay || typeof usageOfDay !== 'object') continue;
          daily[day] = sanitizeUsage(usageOfDay);
        }
      }
      ledger.models[key] = {
        provider: selection.provider,
        providerName: selection.providerName,
        model: selection.model,
        modelName: selection.modelName,
        billed: sanitizeUsage(value.billed),
        daily,
        lastAt: num(value.lastAt),
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
 * 裁剪：只防文件无限长，不动「有多少条会话」这个口径。
 *
 * 两道都跟**存储**有关，跟页面显示无关：
 *  - 每条记录自己那份按天用量只服务三档范围里最大的 30 天，最老的日子从它自己的账上裁掉，
 *    按天的总账不动；
 *  - 超过 `MAX_DAILY_DAYS` 没再动过的记录顺手瘦身：明细、最后一句、上下文构成一起丢掉，
 *    只留身份 + 累计 + 水位。它照旧算一条会话（`all` 那档用累计值），只是最近这几档本来就
 *    轮不到它，留着一百多字节的摘要和几十天明细纯属占地方。
 *
 * 记录条数超过 `MAX_RECORDS` 才真删，删最老的整条：水位跟着一起没，那条会话以后再活跃会
 * 被当成首采、把整段历史重记一遍 —— 所以档位要抬到几年也用不完，别拿它当展示上限。
 */
function trim(ledger) {
  const staleBefore = addDays(dayKeyOf(Date.now()), -MAX_DAILY_DAYS);
  for (const record of Object.values(ledger.sessions)) {
    if (record.daily) {
      const own = Object.keys(record.daily).sort();
      if (own.length > MAX_DAILY_DAYS) {
        for (const day of own.slice(0, own.length - MAX_DAILY_DAYS)) delete record.daily[day];
      }
    }
    const lastDay = num(record.lastAt) > 0 ? dayKeyOf(num(record.lastAt)) : '';
    if (lastDay && lastDay < staleBefore) {
      record.daily = {};
      record.lastText = '';
      record.composition = null;
    }
  }
  const sessionIds = Object.keys(ledger.sessions);
  if (sessionIds.length > MAX_RECORDS) {
    sessionIds.sort((a, b) => num(ledger.sessions[b].lastAt) - num(ledger.sessions[a].lastAt));
    for (const id of sessionIds.slice(MAX_RECORDS)) delete ledger.sessions[id];
  }
  // 模型桶只裁它自己那份按天用量，不按条数裁：一台机器用过的「渠道 + 模型」组合是十几个的
  // 量级，裁条数没有意义；而 `daily` 与每条会话那份一样只服务最近这几档范围。
  if (ledger.models && typeof ledger.models === 'object') {
    for (const [key, bucket] of Object.entries(ledger.models)) {
      if (!bucket || typeof bucket !== 'object') {
        delete ledger.models[key];
        continue;
      }
      const own = Object.keys(bucket.daily || {}).sort();
      if (own.length > MAX_DAILY_DAYS) {
        for (const day of own.slice(0, own.length - MAX_DAILY_DAYS)) delete bucket.daily[day];
      }
      // 一点量都没有、明细也裁空了的桶留着只会让页面出现一张全 0 的卡。
      if (billedOf(bucket.billed) === 0 && Object.keys(bucket.daily || {}).length === 0) delete ledger.models[key];
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
    seenUpdatedAt: 0,
    billed: emptyUsage(),
    daily: {},
    composition: null,
    model: null,
    watermark: null,
  };
}

/**
 * 只往模型表里记一笔（纯函数，原地改并返回账本）。
 *
 * 它不碰 `days` 也不碰 `sessions`：这唯一一个调用点是「老账本回填」—— 一条会话在升级前
 * 已经记过累计量，但账本里没有模型维度；补这张卡的时候把它的累计量在**那条会话的记录上**
 * 已经存在的那份 `billed` 复制进模型桶即可，按天总账与卡片都不该因此多出一份量。
 *
 * `day` 与 `days` / `sessions.daily` 那次记账用同一个日期（首采回填也是同一天），
 * `at` 可不传：老账本的记录上只有最后活动日，落到那天零点就够了（见 `dayStartAt`）。
 */
function applyModelUsage(ledger, entry) {
  const selection = sanitizeModelSelection(entry && entry.model);
  if (!selection) return ledger;
  const key = modelKeyOf(selection.provider, selection.model);
  if (!key) return ledger;
  if (!ledger.models || typeof ledger.models !== 'object') ledger.models = {};
  const bucket = ledger.models[key] || (ledger.models[key] = emptyModelBucket(selection));
  // 名字以最新的为准；空名不覆盖（渠道被卸载 / 宿主这一轮没带目录时不至于把已知名字擦掉）。
  if (selection.providerName) bucket.providerName = selection.providerName;
  if (selection.modelName) bucket.modelName = selection.modelName;
  const usage = sanitizeUsage(entry.usage);
  for (const usageKey of USAGE_KEYS) bucket.billed[usageKey] += usage[usageKey];
  const day = typeof entry.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.day)
    ? entry.day
    : dayKeyOf(Date.now());
  const daily = bucket.daily[day] || (bucket.daily[day] = emptyUsage());
  for (const usageKey of USAGE_KEYS) daily[usageKey] += usage[usageKey];
  bucket.lastAt = Math.max(bucket.lastAt, num(entry.at) || dayStartAt(day));
  return ledger;
}

/**
 * 把一次采集到的增量记进账本（纯函数，原地改并返回它）。
 *
 * `entry.date` 只在「首采回填」时传：一条会话第一次被采到时，它历史上有多少量我们都
 * 不知道发生在哪天，只能记到它最后一次活动的那天 —— 记到今天会让今天凭空多出一大截，
 * 记到创建那天又会让所有历史堆在最早一天。两者都是近似，取「最后活动日」更接近直觉。
 *
 * `entry.model` 是这个选择时可选带的 `{ provider, providerName, model, modelName }`：给了就
 * 把同一份 `delta` 也记进模型桶。名字为空的半个组合不建桶（见 `modelKeyOf`）。
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
  if (entry.title) record.title = entry.title;
  if (entry.cwd) record.cwd = entry.cwd;
  if (entry.workspaceName) record.workspaceName = entry.workspaceName;
  // 最后一句只留一行的长度：卡片底那行是给人认「这是哪条会话」的，不是正文存档。
  if (typeof entry.lastText === 'string' && entry.lastText) {
    record.lastText = entry.lastText.slice(0, LAST_TEXT_MAX);
  }
  // 模型维度：同一份增量在「采集这一刻这条会话正在用的模型」名下再记一笔。日期与上面两处
  // 必须同一个（首采回填也是），否则模型卡和按天账在切范围时会各说一套。
  if (entry.model) applyModelUsage(ledger, { model: entry.model, day: date, at, usage: delta });
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
 * 逐日序列会把范围内每一天都列出来（没有活动的补 0），柱状图靠它保持等距。
 *
 * 三块口径必须对得上：`kpi` 是范围内总量，`sessions` 里的每张卡片是这条会话在同一个范围里
 * 的用量，`untracked` 把「卡片解释不了总量」的那一截（老版本删过记录，只剩按天账）明说出来。
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
  // 构成快照取「最近有动作的那条会话」：每轮只在不是同一条时换，不再被并发读完的最后一条覆盖。
  let composition = null;
  let compositionSession = null;
  for (const [sessionId, record] of Object.entries(ledger.sessions)) {
    const usage = usageInRange(record, startDay, today);
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
    // 除此之外一条都不许筛 —— 卡片条数就是页面上那个「会话」数字。
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
  // 「会话」这一格就是条款数：范围内有量的会话全部在这儿，没有第二条口径。
  kpi.sessions = sessions.length;

  // 卡片加起来仍然少的那一截：老版本把整条记录删掉过（水位与明细都没了），按天的账上却还
  // 留着那些天。只报量、不报条数 —— 那些会话连记录都没了，条数是编不出来的。
  const tracked = sessions.reduce((sum, row) => sum + row.billedTokens, 0);
  const untrackedBilled = Math.max(0, rangeBilled - tracked);

  // 没有任何一条会话带自己的构成时（升级前的老账本），退回那份全局快照。
  if (!composition && ledger.composition) composition = { ...ledger.composition };

  // 模型卡：折算口径与每张会话卡完全一致（同一个 `usageInRange`），页面切范围时两块一起动。
  const models = [];
  // 这一份里认出来的厂商，只带**用到的那几个**图标（`icon` 是一段 SVG 标记，App 用 SvgXml
  // 直接画）：一次响应几十条模型行各自背一份图标没有意义。
  const vendors = {};
  for (const bucket of Object.values(ledger.models || {})) {
    if (!bucket || typeof bucket !== 'object') continue;
    const usage = usageInRange(bucket, startDay, today);
    const billedTokens = billedOf(usage);
    const turns = num(usage.turns);
    // 与卡片同一条规矩：范围内一个 token、一轮都没有的组合不上卡。
    if (billedTokens === 0 && turns === 0) continue;
    // 厂商从模型名 / 模型 id 认，认不出再用渠道兜（见 model-vendors.js）；认不出就不带，
    // 页面那一行退回首字母徽标。
    const vendor = identifyVendor(bucket);
    const logo = vendor ? vendorLogoOf(vendor) : null;
    if (logo) vendors[vendor] = logo;
    models.push({
      provider: bucket.provider || '',
      providerName: bucket.providerName || '',
      model: bucket.model || '',
      modelName: bucket.modelName || '',
      ...(logo ? { vendor } : {}),
      uncachedInputTokens: num(usage.uncachedInputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheWriteTokens: num(usage.cacheWriteTokens),
      outputTokens: num(usage.outputTokens),
      billedTokens,
      turns,
      // 请求数取 `usage.steps`，与按天账同一个口径（见 applyDelta 里的那条注释）。
      requests: num(usage.steps),
      lastAt: num(bucket.lastAt),
    });
  }
  models.sort((a, b) => (b.billedTokens !== a.billedTokens ? b.billedTokens - a.billedTokens : b.lastAt - a.lastAt));

  return {
    generatedAt: now,
    range,
    kpi,
    days,
    heatmap,
    ...(composition ? { composition } : {}),
    ...(compositionSession ? { compositionSessionId: compositionSession.sessionId } : {}),
    untrackedBilled,
    sessions,
    // 一个桶都没有也要给空数组：App 那边缺这个字段就整块不画，给空数组才是「画一块空」。
    models,
    // 一个厂商都没认出来时整项不出：老 App 不认识这个字段，新 App 缺它就是「没有图标」。
    ...(Object.keys(vendors).length > 0 ? { vendors } : {}),
  };
}

module.exports = {
  VERSION,
  MAX_RECORDS,
  MAX_DAYS,
  MAX_DAILY_DAYS,
  HEATMAP_DAYS,
  LAST_TEXT_MAX,
  stateFile,
  readLedger,
  saveLedger,
  forgetLedger,
  sanitizeLedger,
  applyDelta,
  applyModelUsage,
  summarize,
  trim,
  dayKeyOf,
  addDays,
  startDayOf,
  emptyUsage,
  billedOf,
  usageInRange,
  modelKeyOf,
  sanitizeModelSelection,
  num,
};

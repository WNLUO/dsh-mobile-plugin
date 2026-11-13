'use strict';

/**
 * 移动端「定时任务」API：把宿主 `ScheduleService` 的四件事转给手机。
 *
 * 服务走同进程直查 `ctx.get('schedule')`，不写进 `inject`：它是 Typert Remote 服务、不在
 * apiProxy 命名空间里，写进 inject 会因为老宿主没有这个服务而挡住整个插件。
 *
 * 四条接口：catalog（全部任务）、list（该会话的任务）、history（一条任务的运行记录）、
 * delete（硬删）。update 不做：手机端没有编辑入口，接一条没人调的路只会多一份参数校验。
 *
 * list 走 `catalog()` 再按 sessionId 筛，不用宿主的 `list({sessionId})`：后者只回还在跑的
 * 任务、行上没有 sessionId / status，一次性任务跑完就会从手机上「凭空消失」。
 *
 * 收敛规则与 mobile/jobs.js 同口径：必填字段坏了丢整条，可选字段坏了只丢字段，超长截断。
 * 服务不存在（老宿主）回 503 而不是空列表，App 才能分辨「没有这个功能」和「一条都没有」。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

const SCHEDULE_MAX_ENTRIES = 500;         // 单帧条数上限
const SCHEDULE_MAX_RECORDS = 100;         // 单次历史记录条数上限（宿主 limit 最大 100）
const SCHEDULE_ID_MAX = 200;              // 任务 id / messageId 长度上限
const SCHEDULE_TITLE_MAX = 200;           // 任务标题
const SCHEDULE_PROMPT_MAX = 4000;         // prompt（列表里只用于预览）
const SCHEDULE_EXPRESSION_MAX = 200;      // cron 五段表达式
const SCHEDULE_RRULE_MAX = 1000;          // rrule 两行（DTSTART + RRULE）
const SCHEDULE_TIMEZONE_MAX = 64;         // IANA 时区名
const SCHEDULE_TIME_MAX = 40;             // HH:mm:ss.SSS 与 RFC3339 时间戳
const SCHEDULE_DEFAULT_LIMIT = 20;        // 历史记录默认条数
const SCHEDULE_MAX_LIMIT = 100;           // 历史记录条数上限（宿主同一口径）

/** 宿主 ScheduleRecord 的封闭 kind 集（`rrule` 是 v2 宿主加的）。 */
const SCHEDULE_KINDS = new Set(['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule']);

/** 宿主没有这个服务时对 App 的统一回答（不是「没有任务」）。 */
const UNAVAILABLE = Object.freeze({
  code: 'schedule-unavailable',
  message: '宿主没有定时任务服务',
});

/** 必填文本：非字符串或全空白 → ''；超长截断。 */
function requiredText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

/** 可选文本：非法/空白 → undefined；超长截断（不补省略号，前端不显示标记）。 */
function optionalText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** prompt 是正文，别 trim：开头的换行对模型有意义。 */
function promptText(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.length > SCHEDULE_PROMPT_MAX ? value.slice(0, SCHEDULE_PROMPT_MAX) : value;
}

/** 有限正数，否则 undefined（everySeconds / afterSeconds 都只在这个域里）。 */
function optionalPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** ISO 周几数组：1–7 的整数，去重升序；空数组或混入非法值 → undefined。 */
function optionalWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const days = new Set();
  for (const day of value) {
    if (!Number.isInteger(day) || day < 1 || day > 7) return undefined;
    days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** 非负整数，否则 undefined。 */
function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 一条运行记录：messageId 是游标，必须留着；时间字段坏了只丢字段。 */
function normalizeDeliveryRecord(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const messageId = requiredText(item.messageId, SCHEDULE_ID_MAX);
  if (!messageId) return null;
  const scheduledAt = optionalText(item.scheduledAt, SCHEDULE_TIME_MAX);
  const deliveredAt = optionalText(item.deliveredAt, SCHEDULE_TIME_MAX);
  const prompt = optionalText(item.prompt, SCHEDULE_PROMPT_MAX);
  return {
    messageId,
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

/** 宿主回的最后一次投递：两个时间都在才留，缺一个就当没有。 */
function normalizeLastDelivery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scheduledAt = optionalText(value.scheduledAt, SCHEDULE_TIME_MAX);
  const deliveredAt = optionalText(value.deliveredAt, SCHEDULE_TIME_MAX);
  if (scheduledAt === undefined || deliveredAt === undefined) return undefined;
  return { scheduledAt, deliveredAt };
}

/**
 * 一条任务属于哪个会话。
 *
 * v2 宿主把它挪进了 `target`（`session` / `new_once` 带 `sessionId`，`new` 没有），v1 才有行上的
 * `sessionId`；`involvedSessionIds` 是参与过这条任务的会话（建它的那个在前），单会话任务通常就
 * 一条。三处依次退，第一个非空的就是它 —— `new` 目标没有确定会话，退回参与过的那条，
 * 否则这条任务在手机上永远筛不出来（手机是按会话筛的）。
 */
function entrySessionId(item) {
  return scheduleRowSessionIds(item)[0] || '';
}

/**
 * 一条任务**牵扯到的**全部会话，去重后按「行上的 sessionId → target → 参与过的 → 最近一次
 * 投递的目标」排列。
 *
 * `entrySessionId` 只要第一个（list 按会话筛、一条任务只挂一处），而侧栏那只时钟与桌面
 * `taskInvolvesSession` 同一口径：只要这条任务参与过这个会话就算上，所以那一边要整组。
 */
function scheduleRowSessionIds(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  const out = [];
  const push = (value) => {
    const resolved = requiredText(value, SCHEDULE_ID_MAX);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  };
  push(item.sessionId);
  const target = item.target;
  if (target && typeof target === 'object' && !Array.isArray(target)) push(target.sessionId);
  const involved = item.involvedSessionIds;
  if (Array.isArray(involved)) for (const candidate of involved) push(candidate);
  // `new` 目标每次投递都新建会话：桌面把最近一次投递到的那个也认成这条任务的归属。
  const delivery = item.lastDelivery;
  if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) push(delivery.targetSessionId);
  return out;
}

/**
 * 把一条宿主任务压成手机认的 `ScheduleEntry`。
 *
 * `sessionId` / `state` 由调用方给：catalog 用行上的（`status` → `state`），list 用查询串
 * 里的会话 id 且恒为 active —— list 只回裸记录，行上没有这两格。
 *
 * 必填坏了丢整条；`scheduledAt` 坏了只丢字段（App 因此不显示下次运行时间，但任务本身
 * 还在）；kind 专有字段只认自己那一种，混进来的别种字段一律不转发。
 */
function normalizeScheduleEntry(item, sessionId, state) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = requiredText(item.id, SCHEDULE_ID_MAX);
  if (!id) return null;
  if (typeof item.kind !== 'string' || !SCHEDULE_KINDS.has(item.kind)) return null;
  const title = requiredText(item.title, SCHEDULE_TITLE_MAX);
  if (!title) return null;
  // catalog 的会话归属在 target / involvedSessionIds 上，list 的由查询串那个顶上。
  const resolvedSessionId = sessionId || entrySessionId(item);
  if (!resolvedSessionId) return null;

  const entry = {
    id,
    sessionId: resolvedSessionId,
    kind: item.kind,
    title,
    prompt: promptText(item.prompt),
    state: state || stateOf(item.status),
  };

  const scheduledAt = optionalText(item.scheduledAt, SCHEDULE_TIME_MAX);
  if (scheduledAt !== undefined) entry.scheduledAt = scheduledAt;

  if (item.kind === 'after' || item.kind === 'every') {
    const seconds = optionalPositive(item.kind === 'after' ? item.afterSeconds : item.everySeconds);
    if (seconds !== undefined) {
      if (item.kind === 'after') entry.afterSeconds = seconds;
      else entry.everySeconds = seconds;
    }
  } else if (item.kind === 'rrule') {
    // `rrule` 自己带时区（`DTSTART;TZID=Asia/Shanghai:…`），行上没有单独那一格；规则整段
    // 转给 App，时区顺手从 DTSTART 里取出来补上，详情页那一行才不是空的。
    const rrule = optionalText(item.rrule, SCHEDULE_RRULE_MAX);
    if (rrule !== undefined) {
      entry.rrule = rrule;
      const zone = /^DTSTART;TZID=([^:]+):/m.exec(rrule);
      const timeZone = zone === null ? undefined : optionalText(zone[1], SCHEDULE_TIMEZONE_MAX);
      if (timeZone !== undefined) entry.timeZone = timeZone;
    }
  } else if (item.kind !== 'at') {
    // `at` 没有专有字段，别把宿主残留的 time / expression 顺手转发出去。
    const time = optionalText(item.time, SCHEDULE_TIME_MAX);
    const timeZone = optionalText(item.timeZone, SCHEDULE_TIMEZONE_MAX);
    if (time !== undefined) entry.time = time;
    if (timeZone !== undefined) entry.timeZone = timeZone;
    if (item.kind === 'weekly') {
      const weekdays = optionalWeekdays(item.weekdays);
      if (weekdays !== undefined) entry.weekdays = weekdays;
    } else if (item.kind === 'cron') {
      const expression = optionalText(item.expression, SCHEDULE_EXPRESSION_MAX);
      if (expression !== undefined) entry.expression = expression;
    }
  }

  // 修订时刻（RFC3339）：宿主的 CAS 基线。清单里本来就带，只是我们以前没转发 ——
  // 不转发的话，从列表打开一条任务首次保存时手上没有 `expectedUpdatedAt`，那次就不走冲突校验。
  const updatedAt = optionalText(item.updatedAt, SCHEDULE_TIME_MAX);
  if (updatedAt !== undefined) entry.updatedAt = updatedAt;

  const lastDelivery = normalizeLastDelivery(item.lastDelivery);
  if (lastDelivery !== undefined) entry.lastDelivery = lastDelivery;

  return entry;
}

/**
 * 把宿主回的数组收敛成手机列表：非数组当空；坏条目丢掉；按 id 去重（保留先出现的）；
 * 截到条数上限。catalog 与 list 共用同一套规则，所以两边形状天然一致。
 */
function normalizeScheduleEntries(value, sessionId, state) {
  const raw = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray(value.records) ? value.records
      : (value && typeof value === 'object' && Array.isArray(value.items) ? value.items : []));
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = normalizeScheduleEntry(item, sessionId, state);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= SCHEDULE_MAX_ENTRIES) break;
  }
  return out;
}

/**
 * 宿主的 `status` → 手机认的 `state`。
 *
 * v1 只有 `active` / `inactive`；v2 拆成 `active` / `paused` / `ended` —— 后两个都不是
 * 「还会继续投递」，手机那一页只有两档筛选，都收进 `inactive`。缺字段时按 active：
 * 宁可多显示一条，别整条消失。
 */
function stateOf(status) {
  return status === 'inactive' || status === 'paused' || status === 'ended' ? 'inactive' : 'active';
}

/** 错误文字：宿主 reject 的原文，取不到就退回 String()，别回一句空话。 */
function errorText(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * 宿主服务：同进程直查，拿不到就是老宿主（或极简 profile 没装）。
 *
 * 用 `ctx.get` 而不是 inject —— 与 directory-browse 的理由相同：本插件不依赖它，
 * 缺了只该让这四条路由回 503，不该让整个插件装不起来。
 */
function scheduleService(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get('schedule') || null;
  } catch {
    return null;
  }
}

/** 503：宿主没有这个能力（App 据此说「这台电脑没有这个功能」）。 */
function sendUnavailable(res) {
  sendJson(res, 503, { ok: false, error: { ...UNAVAILABLE } });
}

/**
 * 502：宿主调用失败。带已知错误码（`invalid_rule` 之类）就原样透传，App 能按码分支；
 * 否则统一 `schedule_failed`。
 */
function sendFailure(res, error) {
  const code = error && typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : 'schedule_failed';
  sendJson(res, 502, { ok: false, error: { code, message: errorText(error) } });
}

/** 从查询串取一个 trim 过的字符串参数。 */
function queryValue(url, key) {
  return (url.searchParams.get(key) || '').trim();
}

/** GET /api/mobile/v1/schedule/catalog —— 全部任务（active + inactive）。 */
async function handleScheduleCatalog(ctx, _req, res) {
  const service = scheduleService(ctx);
  if (!service) return sendUnavailable(res);

  let value;
  try {
    value = await service.catalog();
  } catch (error) {
    return sendFailure(res, error);
  }

  // `serverNow` 给手机算「还有多久 / 是不是逾期」：手机与电脑的钟不一定对得上，一律以
  // 宿主时间为准，不要在 App 里拿本地 Date.now() 减 scheduledAt。
  sendJson(res, 200, {
    ok: true,
    records: normalizeScheduleEntries(value, undefined, undefined),
    serverNow: Date.now(),
  });
}

/**
 * GET /api/mobile/v1/schedule/list?sessionId=… —— 该会话的全部任务（active + inactive）。
 *
 * 走 `catalog()` 再按 sessionId 筛，而不是宿主的 `list({sessionId})`：后者只回还在跑的，
 * 且行上没有 sessionId / status（见文件头）。`state` 因此由行上的 status 推出来，
 * 已结束的任务才能如实显示成「已结束」。
 *
 * `?brief=1` 是页头那只闹钟用的轻量档：只要「几条活动任务 + 最近要跑的那条 id」，
 * 不把每条任务的正文本、规则、交付记录整份搬回去。**筛选与判定完全同一套**（同一个
 * `normalizeScheduleEntries` + 同一个 active 判据），只是出参少了两样 —— 两处各写一份
 * 判定迟早会给出两个数（角标说 2、任务页说 3）。
 */
async function handleScheduleList(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = queryValue(url, 'sessionId');
  if (!sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid_selector', message: '需要 sessionId' } });
  }

  const service = scheduleService(ctx);
  if (!service) return sendUnavailable(res);

  let value;
  try {
    value = await service.catalog();
  } catch (error) {
    return sendFailure(res, error);
  }

  // 先按目录整体收敛（保住 status → state 的推导），再筛这条会话的。
  const all = normalizeScheduleEntries(value, undefined, undefined);
  const records = all.filter((entry) => entry.sessionId === sessionId);
  if (queryValue(url, 'brief') === '1') {
    const active = records
      .filter((entry) => entry.state === 'active')
      // 与 App 侧同一条排序口径：下次运行最近的在前，没有 scheduledAt 的垫底。
      .sort((a, b) => (Date.parse(a.scheduledAt ?? '') || Infinity) - (Date.parse(b.scheduledAt ?? '') || Infinity));
    return sendJson(res, 200, {
      ok: true,
      brief: true,
      count: active.length,
      ...(active[0]?.id === undefined ? {} : { firstTaskId: active[0].id }),
      serverNow: Date.now(),
    });
  }
  sendJson(res, 200, { ok: true, records, serverNow: Date.now() });
}

/** 把查询串里的 limit 收成 1–100 的整数；非法返回 0。 */
function parseLimit(raw) {
  if (raw === null) return SCHEDULE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return 0;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= SCHEDULE_MAX_LIMIT ? limit : 0;
}

/** 运行记录的 retention：两个非负数，坏了按 0（App 只是据此说「更早的读不到了」）。 */
function normalizeRetention(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    days: optionalCount(source.days) ?? 0,
    records: optionalCount(source.records) ?? 0,
  };
}

/** GET /api/mobile/v1/schedule/history?sessionId=…&id=…&limit=20&before=… */
async function handleScheduleHistory(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = queryValue(url, 'sessionId');
  const id = queryValue(url, 'id');
  if (!sessionId || !id) {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid_selector', message: '需要 sessionId 与 id' } });
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === 0) {
    return sendJson(res, 400, {
      ok: false,
      error: {
        code: 'invalid_limit',
        message: `limit 必须是 1–${SCHEDULE_MAX_LIMIT} 的整数`,
      },
    });
  }

  const service = scheduleService(ctx);
  if (!service) return sendUnavailable(res);

  const payload = { sessionId, id, limit };
  const before = queryValue(url, 'before');
  if (before) payload.before = before;

  let value;
  try {
    value = await service.history(payload);
  } catch (error) {
    return sendFailure(res, error);
  }

  const source = value && typeof value === 'object' ? value : {};
  if (source.code === 'schedule_not_found') {
    return sendJson(res, 404, { ok: false, error: { code: 'schedule_not_found', message: '没有这条定时任务' } });
  }
  if (source.code === 'delivery_cursor_not_found') {
    return sendJson(res, 409, { ok: false, error: { code: 'delivery_cursor_not_found', message: '运行记录游标已失效' } });
  }
  if (source.code) {
    return sendFailure(res, { code: 'schedule_failed', message: `宿主回了未知结果码：${source.code}` });
  }

  const records = [];
  for (const item of Array.isArray(source.records) ? source.records : []) {
    const record = normalizeDeliveryRecord(item);
    if (!record) continue;
    records.push(record);
    if (records.length >= SCHEDULE_MAX_RECORDS) break;
  }
  const nextBefore = optionalText(source.nextBefore, SCHEDULE_ID_MAX);

  sendJson(res, 200, {
    ok: true,
    id: requiredText(source.id, SCHEDULE_ID_MAX) || id,
    records,
    // 两个标记都原样带上：unavailable 是「更早的记录本来就不可用」，pruned 是「按保留
    // 策略清掉了」，App 对前者说「读不到了」、对后者说「已过期清理」，不能合并。
    earlierRecordsUnavailable: source.earlierRecordsUnavailable === true,
    earlierRecordsPruned: source.earlierRecordsPruned === true,
    retention: normalizeRetention(source.retention),
    ...(nextBefore === undefined ? {} : { nextBefore }),
  });
}

/**
 * 删一条任务。
 *
 * v1 宿主有独立的 `delete({sessionId, id})`；v2 把它并进了 `edit({id, action:'delete'})`
 * —— 后者只认 id，存储本来就是全局一张表，行上的 sessionId 只是字段（见 A2-57 的坑）。
 * 先问 `edit`，宿主没有这个方法再退回老的 `delete`。
 */
async function deleteTask(service, sessionId, id) {
  if (typeof service.edit === 'function') {
    return service.edit({ id, action: 'delete' });
  }
  return service.delete({ sessionId, id });
}

/** POST /api/mobile/v1/schedule/delete —— body { sessionId, id }。 */
async function handleScheduleDelete(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!sessionId || !id) {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid_selector', message: '需要 sessionId 与 id' } });
  }

  const service = scheduleService(ctx);
  if (!service) return sendUnavailable(res);

  let value;
  try {
    value = await deleteTask(service, sessionId, id);
  } catch (error) {
    return sendFailure(res, error);
  }

  const source = value && typeof value === 'object' ? value : {};
  // 任务已经不在了不算失败：手机端刷新后本来就看不到它，报错只会弹一个没意义的红条。
  const notFound = source.deleted !== true && source.code === 'schedule_not_found';
  sendJson(res, 200, {
    ok: true,
    id: requiredText(source.id, SCHEDULE_ID_MAX) || id,
    deleted: source.deleted === true,
    ...(notFound ? { code: 'schedule_not_found' } : {}),
  });
}

module.exports = {
  handleScheduleCatalog,
  handleScheduleList,
  handleScheduleHistory,
  handleScheduleDelete,
  entrySessionId,
  scheduleRowSessionIds,
  normalizeScheduleEntry,
  normalizeScheduleEntries,
  normalizeDeliveryRecord,
  normalizeRetention,
  parseLimit,
};

'use strict';

/**
 * 移动端「定时任务」API：把宿主 `ScheduleService` 的四件事转给手机。
 *
 * 桌面端有一套完整的定时任务：任务挂在会话上，到点把 prompt 投进会话，运行记录留在
 * 宿主里。手机端此前一条都看不到 —— 既不知道这个会话排了什么，也没法读「上次跑到
 * 什么时候」或者删掉一条排错的任务。本文件是宿主 `schedule` 服务的移动端代理。
 *
 * 服务走同进程直查 `ctx.get('schedule')`，与 mobile/directory-browse.js 取
 * `directoryPicker` 是同一个先例：它是 Typert Remote 服务，不在 apiProxy 的命名空间
 * 里，写进 `inject` 反而会因为老宿主没有这个服务而挡住整个插件。
 *
 * 四条接口对应宿主的四个公开方法：
 *  - GET  /api/mobile/v1/schedule/catalog  → `catalog()`         全部任务（active + inactive）
 *  - GET  /api/mobile/v1/schedule/list     → `catalog()` 里筛出该会话的任务（**active + inactive**）
 *  - GET  /api/mobile/v1/schedule/history  → `history({...})`    一条任务的运行记录
 *  - POST /api/mobile/v1/schedule/delete   → `delete({...})`     硬删
 *
 * `update` 这一批不做，别顺手接上：手机端暂时没有编辑入口，接一条没人调的路只会多一份
 * 要维护的参数校验。
 *
 * 宿主 catalog 的每项是「裸记录 + sessionId + status + 可选 lastDelivery」。手机只认一种
 * 形状：sessionId 必须带上，状态统一收成 `state`，删除 / 历史 / 修改都必须带行上的
 * sessionId，否则宿主恒回 not_found。
 *
 * **`list` 为什么不用宿主的 `list({sessionId})`**（2026-10-23 改）：宿主那个方法只回
 * **还在跑**的任务、而且回的是裸记录（没有 sessionId / status）。于是手机上按对话看任务时，
 * 一次性任务跑完就从这个入口消失了 —— 用户看到的是「任务凭空没了」，实际只是「结束了」。
 * 现在改成从 `catalog()`（active + inactive 全都有、行上带 status）里按 sessionId 筛，
 * 手机端因此能列出这条会话的全部任务（含已结束），筛选里那三档也才真正有意义。
 * 代价是一次多拉这份目录，它是宿主内存里的账、不是磁盘扫描，与统一页那一发等价。
 *
 * 收敛规则与 mobile/jobs.js 同口径：必填（id / kind / title / sessionId）坏了丢整条，
 * 可选字段坏了只丢字段 —— 少一个「下次运行时间」只是不显示，整条消失才是信息丢失。
 * 超长一律截断而不是丢整条：宿主已经校验过形状，这里的上限只防异常宿主把手机端列表
 * 撑爆。
 *
 * 服务不存在（老宿主）必须回 503 而不是空列表：App 要能分辨「这台电脑没有这个功能」
 * 和「一条任务都没有」，后者画空状态、前者画「升级宿主」。宿主调用抛错走 502，把原文
 * 带给 App —— 定时任务这块的错误多半是宿主的，插件不该换成一句「操作失败」。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

const SCHEDULE_MAX_ENTRIES = 500;         // 单帧条数上限
const SCHEDULE_MAX_RECORDS = 100;         // 单次历史记录条数上限（宿主 limit 最大 100）
const SCHEDULE_ID_MAX = 200;              // 任务 id / messageId 长度上限
const SCHEDULE_TITLE_MAX = 200;           // 任务标题
const SCHEDULE_PROMPT_MAX = 4000;         // prompt（列表里只用于预览）
const SCHEDULE_EXPRESSION_MAX = 200;      // cron 五段表达式
const SCHEDULE_TIMEZONE_MAX = 64;         // IANA 时区名
const SCHEDULE_TIME_MAX = 40;             // HH:mm:ss.SSS 与 RFC3339 时间戳
const SCHEDULE_DEFAULT_LIMIT = 20;        // 历史记录默认条数
const SCHEDULE_MAX_LIMIT = 100;           // 历史记录条数上限（宿主同一口径）

/** 宿主 ScheduleRecord 的封闭 kind 集。 */
const SCHEDULE_KINDS = new Set(['after', 'at', 'every', 'daily', 'weekly', 'cron']);

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
  // catalog 的 sessionId 在行上，list 的行上没有（由查询串那个顶上）。
  const resolvedSessionId = sessionId || requiredText(item.sessionId, SCHEDULE_ID_MAX);
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

/** 宿主的 `status` → 手机认的 `state`。缺字段时按 active：宁可多显示一条，别整条消失。 */
function stateOf(status) {
  return status === 'inactive' ? 'inactive' : 'active';
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
  sendJson(res, 200, {
    ok: true,
    records: all.filter((entry) => entry.sessionId === sessionId),
    serverNow: Date.now(),
  });
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
    value = await service.delete({ sessionId, id });
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
  normalizeScheduleEntry,
  normalizeScheduleEntries,
  normalizeDeliveryRecord,
  normalizeRetention,
  parseLimit,
};

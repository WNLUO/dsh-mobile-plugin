'use strict';

/**
 * 移动端「定时任务管理面」：新建、编辑、暂停、恢复、立即执行。
 *
 * 复用宿主 `ScheduleService` 已有的写能力，不自己接一套存储：
 *
 *  - 新建   → `create(request)`：`{ title, prompt, timing, target? }`。
 *  - 编辑   → `edit({ id, action: 'update', patch, expectedUpdatedAt? })`：
 *             patch 可以是 `{ title, prompt, timing, target, active }` 的任意子集。
 *  - 暂停   → 同 `edit`，patch 固定 `{ active: false }`（宿主 `status` 变 `paused`，不再计时）。
 *  - 恢复   → 同 `edit`，patch 固定 `{ active: true }`（宿主重算下一次触发时间）。
 *  - 立即执行 → `run({ id })`：投递一次但不消耗 / 移动原定触发时刻；任务正在执行时宿主回
 *             `schedule_execution_pending`。
 *
 * 宿主把「暂停 / 恢复」压在一个 `active` 布尔上，没有独立的 pause / resume 方法 —— 这不是
 * 我们另造语义，`edit` 的 `patch.active` 就是宿主给的唯一开关。删除已有 `schedule.js` 的
 * `edit({action:'delete'})` 兜底，这里不再重复。
 *
 * 走哪个方法：宿主实例是 Typert Remote 服务，人类可达的那几条叫 `remoteCreate` /
 * `remoteEdit`；直接 `create` / `edit` 需要多传一个 actorSessionId（不给就是「人类调用」）。
 * 优先用 `remote*`，老一点的宿主没这层就退回直调并显式传 undefined。两者都没有，按「这台
 * 电脑没有这个功能」回 503，不假装成功。
 *
 * `expectedUpdatedAt` 原样透传给宿主做 CAS：手机上的条目带着 `updatedAt`，保存时回传；
 * 电脑上这条已经被改过，宿主回 `schedule_conflict`，这里转成 409，App 提示刷新后再改，
 * 绝不静默覆盖别人的改动。
 *
 * 收敛口径：kind 闭集沿用 `after / at / every / daily / weekly / cron / rrule`（与
 * `schedule.js` 及宿主 `ScheduleRecord` 同一套）；timing 按宿主 wire 形状（snake_case）
 * 校验后转发，认不出的形状回 400 而不是让宿主抛。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');
const { normalizeScheduleEntry } = require('./schedule.js');

const SCHEDULE_ID_MAX = 200;
const SCHEDULE_TITLE_MAX = 120;        // 宿主 MAX_TITLE_LENGTH
const SCHEDULE_PROMPT_MAX = 4000;      // 指令正文上限（列表只用于预览，这里防一次塞爆请求）
const SCHEDULE_EXPRESSION_MAX = 200;   // cron 五段表达式
const SCHEDULE_RRULE_MAX = 1000;       // rrule 两行（DTSTART + RRULE）
const SCHEDULE_TIMEZONE_MAX = 64;      // IANA 时区名
const SCHEDULE_TIME_MAX = 40;          // HH:mm:ss.SSS / RFC3339

/** 宿主 ScheduleRecord 的封闭 kind 集（`rrule` 是 v2 宿主加的）。 */
const SCHEDULE_KINDS = new Set(['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule']);

/** 宿主没有这个服务（或没有写方法）时对 App 的统一回答。 */
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

/** prompt 是正文，别 trim：开头的换行对模型有意义。 */
function promptText(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.length > SCHEDULE_PROMPT_MAX ? value.slice(0, SCHEDULE_PROMPT_MAX) : value;
}

/** 可选文本：非法/空白 → undefined；超长截断。 */
function optionalText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** 有限正数，否则 undefined。 */
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

/**
 * 把一个 timing 输入收成宿主认的 wire 形状；不合法回 null。
 *
 * 兼容 App 可能传的 snake_case（宿主原字段）与 camelCase（少数客户端习惯）：两种写法都认，
 * 出去一律按宿主那套（after_seconds / every_seconds / daily.time_zone …）。
 *
 * @returns 宿主 `ScheduleTiming` 或 null
 */
function normalizeTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = value.kind;
  if (typeof kind !== 'string' || !SCHEDULE_KINDS.has(kind)) return null;

  if (kind === 'after') {
    const seconds = optionalPositive(value.after_seconds ?? value.afterSeconds);
    return seconds === undefined ? null : { kind: 'after', after_seconds: seconds };
  }
  if (kind === 'every') {
    const seconds = optionalPositive(value.every_seconds ?? value.everySeconds);
    return seconds === undefined ? null : { kind: 'every', every_seconds: seconds };
  }
  if (kind === 'at') {
    const at = value.at;
    if (typeof at === 'string') {
      const text = at.trim();
      return text ? { kind: 'at', at: text.slice(0, SCHEDULE_ID_MAX) } : null;
    }
    if (at && typeof at === 'object' && !Array.isArray(at)) {
      const date = requiredText(at.date, SCHEDULE_TIME_MAX);
      const time = requiredText(at.time, SCHEDULE_TIME_MAX);
      const zone = requiredText(at.time_zone ?? at.timeZone, SCHEDULE_TIMEZONE_MAX);
      if (!date || !time || !zone) return null;
      return { kind: 'at', at: { date, time, time_zone: zone } };
    }
    return null;
  }
  if (kind === 'rrule') {
    const rrule = optionalText(value.rrule, SCHEDULE_RRULE_MAX);
    return rrule === undefined ? null : { kind: 'rrule', rrule };
  }

  // daily / weekly / cron 都是「一个对象 + time_zone」的形状。允许嵌套（宿主原形状）与
  // 平铺（`{kind:'daily', time, time_zone}`）两种写法，出去一律还原成宿主那套嵌套。
  const nested = value[kind];
  const body = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : value;
  if (kind === 'daily') {
    const time = requiredText(body.time, SCHEDULE_TIME_MAX);
    const zone = requiredText(body.time_zone ?? body.timeZone, SCHEDULE_TIMEZONE_MAX);
    if (!time || !zone) return null;
    return { kind: 'daily', daily: { time, time_zone: zone } };
  }
  if (kind === 'weekly') {
    const time = requiredText(body.time, SCHEDULE_TIME_MAX);
    const zone = requiredText(body.time_zone ?? body.timeZone, SCHEDULE_TIMEZONE_MAX);
    const weekdays = optionalWeekdays(body.weekdays);
    if (!time || !zone || weekdays === undefined) return null;
    return { kind: 'weekly', weekly: { time, time_zone: zone, weekdays } };
  }
  // cron
  const expression = optionalText(body.expression, SCHEDULE_EXPRESSION_MAX);
  const zone = requiredText(body.time_zone ?? body.timeZone, SCHEDULE_TIMEZONE_MAX);
  if (expression === undefined || !zone) return null;
  return { kind: 'cron', cron: { expression, time_zone: zone } };
}

/** 会话创建参数（宿主 `ScheduleSessionCreateSpec`）。 */
function normalizeCreateSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const spec = {};
  const cwd = optionalText(value.cwd, 4096);
  const preset = optionalText(value.agentPreset ?? value.agent_preset, SCHEDULE_ID_MAX);
  if (cwd !== undefined) spec.cwd = cwd;
  if (preset !== undefined) spec.agentPreset = preset;
  return Object.keys(spec).length === 0 ? undefined : spec;
}

/**
 * 投递目标：`session` / `new_once` / `new`。不合法回 null（调用方转 400）；
 * 缺省（undefined 输入）回 undefined，交给宿主按 `new_once` 处理。
 */
function normalizeTarget(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = value.kind;
  if (kind === 'session') {
    const sessionId = requiredText(value.sessionId, SCHEDULE_ID_MAX);
    return sessionId ? { kind: 'session', sessionId } : null;
  }
  if (kind === 'new_once' || kind === 'new') {
    const spec = normalizeCreateSpec(value.create);
    return spec === undefined ? { kind } : { kind, create: spec };
  }
  return null;
}

/** 宿主的 `status` → 手机认的 `state`（与 schedule.js 同一套：paused / ended 都算 inactive）。 */
function stateOf(status) {
  return status === 'inactive' || status === 'paused' || status === 'ended' ? 'inactive' : 'active';
}

/**
 * 把宿主回的一条任务压成手机能画的形状。
 *
 * 正常走 `schedule.js` 的 `normalizeScheduleEntry`（字段收敛只有一份），再把编辑要用的
 * `updatedAt` 补上；极少数没有确定会话的 `new` 目标任务会被那一份判成 null（它要求
 * sessionId 非空），这里退化成最小形状，别让新建 / 编辑的返回凭空变成 500。
 */
function mobileEntry(raw, fallbackSessionId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const base = normalizeScheduleEntry(raw, fallbackSessionId, undefined);
  if (base) {
    const updatedAt = optionalText(raw.updatedAt, SCHEDULE_TIME_MAX);
    if (updatedAt !== undefined) base.updatedAt = updatedAt;
    return base;
  }

  const id = requiredText(raw.id, SCHEDULE_ID_MAX);
  const title = requiredText(raw.title, SCHEDULE_TITLE_MAX);
  if (!id || !title || typeof raw.kind !== 'string' || !SCHEDULE_KINDS.has(raw.kind)) return null;
  const entry = {
    id,
    sessionId: requiredText(fallbackSessionId, SCHEDULE_ID_MAX),
    kind: raw.kind,
    title,
    prompt: promptText(raw.prompt),
    state: stateOf(raw.status),
  };
  const scheduledAt = optionalText(raw.scheduledAt, SCHEDULE_TIME_MAX);
  if (scheduledAt !== undefined) entry.scheduledAt = scheduledAt;
  const updatedAt = optionalText(raw.updatedAt, SCHEDULE_TIME_MAX);
  if (updatedAt !== undefined) entry.updatedAt = updatedAt;
  return entry;
}

/** 控制类响应额外带上宿主的原始 status：App 要区分「暂停」与「已结束」时用得着。 */
function withStatus(entry, raw) {
  if (entry && raw && typeof raw.status === 'string') entry.status = raw.status;
  return entry;
}

/** 从 body 取 `expectedUpdatedAt`：null 合法（代表「已知当前没有 updatedAt」），缺省不传。 */
function expectedFrom(body) {
  if (!body || body.expectedUpdatedAt === undefined) return undefined;
  if (body.expectedUpdatedAt === null) return null;
  if (typeof body.expectedUpdatedAt !== 'string') return undefined;
  const text = body.expectedUpdatedAt.trim();
  return text ? text : undefined;
}

/** 宿主服务：同进程直查，拿不到就是老宿主（或极简 profile 没装）。 */
function scheduleService(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get('schedule') || null;
  } catch {
    return null;
  }
}

/** 400：参数不合法（不会去碰宿主）。 */
function badRequest(res, code, message) {
  sendJson(res, 400, { ok: false, error: { code, message } });
}

/** 503：宿主没有这个能力。 */
function sendUnavailable(res) {
  sendJson(res, 503, { ok: false, error: { ...UNAVAILABLE } });
}

/** 错误文字：宿主 reject 的原文，取不到就退回 String()。 */
function errorText(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/** 502：宿主调用失败；带已知错误码就原样透传。 */
function sendFailure(res, error) {
  const code = error && typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : 'schedule_failed';
  sendJson(res, 502, { ok: false, error: { code, message: errorText(error) } });
}

/** 宿主结果里带 `code` 的三种可解释结局。 */
function sendResultCode(res, code) {
  if (code === 'schedule_not_found') {
    return sendJson(res, 404, { ok: false, error: { code: 'schedule_not_found', message: '没有这条定时任务' } });
  }
  if (code === 'schedule_conflict') {
    return sendJson(res, 409, { ok: false, error: { code: 'schedule_conflict', message: '这条任务刚被改过，刷新后再试' } });
  }
  if (code === 'schedule_execution_pending') {
    return sendJson(res, 409, { ok: false, error: { code: 'schedule_execution_pending', message: '这条任务正在执行中' } });
  }
  return sendFailure(res, { code: 'schedule_failed', message: `宿主回了未知结果码：${code}` });
}

/**
 * 宿主抛出的错误按码分流：`schedule/input-invalid` 一类是参数问题（400），
 * `schedule_not_found` / `schedule_conflict` 按语义走对应状态，其余一律 502。
 */
function sendHostError(res, error) {
  const code = error && typeof error.code === 'string' ? error.code.trim() : '';
  if (code === 'schedule/input-invalid' || code === 'invalid_rule') {
    return badRequest(res, 'invalid_rule', errorText(error));
  }
  if (code === 'schedule_not_found') return sendResultCode(res, 'schedule_not_found');
  if (code === 'schedule_conflict') return sendResultCode(res, 'schedule_conflict');
  return sendFailure(res, error);
}

/** 新建：优先 remoteCreate（人类可达），老宿主退回 create(request, undefined)。 */
async function invokeCreate(service, request) {
  if (typeof service.remoteCreate === 'function') return service.remoteCreate(request);
  return service.create(request, undefined);
}

/** 编辑（含暂停 / 恢复）：优先 remoteEdit，老宿主退回 edit(request, undefined)。 */
async function invokeEdit(service, request) {
  if (typeof service.remoteEdit === 'function') return service.remoteEdit(request);
  return service.edit(request, undefined);
}

/** 宿主有没有某一条写方法（没有就当这个能力不存在）。 */
function hasCreate(service) {
  return !!service && (typeof service.remoteCreate === 'function' || typeof service.create === 'function');
}

function hasEdit(service) {
  return !!service && (typeof service.remoteEdit === 'function' || typeof service.edit === 'function');
}

/**
 * POST /api/mobile/v1/schedule/create
 * body { sessionId?, title, prompt, timing, target? }
 */
async function handleScheduleCreate(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const title = requiredText(body.title, SCHEDULE_TITLE_MAX);
  if (!title) return badRequest(res, 'invalid_title', `标题必填，且不超过 ${SCHEDULE_TITLE_MAX} 字`);
  const prompt = promptText(body.prompt);
  if (!prompt.trim()) return badRequest(res, 'invalid_prompt', '指令不能为空');
  const timing = normalizeTiming(body.timing);
  if (!timing) return badRequest(res, 'invalid_timing', '时间规则不合法');

  let target;
  if (body.target !== undefined && body.target !== null) {
    target = normalizeTarget(body.target);
    if (target === null) return badRequest(res, 'invalid_target', '投递目标不合法');
  } else if (sessionId) {
    // 没指定目标、又有会话：默认落在这条会话上（手机端建任务最常见的就是「当前对话」）。
    target = { kind: 'session', sessionId };
  }

  const service = scheduleService(ctx);
  if (!hasCreate(service)) return sendUnavailable(res);

  const request = { title, prompt, timing, ...(target === undefined ? {} : { target }) };
  let result;
  try {
    result = await invokeCreate(service, request);
  } catch (error) {
    return sendHostError(res, error);
  }
  if (!result || typeof result !== 'object') return sendFailure(res, new Error('宿主没有返回任务'));
  if (typeof result.code === 'string') return sendResultCode(res, result.code);

  const record = withStatus(mobileEntry(result, sessionId), result);
  if (!record) return sendFailure(res, new Error('宿主返回的任务形状不对'));
  sendJson(res, 200, { ok: true, record });
}

/**
 * 把 App 传来的 patch 收成宿主认的形状；不合法回 null（调用方转 400）。
 * 只透传白名单字段（title / prompt / timing / target / active），别的字段一律不转发。
 */
function normalizePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const patch = {};
  if ('title' in value) {
    const title = requiredText(value.title, SCHEDULE_TITLE_MAX);
    if (!title) return null;
    patch.title = title;
  }
  if ('prompt' in value) {
    const prompt = promptText(value.prompt);
    if (!prompt.trim()) return null;
    patch.prompt = prompt;
  }
  if ('timing' in value) {
    const timing = normalizeTiming(value.timing);
    if (!timing) return null;
    patch.timing = timing;
  }
  if ('target' in value) {
    const target = normalizeTarget(value.target);
    if (target === null) return null;
    if (target !== undefined) patch.target = target;
  }
  if ('active' in value) {
    if (typeof value.active !== 'boolean') return null;
    patch.active = value.active;
  }
  return patch;
}

/** 执行一次 edit 并把结果写成手机认的响应。 */
async function applyEdit(res, service, id, patch, expected, fallbackSessionId) {
  const request = { id, action: 'update', patch };
  if (expected !== undefined) request.expectedUpdatedAt = expected;

  let result;
  try {
    result = await invokeEdit(service, request);
  } catch (error) {
    return sendHostError(res, error);
  }
  if (!result || typeof result !== 'object') return sendFailure(res, new Error('宿主没有返回任务'));
  if (typeof result.code === 'string') return sendResultCode(res, result.code);

  const record = withStatus(mobileEntry(result, fallbackSessionId), result);
  if (!record) return sendFailure(res, new Error('宿主返回的任务形状不对'));
  sendJson(res, 200, { ok: true, record });
}

/**
 * POST /api/mobile/v1/schedule/update
 * body { id, patch, expectedUpdatedAt? }  —— patch 是 {title,prompt,timing,target,active} 的任意子集。
 */
async function handleScheduleEdit(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const id = requiredText(body.id, SCHEDULE_ID_MAX);
  if (!id) return badRequest(res, 'invalid_selector', '需要 id');
  const patch = normalizePatch(body.patch);
  if (patch === null) return badRequest(res, 'invalid_patch', 'patch 字段不合法');
  if (Object.keys(patch).length === 0) return badRequest(res, 'invalid_patch', 'patch 至少要有一个字段');

  const service = scheduleService(ctx);
  if (!hasEdit(service)) return sendUnavailable(res);

  return applyEdit(res, service, id, patch, expectedFrom(body), '');
}

/** 暂停 / 恢复共用：patch 固定 active。 */
async function setActive(ctx, req, res, active) {
  const body = (await readJsonBody(req)) || {};
  const id = requiredText(body.id, SCHEDULE_ID_MAX);
  if (!id) return badRequest(res, 'invalid_selector', '需要 id');

  const service = scheduleService(ctx);
  if (!hasEdit(service)) return sendUnavailable(res);

  return applyEdit(res, service, id, { active }, expectedFrom(body), '');
}

/** POST /api/mobile/v1/schedule/pause —— body { id, expectedUpdatedAt? } */
async function handleSchedulePause(ctx, req, res) {
  return setActive(ctx, req, res, false);
}

/** POST /api/mobile/v1/schedule/resume —— body { id, expectedUpdatedAt? } */
async function handleScheduleResume(ctx, req, res) {
  return setActive(ctx, req, res, true);
}

/**
 * POST /api/mobile/v1/schedule/run —— body { id }，立即执行一次。
 *
 * 宿主 `run` 不消耗原定触发时刻；同一任务正在执行时回 `schedule_execution_pending`，
 * 这不是失败，如实回 `ran:false` 让 App 说「正在跑」。
 */
async function handleScheduleRun(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const id = requiredText(body.id, SCHEDULE_ID_MAX);
  if (!id) return badRequest(res, 'invalid_selector', '需要 id');

  const service = scheduleService(ctx);
  if (!service || typeof service.run !== 'function') return sendUnavailable(res);

  let result;
  try {
    result = await service.run({ id });
  } catch (error) {
    return sendHostError(res, error);
  }
  if (!result || typeof result !== 'object') return sendFailure(res, new Error('宿主没有返回任务'));
  if (result.code === 'schedule_execution_pending') {
    return sendJson(res, 200, { ok: true, id, ran: false, code: 'schedule_execution_pending' });
  }
  if (typeof result.code === 'string') return sendResultCode(res, result.code);

  const record = withStatus(mobileEntry(result, ''), result);
  if (!record) return sendFailure(res, new Error('宿主返回的任务形状不对'));
  sendJson(res, 200, { ok: true, id: record.id, ran: true, record });
}

module.exports = {
  SCHEDULE_KINDS,
  normalizeTiming,
  normalizeTarget,
  normalizePatch,
  handleScheduleCreate,
  handleScheduleEdit,
  handleSchedulePause,
  handleScheduleResume,
  handleScheduleRun,
};

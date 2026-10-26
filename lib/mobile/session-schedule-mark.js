'use strict';

/**
 * 会话行左边那只时钟：这一条会话有没有还在生效的自动化任务。
 *
 * 桌面上那个标记只在会话行的主状态空闲时挂得上（有审批 / 新消息 / 正在跑时那格留给状态点），
 * 归档行留空；手机端此前没有这个标记。
 *
 * 数据从宿主的任务目录来：`schedule.catalog()` 一次给出全部任务的 sessionId + status，按
 * `status === 'active'` 收成集合，列表每行查表。不逐行发 `schedule/list` —— 会话列表每 10 秒
 * 重建一次，逐行请求等于每轮几十次往返。
 *
 * 三条取舍：服务不在（老宿主 / 极简 profile）就当没有任务；读失败也只吞这一条、不缓存，
 * 下个周期照常重问；只看 active，一次性任务投完转 inactive 后标记自然消失。
 */

/** 目录一次最多收多少条（与 schedule.js 的 SCHEDULE_MAX_ENTRIES 同量级，这里只用来防异常宿主）。 */
const CATALOG_MAX_ENTRIES = 500;

/**
 * 宿主 `schedule` 服务：同进程直查。
 *
 * 用 `ctx.get` 而不是 inject，理由与 mobile/schedule.js 相同：本插件不依赖它，缺了只该
 * 少一个标记，不该让整个插件装不起来。
 */
function scheduleService(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get('schedule') || null;
  } catch {
    return null;
  }
}

/**
 * 哪些会话还有活动自动化任务。
 *
 * @param ctx 插件上下文（取宿主 `schedule` 服务）
 * @returns {Promise<Set<string>>} 有活动任务的 sessionId 集合；服务缺失或读失败时为空集
 */
async function activeScheduleSessions(ctx) {
  const service = scheduleService(ctx);
  if (!service || typeof service.catalog !== 'function') return new Set();
  let value;
  try {
    value = await service.catalog();
  } catch {
    return new Set();
  }
  const records = Array.isArray(value)
    ? value
    : (value && Array.isArray(value.records) ? value.records : []);
  const out = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.status !== 'active') continue;
    if (typeof record.sessionId !== 'string' || !record.sessionId) continue;
    out.add(record.sessionId);
    if (out.size >= CATALOG_MAX_ENTRIES) break;
  }
  return out;
}

module.exports = { activeScheduleSessions };

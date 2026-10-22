'use strict';

/**
 * 会话行左边那只时钟：**这一条会话有没有还在生效的自动化任务**。
 *
 * 桌面上那个标记在 `@deepseek-ai/dsh-client-ui-schedule` 的 `SessionScheduleMark`：它占
 * 会话行标题前那格 16px，画一颗 14px 的 `IconClockOutlineRegular`；只在 「这一行自己的
 * 主状态是空闲」时才挂得上（有审批 / 有新消息 / 正在跑时，那一格留给状态点），归档行那格
 * 留空。手机端此前没有这个标记，用户在桌面上排了定时任务，手机上那条会话看不出任何区别。
 *
 * 数据从宿主的任务目录来：`schedule.catalog()` 一次给出全部任务的 sessionId + status，
 * 按 `status === 'active'` 收成一份「哪些会话有活动任务」的集合，列表每行只要查表。**不**
 * 每行发一次 `schedule/list` —— 会话列表每 10 秒重建一次，逐行请求等于每轮几十次往返。
 *
 * 三条取舍：
 *  - **服务不在就当没有任务**（老宿主 / 极简 profile 没装）：时钟是提示性信息，为它让整个
 *    会话列表失败是拿主要功能换装饰；
 *  - **读失败也当没有**，但只吞这一条，不缓存：下一个 10 秒周期照常重问，宿主的
 *    `schedule/changed` 与目录本身都是活的；
 *  - 只看 `active`：一次性任务投完就自动结束（`status` 转 inactive），桌面上那颗也跟着消失。
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

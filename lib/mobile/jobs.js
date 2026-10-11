'use strict';

/**
 * 移动端「后台任务」：把宿主会话的 job 视图收敛成手机能画的形状。
 *
 * 桌面端会话头部有一个任务触发器（@deepseek-ai/dsh-client-ui-jobs 的
 * JobListAction）：只在会话真的有 job 时才出现，显示「进行中 N / 共 M」，
 * 展开是一行一个任务（状态点 + 标签 + 已用时长）。数据源不是某个 RPC，而是
 * 宿主事件流上的整帧 `session/jobs`：{ type, sessionId, jobs: taskView[] }。
 *
 * 手机端此前**一帧都收不到** —— /session/stream 只转发了
 * session/event / session/queue / session/projection / question / approval，
 * `session/jobs` 落进了 else 分支被静默丢掉，于是后台任务在手机上是隐形的。
 *
 * 宿主已经把帧按 taskViewSchema 校验过，这里只做形状收敛与限长限条数，
 * 避免异常宿主把手机端列表撑爆。空的 jobs 数组必须原样转发：它是「任务都结束了」
 * 的唯一信号（宿主在 jobs.onJobsChanged 里就是靠空数组通知清空的）。
 */

const JOB_MAX_ITEMS = 50;    // 单帧任务条数上限（桌面端也只是个小列表）
const JOB_ID_MAX = 200;      // 任务 id 长度上限
const JOB_KIND_MAX = 60;     // 任务种类（bash / workflow…）
const JOB_LABEL_MAX = 200;   // 任务标题
const JOB_DETAIL_MAX = 300;  // 任务副标题

/** 宿主 wire 的封闭状态集（dsh-host-apiproxy taskViewSchema）。 */
const JOB_STATUSES = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);

/** 必填文本：非字符串或全空白 → ''；超长截断（不补省略号，id/kind 不是给人看的）。 */
function requiredText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

/** 可选文本：非法/空白 → undefined；超长截断补省略号。 */
function optionalText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 非负安全整数，否则 undefined。 */
function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 把一条 taskView 压成手机需要的形状。
 *
 * 必填字段（id / kind / label / status / startedAt）任一不合法就丢掉整条：
 * 缺了状态或开始时间的任务行画出来只会误导用户。
 * 可选字段（detail / finishedAt）不合法只丢字段、不丢任务：它不影响这一行
 * 「是什么、还在不在跑」，而状态本身已经说明任务是否结束。
 */
function normalizeJob(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = requiredText(item.id, JOB_ID_MAX);
  if (!id) return null;
  const kind = requiredText(item.kind, JOB_KIND_MAX);
  if (!kind) return null;
  const label = requiredText(item.label, JOB_LABEL_MAX);
  if (!label) return null;
  if (typeof item.status !== 'string' || !JOB_STATUSES.has(item.status)) return null;
  const startedAt = optionalCount(item.startedAt);
  if (startedAt === undefined) return null;
  const detail = optionalText(item.detail, JOB_DETAIL_MAX);
  const finishedAt = optionalCount(item.finishedAt);
  return {
    id,
    kind,
    label,
    status: item.status,
    startedAt,
    ...(detail === undefined ? {} : { detail }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

/** 一帧里的任务数组：非数组 → []；坏条目丢掉；按 id 去重（保留先出现的）；限条数。 */
function normalizeJobs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const job = normalizeJob(item);
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
    if (out.length >= JOB_MAX_ITEMS) break;
  }
  return out;
}

module.exports = { normalizeJob, normalizeJobs };

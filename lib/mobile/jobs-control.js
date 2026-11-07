'use strict';

/**
 * 后台任务的启停控制。
 *
 * 宿主把后台任务拆成两半：
 *  - 读：`session/jobs` 帧（`jobs.js` 只做形状收敛）与 `jobController` 的流式 `list` /
 *    `follow`（桌面端的任务面板用）。手机端已有的 `jobs` 帧已经能显示「进行中 N / 共 M」。
 *  - 写：宿主 `JobController` 只公开一条 `kill`（`job/kill`，人类代删，reason 记
 *    「cancelled by the user」，owner 仍会收到完成通知）。它接 `{ sessionId, jobId }`，
 *    回 `{ outcome: 'requested' | 'already-finished' }`，任务看不见时抛 `job/not-found`。
 *
 * 所以**取消能接，启动接不了**：`ctx.jobs.start()` 是给 bash / PTY 之类「生产者」用的
 * 内部 seam，`tool-jobs` 插件靠它把命令跑起来；移动 API 一旦放开「启动」就等于放开「跑任意
 * 命令」，直接撞上「不暴露 shell」那条能力边界。这里给启动一条显式 501（`jobs-start-
 * unsupported`），让 App 能明确显示「这台电脑只能看和取消，不能从这里起任务」，而不是装作
 * 成功或 404。
 *
 * 服务同进程直查 `ctx.get('jobController')`，不写进 inject：老宿主没有它时只该让这一条
 * 路由回 503，不该影响整个插件装配。没有这个服务就回 503（与 schedule 那套同口径）。
 */

const { sendJson, readJsonBody } = require('../shared/http-util');

const JOB_ID_MAX = 200;
const SESSION_ID_MAX = 200;

/** 宿主没有后台任务控制服务时的统一回答。 */
const UNAVAILABLE = Object.freeze({
  code: 'jobs-unavailable',
  message: '宿主没有后台任务控制服务',
});

/** 启动能力的统一回答：宿主不提供，只能取消。 */
const START_UNSUPPORTED = Object.freeze({
  code: 'jobs-start-unsupported',
  message: '宿主的移动 API 不能启动后台任务，只能查看与取消',
});

/** 必填文本：非字符串或全空白 → ''；超长截断。 */
function requiredText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

/** 错误文字：宿主 reject 的原文，取不到就退回 String()。 */
function errorText(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/** 同进程直查 `jobController`；拿不到返回 null。 */
function jobControllerService(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null;
    return ctx.get('jobController') || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/mobile/v1/jobs/cancel
 * body { sessionId?, jobId }  —— 取消一条后台任务。
 *
 * `sessionId` 取任务那一帧上带的会话（owner fence）：宿主只让会话看得见的任务被取消。
 * 无主任务可以不传；传了也不会错。
 */
async function handleJobsCancel(ctx, req, res) {
  const body = (await readJsonBody(req)) || {};
  const sessionId = requiredText(body.sessionId, SESSION_ID_MAX);
  const jobId = requiredText(body.jobId ?? body.id, JOB_ID_MAX);
  if (!jobId) {
    return sendJson(res, 400, { ok: false, error: { code: 'invalid_selector', message: '需要 jobId' } });
  }

  const service = jobControllerService(ctx);
  if (!service || typeof service.kill !== 'function') {
    return sendJson(res, 503, { ok: false, error: { ...UNAVAILABLE } });
  }

  let result;
  try {
    result = await service.kill({ sessionId, jobId });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code.trim() : '';
    if (code === 'job/not-found' || /not[\s-]?found/i.test(errorText(error))) {
      // 任务已经不在了不算大错：手机刷新一下就没有它了。
      return sendJson(res, 404, { ok: false, error: { code: 'job-not-found', message: '没有这个后台任务' } });
    }
    return sendJson(res, 502, { ok: false, error: { code: 'jobs_failed', message: errorText(error) } });
  }

  const outcome = result && typeof result === 'object' ? result.outcome : result;
  sendJson(res, 200, {
    ok: true,
    id: jobId,
    outcome: typeof outcome === 'string' && outcome ? outcome : 'requested',
  });
}

/**
 * POST /api/mobile/v1/jobs/start —— 宿主不提供这个能力，显式 501。
 *
 * 保留这条是为了让 App 能拿到一个明确答复（据此决定按钮显不显示 / 怎么写提示），
 * 而不是靠 404 猜。真要支持启动，得先改设计：那等于让移动端跑任意命令。
 */
async function handleJobsStart(_ctx, _req, res) {
  sendJson(res, 501, { ok: false, error: { ...START_UNSUPPORTED } });
}

module.exports = {
  handleJobsCancel,
  handleJobsStart,
};

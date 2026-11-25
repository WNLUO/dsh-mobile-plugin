// 用途：轮询平台现有反馈读取端点，等线程里出现第一条新官方回复；超时给改用 read 的提示。
'use strict';

const { readFeedback } = require('./feedback-read.cjs');

/** 两秒一问、最多两分钟；不是长连接，到点就停，不无限等。 */
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const TIMEOUT_MESSAGE = '暂时没收到回复，请用 read 查看';

/**
 * 轮询现有 /api/sdk/feedback（与 read 同一端点）等第一条官方回复。
 * 只读公开反馈，不读凭据、不碰会话内容。
 *
 * 选项：afterMessageId（已见过的最大 id，默认 0）、intervalMs（默认 2 秒）、
 * timeoutMs（默认 2 分钟）。平台没有公开事件流可用，所以每轮沿用 read 的线程视图，
 * 取第一条 author 为 staff 且 id 大于水位的消息；提交后立刻到达的回复也在第一轮被看到。
 * 到点仍无回复返回 { timedOut: true, message }；HTTP 与网络错误照状态抛出。
 */
async function watchFeedback(threadKey, options = {}) {
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (!key) throw Object.assign(new Error('watch 需要 threadKey'), { status: 400 });
  const opts = options && typeof options === 'object' ? options : {};
  const afterMessageId = Number.isFinite(opts.afterMessageId) ? opts.afterMessageId : 0;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const thread = await readFeedback(key);
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    const reply = messages.find((message) => message && message.author === 'staff'
      && typeof message.id === 'number' && message.id > afterMessageId);
    if (reply) {
      return {
        id: reply.id,
        author: 'staff',
        content: reply.content,
        created_at: reply.created_at,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true, message: TIMEOUT_MESSAGE };
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS, TIMEOUT_MESSAGE, watchFeedback };

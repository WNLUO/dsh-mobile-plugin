// 用途：订阅固定分发平台的公开反馈 SSE，实时等第一条官方回复，工具与本机控制面共用同一份线程契约。
'use strict';

const PLATFORM_ORIGIN = 'https://app.wnluo.com';
const FEEDBACK_EVENTS_PATH = '/api/sdk/feedback/events';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** 与 feedback-read.cjs 同一口径：错误自带 status，调用方照原样带出去。 */
function feedbackError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** 只认 id 大于水位、作者是官方的 reply；其余帧都不算回复。 */
function staffReplyOf(event, data, afterMessageId) {
  if (event !== 'reply' || !data) return null;
  let payload = null;
  try { payload = JSON.parse(data); } catch { return null; }
  if (!payload || typeof payload.id !== 'number' || payload.id <= afterMessageId || payload.author !== 'staff') return null;
  return {
    id: payload.id,
    author: 'staff',
    content: typeof payload.content === 'string' ? payload.content : '',
    created_at: typeof payload.created_at === 'string' ? payload.created_at : '',
  };
}

/**
 * 挂 SSE 长连接等官方回复。只读公开事件流，不读凭据、不碰会话内容。
 * 选项：afterMessageId（已见过的最大 id，默认 0）、timeoutMs（默认 5 分钟）。
 * 超时或服务端提前断流且没有回复时返回 { timedOut: true }；HTTP 错误与网络错误抛出。
 */
async function watchFeedback(threadKey, options = {}) {
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (!key) throw feedbackError('watch 需要 threadKey', 400);
  const opts = options && typeof options === 'object' ? options : {};
  const afterMessageId = Number.isFinite(opts.afterMessageId) ? opts.afterMessageId : 0;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader = null;
  try {
    const response = await fetch(`${PLATFORM_ORIGIN}${FEEDBACK_EVENTS_PATH}?thread_key=${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      let message = '';
      if (typeof response.json === 'function') {
        try {
          const body = await response.json();
          if (body && typeof body.error === 'string') message = body.error.trim();
        } catch { /* 非 JSON 错误体按状态码报 */ }
      }
      throw feedbackError(message || `反馈订阅失败（HTTP ${response.status}）`, response.status);
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw feedbackError('反馈订阅没有返回事件流', 502);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const reply = staffReplyOf(event, data, afterMessageId);
          if (reply) return reply;
          event = '';
          data = '';
          continue;
        }
        if (line.startsWith(':')) continue; // 心跳注释
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let valueText = colon === -1 ? '' : line.slice(colon + 1);
        if (valueText.startsWith(' ')) valueText = valueText.slice(1);
        if (field === 'event') event = valueText;
        else if (field === 'data') data = data ? `${data}\n${valueText}` : valueText;
      }
    }
    const pending = staffReplyOf(event, data, afterMessageId);
    if (pending) return pending;
    return { timedOut: true };
  } catch (error) {
    if (error && (error.name === 'AbortError' || controller.signal.aborted)) return { timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
    if (reader) {
      try { await reader.cancel(); } catch { /* 流已被服务端收掉 */ }
    }
  }
}

module.exports = { watchFeedback };

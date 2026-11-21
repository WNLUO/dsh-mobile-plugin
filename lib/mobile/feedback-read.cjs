// 用途：按线程 key 读取固定分发平台的反馈，工具与本机控制面共用同一份线程契约。
'use strict';

const PLATFORM_ORIGIN = 'https://app.wnluo.com';
const FEEDBACK_PATH = '/api/sdk/feedback';
const READ_TIMEOUT_MS = 10_000;

function feedbackError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** 与 App 的反馈线程视图保持同形状，不回传平台侧的设备与诊断元数据。 */
function threadView(raw) {
  if (!raw || typeof raw.thread_key !== 'string' || !raw.thread_key.trim()) {
    throw feedbackError('反馈接口没有返回线程信息', 502);
  }
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    thread_key: raw.thread_key,
    status: raw.status === 'closed' ? 'closed' : 'open',
    messages: Array.isArray(raw.messages) ? raw.messages.filter(message => message && typeof message.id === 'number').map(message => ({
      id: message.id,
      author: message.author === 'staff' ? 'staff' : 'user',
      content: typeof message.content === 'string' ? message.content : '',
      created_at: typeof message.created_at === 'string' ? message.created_at : '',
      attachments: Array.isArray(message.attachments)
        ? message.attachments.filter(file => file && typeof file.url === 'string' && typeof file.file_name === 'string')
        : [],
    })) : [],
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
    last_user_at: typeof raw.last_user_at === 'string' ? raw.last_user_at : null,
    last_staff_at: typeof raw.last_staff_at === 'string' ? raw.last_staff_at : null,
  };
}

async function readFeedback(threadKey) {
  const key = typeof threadKey === 'string' ? threadKey.trim() : '';
  if (!key) throw feedbackError('read 需要 threadKey', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const response = await fetch(`${PLATFORM_ORIGIN}${FEEDBACK_PATH}?thread_key=${encodeURIComponent(key)}`, {
      method: 'GET',
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status >= 200 && response.status < 300) return threadView(body?.data);
    const message = typeof body?.error === 'string' ? body.error.trim() : '';
    throw feedbackError(message || `反馈读取失败（HTTP ${response.status}）`, response.status);
  } catch (error) {
    if (error?.name === 'AbortError') throw feedbackError('反馈读取超时，网络可能不通', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readFeedback };

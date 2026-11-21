// 用途：本机与局域网控制面读取反馈、续回复；业务复用统一反馈服务。
'use strict';

const { readFeedback, submitFeedback } = require('../mobile/feedback.js');

async function handleFeedback({ req, res, readJson, sendJson, credentials, instanceId }) {
  try {
    if (req.method === 'GET') {
      const key = new URL(req.url, 'http://localhost').searchParams.get('thread_key');
      return sendJson(res, 200, await readFeedback(key));
    }
    const body = await readJson(req);
    const submitted = await submitFeedback({ credentials, instanceId }, body.content, body.threadKey);
    return sendJson(res, 200, submitted);
  } catch (error) {
    return sendJson(res, error.status || 502, { ok: false, error: { code: 'feedback_failed', message: String(error?.message || error) } });
  }
}

module.exports = { handleFeedback };

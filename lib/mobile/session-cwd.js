'use strict';

/**
 * 会话的工作区目录：正文里相对路径的解析基准。
 *
 * 两处在用，口径必须是同一个 —— 正文里的图片（`local-images.js` 按它把 `deliverables/a.png`
 * 换成内嵌字节）与点开正文里的文件链接（`session-file.js` 按它找文件）。
 *
 * 它是**可选的旁路**：取不到就回空串，调用方一律退回「只认绝对路径」的旧行为。这条跑在
 * 历史投影与 SSE 的同一条管线上，抛一次会让整页消息或一整帧事件一起挂掉，所以这里不抛。
 */

const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');

/** 会话的工作区目录（相对路径的解析基准）。取不到就回空串，由调用方决定怎么办。 */
async function cwdOf(ctx, sessionId) {
  try {
    const { value } = unwrap(await callSessions(ctx, 'list', {}));
    const items = (value && value.items) || [];
    const row = items.find((item) => item && item.sessionId === sessionId);
    return row && typeof row.cwd === 'string' ? row.cwd : '';
  } catch {
    return '';
  }
}

module.exports = { cwdOf };

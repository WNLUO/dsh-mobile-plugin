// 媒体任务整帧随会话流推送；收存进度按 revision 合并，不逐字节发帧。
'use strict';
const { mediaServiceOf } = require('./runtime.js');
function attachMediaTasks(ctx, sessionId, sink) {
  const service = mediaServiceOf(ctx);
  if (!service) return () => {};
  let last = '';
  const emit = (snapshot) => {
    const value = snapshot || service.snapshot(sessionId);
    const key = `${value.revision}`;
    if (key === last) return;
    last = key;
    try { sink({ type: 'media/tasks', sessionId, revision: value.revision, items: value.items }); } catch { /* 连接可能已关闭 */ }
  };
  const off = service.subscribe(sessionId, emit);
  try { emit(); } catch { /* 首帧失败不挡开流 */ }
  return off;
}
module.exports = { attachMediaTasks };

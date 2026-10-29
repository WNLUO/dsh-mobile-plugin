'use strict';

/**
 * 「这一页里只看到工具调用、看不到它的结果」时的补救：把结果记在进程里，供更早的页用。
 *
 * 为什么需要：历史是倒着分页取的（`beforeSeq`），一页的事件是 `[oldest, beforeSeq)`。而
 * `tool/result` 事件的 seq 比「发起这次调用的 assistant 消息」**大** —— 边界正好切在两者
 * 之间时，那一页只看得到调用，看不到结果，于是那条消息的工具图缺一块；等下一页（更新的一页，
 * 本机早就拿到过）把结果带回来再补，手机侧那一行已经从「没图」的高度长到「有图」的高度，
 * 而它在用户头顶上 —— 一变就把正看的内容推走（真机录制：同一条消息 589 ↔ 817 来回）。
 *
 * 做法：每次投影都把这一页看到的结果记下来；下一次投影更早的页时，把这些记下的结果一并喂给
 * `deriveMessages`，图就跟着消息一起下发，行在挂载那一帧就是终高。
 *
 * 边界：只活在插件进程里、只按会话分桶、每桶按插入序淘汰 —— 进程重启就没了，那时手机重新
 * 进对话本来也要重拉。
 */

/** 每条会话记住多少个调用：一次翻页窗口最多几百个，2000 足够覆盖一次通读。 */
const MAX_CALLS_PER_SESSION = 2000;
/** 同时记几条会话：手机一般只在一两条会话里翻历史。 */
const MAX_SESSIONS = 8;

/** sessionId → Map(callId → 结果)。Map 的插入序就是淘汰序。 */
const stores = new Map();

/**
 * 记住这一页看到的结果（已存在的不覆盖：同一次调用的结果不会变，先记下的就是它）。
 */
function rememberToolResults(sessionId, results) {
  if (!sessionId || !results || results.size === 0) return;
  let bucket = stores.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    stores.set(sessionId, bucket);
    // 新会话进来，把最旧的那条挤掉。
    while (stores.size > MAX_SESSIONS) {
      const oldest = stores.keys().next();
      if (oldest.done) break;
      stores.delete(oldest.value);
    }
  } else {
    // 读到就挪到末尾（按使用序淘汰，而不是按写入序）。
    stores.delete(sessionId);
    stores.set(sessionId, bucket);
  }
  for (const [callId, result] of results) {
    if (bucket.has(callId)) continue;
    bucket.set(callId, result);
    if (bucket.size > MAX_CALLS_PER_SESSION) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
    }
  }
}

/** 这条会话已经记下的结果（没有就是 empty Map）。调用方不要改它。 */
function toolResultsFor(sessionId) {
  return (sessionId && stores.get(sessionId)) || null;
}

/** 测试用：清掉一条（或全部）会话的记录。 */
function clearToolResults(sessionId) {
  if (sessionId) stores.delete(sessionId);
  else stores.clear();
}

module.exports = {
  rememberToolResults,
  toolResultsFor,
  clearToolResults,
  MAX_CALLS_PER_SESSION,
  MAX_SESSIONS,
};

'use strict';

/**
 * 消息与统计快照：镜像推送与 /messages 分页共用的两条折叠路径。
 *
 * buildMessagesSnapshot（不解析 query）与 handleMessages（解析 beforeSeq/afterSeq/limit）
 * 是同一套折叠逻辑的两种调用方式，放在一起是为了让「增量水位」的算法改动只发生在
 * 一处——它们此前隔着一百多行，两边各写一遍归一化，迟早会漂移。
 *
 * 上游 session.history 不认 afterSeq（只认 beforeSeq/maxMessages），所以增量轮询在
 * 插件内用较大的窗口（Math.max(limit, 200)）拉最近若干事件后再按 seq 过滤；缺口
 * 超过窗口时会漏，此时用 resyncRequired 让客户端回落到权威快照，而不是安静地少消息。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { deriveMessages } = require('./history-derive.js');
const { resolveEventAttachments } = require('./attachments.js');
const { createTextImageBudget } = require('./local-images.js');

const MESSAGES_DEFAULT_LIMIT = 50;  // /messages 默认条数

/** 从 history 事件条目取事件序号（entry.event.seq，兼容裸事件 entry.seq）。 */
function eventSeqOf(entry) {
  if (!entry) return undefined;
  return entry.event && entry.event.seq !== undefined ? entry.event.seq : entry.seq;
}

/**
 * 镜像快照用的消息折叠（不解析 query，无 afterSeq/beforeSeq/limit 分页）：
 * 与 handleMessages 的核心折叠逻辑保持一致，供 pushMirror 为活跃会话生成消息快照。
 */
async function buildMessagesSnapshot(ctx, sessionId, limit = MESSAGES_DEFAULT_LIMIT) {
  const { value, error } = unwrap(await callSessions(ctx, 'history', { sessionId, maxMessages: limit }));
  if (error) return { ok: false, error };
  const events = (value && value.events) || [];
  const budget = createTextImageBudget();
  const resolvedEvents = await Promise.all(events.map((entry) => resolveEventAttachments(ctx, sessionId, entry.event || entry, { budget }).then((event) => entry.event ? { ...entry, event } : event)));
  const messages = deriveMessages(resolvedEvents);
  const lastSeq = events.length ? (eventSeqOf(events[events.length - 1]) ?? 0) : 0;
  const hasMore = !!(value && value.hasMore);
  return { ok: true, items: messages, lastSeq, hasMore };
}

/**
 * 镜像快照用的统计投影（与 handleStats 尾部投影读取保持一致）：取整帧 projections，
 * 并把 plan 归一化为 planMode，供 pushMirror 为活跃会话生成统计快照。
 */
async function buildStatsSnapshot(ctx, sessionId) {
  return statsProjections(ctx, sessionId);
}

/**
 * 统计投影快照（handleStats 与 buildStatsSnapshot 共用）。
 *
 * 0.2.0 把整帧投影从 session.history/page 的返回值里拆走了（page 只回
 * events/hasMore/cursor），所以「拉 1 条历史顺带取投影」这条路已经断了；改走
 * host-bridge 翻译出来的 `apiProxy.sessions.projections({ request: { sessionId } })`，
 * 返回值是 `{ asOfSeq, values }`。顺带把 plan 归一化成 planMode（plan.active 加可选的
 * pending），排队条与计划条读的是 planMode。历史轮询是每 5 秒一次的热路径，多背一次
 * 投影 RPC 划不来，所以宁可让统计单独走投影端点。
 */
async function statsProjections(ctx, sessionId) {
  // 显式给 signal：宿主部分方法内部直接读 signal.aborted，不做 undefined 兜底。
  const controller = new AbortController();
  let value;
  let error;
  try {
    ({ value, error } = unwrap(await callSessions(ctx, 'projections', { sessionId }, 'mobile', controller.signal)));
  } catch (thrown) {
    // 投影读不出来不该变成一个从路由层逃出去的 rejection：handleStats 要回 400，
    // pushMirror 那边更是一条都不能抛（抛了整帧快照就丢了）。收敛成正常错误态。
    error = thrown && typeof thrown === 'object' && typeof thrown.code === 'string'
      ? { code: thrown.code, message: typeof thrown.message === 'string' ? thrown.message : '读会话投影失败' }
      : { code: 'host-call-failed', message: thrown && thrown.message ? String(thrown.message) : '读会话投影失败' };
  }
  if (error) return { ok: false, error };
  const projections = value && value.values && typeof value.values === 'object' ? value.values : {};
  const plan = projections.plan;
  return {
    ok: true,
    projections: plan && typeof plan === 'object' && typeof plan.active === 'boolean'
      ? { ...projections, planMode: { active: plan.active, ...(typeof plan.pending === 'boolean' ? { pending: plan.pending } : {}) } }
      : projections,
  };
}

/** GET /api/mobile/v1/session/messages?sessionId=…&beforeSeq=…&afterSeq=…&limit=…（token） */
async function handleMessages(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const beforeSeqRaw = url.searchParams.get('beforeSeq');
  const beforeSeq = beforeSeqRaw !== null && /^\d+$/.test(beforeSeqRaw) && Number.isSafeInteger(Number(beforeSeqRaw))
    ? Number(beforeSeqRaw) : null;
  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 200) : MESSAGES_DEFAULT_LIMIT;
  // 增量轮询水位：仅当为安全非负整数时使用（空/负数/小数/超界字符串一律忽略，退化为全量或历史分页）。
  const afterSeqRaw = url.searchParams.get('afterSeq');
  let afterSeq = null;
  if (afterSeqRaw !== null && afterSeqRaw !== '' && /^\d+$/.test(afterSeqRaw)) {
    const parsed = Number(afterSeqRaw);
    if (Number.isSafeInteger(parsed)) afterSeq = parsed;
  }
  const payload = { sessionId, maxMessages: limit };
  if (beforeSeq !== null) payload.beforeSeq = beforeSeq;
  // 上游 session.history 不支持 afterSeq（只认 beforeSeq/maxMessages），故在插件内
  // 用较大的窗口（Math.max(limit, 200)）拉最近若干事件后再过滤 seq > afterSeq，覆盖常见轮询缺口；
  // 若缺口超过窗口才会漏（简单且安全的折中，不动上游分页协议）。
  if (afterSeq !== null) payload.maxMessages = Math.max(limit, 200);
  const { value, error } = unwrap(await callSessions(ctx, 'history', payload));
  if (error) return sendJson(res, 400, { ok: false, error });
  const events = (value && value.events) || [];
  // 增量：只保留水位之后的事件；非 afterSeq 调用时 events 原样保留（行为与之前完全一致）。
  const filtered = afterSeq !== null ? events.filter((entry) => (eventSeqOf(entry) ?? -1) > afterSeq) : events;
  // 一页历史共用一个内联图片预算：正文里的本机图片越多，越靠后的那些保持字面 markdown，
  // 而不是让单次响应无限膨胀（见 local-images.js 的三级预算）。
  const budget = createTextImageBudget();
  const resolvedEvents = await Promise.all(filtered.map((entry) => resolveEventAttachments(ctx, sessionId, entry.event || entry, { budget }).then((event) => entry.event ? { ...entry, event } : event)));
  const messages = deriveMessages(resolvedEvents);
  const hasMore = !!(value && value.hasMore);
  const seqs = events.map(eventSeqOf).filter((seq) => Number.isSafeInteger(seq) && seq >= 0);
  const oldestSeq = seqs.length ? Math.min(...seqs) : null;
  // A truncated history window is not a complete incremental answer. Keep the
  // cursor unchanged and tell capable clients to resync from an authoritative snapshot.
  const resyncRequired = afterSeq !== null && hasMore && oldestSeq !== null && oldestSeq > afterSeq;
  const lastSeq = afterSeq !== null
    ? (resyncRequired ? afterSeq : (seqs.length ? Math.max(...seqs.filter((seq) => seq > afterSeq), afterSeq) : afterSeq))
    : (seqs.length ? Math.max(...seqs) : 0);
  sendJson(res, 200, {
    ok: true,
    items: messages,
    hasMore,
    lastSeq,
    ...(oldestSeq !== null ? { oldestSeq } : {}),
    ...(resyncRequired ? { resyncRequired: true } : {}),
  });
}

module.exports = { eventSeqOf, buildMessagesSnapshot, statsProjections, buildStatsSnapshot, handleMessages };

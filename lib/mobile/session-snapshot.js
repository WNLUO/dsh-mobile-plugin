'use strict';

/**
 * 消息快照：镜像推送与 /messages 分页共用的折叠路径。
 *
 * buildMessagesSnapshot（不解析 query）与 handleMessages（解析 beforeSeq/afterSeq/limit）
 * 共用消息折叠逻辑。普通会话走 sessions.history；子代理必须携带 durable parent address，
 * 改走 subagents.history，不能把 child sessionId 当普通会话读。统计投影不在这里，
 * 在 session-stats.js（两条路径的取数口径不同，别混回一份）。
 *
 * 上游历史接口不认 afterSeq（只认 beforeSeq/maxMessages），所以增量轮询在插件内用较大的
 * 窗口（Math.max(limit, 200)）拉最近若干事件后再按 seq 过滤；缺口超过窗口时会漏，此时
 * 用 resyncRequired 让客户端回落到权威快照，而不是安静地少消息。
 */

const { sendJson } = require('../shared/http-util');
const { unwrap } = require('./envelope.js');
const { callSessions } = require('./rpc.js');
const { deriveMessages, thinEntryMessages, toolResultPatchesFor } = require('./history-derive.js');
const { resolveEventAttachments } = require('./attachments.js');
const { createTextImageBudget } = require('./local-images.js');
const { entryWindowPayload } = require('./entry-window.js');

const MESSAGES_DEFAULT_LIMIT = 50, TOOL_LOOKBACK_EVENTS = 120;  // 默认条数 / 倒着翻页时多看几条（只为认出这一轮的工具结果）

function historyHttpStatus(error) {
  switch (error && error.code) {
    case 'bad-request': return 400;
    case 'session-not-found':
    case 'subagent-not-found': return 404;
    case 'subagent-unauthorized': return 403;
    case 'host-unavailable': return 503;
    default: return 502;
  }
}

function normalizeHistoryError(error) {
  return {
    code: error && typeof error.code === 'string' ? error.code : 'host-call-failed',
    message: error && typeof error.message === 'string' && error.message
      ? error.message
      : '读取会话历史失败',
  };
}

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
  const allEvents = (value && value.events) || [];
  // 这一路是整窗快照，不带分页参数（宿主已按 maxMessages 截过）：多给了就只留尾部那一窗。
  const events = allEvents.length > limit ? allEvents.slice(-limit) : allEvents;
  // 引用模式：图片只下发 attachmentId，不取字节（见 attachments.js）。正文里本机图片的
  // 内联仍走 budget，与之前一致。
  const budget = createTextImageBudget();
  const resolvedEvents = await Promise.all(events.map((entry) => resolveEventAttachments(ctx, sessionId, entry.event || entry, { budget, referencesOnly: true }).then((event) => entry.event ? { ...entry, event } : event)));
  const messages = deriveMessages(resolvedEvents, sessionId);
  const lastSeq = events.length ? (eventSeqOf(events[events.length - 1]) ?? 0) : 0;
  const hasMore = !!(value && value.hasMore);
  return { ok: true, items: messages, lastSeq, hasMore };
}

/** GET /api/mobile/v1/session/messages?sessionId=…&beforeSeq=…&afterSeq=…&limit=…（token） */
async function handleMessages(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  const parentSessionId = url.searchParams.get('parentSessionId');
  const mode = url.searchParams.get('mode');
  const hasSubagentAddress = parentSessionId !== null || mode !== null;
  if (hasSubagentAddress && (
    typeof parentSessionId !== 'string' || !parentSessionId.trim()
    || (mode !== 'one-shot' && mode !== 'continuable')
  )) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '子代理历史需要 parentSessionId 和有效 mode' } });
  }
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
  if (beforeSeq !== null) { payload.beforeSeq = beforeSeq; payload.maxMessages = limit + TOOL_LOOKBACK_EVENTS; }
  // 上游历史接口都不支持 afterSeq（只认 beforeSeq/maxMessages），故在插件内用较大的窗口
  // 拉最近若干事件后再过滤 seq > afterSeq，覆盖常见轮询缺口；缺口超过窗口时要求客户端全量补齐。
  if (afterSeq !== null) payload.maxMessages = Math.max(limit, 200);
  // 入口那一发（不带游标）可以要求按内容裁：宿主按轮取整，过程块见 thinEntryMessages。
  const wantThin = url.searchParams.get('thin') === '1' && beforeSeq === null && afterSeq === null;
  if (wantThin) entryWindowPayload(payload, limit);

  let value;
  let error;
  try {
    // 子会话走**同一条** session.page（historyViaPage），只是地址换成带父会话的 durable
    // 地址：宿主 0.2.1 起子代理已经没有 `subagents.history` 这个远程方法了（它只剩
    // prompt / interrupt / list），继续调它就是 `host-unavailable` → 手机端一条
    // 「请求失败 (HTTP 503)」。宿主自己的 page/follow 本来就认 `{kind:'subagent'}` 地址
    // （见 validateAddress），传对地址即可，不该另借一条已被删掉的接口。
    const historyPayload = hasSubagentAddress
      ? { ...payload, parentSessionId, mode }
      : payload;
    ({ value, error } = unwrap(await callSessions(ctx, 'history', historyPayload)));
  } catch (thrown) {
    error = normalizeHistoryError(thrown);
  }
  if (error) return sendJson(res, historyHttpStatus(error), { ok: false, error });
  const allEvents = (value && value.events) || [];
  const lookback = beforeSeq !== null && allEvents.length > limit ? allEvents.slice(0, -limit) : null;
  const events = lookback ? allEvents.slice(-limit) : allEvents;
  // 增量：游标之后的事件才是要发的行，但**折叠**仍按整窗做（见下）。
  // 一页历史共用一个内联图片预算：正文里的本机图片越多，越靠后的那些保持字面 markdown，
  // 而不是让单次响应无限膨胀（见 local-images.js 的三级预算）。
  //
  // 折叠要看**整窗**：压缩与 slash 命令行都是「一串事件攒出来的一行」（start → summary → end、
  // run → done），按游标先把事件砍掉再折叠，剩下那半截就会漏成「没有摘要的压缩行」和
  // 「没有名字的命令行」——真机现场就是屏幕上并排三行：`compact·执行中`、`上下文已压缩·
  // 压缩摘要不可用`、`命令·Compacted 206 history items`。所以游标只用来筛**折叠出来的行**，
  // 事件仍按整窗折叠；附件只为游标之后的事件解析（游标前那批只当上下文，不出行）。
  const budget = createTextImageBudget();
  const resolvedEvents = await Promise.all(events.map((entry) => {
    const seq = eventSeqOf(entry);
    const deliverable = afterSeq === null || !Number.isSafeInteger(seq) || seq > afterSeq;
    const event = entry.event || entry;
    if (!deliverable) return event;
    return resolveEventAttachments(ctx, sessionId, event, { budget, referencesOnly: true })
      .then((resolved) => (entry.event ? { ...entry, event: resolved } : resolved));
  }));
  const messages = deriveMessages(resolvedEvents, sessionId, lookback);
  const hasMore = !!(value && value.hasMore);
  const items = wantThin
    ? thinEntryMessages(messages, { hasMore })
    // 结构行（压缩 / 命令行）照发：它们由整段生命周期折出来，一次也就一两条，按 id 覆盖
    // 正好把屏幕上已经歪掉的那一行修回来 —— 按游标筛掉就永远修不回来。
    : (afterSeq === null
      ? messages
      : messages.filter((item) => item.kind === 'compaction' || item.kind === 'command'
        || (Number.isSafeInteger(item.seq) && item.seq > afterSeq)));
  // 工具结果不产生消息行，但会把**缓存里已有的**工具卡从 running 补成最终态。补丁取自
  // 整个窗口（调用方游标可能已越过结果 seq）；已随消息块下发的只回状态（见 toolResultPatchesFor）。
  // 增量那一发（带 afterSeq）一律只回状态：调用方手上已有一份会话，整窗重发等于每 15 秒
  // 把最近两百条的工具输出再传一次；入口裁剪那一发不带补丁（过程块已摘掉、无处可打）。
  const toolResults = wantThin ? [] : toolResultPatchesFor(events, items, { bodies: afterSeq === null });
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
    items,
    hasMore,
    lastSeq,
    ...(oldestSeq !== null ? { oldestSeq } : {}),
    ...(resyncRequired ? { resyncRequired: true } : {}),
    ...(toolResults.length ? { toolResults } : {}),
  });
}

module.exports = { eventSeqOf, buildMessagesSnapshot, handleMessages };

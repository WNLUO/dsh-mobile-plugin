'use strict';

/**
 * 会话列表的「最后一条消息」预览：为最近 / 运行中的会话补一次 history 折叠。
 *
 * 会话列表的标题与行数据都来自宿主 `sessions.list` 摘要，只有 `lastMessage` 要读日志，
 * 属于重活，所以只对预览子集做（见 sessions.js 的 SESSIONS_PREVIEW_LIMIT）。
 *
 * 同一份预览按会话指纹复用：运行中的会话 `updatedAt` 几乎每轮都在变，指纹于是每轮都变，
 * 10 秒的列表缓存一到期就要为每个运行中会话重读一次 history；一轮生成里手机侧 15s
 * 轮询会反复撞上「指纹变了但预览内容其实没变」的中间态，所以另加一个更短的窗口。
 * 非运行中的会话仍走指纹判定（它们的 updatedAt 不变，指纹不变，本来就不会重读）。
 */

const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { deriveMessages, lastMessageOf } = require('./history-derive.js');
const {
  sessionPreviewStateOf, sessionPreviewInFlightStateOf, sessionPreviewClockOf,
} = require('./session-cache.js');

/** 补预览时拉取的消息条数（低到足够取最后一条预览，避免每次重活）。 */
const HISTORY_FOR_ENRICH = 10;
/** 运行中会话的预览重读下限。 */
const RUNNING_PREVIEW_MIN_INTERVAL_MS = 3000;

function sessionPreviewFingerprint(summary) {
  return `${summary.updatedAt || 0}:${summary.running ? 'running' : 'idle'}:${summary.blank ? 'blank' : 'content'}`;
}

/** Read one preview at most once per unchanged session revision. */
async function sessionPreviewFor(ctx, summary) {
  const sessionId = summary.sessionId;
  const fingerprint = sessionPreviewFingerprint(summary);
  const cached = sessionPreviewStateOf(ctx).get(sessionId);
  if (cached?.fingerprint === fingerprint) return { events: [], lastMessage: cached.lastMessage };

  const inFlight = sessionPreviewInFlightStateOf(ctx);
  const existing = inFlight.get(sessionId);
  if (existing?.fingerprint === fingerprint) return existing.promise;

  // 运行中会话的节流（见 RUNNING_PREVIEW_MIN_INTERVAL_MS）：窗口内复用上一次预览，
  // 不为「updatedAt 又动了一下」再读一遍日志。返回空 events 与 cache-hit 分支一致
  // ——完成态确认只在真正读回历史时进行，本轮不复用它的边沿判定。
  const clock = sessionPreviewClockOf(ctx);
  if (cached && summary.running && Date.now() - (clock.get(sessionId) || 0) < RUNNING_PREVIEW_MIN_INTERVAL_MS) {
    return { events: [], lastMessage: cached.lastMessage };
  }
  clock.set(sessionId, Date.now());

  const promise = Promise.resolve(callSessions(ctx, 'history', {
    sessionId,
    maxMessages: HISTORY_FOR_ENRICH,
  })).then((response) => {
    const h = unwrap(response);
    if (h.error) return { events: [], lastMessage: null };
    const events = (h.value && h.value.events) || [];
    const messages = deriveMessages(events);
    const last = lastMessageOf(messages);
    const lastMessage = last ? { role: last.role, text: last.text.slice(0, 200), at: last.time } : null;
    sessionPreviewStateOf(ctx).set(sessionId, { fingerprint, lastMessage });
    return { events, lastMessage };
  }).finally(() => {
    if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, { fingerprint, promise });
  return promise;
}

module.exports = { HISTORY_FOR_ENRICH, RUNNING_PREVIEW_MIN_INTERVAL_MS, sessionPreviewFingerprint, sessionPreviewFor };

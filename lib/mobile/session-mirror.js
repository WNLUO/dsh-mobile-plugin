'use strict';

/**
 * 镜像快照：给中转侧手机回程推送准备的整帧会话数据。
 *
 * 两种模式：①高优先（给了 sessionIds）一次并行构建指定会话；②后台（不给）从摘要
 * 逐个构建、每建完一个就能推一帧，单次最多 maxSessions 个。缓存按
 * `updatedAt:running:limit` 指纹判鲜，2 分钟 TTL，上限 256 条按插入序淘汰。
 */

const { buildMessagesSnapshot } = require('./session-snapshot.js');
const { buildStatsSnapshot } = require('./session-stats.js');
const { mirrorHistoryStateOf } = require('./session-cache.js');

const MIRROR_HISTORY_CACHE_MS = 120000;  // 2 min TTL, reduces redundant rebuilds
const MIRROR_HISTORY_MAX_ENTRIES = 256;

/**
 * 快照构建失败的原因文本。
 *
 * 以前这里只记 `ok` 真假，`error.code/message` 被丢掉——真机上镜像推送连续报
 * 「session message snapshot missing for <id>」却查不出「为什么读不到」：状态接口、
 * stderr、测试全只有那一句，排查只能靠猜。带上 code 与 message 之后，同一个症状
 * 立刻能区分「会话不存在 / 宿主 RPC 报错 / 参数不对」。
 */
function describeBuildError(error) {
  if (!error) return 'unknown';
  if (typeof error === 'string') return error;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

/** 把 per-session 的失败原因挂到返回的 map 上（`_errors`，与 `_builtCount` 同族，不是会话键）。 */
function attachBuildErrors(messages, errors) {
  if (Object.keys(errors).length) messages._errors = errors;
}

/**
 * Build a single session's mirror snapshot (messages + stats).
 * Returns { ok, items, lastSeq, hasMore, stats } or { ok: false, error }.
 */
async function buildSingleSessionMirror(ctx, sessionId, options = { limit: 200 }) {
  if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: { code: 'bad-request', message: 'missing sessionId' } };
  const limit = Math.max(1, Math.min(Number(options.limit) || 200, 200));
  try {
    const [msgBody, statsBody] = await Promise.all([
      buildMessagesSnapshot(ctx, sessionId, limit),
      buildStatsSnapshot(ctx, sessionId),
    ]);
    if (!msgBody || !msgBody.ok) return { ok: false, error: msgBody?.error || { code: 'internal', message: 'failed to build messages' } };
    return {
      ok: true,
      items: msgBody.items,
      lastSeq: msgBody.lastSeq,
      hasMore: msgBody.hasMore,
      stats: statsBody && statsBody.ok ? statsBody.projections : undefined,
    };
  } catch (e) {
    return { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Build mirror warm snapshots for the host mirror push.
 *
 * Two modes: high-priority (sessionIds given) builds all specified sessions at once; background
 * (no sessionIds) builds from summaries one at a time so the caller can push incrementally,
 * at most `maxSessions` per call, using the cache when fresh.
 *
 * @param {object} ctx - harness context
 * @param {Array} summaries - session list summaries from host
 * @param {string} [activeSessionId] - optional active session to prioritize
 * @param {object} [options]
 * @param {string[]} [options.sessionIds] - specific sessions to build (high-priority)
 * @param {number} [options.limit=200] - max messages per session (capped at 200)
 * @param {number} [options.maxSessions=32] - max sessions to build in one call
 * @param {boolean} [options.noCache=false] - 完全绕开时间型缓存（既不读也不写）。事件驱动的
 *   推送必须传它：缓存只认「宿主抬了 updatedAt」这一种变化，新消息落盘而摘要未变时会把上一份
 *   正文当成这一份发出去。也不能靠传一个必然不同的 updatedAt 来绕：同一毫秒的两次推送指纹相同。
 * @returns {Promise<object>} messages map { [sessionId]: { ok, items, lastSeq, hasMore } }；
 *   后台模式还会带 _moreSessions（是否还有剩余会话）与 _builtCount（本次真正构建了几个）。
 */
async function buildMirrorWarmSnapshots(ctx, summaries, activeSessionId, options = {}) {
  const maxSessions = Math.max(1, Math.min(Number(options.maxSessions) || 32, 256));
  const limit = Math.max(1, Math.min(Number(options.limit) || 200, 200));
  let cache = mirrorHistoryStateOf(ctx);

  // Mode 1: High-priority - build specific sessions, all at once
  if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
    const messages = {};
    const errors = {};
    const ids = options.sessionIds.filter(id => typeof id === 'string' && id);
    await Promise.all(ids.map(async (sessionId) => {
      try {
        const body = await buildSingleSessionMirror(ctx, sessionId, { limit });
        if (body && body.ok) {
          // Update cache
          cache.delete(sessionId);
          cache.set(sessionId, { fingerprint: '', at: Date.now(), body });
          messages[sessionId] = body;
        } else {
          errors[sessionId] = describeBuildError(body && body.error);
        }
      } catch (error) {
        errors[sessionId] = describeBuildError(error);
      }
    }));
    attachBuildErrors(messages, errors);
    // Evict oldest entries when over limit
    while (cache.size > MIRROR_HISTORY_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return messages;
  }

  // Mode 2: Background - build from summaries, one at a time
  const candidates = (summaries || [])
    .filter(s => s && typeof s.sessionId === 'string' && s.sessionId)
    .slice()
    .sort((a, b) =>
      (b.sessionId === activeSessionId ? 1 : 0) - (a.sessionId === activeSessionId ? 1 : 0) ||
      (b.running ? 1 : 0) - (a.running ? 1 : 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0)
    );
  if (activeSessionId && !candidates.some(s => s.sessionId === activeSessionId)) {
    candidates.unshift({ sessionId: activeSessionId, updatedAt: 0, running: true });
  }

  const messages = {};
  const errors = {};
  let builtCount = 0;
  for (const summary of candidates) {
    if (builtCount >= maxSessions) {
      messages._moreSessions = true;
      break;
    }
    const id = summary.sessionId;
    const fingerprint = String(summary.updatedAt || 0) + ':' + (summary.running ? 'running' : 'idle') + ':' + limit;
    const previous = cache.get(id);
    if (!options.noCache && previous && previous.fingerprint === fingerprint && Date.now() - previous.at < MIRROR_HISTORY_CACHE_MS) {
      messages[id] = previous.body;
      continue;
    }
    try {
      const body = await buildMessagesSnapshot(ctx, id, limit);
      if (body && body.ok) {
        // noCache 时也不写：调用方给的 updatedAt 在事件驱动路径上不可信（可能是合成值），
        // 用它当指纹会往缓存里塞一条永远命不中的死条目，还会把该会话真实指纹挤掉。
        if (!options.noCache) {
          cache.delete(id);
          cache.set(id, { fingerprint, at: Date.now(), body });
        }
        messages[id] = body;
        builtCount++;
      } else {
        // 失败必须带上原因（见 describeBuildError）：调用方只看到「这个会话没进 map」，
        // 靠 `_errors` 才能把「读不到」与「读到了但空」分开。
        errors[id] = describeBuildError(body && body.error);
      }
    } catch (error) {
      errors[id] = describeBuildError(error);
    }
  }
  messages._builtCount = builtCount;
  attachBuildErrors(messages, errors);

  // Evict oldest entries when over limit
  while (cache.size > MIRROR_HISTORY_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return messages;
}

module.exports = { buildSingleSessionMirror, buildMirrorWarmSnapshots };

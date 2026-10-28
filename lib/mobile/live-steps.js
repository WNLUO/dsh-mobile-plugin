'use strict';

/**
 * 直播时那一轮的过程副本：**只在内存里**，收下一轮就换掉。
 *
 * 为什么需要它：录制里的推理正文与工具参数在落盘之前只存在于直播流里，宿主的
 * `session.history` 取不到跑到一半的那一步 —— 用户点开「正在读取文件」这一行时，
 * 详情接口只能从这份副本里答。落定以后按 `seq` 回拉历史，这份副本就不必再管。
 *
 * 容量口径：只留**当前这一轮**（`turn/start` 覆盖），整个进程里最多留几条会话。它复制
 * 的本就是宿主此刻正在攒的东西，所以量级与「这一轮有多长」同一档，收口后不再增长。
 */

/** 进程里同时留几条会话的直播副本（多开的会话不会一起跑，留几条够来回切）。 */
const MAX_SESSIONS = 4;

/** 单段文本的上限：详情是给人看的，超长输出照旧截断，别把一份 20MB 的结果塞回手机。 */
const TEXT_MAX = 200_000;

const { liveStepTurnOf } = require('./session-cache.js');

function bucketOf(ctx) {
  return liveStepTurnOf(ctx);
}

function turnOf(ctx, sessionId) {
  const bucket = bucketOf(ctx);
  let turn = bucket.get(sessionId);
  if (!turn) {
    turn = { tools: new Map(), thoughts: new Map(), callIdByIndex: new Map(), activeCallId: '', ended: false };
    bucket.delete(sessionId);
    bucket.set(sessionId, turn);
    // 只留几条会话（Map 按插入顺序，最老的先丢）。
    while (bucket.size > MAX_SESSIONS) bucket.delete(bucket.keys().next().value);
  }
  return turn;
}

/** 把一段文本接到已有的那段后面，超过上限就只留尾巴。 */
function appendText(prev, next) {
  if (typeof next !== 'string' || next === '') return prev || '';
  const joined = (prev || '') + next;
  return joined.length > TEXT_MAX ? joined.slice(joined.length - TEXT_MAX) : joined;
}

/** 工具结果两种形状都认（与 history-derive 的 toolResultParts 同一口径）。 */
function resultParts(message) {
  const direct = Array.isArray(message.content) ? message.content : [];
  const envelope = direct.length === 1 && direct[0] && typeof direct[0] === 'object'
    && typeof direct[0].type !== 'string' ? direct[0] : null;
  if (!envelope) return { parts: direct, isError: message.isError === true };
  return {
    parts: Array.isArray(envelope.content) ? envelope.content : [],
    isError: envelope.isError === true || message.isError === true,
  };
}

/**
 * 收一帧直播事件（在 `wire-cut` 之前看原始内容，所以这里什么都拿得到）。
 *
 * 只有三类事件有料：工具参数增量、推理增量、工具结果。其余一概忽略。
 */
function noteLiveEvent(ctx, sessionId, event) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return;
  if (!event || typeof event !== 'object') return;
  const data = event.data && typeof event.data === 'object' ? event.data : null;
  if (event.type === 'turn/start') {
    // 新的一轮开始：上一轮的过程副本作废（换掉了，就别再让人点开旧内容）。
    bucketOf(ctx).delete(sessionId);
    turnOf(ctx, sessionId);
    return;
  }
  if (!data) return;
  const turn = turnOf(ctx, sessionId);
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk;
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.type === 'tool-call-delta') {
      // 宿主只在**第一帧**带 `id` / `name`，后面那些帧只剩 `index` 与 `argumentsDelta`
      // （见 wire-cut.js 的同一条注释）。所以按块序号记住「这个 index 是哪个调用」，
      // 没有 id 的帧接到上一次那个调用上；一步里并行两个调用时按 index 各归各的。
      const index = Number.isSafeInteger(chunk.index) ? chunk.index : null;
      let callId = chunk.id != null ? String(chunk.id) : '';
      if (callId) {
        turn.activeCallId = callId;
        if (index !== null) turn.callIdByIndex.set(index, callId);
      } else if (index !== null && turn.callIdByIndex.has(index)) {
        callId = turn.callIdByIndex.get(index);
      } else if (turn.activeCallId) {
        callId = turn.activeCallId;
      }
      if (!callId) return;
      const current = turn.tools.get(callId) || { name: '', argsRaw: '' };
      turn.tools.set(callId, {
        name: typeof chunk.name === 'string' && chunk.name ? chunk.name : current.name,
        argsRaw: appendText(current.argsRaw, chunk.argumentsDelta),
      });
      return;
    }
    if (chunk.type === 'reasoning-delta') {
      if (!Number.isSafeInteger(chunk.index)) return;
      turn.thoughts.set(chunk.index, appendText(turn.thoughts.get(chunk.index), chunk.text));
    }
    return;
  }
  if (event.type === 'tool/result') {
    const message = data.message;
    const src = message && message.source;
    if (!src || typeof src.callId !== 'string') return;
    const current = turn.tools.get(src.callId) || { name: '', argsRaw: '' };
    const { parts, isError } = resultParts(message);
    const output = parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
    const diffs = data.meta && Array.isArray(data.meta.diffs) ? data.meta.diffs : undefined;
    const code = data.error && typeof data.error.code === 'string' ? data.error.code : undefined;
    turn.tools.set(src.callId, {
      ...current,
      output: output.length > TEXT_MAX ? output.slice(0, TEXT_MAX) : output,
      ...(isError ? { error: code === 'interrupted' ? 'stopped' : 'error' } : { error: null }),
      ...(diffs ? { diffs } : {}),
    });
    return;
  }
  if (event.type === 'turn/end') {
    turn.ended = true;
  }
}

/**
 * 取一步的直播详情；没有这一份（换了一轮、或这一步已经落盘）返回 null，由调用方转历史。
 */
function liveStepOf(ctx, sessionId, query) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return null;
  const bucket = liveStepTurnOf(ctx);
  const turn = bucket.get(sessionId);
  if (!turn) return null;
  if (query && query.kind === 'think') {
    const index = Number.isSafeInteger(query.index) ? query.index : null;
    if (index === null) return null;
    const text = turn.thoughts.get(index);
    if (typeof text !== 'string' || text === '') return null;
    return { kind: 'think', text, live: true, state: turn.ended ? 'ok' : 'running' };
  }
  const callId = query && typeof query.callId === 'string' ? query.callId : '';
  if (!callId) return null;
  const tool = turn.tools.get(callId);
  if (!tool) return null;
  const state = tool.error === undefined ? (turn.ended ? 'ok' : 'running') : (tool.error || 'ok');
  return {
    kind: 'tool',
    live: true,
    ...(tool.name ? { name: tool.name } : {}),
    state,
    ...(tool.argsRaw ? { argsRaw: tool.argsRaw } : {}),
    ...(typeof tool.output === 'string' && tool.output ? { output: tool.output } : {}),
    ...(Array.isArray(tool.diffs) && tool.diffs.length > 0 ? { diffs: tool.diffs } : {}),
  };
}

/** 丢掉一条会话的直播副本（会话关掉、或者换设备时用）。 */
function clearLiveSteps(ctx, sessionId) {
  liveStepTurnOf(ctx).delete(sessionId);
}

module.exports = { noteLiveEvent, liveStepOf, clearLiveSteps };

'use strict';

/**
 * 直播时那一轮的过程副本：**只在内存里**，收下一轮就换掉。
 *
 * 为什么需要它：录制里的推理正文与工具参数在落盘之前只存在于直播流里，宿主的
 * `session.history` 取不到跑到一半的那一步 —— 用户点开「正在读取文件」这一行时，
 * 详情接口只能从这份副本里答。落定以后按 `seq` 回拉历史，这份副本就不必再管。
 *
 * 它同时是**跑着那一轮的过程清单**：手机上那条「过程 · 已跑 3 步」要每一行一步的摘要，
 * 而推理块整块不上线路、工具参数也不上（见 `wire-cut.js`），所以摘要与状态只能在这里
 * 算好再按步发出去（`drainLiveSteps` → `session/live-steps` 帧）。**摘要由电脑算**
 * 这条不变：手机上根本没有参数可拼。
 *
 * 容量口径：只留**当前这一轮**（`turn/start` 覆盖），整个进程里最多留几条会话。它复制
 * 的本就是宿主此刻正在攒的东西，所以量级与「这一轮有多长」同一档，收口后不再增长。
 */

/** 进程里同时留几条会话的直播副本（多开的会话不会一起跑，留几条够来回切）。 */
const MAX_SESSIONS = 4;

/** 单段文本的上限：详情是给人看的，超长输出照旧截断，别把一份 20MB 的结果塞回手机。 */
const TEXT_MAX = 200_000;

const { liveStepTurnOf } = require('./session-cache.js');
const { reasoningStepSummary, toolStepSummary } = require('./step-index.js');

function bucketOf(ctx) {
  return liveStepTurnOf(ctx);
}

function turnOf(ctx, sessionId) {
  const bucket = bucketOf(ctx);
  let turn = bucket.get(sessionId);
  if (!turn) {
    turn = {
      tools: new Map(),
      /** 推理正文：键是**这一轮里的第几段思考**（不是内容块序号，块序号每步从 0 重数）。 */
      thoughts: new Map(),
      /** 内容块序号 → 那一段思考的编号（只在当前这一步内有效，落定即清）。 */
      thoughtOfBlock: new Map(),
      nextThought: 0,
      callIdByIndex: new Map(),
      activeCallId: '',
      /** 这一轮跑过的步（按发生顺序），一步一条，`key` 是它在 App 侧的稳定身份。 */
      steps: [],
      stepByKey: new Map(),
      /** 还没发出去的那几步（`drainLiveSteps` 取走）。 */
      pending: [],
      ended: false,
    };
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

/**
 * 记一步：没有就追加到清单末尾，有就改它（同一处只占一条）。
 *
 * 只有**真的变了**的那个字段才进待发清单 —— 工具身份帧会来好几发，每发都推送一遍等于
 * 把同一行反复发给你。
 */
function putStep(turn, key, patch) {
  let entry = turn.stepByKey.get(key);
  if (!entry) {
    entry = { key, step: {} };
    turn.stepByKey.set(key, entry);
    turn.steps.push(entry);
    Object.assign(entry.step, patch);
    turn.pending.push({ key, step: { ...entry.step } });
    return entry;
  }
  const before = entry.step;
  const changed = Object.keys(patch).some((field) => patch[field] !== before[field]);
  if (changed) {
    Object.assign(entry.step, patch);
    turn.pending.push({ key, step: { ...entry.step } });
  }
  return entry;
}

function toolKey(callId) {
  return `tool:${callId}`;
}

function thinkKey(ordinal) {
  return `think:${ordinal}`;
}

/**
 * 工具步的摘要与状态：摘要参数齐了才拼（读到哪算哪的一行「读文件」等于没写）。
 *
 * `error` 是**三态**：没有这一格 = 结果还没来（还在跑）；`null` = 结果到了、成功了；
 * `'error'` / `'stopped'` = 结果到了、失败了。别把 `null` 当成「还在跑」。
 */
function refreshToolStep(turn, callId) {
  const tool = turn.tools.get(callId);
  if (!tool) return;
  const summary = toolStepSummary(tool.name, tool.argsRaw);
  const state = tool.error === undefined
    ? 'running'
    : (tool.error === null ? 'ok' : (tool.error === 'stopped' ? 'stopped' : 'error'));
  putStep(turn, toolKey(callId), {
    kind: 'tool',
    callId,
    ...(tool.name ? { name: tool.name } : {}),
    summary,
    state,
  });
}

/** 一段思考落定：摘要补上，状态收成成功。 */
function settleThought(turn, ordinal) {
  const text = turn.thoughts.get(ordinal);
  if (typeof text !== 'string' || text === '') {
    putStep(turn, thinkKey(ordinal), { state: 'ok' });
    return;
  }
  putStep(turn, thinkKey(ordinal), { summary: reasoningStepSummary(text), state: 'ok' });
}

/** 这一步的所有思考都收尾（一步的块序号只在这一步内有效，落定即清）。 */
function closeThoughtsOfStep(turn) {
  for (const ordinal of turn.thoughtOfBlock.values()) settleThought(turn, ordinal);
  turn.thoughtOfBlock.clear();
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
 * 只有这几类事件有料：工具参数增量、推理增量、块边界、助手消息、工具结果、回合结束。
 * 其余一概忽略。
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
  if (event.type === 'assistant/message') {
    // 一步落定：这一步的思考按块序号收尾（后面那一步的块序号从 0 重新数）。
    closeThoughtsOfStep(turn);
    // 块序号 → 调用 的对照也随之作废：下一步的 0 号块是另一个块，留着它会让一条正文
    // 的块边界把上一步的工具重新标成「运行中」。
    turn.callIdByIndex.clear();
    turn.activeCallId = '';
    const message = data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool-call' || block.id == null) continue;
      const callId = String(block.id);
      const current = turn.tools.get(callId) || { name: '', argsRaw: '' };
      // 参数到这里是齐的 —— 摘要该按它拼出来了。身份帧可能在断线 / 合并里丢过，
      // 所以这里也顺手把这一步补进清单（有就只更新）。
      turn.tools.set(callId, {
        name: typeof block.name === 'string' && block.name ? block.name : current.name,
        argsRaw: typeof block.arguments === 'string'
          ? block.arguments
          : (block.arguments != null ? JSON.stringify(block.arguments) : current.argsRaw),
      });
      refreshToolStep(turn, callId);
    }
    return;
  }
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
        ...(current.output !== undefined ? { output: current.output } : {}),
        ...(current.diffs !== undefined ? { diffs: current.diffs } : {}),
        ...(current.error !== undefined ? { error: current.error } : {}),
      });
      // 参数还在流：这一步照实说「运行中」，摘要等参数齐了再补。
      const tool = turn.tools.get(callId);
      putStep(turn, toolKey(callId), {
        kind: 'tool',
        callId,
        ...(tool.name ? { name: tool.name } : {}),
        summary: '',
        state: 'running',
      });
      return;
    }
    if (chunk.type === 'reasoning-delta') {
      if (!Number.isSafeInteger(chunk.index)) return;
      let ordinal = turn.thoughtOfBlock.get(chunk.index);
      if (ordinal === undefined) {
        ordinal = turn.nextThought;
        turn.nextThought += 1;
        turn.thoughtOfBlock.set(chunk.index, ordinal);
        turn.thoughts.set(ordinal, '');
        // **思考也算一步**：从第一段推理就开始算，不必等到它调工具。
        putStep(turn, thinkKey(ordinal), { kind: 'think', index: ordinal, summary: '', state: 'running' });
      }
      turn.thoughts.set(ordinal, appendText(turn.thoughts.get(ordinal), chunk.text));
      return;
    }
    if (chunk.type === 'block-end') {
      const index = Number.isSafeInteger(chunk.index) ? chunk.index : null;
      if (index === null) return;
      const callId = turn.callIdByIndex.get(index);
      if (callId) {
        // 参数流完了（接下来才是执行）：这一刻的摘要就是用户要看的那个路径 / 命令。
        refreshToolStep(turn, callId);
        return;
      }
      const ordinal = turn.thoughtOfBlock.get(index);
      if (ordinal !== undefined) {
        settleThought(turn, ordinal);
        turn.thoughtOfBlock.delete(index);
      }
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
    // 失败有两种写法：`message.isError` 与 `data.error.code`（宿主两种都发过），任一都算失败。
    const failed = isError || code !== undefined;
    turn.tools.set(src.callId, {
      ...current,
      output: output.length > TEXT_MAX ? output.slice(0, TEXT_MAX) : output,
      ...(failed ? { error: code === 'interrupted' ? 'stopped' : 'error' } : { error: null }),
      ...(diffs ? { diffs } : {}),
    });
    refreshToolStep(turn, src.callId);
    return;
  }
  if (event.type === 'turn/end') {
    turn.ended = true;
    // 这一轮收口：还在跑的那几步按成功收尾（宿主不会再补一条结果给它们）。
    closeThoughtsOfStep(turn);
    for (const [callId, tool] of turn.tools) {
      if (tool.error === undefined) putStep(turn, toolKey(callId), { state: 'ok' });
    }
  }
}

/**
 * 这一轮到目前为止跑过的步（App 侧的过程清单）。
 *
 * 只给「一行摘要 + 状态 + 位置」：正文一个字节都不在这里，点开某一步才走 `/session/step`。
 */
function liveStepsOf(ctx, sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return [];
  const turn = liveStepTurnOf(ctx).get(sessionId);
  if (!turn) return [];
  return turn.steps.map((entry) => ({ key: entry.key, step: { ...entry.step } }));
}

/**
 * 取走「还没告诉过手机」的那几步。
 *
 * 每条都是 `{ key, step }`：新的一步就是追加，同一步的状态变化就是按 `key` 替换。
 */
function drainLiveSteps(ctx, sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return [];
  const turn = liveStepTurnOf(ctx).get(sessionId);
  if (!turn || turn.pending.length === 0) return [];
  const out = turn.pending.slice();
  turn.pending.length = 0;
  return out;
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

module.exports = { noteLiveEvent, liveStepOf, liveStepsOf, drainLiveSteps, clearLiveSteps };

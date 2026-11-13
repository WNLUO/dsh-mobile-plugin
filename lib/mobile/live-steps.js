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

const { liveStepTurnOf, liveStepWriterOf, liveStepSinkOf } = require('./session-cache.js');
const { reasoningText, reasoningStepSummary, toolStepSummary } = require('./step-index.js');
const { createTurnFacts, absorbTurnFact, rebuildTurnFacts, turnFactsSnapshot, turnChangesSnapshot, resultCallId } = require('./turn-facts.js');

function bucketOf(ctx) {
  return liveStepTurnOf(ctx);
}

/**
 * 「谁在往这条会话的直播副本里写」。
 *
 * 直播副本是**进程级、按会话共享**的一份：电脑上这条会话跑着的时候，任何一条连进来的
 * `/session/stream` 都会把收到的增量喂进来。而同一条会话**可能同时有不止一条流**（同一个
 * 聊天页被开着两屏——屏栈下层是保留挂载的；或重连那一刻旧连接还没在电脑这头断干净）。
 * 若每条流都往里写，每段推理就会被接两遍，用户点开「思考」看到的是逐 token 翻倍的正文
 * （`TheThe proxy proxy …`）。所以定一条规矩：**同一会话只认一个写入者**，它关掉之后下一个
 * 连进来的流再接棒。其余流只读（`liveStepOf` / `liveStepsOf` 照常能读，正文不会翻倍）。
 *
 * 归属按 `ctx` 分（与 `liveStepTurnOf` 同一把钥匙），换轮（`turn/start` 清桶）不动它——
 * 还是那条流在写。表本身住在 `session-cache`（模块级可变状态只能在那里）。
 */
function claimLiveWriter(ctx, sessionId, writerId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return false;
  if (typeof writerId !== 'string' || !writerId) return false;
  const map = liveStepWriterOf(ctx);
  const owner = map.get(sessionId);
  if (owner !== undefined && owner !== writerId) return false;
  map.set(sessionId, writerId);
  return true;
}

/** 释放写入权：只有当前就是自己时才清，避免晚到的旧流把新写入者顶掉。 */
function releaseLiveWriter(ctx, sessionId, writerId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return;
  const map = liveStepWriterOf(ctx);
  if (map.get(sessionId) === writerId) map.delete(sessionId);
}

/** 这一帧该不该由 `writerId` 写：没带写入者身份时（老调用 / 测试）一律放行。 */
function writerAllows(ctx, sessionId, writerId) {
  if (writerId === undefined) return true;
  const map = liveStepWriterOf(ctx);
  const owner = map.get(sessionId);
  // 还没人认领：这一条就当写入者认下来（正常由 stream 开流时先认领，这里只是兜底）。
  if (owner === undefined) return claimLiveWriter(ctx, sessionId, writerId);
  return owner === writerId;
}

/**
 * 同一会话上开着的各条流（每条一个「收增量」的回调）。
 *
 * 写入者只有一条，但**所有屏都得看见同一份清单**：只读的那条流不会自己去攒，它靠写入者
 * 把 `drainLiveSteps` 取到的那几步广播过来。少了这一程，第二屏的「过程 · 已跑 N 步」会一直
 * 停在自己连上那一刻。
 */
/**
 * 挂上一条流，返回摘钩函数。
 *
 * `sink(frame)` 收到的是**已经算好的**整帧形状（`{ type, sessionId, full, turn, steps }`），
 * 这里不碰 SSE、也不认客户端，只做进程内的转发。
 */
function attachLiveSteps(ctx, sessionId, sink) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId || typeof sink !== 'function') return () => {};
  const map = liveStepSinkOf(ctx);
  let set = map.get(sessionId);
  if (!set) {
    set = new Set();
    map.set(sessionId, set);
  }
  set.add(sink);
  return () => {
    const current = map.get(sessionId);
    if (!current) return;
    current.delete(sink);
    if (current.size === 0) map.delete(sessionId);
  };
}

/** 把一步的增量转给这条会话上开着的每一条流（`except` 是写入者自己那份，它已经在按顺序写了）。 */
function broadcastLiveSteps(ctx, sessionId, frame, except) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return;
  const set = liveStepSinkOf(ctx).get(sessionId);
  if (!set) return;
  for (const sink of set) {
    if (sink === except) continue;
    try {
      sink(frame);
    } catch {
      /* 一条流写失败不该连累别的流（它自己那条连接会按写失败收尾） */
    }
  }
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
      /** 这份副本属于哪一轮（宿主 turn 号）：换轮就整份作废，见 `turnForEvent`。 */
      turnNo: null,
      /** 事实与详情同桶、同写入者；断流只释放写入权，下一轮才替换这份事实。 */
      facts: createTurnFacts(),
      factsSentRevision: -1,
      factsSentSnapshot: null,
    };
    bucket.delete(sessionId);
    bucket.set(sessionId, turn);
    // 只留几条会话（Map 按插入顺序，最老的先丢）。
    while (bucket.size > MAX_SESSIONS) bucket.delete(bucket.keys().next().value);
  }
  return turn;
}

/**
 * 把一条事件归到它所属的那一轮；**轮号一变就整份作废**。
 *
 * 为什么要靠事件自带的 `data.turn` 兜这一手：`noteLiveEvent` 只在这条流上收到 `turn/start`
 * 时清桶，可断线重连后那一轮的 `turn/start` 已经在重连之前发生过、被当作「回放已覆盖」丢掉，
 * 于是新的一轮的步骤会接着上一轮往后长，越积越多、最后全挂在最新那条消息下。每一帧增量
 * 都带着它属于哪个 turn，用它来判就不会漏：turn 号变了就把整轮副本换掉（下一轮的步骤从空起）。
 * 同一轮内（turn 号相同）原样沿用。
 */
function turnForEvent(ctx, sessionId, data) {
  const bucket = bucketOf(ctx);
  const explicitTurn = data && typeof data.turn === 'number' ? data.turn : null;
  let turn = bucket.get(sessionId);
  if (turn && explicitTurn !== null && turn.turnNo !== null && turn.turnNo > explicitTurn) return null;
  if (turn && explicitTurn !== null && turn.turnNo !== null && turn.turnNo !== explicitTurn) {
    bucket.delete(sessionId);
    turn = undefined;
  }
  if (!turn) turn = turnOf(ctx, sessionId);
  if (turn.turnNo === null && explicitTurn !== null) turn.turnNo = explicitTurn;
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
function noteLiveEvent(ctx, sessionId, event, writerId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return;
  if (!event || typeof event !== 'object') return;
  // 同一条会话只让一个写入者累加：别的流（多开的一屏 / 重连里还没断干净的旧连接）只读不写，
  // 否则每段推理会被接两遍（见 liveStepWriterOf 那条注释）。
  if (!writerAllows(ctx, sessionId, writerId)) return;
  const data = event.data && typeof event.data === 'object' ? event.data : null;
  if (event.type === 'turn/start') {
    const existing = bucketOf(ctx).get(sessionId);
    if (existing && data && typeof data.turn === 'number' && existing.turnNo > data.turn) return;
    if (existing && existing.turnNo === (data && data.turn)) {
      absorbTurnFact(existing.facts, event);
      return;
    }
    // 新的一轮开始：上一轮的过程副本作废（换掉了，就别再让人点开旧内容）。
    bucketOf(ctx).delete(sessionId);
    const started = turnOf(ctx, sessionId);
    if (data && typeof data.turn === 'number') started.turnNo = data.turn;
    absorbTurnFact(started.facts, event);
    return;
  }
  if (!data) return;
  const turn = turnForEvent(ctx, sessionId, data);
  if (!turn) return;
  absorbTurnFact(turn.facts, event);
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
        ...current,
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
    const callId = resultCallId(event);
    if (!callId || !message) return;
    const current = turn.tools.get(callId) || { name: '', argsRaw: '' };
    const { parts, isError } = resultParts(message);
    const output = parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
    const diffs = data.meta && Array.isArray(data.meta.diffs) ? data.meta.diffs : undefined;
    const code = data.error && typeof data.error.code === 'string' ? data.error.code : undefined;
    // 失败有两种写法：`message.isError` 与 `data.error.code`（宿主两种都发过），任一都算失败。
    const failed = isError || code !== undefined;
    turn.tools.set(callId, {
      ...current,
      output: output.length > TEXT_MAX ? output.slice(0, TEXT_MAX) : output,
      ...(failed ? { error: code === 'interrupted' ? 'stopped' : 'error' } : { error: null }),
      ...(diffs ? { diffs } : {}),
    });
    refreshToolStep(turn, callId);
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

/** 这份直播清单属于哪一轮（宿主 turn 号）——随 `session/live-steps` 帧下发，App 据此按轮隔离。 */
function liveStepsTurnOf(ctx, sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return null;
  const turn = liveStepTurnOf(ctx).get(sessionId);
  return turn && typeof turn.turnNo === 'number' ? turn.turnNo : null;
}

/** 按需读取当前轮的完整事实；没有轮号时不把空壳发给客户端。 */
function liveTurnFactsOf(ctx, sessionId) {
  if (!ctx || !sessionId) return null;
  const turn = liveStepTurnOf(ctx).get(sessionId);
  if (!turn || typeof turn.turnNo !== 'number') return null;
  const facts = turnFactsSnapshot(turn.facts);
  // 没有新事实不增加空控制帧；曾发过产出的轮撤销回空时仍必须发快照清除旧状态。
  if (!turn.factsSentSnapshot && !facts.actualModel && !facts.modelTrail.length && !facts.producedFiles.length) return null;
  return { turn: turn.turnNo, ...facts };
}

function liveTurnChangesOf(ctx, sessionId, wantedTurn, historyEntries) {
  if (!ctx || !sessionId) return null;
  const turn = liveStepTurnOf(ctx).get(sessionId);
  if (!turn || turn.turnNo !== wantedTurn) return null;
  if (!historyEntries) return turnChangesSnapshot(turn.facts);
  // 仅为本次读取建临时副本，按 seq 合并授权历史；不抢直播单写者的写入权。
  const merged = createTurnFacts();
  for (const entry of historyEntries) {
    const event = entry && entry.event ? entry.event : entry;
    if (event && event.data && event.data.turn === wantedTurn) absorbTurnFact(merged, event);
  }
  for (const [key, fact] of turn.facts.events) {
    if (!merged.events.has(key)) merged.events.set(key, fact);
  }
  rebuildTurnFacts(merged);
  merged.truncated = merged.truncated || turn.facts.truncated;
  return turnChangesSnapshot(merged);
}

function drainLiveTurnFacts(ctx, sessionId, writerId) {
  if (!ctx || !sessionId || !writerAllows(ctx, sessionId, writerId)) return null;
  const turn = liveStepTurnOf(ctx).get(sessionId);
  if (!turn || turn.factsSentRevision === turn.facts.revision || typeof turn.turnNo !== 'number') return null;
  turn.factsSentRevision = turn.facts.revision;
  const snapshot = liveTurnFactsOf(ctx, sessionId);
  if (!snapshot) return null;
  const serialized = JSON.stringify(snapshot);
  if (serialized === turn.factsSentSnapshot) return null;
  turn.factsSentSnapshot = serialized;
  return snapshot;
}

/** 从已授权的历史窗补齐直播事实，只吸游标之后的事件，不回放推理或参数增量。 */
function seedLiveTurnFacts(ctx, sessionId, entries, writerId) {
  if (!ctx || !sessionId || !writerAllows(ctx, sessionId, writerId)) return;
  const events = (entries || []).map((entry) => entry && entry.event ? entry.event : entry)
    .filter(Boolean).sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  for (const event of events) {
    const data = event.data;
    if (!data || typeof data.turn !== 'number') continue;
    const existing = liveStepTurnOf(ctx).get(sessionId);
    if (existing && existing.turnNo !== null && data.turn < existing.turnNo) continue;
    const turn = turnForEvent(ctx, sessionId, data);
    absorbTurnFact(turn.facts, event);
  }
}

/**
 * 取走「还没告诉过手机」的那几步。
 *
 * 每条都是 `{ key, step }`：新的一步就是追加，同一步的状态变化就是按 `key` 替换。
 * 只有写着（writerId 命中）的那条流来取：只读的流取会把写入者该发的增量抢走，让主屏漏步。
 */
function drainLiveSteps(ctx, sessionId, writerId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return [];
  if (!writerAllows(ctx, sessionId, writerId)) return [];
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
    // 签名块在展示前剥掉（与桌面同口径）；剥完没有正文，这一段思考就当还没有内容。
    const text = reasoningText(turn.thoughts.get(index));
    if (text === '') return null;
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
  liveStepWriterOf(ctx).delete(sessionId);
  liveStepSinkOf(ctx).delete(sessionId);
}

module.exports = {
  noteLiveEvent,
  liveStepOf,
  liveStepsOf,
  liveStepsTurnOf,
  liveTurnFactsOf,
  liveTurnChangesOf,
  drainLiveTurnFacts,
  seedLiveTurnFacts,
  drainLiveSteps,
  clearLiveSteps,
  claimLiveWriter,
  releaseLiveWriter,
  attachLiveSteps,
  broadcastLiveSteps,
};

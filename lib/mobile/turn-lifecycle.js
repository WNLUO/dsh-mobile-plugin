'use strict';

/** 会话日志里的真实轮次边界，随消息快照恢复开跑和收尾，不能用模型信息推断完成。 */
function turnLifecyclesOf(events, lookback = []) {
  const turns = new Map();
  for (const entry of [...lookback, ...events]) {
    const event = entry.event || entry;
    if (!event || !event.data || !Number.isSafeInteger(event.data.turn) || !Number.isSafeInteger(event.seq)) continue;
    const turn = event.data.turn;
    const previous = turns.get(turn);
    if (previous && previous.seq >= event.seq) continue;
    if (event.type === 'turn/start') {
      if (previous && previous.state !== 'running') continue;
      turns.set(turn, { turn, seq: event.seq, startSeq: event.seq, state: 'running', ...(typeof event.time === 'number' ? { startedAt: event.time } : {}) });
    } else if (event.type === 'turn/end') {
      const state = event.data.reason && event.data.reason.kind;
      if (!['completed', 'aborted', 'error', 'max-tokens'].includes(state)) continue;
      turns.set(turn, { ...previous, turn, seq: event.seq, state, ...(typeof event.time === 'number' ? { endedAt: event.time } : {}) });
    }
  }
  return turns;
}

module.exports = { turnLifecyclesOf };

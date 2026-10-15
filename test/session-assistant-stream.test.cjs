'use strict'
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js')

// 0.2.0 的宿主把逐块流式增量从会话事件里拿走了：正文/推理的每个 delta 只在 follow 流的
// `assistant-stream` 通知里（且必须显式 assistantStream: true 才发）。不订阅它，App 就只能
// 在一步结束时拿到整块 assistant/message —— 真机表现就是「回复整段突然蹦出来、运行中那一行
// 没有实时明细」。这组断言钉住兼容桥把通知合成 assistant/chunk 事件这件事。

/** 假网关：记录每条流的请求，session/follow 按给定帧喂流，其余流空跑。 */
function makeCtx(followFrames, seen = [], warns = []) {
  const gateway = {
    async invoke() {
      throw new Error('本测试不涉及 invoke')
    },
    async stream(request) {
      seen.push(request)
      if (request.namespace === 'session' && request.method === 'follow') return Readable.from(followFrames)
      return Readable.from([])
    },
  };
  return {
    ctx: {
      get: (name) => (name === 'typertGateway' ? gateway : undefined),
      logger: { warn: (message) => warns.push(String(message)), error() {} },
    },
    seen,
    warns,
  };
}

async function collect(iterable) {
  const frames = [];
  for await (const frame of iterable) frames.push(frame);
  return frames;
}

const SID = 'session-1';
const eventFrames = (frames) => frames.filter((frame) => frame.payload.type === 'session/event');

test('follow 订阅必须显式要 assistantStream，否则宿主根本不发增量', async () => {
  const seen = [];
  const { ctx } = makeCtx([], seen);
  await collect(muxFrames(ctx, { payload: { sessionId: SID } }));
  const follow = seen.find((request) => request.namespace === 'session' && request.method === 'follow');
  assert.ok(follow, '缺少 session/follow 订阅');
  assert.equal(follow.args.request.assistantStream, true, '没带 assistantStream 开关，宿主的逐块增量一条都不会发');
});

test('实时增量通知合成 assistant/chunk 事件（无 seq、带 turn/step、块序号取通知帧）', async () => {
  const { ctx } = makeCtx([
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a-1', revision: 0, startedAfterSeq: 7, turn: 3, step: 2 } },
    // 真机形状：chunk 自己带 index。
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 1, index: 0, time: 111, chunk: { type: 'reasoning-delta', index: 0, text: '想' } } },
    // 兜底形状：chunk 没带 index，取通知帧上的。
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 2, index: 1, time: 222, chunk: { type: 'text-delta', text: '答' } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a-1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 8 } } },
    { type: 'snapshot', cursor: 9, assistantStream: { revision: 3, activeAttempt: null } },
  ]);

  const events = eventFrames(await collect(muxFrames(ctx, { payload: { sessionId: SID } })));

  assert.deepEqual(events.map((frame) => frame.payload.event), [
    { type: 'assistant/chunk', time: 111, data: { turn: 3, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: '想' } } },
    { type: 'assistant/chunk', time: 222, data: { turn: 3, step: 2, chunk: { type: 'text-delta', index: 1, text: '答' } } },
  ]);
  // 无 seq 是刻意的：合成事件没有持久化身份，不能参与客户端的序门/去重/续传水位。
  assert.equal(events.some((frame) => 'seq' in frame.payload.event), false, '合成增量带了 seq，客户端会把它当成真实事件水位');
  assert.equal(events.every((frame) => frame.payload.sessionId === SID), true);
});

test('通知里的 chunk 一旦开始，事件流里同类型的 assistant/chunk 事件不再重复交付', async () => {
  const dup = { type: 'assistant/chunk', seq: 8, time: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '重复' } } };
  const withNotice = makeCtx([
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 1, index: 0, time: 5, chunk: { type: 'text-delta', index: 0, text: '一次' } } },
    { type: 'event', event: dup },
  ]);
  const kept = eventFrames(await collect(muxFrames(withNotice.ctx, { payload: { sessionId: SID } })));
  assert.deepEqual(kept.map((frame) => frame.payload.event.type), ['assistant/chunk']);
  assert.equal(kept[0].payload.event.data.chunk.text, '一次', '重复的 chunk 事件把增量交付了两遍');

  // 宿主没发通知时（旧版本把 chunk 当事件发），事件流里的 chunk 照旧转发。
  const eventsOnly = makeCtx([{ type: 'event', event: dup }]);
  const kept2 = eventFrames(await collect(muxFrames(eventsOnly.ctx, { payload: { sessionId: SID } })));
  assert.deepEqual(kept2.map((frame) => frame.payload.event.type), ['assistant/chunk']);
});

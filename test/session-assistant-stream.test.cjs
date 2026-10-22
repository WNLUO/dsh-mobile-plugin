'use strict'

/**
 * 流式增量合成的守卫：0.2.0 宿主把逐块增量挪进了 follow 流的 `assistant-stream` 通知
 * （必须显式 `assistantStream: true` 才发），兼容桥要把它合成回 `assistant/chunk`；
 * 另外**首帧 snapshot 里那份「正在跑的那一步」的压缩基线**也必须展开成增量帧 ——
 * 中途进入会话的人只有这一份，开跑之前的实时帧宿主不补发。
 */

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

test('中途进入会话：首帧基线里已生成的那一步要还原成增量帧（同一块合并、带 turn/step）', async () => {
  // 宿主 follow 的第一帧带着「正在跑的那一步」的压缩基线；不接这一段，中途进来的人
  // 前半段正文与 Think 明细就永远是空的（开跑之前的实时帧宿主不会补发）。
  const { ctx } = makeCtx([
    {
      type: 'snapshot',
      cursor: 12,
      assistantStream: {
        revision: 4,
        activeAttempt: {
          attemptId: 'a-1',
          startedAfterSeq: 9,
          turn: 3,
          step: 2,
          nextIndex: 8,
          stream: [
            { type: 'reasoning-chunks', index: 0, time0: 100, dt: [10, 10], texts: ['想', '一', '下'] },
            { type: 'text-chunks', index: 1, time0: 200, dt: [5], texts: ['你', '好'] },
            { type: 'chunk', time: 300, chunk: { type: 'block-start', index: 2, id: 'c-1', name: 'read' } },
            { type: 'tool-call-chunks', index: 2, id: 'c-1', name: 'read', time0: 310, dt: [2], args: ['{"pa', 'th":1}'] },
          ],
        },
      },
    },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 5, index: 8, time: 400, chunk: { type: 'text-delta', index: 3, text: '实时' } } },
  ]);

  const events = eventFrames(await collect(muxFrames(ctx, { payload: { sessionId: SID } })));
  const chunks = events.map((frame) => frame.payload.event.data);
  assert.deepEqual(chunks.map((data) => data.chunk.type), ['reasoning-delta', 'text-delta', 'block-start', 'tool-call-delta', 'text-delta']);
  // 同一块的连续 delta 合成一帧：几千帧逐字帧会把 App 的守门缓冲挤爆。
  assert.equal(chunks[0].chunk.text, '想一下');
  assert.equal(chunks[1].chunk.text, '你好');
  assert.equal(chunks[2].chunk.index, 2);
  assert.equal(chunks[3].chunk.argumentsDelta, '{"path":1}');
  // 基线里的帧同样要带作用域，否则 App 不知道怎么把这段草稿归属到哪一步，
  // 后续实时增量也与它对不上号。
  assert.equal(chunks.every((data) => data.turn === 3 && data.step === 2), true);
  assert.equal(chunks[4].chunk.text, '实时');
  assert.equal(events.some((frame) => 'seq' in frame.payload.event), false);

  // 没有 activeAttempt（空闲会话）时一帧都不发。
  const idle = makeCtx([{ type: 'snapshot', cursor: 9, assistantStream: { revision: 3, activeAttempt: null } }]);
  const idleEvents = eventFrames(await collect(muxFrames(idle.ctx, { payload: { sessionId: SID } })));
  assert.equal(idleEvents.length, 0);
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

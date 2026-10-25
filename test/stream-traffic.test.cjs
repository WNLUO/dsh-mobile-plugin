'use strict';

/**
 * 回归：单会话流的「按帧算钱」。
 *
 * 现场（2026-10-25）：一轮三十秒的回复在线上五百 KB，而正文只有三十几 KB —— 一多半是
 * 「每来一个 token 写一帧」的固定成本（SSE 头 + 稳定 id + 加密信封两三百字节）与按时间
 * 补的 2KB 注释。这里钉住三条收口：
 *   1. 同一步同一块的增量合并成一帧（正文一字不少，帧数按窗口降下来）；
 *   2. 推理增量只推开头一段，之后改推轻量进度帧（完整正文仍走 assistant/message 与历史）；
 *   3. 工具结果的可见输出截到一段（展开看全文走历史那一条）。
 * 另外两条顺序/收尾约束也在这里：非草稿帧之前必须先写掉攒着的草稿；流结束不许丢尾巴。
 *
 * 运行：node --test test/stream-traffic.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStream } = require('../lib/mobile/stream.js');

function response() {
  const chunks = [];
  return {
    chunks,
    writableLength: 0,
    socket: { writableLength: 0 },
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.ended = true; },
    on() {}, once() {}, off() {}, emit() {},
  };
}

function request(url) {
  const req = new (require('node:events').EventEmitter)();
  req.url = url;
  req.headers = {};
  return req;
}

/** mux：把给定帧按顺序吐完就结束（收尾走 flushAll，正好验「不丢尾巴」）。 */
const muxOf = (frames) => async function* () {
  for (const frame of frames) yield frame;
};

const ctxWith = (mux) => ({
  apiProxy: {
    events: { mux },
    sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
  },
});

const sessionId = 's-traffic';
const chunkFrame = (chunk, extra = {}) => ({
  payload: {
    type: 'session/event',
    sessionId,
    event: { type: 'assistant/chunk', time: 1, data: { turn: 1, step: 1, chunk, ...extra } },
  },
});
const textDelta = (text, index = 0) => chunkFrame({ type: 'text-delta', index, text });
const reasoningDelta = (text) => chunkFrame({ type: 'reasoning-delta', index: 0, text });

/** 只取会话事件帧：收尾那帧 `session/resync-required` 是连接层面的，不属于内容。 */
const dataFrames = (res) => res.chunks
  .map(String)
  .filter((chunk) => chunk.includes('data: '))
  .map((chunk) => JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: ')).slice(6)))
  .filter((frame) => frame && frame.type !== 'session/resync-required');

const runStream = async (frames) => {
  const res = response();
  await handleStream(ctxWith(muxOf(frames)), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
  return res;
};

test('同一步同一块的增量合并成一帧，正文一字不少', async () => {
  const parts = ['第一段', '第二段', '第三段', '第四段'];
  const res = await runStream(parts.map((text) => textDelta(text)));
  const frames = dataFrames(res);
  assert.equal(frames.length, 1, `四条增量应该并成一帧，实际 ${frames.length} 帧`);
  assert.equal(frames[0].data.chunk.text, parts.join(''));
  assert.equal(frames[0].data.chunk.index, 0);
});

test('不同块、不同类型的增量不合并', async () => {
  const res = await runStream([
    textDelta('甲', 0),
    textDelta('乙', 1),
    chunkFrame({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'read', argumentsDelta: '{"pa' }),
    chunkFrame({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'read', argumentsDelta: 'th":"a"}' }),
  ]);
  const frames = dataFrames(res);
  assert.equal(frames.length, 3, '文本两块各一帧、工具参数两块并一帧');
  assert.equal(frames[0].data.chunk.text, '甲');
  assert.equal(frames[1].data.chunk.text, '乙');
  assert.equal(frames[2].data.chunk.argumentsDelta, '{"path":"a"}', '工具参数按块序号拼接');
});

test('推理增量只推开头一段，其余整段丢弃', async () => {
  const res = await runStream([
    reasoningDelta('思'.repeat(400)),
    reasoningDelta('考'.repeat(400)),
    reasoningDelta('继'.repeat(400)),
  ]);
  const frames = dataFrames(res);
  const liveChars = frames
    .filter((f) => f.data.chunk.type === 'reasoning-delta')
    .reduce((sum, f) => sum + f.data.chunk.text.length, 0);
  assert.equal(liveChars, 600, '实时只推开头 600 字，其余靠 assistant/message 与历史');
  assert.equal(frames.length, 2, '超出的第三段一条帧都不该发');
  assert.equal(frames[1].data.chunk.text, '考'.repeat(200), '第二段被截到剩余额度为止');
});

test('换了一步重新给额度（推理按步限流，不是按整轮）', async () => {
  const step2 = (text) => ({
    payload: {
      type: 'session/event',
      sessionId,
      event: { type: 'assistant/chunk', time: 2, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text } } },
    },
  });
  const res = await runStream([reasoningDelta('甲'.repeat(600)), step2('乙'.repeat(300))]);
  const text = dataFrames(res)
    .filter((f) => f.data.chunk.type === 'reasoning-delta')
    .map((f) => f.data.chunk.text)
    .join('');
  assert.equal(text.length, 900, '第二步的推理重新拿到 600 字的额度');
});

test('工具结果的可见输出截到一段，状态与图片引用照旧', async () => {
  const event = {
    type: 'tool/result',
    seq: 9,
    data: {
      message: {
        source: { callId: 'call-1' },
        content: [{ type: 'text', text: 'x'.repeat(5000) }],
      },
    },
  };
  const res = await runStream([{ payload: { type: 'session/event', sessionId, event } }]);
  const frames = dataFrames(res);
  const message = frames[0].data.message;
  assert.equal(message.source.callId, 'call-1', 'callId 必须原样留着（状态回填靠它）');
  assert.ok(message.content[0].text.length < 5000, '输出必须被截断');
  assert.ok(message.content[0].text.length <= 2000 + 40, `截断后 ${message.content[0].text.length} 字`);
  assert.match(message.content[0].text, /展开时取全文/);
});

test('非草稿帧之前先把攒着的草稿写出去（顺序）', async () => {
  const res = await runStream([
    textDelta('先到的正文'),
    { payload: { type: 'session/event', sessionId, event: { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '整段' }] } } } } },
  ]);
  const types = dataFrames(res).map((f) => f.type);
  assert.deepEqual(types, ['assistant/chunk', 'assistant/message'], `顺序错了：${types.join(',')}`);
});

test('草稿的填充窗口是 250ms（底线从 16KB/s 降到 8KB/s）', async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  // 每拍一条 1100 字节的草稿：越过合并缓冲的上限，于是「一到就写出去」，不需要定时器。
  const beatFrame = (index) => textDelta('x'.repeat(1100), index);
  // 三拍：0ms、200ms、300ms —— 填充窗口按「上次补齐的时刻」算。
  const script = [
    { at: 0, frames: [beatFrame(0)] },
    { at: 200, frames: [beatFrame(1)] },
    { at: 300, frames: [beatFrame(2)] },
  ];
  try {
    const res = response();
    const mux = async function* () {
      for (const beat of script) {
        now += beat.at;
        for (const frame of beat.frames) yield frame;
      }
    };
    await handleStream(ctxWith(mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    const pads = res.chunks.map((chunk) => {
      const line = String(chunk).split('\n').find((l) => l.startsWith(': ') && l.length > 128);
      return line ? line.length : 0;
    });
    const beats = pads.filter((n) => n > 0);
    // 第 0ms 那拍补满（流的第一条记录必须越过客户端阈值），200ms 那拍不补（还没到 250ms 窗口），
    // 300ms 那拍补。窗口退回 120ms 时第二拍也会补 —— 这条就红了。
    assert.equal(beats.length, 2, `补过的记录 ${beats.length} 条，200ms 那一拍不该补`);
  } finally {
    Date.now = realNow;
  }
});

'use strict';

/**
 * 回归：单会话流的「按帧算钱」与「过程明细不下发」。
 *
 * 现场（2026-10-25）：一轮三十秒的回复在线上五百 KB，而正文只有三十几 KB —— 一多半是
 * 「每来一个 token 写一帧」的固定成本（SSE 头 + 稳定 id + 加密信封两三百字节）与按时间
 * 补的 2KB 注释。这里钉住收口：同一步同一块的增量合并成一帧（正文一字不少）。
 * 另外一条边界也在这里：推理、工具参数、工具结果正文与 diff 都不上线路，只留图片与
 * 三张轮尾卡的料（减法在 `lib/mobile/wire-cut.js`，与历史那条路同一份实现）。
 *
 * 2026-10-29 起线上多了一种**自制帧** `session/live-steps`（跑着那一轮的过程清单，见
 * `live-steps.js` / A3-68）：一步一条，只带 kind / 名字 / 一行摘要 / 状态，**推理正文与参数
 * 仍一个字都不带**。下面那些「内容帧」的断言因此改用 `contentFrames`（把这一种滤掉），
 * 它自己那几条断言集中在文件末尾。
 * 顺序/收尾约束同样在这里：非草稿帧之前必须先写掉攒着的草稿；流结束不许丢尾巴。
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

/** 内容帧：把过程清单那一类自制帧滤掉，剩下的才是下发给手机的会话内容。 */
const contentFrames = (res) => dataFrames(res).filter((frame) => frame.type !== 'session/live-steps');
/** 过程清单帧（一步一条：新的一步，或某一步的状态变了）。 */
const stepFrames = (res) => dataFrames(res).filter((frame) => frame.type === 'session/live-steps');

const runStream = async (frames) => {
  const res = response();
  await handleStream(ctxWith(muxOf(frames)), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
  return res;
};

test('同一步同一块的增量合并成一帧，正文一字不少', async () => {
  const parts = ['第一段', '第二段', '第三段', '第四段'];
  const res = await runStream(parts.map((text) => textDelta(text)));
  const frames = contentFrames(res);
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
  const frames = contentFrames(res);
  assert.equal(frames.length, 3, '文本两块各一帧、工具参数两块并一帧');
  assert.equal(frames[0].data.chunk.text, '甲');
  assert.equal(frames[1].data.chunk.text, '乙');
  assert.deepEqual(frames[2].data.chunk, { type: 'tool-call-delta', index: 2, id: 'c1', name: 'read' },
    '参数正文不下发；帧与身份字段照留（App 靠它们建流式工具块）');
});

test('tool-call-delta：只留身份帧，参数正文一帧都不带', async () => {
  const body = '{"path":"/tmp/a.md","content":"' + 'x'.repeat(3000);
  const res = await runStream([
    chunkFrame({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'write', argumentsDelta: body }),
    chunkFrame({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'write', argumentsDelta: body }),
  ]);
  const frames = contentFrames(res);
  assert.equal(frames.length, 1, '同一块的增量照旧并成一帧');
  const chunk = frames[0].data.chunk;
  assert.equal(chunk.type, 'tool-call-delta');
  assert.equal(chunk.id, 'c1');
  assert.equal(chunk.name, 'write');
  assert.equal(chunk.index, 2);
  assert.equal('argumentsDelta' in chunk, false, '整份文件内容不许跟着增量走');
  assert.equal(JSON.stringify(frames[0]).includes('/tmp/a.md'), false, '一个字节都不许漏出去');
});

test('tool-call-delta：参数砍空之后的帧整条不发（一次调用只占一帧身份）', async () => {
  // 第一帧带身份，后面几十帧只剩 { type, index }。那些空壳在线上每 200ms 一窗、每窗补 2KB，
  // 一个改文件的调用光参数流式就能白走几十上百 KB —— 手机只要「有个工具开始了、叫什么」。
  const identity = chunkFrame({ type: 'tool-call-delta', index: 3, id: 'c7', name: 'edit', argumentsDelta: '{"pa' });
  const shells = Array.from({ length: 8 }, () => chunkFrame({ type: 'tool-call-delta', index: 3, argumentsDelta: 'th":"/a"}' }));
  const frames = contentFrames(await runStream([identity, ...shells]));
  assert.equal(frames.length, 1, `空壳帧一帧都不该发，实际 ${frames.length} 帧`);
  assert.deepEqual(frames[0].data.chunk, { type: 'tool-call-delta', index: 3, id: 'c7', name: 'edit' });
  assert.equal(JSON.stringify(frames).includes('argumentsDelta'), false, '参数正文不许跟着走');
});

test('推理增量本身一帧都不下发，只留一句「有一步在思考」（正文不出本机）', async () => {
  const res = await runStream([
    reasoningDelta('思'.repeat(400)),
    reasoningDelta('考'.repeat(400)),
  ]);
  assert.equal(contentFrames(res).length, 0, '推理增量一条都不该发');
  const steps = stepFrames(res);
  assert.equal(steps.length, 1, `过程清单只该多出一步，实际 ${steps.length} 帧`);
  assert.equal(steps[0].steps[0].step.kind, 'think');
  assert.equal(JSON.stringify(steps).includes('思'), false, '推理正文一个字节都不许漏出去');
});

test('assistant/message：推理块删掉，tool-call 只留骨架（三张轮尾卡的工具留 arguments）', async () => {
  const event = {
    type: 'assistant/message',
    seq: 3,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先想一下' },
          { type: 'text', text: '答案是 42' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
          { type: 'tool-call', id: 'c2', name: 'exit_plan_mode', arguments: '{"plan":"先建目录"}' },
        ],
      },
    },
  };
  const res = await runStream([{ payload: { type: 'session/event', sessionId, event } }]);
  const content = contentFrames(res)[0].data.message.content;
  assert.deepEqual(content, [
    { type: 'text', text: '答案是 42' },
    { type: 'tool-call', id: 'c1', name: 'bash' },
    { type: 'tool-call', id: 'c2', name: 'exit_plan_mode', arguments: '{"plan":"先建目录"}' },
  ]);
});

test('tool/result：正文与 meta 都不落，状态与图片照旧', async () => {
  const event = {
    type: 'tool/result',
    seq: 9,
    data: {
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [
          { type: 'text', text: 'x'.repeat(5000) },
          { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } },
        ],
      },
      meta: { diffs: [{ path: '/tmp/a.md', oldText: null, newText: 'y'.repeat(5000) }] },
    },
  };
  const res = await runStream([{ payload: { type: 'session/event', sessionId, event } }]);
  const frame = contentFrames(res)[0];
  assert.equal(frame.data.message.source.callId, 'call-1', 'callId 必须原样留着（状态回填靠它）');
  assert.deepEqual(frame.data.message.content, [
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } },
  ], '正文整条丢掉，图片块照旧');
  assert.equal('meta' in frame.data, false, 'write/edit 的 diff 不上线路');
});

test('tool/result：schedule_create 的结果正文留着（定时任务卡解析它）', async () => {
  const call = {
    type: 'assistant/message',
    seq: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c9', name: 'schedule_create', arguments: '{"cron":"0 9 * * *"}' }],
      },
    },
  };
  const result = {
    type: 'tool/result',
    seq: 3,
    data: {
      message: {
        source: { kind: 'tool', callId: 'c9' },
        content: [{ type: 'text', text: '{"id":"t1","cron":"0 9 * * *"}' }],
      },
    },
  };
  const res = await runStream([
    { payload: { type: 'session/event', sessionId, event: call } },
    { payload: { type: 'session/event', sessionId, event: result } },
  ]);
  const frames = contentFrames(res);
  assert.deepEqual(frames[0].data.message.content, [
    { type: 'tool-call', id: 'c9', name: 'schedule_create', arguments: '{"cron":"0 9 * * *"}' },
  ]);
  assert.equal(frames[1].data.message.content[0].text, '{"id":"t1","cron":"0 9 * * *"}', '卡的料一个字都不能少');
});

test('tool/call：整条不下发（手机端没有消费者，但它带 seq、每帧补 2KB）', async () => {
  const bash = { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' } };
  const schedule = { type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'c2', name: 'schedule_create', arguments: '{"cron":"0 9 * * *"}' } };
  const nameless = { type: 'tool/call', seq: 6, data: { turn: 1, step: 1, callId: 'c3', arguments: '{"command":"rm -rf /"}' } };
  const res = await runStream([
    { payload: { type: 'session/event', sessionId, event: bash } },
    { payload: { type: 'session/event', sessionId, event: schedule } },
    { payload: { type: 'session/event', sessionId, event: nameless } },
  ]);
  assert.equal(contentFrames(res).length, 0, '三条 tool/call 一条都不该上线');
  // 三张轮尾卡的料走 assistant/message 里的 tool-call 块（见上一条用例），不靠这条事件。
  const text = String(res.chunks.join(''));
  assert.equal(text.includes('ls -la'), false, '命令行一个字节都不许漏出去');
});

test('非草稿帧之前先把攒着的草稿写出去（顺序）', async () => {
  const res = await runStream([
    textDelta('先到的正文'),
    { payload: { type: 'session/event', sessionId, event: { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '整段' }] } } } } },
  ]);
  const types = contentFrames(res).map((f) => f.type);
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

test('过程清单帧：一步一条、开流不空发、摘要等参数齐了才带', async () => {
  // 跑着那一轮的过程清单走自制帧（`session/live-steps`）：思考从第一段推理就算一步，
  // 工具的参数齐了才拼出摘要（路径 / 命令 —— 这一行是 2026-10-29 过程清单的一部分，
  // 参数原文本身仍然不上线路）。
  const res = await runStream([
    reasoningDelta('先看这个文件'),
    chunkFrame({ type: 'block-end', index: 0 }),
    chunkFrame({ type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{"file_path":"/tmp/a.md"}' }),
    chunkFrame({ type: 'block-end', index: 1 }),
  ]);
  const steps = stepFrames(res);
  assert.deepEqual(steps.map((frame) => frame.steps[0].key), ['think:0', 'think:0', 'tool:c1', 'tool:c1']);
  assert.equal(steps[0].steps[0].step.state, 'running');
  assert.equal(steps[0].steps[0].step.summary, '', '思考还在写的时候不先塞半句');
  assert.equal(steps[1].steps[0].step.state, 'ok');
  assert.equal(steps[1].steps[0].step.summary, '先看这个文件');
  assert.equal(steps[2].steps[0].step.summary, '', '参数还在流，先不发半截路径');
  assert.equal(steps[3].steps[0].step.summary, '/tmp/a.md');
  assert.equal(steps.every((frame) => frame.full === false), true, '开流那一份没有东西就不发');
  assert.equal(steps.every((frame) => !('seq' in frame)), true, '清单帧不带 seq（不参与序门与水位）');
  assert.equal(JSON.stringify(steps).includes('argumentsDelta'), false, '参数原文不上线路');
});

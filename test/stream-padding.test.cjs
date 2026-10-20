'use strict';

/**
 * 回归：流式回复的填充注释按「每条记录」补，把正文放大了十几倍。
 *
 * 现场：安卓 RN 的 XHR 要攒够一定字节才把进度吐给界面，插件于是给每条 SSE 记录补
 * 2048 字节注释。可一次流式回复每秒有几十条增量，一条几十秒的回答光注释就是几百 KB
 * 到几 MB，而这些字节在中转隧道和公网两条腿上都实打实要走。
 *
 * 修法（见 lib/shared/sse-write.js 的 takePadding）：按 120ms 一个窗口补齐 —— 客户端
 * 拿到的仍然是「每 ≥2048 字节就有一条补过注释的记录」，出字节奏不变，注释总量按窗口数
 * 封顶而不是按记录数封顶。
 *
 * 这里钉住：正文一帧不少、注释有且只在窗口边界出现、总量不再随记录数线性涨；实时流里带
 * seq 的持久事件照旧补满整份（它可能夹在一串慢草稿后面单独到达），而**断线重放的成批灌入**
 * 同样走窗口 —— 一次 903 帧的重放逐条补出来约 1.8MB 注释，客户端本来就在持续收字节。
 *
 * 运行：node --test test/stream-padding.test.cjs
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

function muxOf(events) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release,
    mux: async function* () {
      for (const event of events) yield { payload: event };
      await gate;
    },
  };
}

const ctxWith = (mux) => ({
  apiProxy: {
    events: { mux },
    sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
  },
});

/** 断线续传用：宿主 history 回一批带 seq 的事件（信封形状与真实 apiProxy 相同）。 */
const ctxReplaying = (mux, events) => ({
  apiProxy: {
    events: { mux },
    sessions: { history: async () => ({ result: { ok: true, value: { events } } }) },
  },
});

const chunkEvent = (sessionId, text) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text } } },
});

/** 一条有 seq 的持久事件：这类帧永远补满整份，不进补齐窗口。 */
const seqEvent = (sessionId, seq) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'turn/start', seq, data: { turn: 1 } },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function stubIntervals() {
  const real = global.setInterval;
  const realClear = global.clearInterval;
  global.setInterval = () => ({ unref() {}, cleared: false });
  global.clearInterval = () => {};
  return () => { global.setInterval = real; global.clearInterval = realClear; };
}

/** 单条记录里的填充注释行（`': ' + 一大串空格`），正文注释行很短，不会被算进来。 */
const paddingBytes = (chunk) => String(chunk)
  .split('\n')
  .filter((line) => line.startsWith(': ') && line.length > 128)
  .reduce((sum, line) => sum + line.length, 0);

const dataFrameCount = (chunks) => chunks.reduce(
  (sum, chunk) => sum + String(chunk).split('\n').filter((line) => line.startsWith('data: ')).length,
  0,
);

test('一串增量只按窗口补注释，正文一帧不少', async () => {
  const restore = stubIntervals();
  const sessionId = 's-padding-window';
  const events = Array.from({ length: 40 }, (_, i) => chunkEvent(sessionId, `片段${i}`));
  const res = response();
  const ctl = muxOf(events);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    await flush();
    const frames = dataFrameCount(res.chunks);
    const padded = res.chunks.reduce((sum, chunk) => sum + paddingBytes(chunk), 0);
    assert.equal(frames, 40, '每条增量都必须送到，填充只影响字节数');
    assert.ok(padded > 0, '第一批记录必须补一次：客户端要靠它越过进度阈值');
    // 40 条记录是全在同一瞬间写出去的，所以只该有极少数窗口边界补过注释。
    assert.ok(padded <= 3 * 2048, `注释总量 ${padded} 字节，40 条记录逐条补会是 ${40 * 2048} 字节`);
    ctl.release();
    await pending;
  } finally { restore(); }
});

test('单条记录自己就够大时不再补注释', async () => {
  const restore = stubIntervals();
  const sessionId = 's-padding-big';
  const big = chunkEvent(sessionId, 'x'.repeat(4096));
  const res = response();
  const ctl = muxOf([big]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    assert.equal(paddingBytes(res.chunks.join('')), 0, '这一发自己就过了阈值，注释是纯浪费');
    assert.equal(dataFrameCount(res.chunks), 1);
    ctl.release();
    await pending;
  } finally { restore(); }
});

test('带 seq 的事件不走窗口，永远补满整份', async () => {
  const restore = stubIntervals();
  const sessionId = 's-padding-seq';
  // 紧跟在一串草稿之后写出来的持久事件：草稿那几发已经把窗口占住了，但这一帧必须照补。
  const events = [chunkEvent(sessionId, 'a'), chunkEvent(sessionId, 'b'), seqEvent(sessionId, 7)];
  const res = response();
  const ctl = muxOf(events);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    await flush();
    const record = res.chunks.find((chunk) => String(chunk).includes('turn/start'));
    assert.ok(record, '持久事件必须写出去');
    assert.ok(paddingBytes(record) > 0, '带 seq 的事件慢一拍就可能表现为「消息不落地」，不许省这份注释');
    ctl.release();
    await pending;
  } finally { restore(); }
});

test('回放成批灌入也只按窗口补注释，一帧都不少', async () => {
  const restore = stubIntervals();
  const sessionId = 's-padding-replay';
  // 一次断线重放的形状：一长串带 seq 的事件连着写出去（实测一次 903 帧、2.06MB，
  // 其中约 1.85MB 是逐条补出来的注释）。
  const events = Array.from({ length: 60 }, (_, i) => ({
    type: 'tool/call',
    seq: i + 2,
    data: { callId: `c${i}`, name: 'read' },
  }));
  const res = response();
  const ctl = muxOf([]);
  try {
    const pending = handleStream(
      ctxReplaying(ctl.mux, events),
      request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&lastSeq=1`),
      res,
    );
    await flush();
    await flush();
    assert.equal(dataFrameCount(res.chunks), 60, '回放的每一条都必须送到，填充只影响字节数');
    const padded = res.chunks.reduce((sum, chunk) => sum + paddingBytes(chunk), 0);
    assert.ok(padded > 0, '第一条回放记录必须补满一个窗口：重连后界面要立刻出内容');
    // 60 条是在同一瞬间连着写出去的，窗口机制只该补极少数几次。
    assert.ok(padded <= 3 * 2048, `注释总量 ${padded} 字节，60 条逐条补会是 ${60 * 2048} 字节`);
    ctl.release();
    await pending;
  } finally { restore(); }
});

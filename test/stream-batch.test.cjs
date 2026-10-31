'use strict';

/**
 * 回归：合帧（`frameBatch=1`）。
 *
 * 流式回复一秒几十条 `assistant/chunk`，一帧一条就是几十次「加密 + 写套接字 + 客户端逐帧
 * 解密与解析」。带 `frameBatch=1` 的连接把这些增量在 40ms 窗口内并成一帧
 * `{type:'batch', events:[...]}`，客户端（App）按原顺序逐条回放。
 *
 * 这里钉四件事：
 *  1. 不带参数的行为一字不变（老 App 不能受影响）；
 *  2. 带参数时一串增量只出一帧，且批内顺序与到达顺序一致；
 *  3. 控制帧 / 心跳不被延迟：先 flush 掉攒着的增量，再立刻发自己（顺序不能倒）；
 *  4. 满了 8 条提前发，不必等窗口到期。
 *
 * 运行：node --test test/stream-batch.test.cjs
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

const chunkEvent = (sessionId, text) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text } } },
});

const seqEvent = (sessionId, seq) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'turn/start', seq, data: { turn: 1 } },
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 写出去的 `data:` 记录解成对象。 */
function frames(res) {
  return res.chunks
    .flatMap((chunk) => String(chunk).split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

test('不带 frameBatch 时一条增量一帧（老 App 行为不变）', async () => {
  const sessionId = 's-batch-off';
  const res = response();
  const ctl = muxOf([chunkEvent(sessionId, 'a'), chunkEvent(sessionId, 'b'), chunkEvent(sessionId, 'c')]);
  const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
  await settle(80);
  const list = frames(res);
  assert.equal(list.filter((f) => f.type === 'batch').length, 0, '没声明就不许合帧');
  assert.equal(list.filter((f) => f.type === 'assistant/chunk').length, 3);
  ctl.release();
  await pending;
});

test('带 frameBatch=1 时一串增量并成一帧，顺序不变', async () => {
  const sessionId = 's-batch-on';
  const texts = ['一', '二', '三', '四'];
  const res = response();
  const ctl = muxOf(texts.map((text) => chunkEvent(sessionId, text)));
  const pending = handleStream(
    ctxWith(ctl.mux),
    request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&frameBatch=1`),
    res,
  );
  await settle(80);
  const list = frames(res);
  const batched = list.filter((f) => f.type === 'batch');
  assert.equal(batched.length, 1, `应当只有一帧，实际 ${batched.length}`);
  assert.deepEqual(
    batched[0].events.map((event) => event.data.chunk.text),
    texts,
    '批内顺序必须与到达顺序一致',
  );
  ctl.release();
  await pending;
});

test('控制帧不被延迟：先放增量、再发控制帧', async () => {
  const sessionId = 's-batch-control';
  const res = response();
  const ctl = muxOf([
    chunkEvent(sessionId, 'x'),
    chunkEvent(sessionId, 'y'),
    seqEvent(sessionId, 7),
  ]);
  const pending = handleStream(
    ctxWith(ctl.mux),
    request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&frameBatch=1`),
    res,
  );
  await settle(20);
  const list = frames(res);
  const batchAt = list.findIndex((f) => f.type === 'batch');
  const controlAt = list.findIndex((f) => f.type === 'turn/start');
  assert.ok(batchAt >= 0, '控制帧之前必须先把攒着的增量放出去');
  assert.ok(controlAt > batchAt, `控制帧不能抢在增量前面（batch=${batchAt}, control=${controlAt}）`);
  assert.deepEqual(list[batchAt].events.map((e) => e.data.chunk.text), ['x', 'y']);
  ctl.release();
  await pending;
});

test('攒满 8 条提前发，不必等窗口到期', async () => {
  const sessionId = 's-batch-full';
  const res = response();
  const ctl = muxOf(Array.from({ length: 8 }, (_, i) => chunkEvent(sessionId, `t${i}`)));
  const pending = handleStream(
    ctxWith(ctl.mux),
    request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&frameBatch=1`),
    res,
  );
  // 窗口是 40ms；这里只等 10ms，能出帧就说明是「满 8 条」那条路。
  await settle(10);
  const batched = frames(res).filter((f) => f.type === 'batch');
  assert.equal(batched.length, 1);
  assert.equal(batched[0].events.length, 8);
  ctl.release();
  await pending;
});

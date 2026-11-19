// 验证 SSE 合帧顺序、实际写入背压与延迟帧的字节预算。
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


const { EventEmitter } = require('node:events');
const { writeSse, flushFrameBatch, SSE_CLOSE_BUFFERED_BYTES, BATCH_WINDOW_MS } = require('../lib/shared/sse-write.js');
function writable() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.socket = { writableLength: 0 };
  res.write = (text) => { res.chunks.push(text); return false; };
  return res;
}

test('合帧定时器的真实needDrain返回给连接；延迟帧立即计费', async () => {
  const res = writable();
  let result;
  const sent = writeSse(res, { type: 'assistant/chunk', data: { text: '中文'.repeat(1000) } }, {
    batch: true, onBatchResult: (value) => { result = value; },
  });
  assert.equal(sent.deferred, true);
  assert.ok(sent.bytes >= Buffer.byteLength('中文'.repeat(1000)));
  await settle(BATCH_WINDOW_MS + 20);
  assert.equal(result.ok, true);
  assert.equal(result.needDrain, true, '定时写出不能吞掉write=false');
  assert.equal(res.chunks.length, 1);
});

test('延迟合帧仍受硬水位约束，定时写入失败主动通知连接', async () => {
  const res = writable();
  let result;
  writeSse(res, { type: 'assistant/chunk', text: 'pending' }, { batch: true, onBatchResult: (value) => { result = value; } });
  res.socket.writableLength = SSE_CLOSE_BUFFERED_BYTES + 1;
  await settle(BATCH_WINDOW_MS + 20);
  assert.equal(result.ok, false);
  assert.equal(res.chunks.length, 0);
  assert.equal(writeSse(res, { type: 'assistant/chunk', text: 'next' }, { batch: true }).ok, false);
});

test('合帧尚未写出的大帧也不能越过硬水位，控制帧保留flush的背压', () => {
  const res = writable();
  const large = { type: 'assistant/chunk', seq: 1, text: 'x'.repeat(SSE_CLOSE_BUFFERED_BYTES) };
  assert.equal(writeSse(res, large, { batch: true }).ok, false);
  assert.equal(res.chunks.length, 0);
  const pending = writeSse(res, { type: 'assistant/chunk', text: 'small' }, { batch: true });
  assert.ok(pending.bytes > 0);
  const control = writeSse(res, { type: 'session/heartbeat' }, { batch: true });
  assert.equal(control.needDrain, true);
  assert.equal(res.chunks.length, 2);
  assert.equal(flushFrameBatch(res).ok, true);
});

test('异步合帧写不动时实时循环暂停，drain之后才继续消费后续帧', async () => {
  const sessionId = 'batch-drain-live';
  const res = new EventEmitter();
  Object.assign(res, response());
  // response的空事件桩不能覆盖真实事件机制。
  for (const name of ['on', 'once', 'off', 'emit']) res[name] = EventEmitter.prototype[name];
  let blocked = false;
  const originalWrite = res.write;
  res.write = (text) => {
    originalWrite(text);
    if (String(text).includes('"type":"batch"')) { blocked = true; return false; }
    return true;
  };
  let next;
  let consumed = false;
  let finish;
  const gate = new Promise((resolve) => { next = resolve; });
  const done = new Promise((resolve) => { finish = resolve; });
  async function* source() {
    yield { payload: chunkEvent(sessionId, 'first') };
    await gate;
    yield { payload: seqEvent(sessionId, 1) };
    consumed = true;
    await done;
  }
  const pending = handleStream(ctxWith(source), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&frameBatch=1`), res);
  await settle(BATCH_WINDOW_MS + 30);
  assert.equal(blocked, true);
  next();
  await settle(20);
  assert.equal(consumed, false, '等待真实drain时不能继续向上游拉帧');
  res.emit('drain');
  await settle(20);
  assert.equal(consumed, true);
  finish();
  await pending;
});


test('回放中的deferred合帧先计字节，达到预算即截断并通知resync', async () => {
  const sessionId = 'batch-replay-budget';
  const res = response();
  const ctl = muxOf([]);
  const events = Array.from({ length: 20 }, (_, index) => ({
    event: { type: 'assistant/chunk', seq: index + 2, data: { turn: 1, step: 1, chunk: { index: 0, text: 'x'.repeat(70 * 1024) } } },
  }));
  const ctx = ctxWith(ctl.mux);
  ctx.apiProxy.sessions.history = async () => ({ result: { ok: true, value: { events, hasMore: false } } });
  const pending = handleStream(ctx, request(`/api/mobile/v1/session/stream?sessionId=${sessionId}&lastSeq=1&frameBatch=1`), res);
  await settle(80);
  const list = frames(res);
  const replayed = list.filter((frame) => frame.type === 'batch').flatMap((frame) => frame.events);
  assert.ok(replayed.length > 0 && replayed.length <= 8, '512KiB预算不能等整批写出才开始计费');
  assert.ok(list.some((frame) => frame.type === 'session/resync-required'), '回放截断必须通知客户端补权威历史');
  ctl.release();
  await pending;
});

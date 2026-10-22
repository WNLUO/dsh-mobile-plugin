'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStream, parseResumeSeq } = require('../lib/mobile/stream.js');

function response() {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(String(chunk)); },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
  };
}

function request(url, headers = {}) {
  const req = new (require('node:events').EventEmitter)();
  req.url = url;
  req.headers = headers;
  return req;
}

/** 从 SSE chunk 里提取 `data:` 行的 JSON。 */
function dataFrames(chunks) {
  const out = [];
  for (const chunk of chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6).trim()));
    }
  }
  return out;
}

test('parseResumeSeq reads Last-Event-ID header and lastSeq query param', () => {
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1', { 'last-event-id': 's-1:42' }), 's-1'), 42);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1&lastSeq=7', {}), 's-1'), 7);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1&lastSeq=7', { 'last-event-id': 's-1:42' }), 's-1'), 42);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1', {}), 's-1'), null);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1&lastSeq=abc', {}), 's-1'), null);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1', { 'last-event-id': 'oops-not-numeric' }), 's-1'), null);
  assert.equal(parseResumeSeq(request('/stream?sessionId=s-1', { 'last-event-id': 's-1:-3' }), 's-1'), null);
});

test('reconnect replays history after lastSeq then dedupes the mux boundary', async () => {
  const res = response();
  const req = request('/api/mobile/v1/session/stream?sessionId=s-1&lastSeq=5', { 'last-event-id': 's-1:5' });

  // history 返回 seq 6,7,8（其中 6/7 在上次断线期间 miss，8 是回放与实时交界）。
  const history = async () => ({ result: { ok: true, value: { events: [
    { event: { type: 'assistant/message', seq: 8, data: { n: 8 }, time: 8 } },
    { event: { type: 'assistant/message', seq: 6, data: { n: 6 }, time: 6 } },
    { event: { type: 'assistant/message', seq: 7, data: { n: 7 }, time: 7 } },
  ] } } });

  // mux 实时流：先重复 seq 8（已回放→应跳过），再给 seq 9。
  const mux = async function* (_request, signal) {
    if (signal.aborted) return;
    yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 8, data: { n: 8 }, time: 8 } } };
    yield { rpcId: 'mux-2', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 9, data: { n: 9 }, time: 9 } } };
  };

  const ctx = {
    apiProxy: {
      events: { mux },
      sessions: { history },
    },
  };

  await handleStream(ctx, req, res);
  const frames = dataFrames(res.chunks);
  const seqs = frames.map((frame) => frame.seq);
  // 回放按序补全 seq 6,7,8；实时流的 seq 8 被去重，只交付 seq 9。
  // 末尾 undefined 是「实时循环正常结束」时补发的 session/resync-required。
  assert.deepEqual(seqs, [6, 7, 8, 9, undefined]);
  assert.equal(frames[0].type, 'assistant/message');
  assert.equal(frames.at(-1).type, 'session/resync-required');
  assert.equal(frames.at(-1).final, true, '流正常收尾的 gap 帧必须带 final，App 才能立刻换连接重放');
});

test('reconnect with no resume point forwards only live frames', async () => {
  const res = response();
  const req = request('/api/mobile/v1/session/stream?sessionId=s-1');
  const history = async () => { throw new Error('should not call history without resume'); };
  const mux = async function* (_request, signal) {
    if (signal.aborted) return;
    yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 3, data: {}, time: 3 } } };
  };
  const ctx = { apiProxy: { events: { mux }, sessions: { history } } };
  await handleStream(ctx, req, res);
  const frames = dataFrames(res.chunks);
  assert.deepEqual(frames.map((f) => f.event?.seq ?? f.seq), [3, undefined]);
  assert.equal(frames.at(-1).type, 'session/resync-required');
});

test('replay failure does not block the live stream', async () => {
  const res = response();
  const req = request('/api/mobile/v1/session/stream?sessionId=s-1&lastSeq=1');
  const history = async () => { throw new Error('history down'); };
  const mux = async function* (_request, signal) {
    if (signal.aborted) return;
    yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 2, data: {}, time: 2 } } };
  };
  const ctx = { apiProxy: { events: { mux }, sessions: { history } } };
  await handleStream(ctx, req, res);
  const frames = dataFrames(res.chunks);
  // 回放失败不阻塞实时流；末尾那一帧是循环正常结束时的 resync。
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event?.seq ?? frames[0].seq, 2);
  assert.equal(frames[1].type, 'session/resync-required');
});

test('signals an authoritative resync when replay history has a gap', async () => {
  const res = response();
  const req = request('/api/mobile/v1/session/stream?sessionId=s-1&lastSeq=5');
  const history = async () => ({ result: { ok: true, value: { hasMore: true, events: [
    { event: { type: 'assistant/message', seq: 10, data: {}, time: 10 } },
    { event: { type: 'assistant/message', seq: 11, data: {}, time: 11 } },
  ] } } });
  const mux = async function* (_request, signal) {
    if (signal.aborted) return;
    yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 12, data: {}, time: 12 } } };
  };
  const ctx = { apiProxy: { events: { mux }, sessions: { history } } };
  await handleStream(ctx, req, res);
  const frames = dataFrames(res.chunks);
  // 末尾多出的一帧 resync 来自「实时循环正常结束」：流到此为止，客户端应带
  // lastSeq 重连重放，而不是把静默断流当正常状态（见 stream-liveness.test.cjs）。
  assert.deepEqual(frames.map((frame) => frame.seq ?? frame.type), [10, 11, 'session/resync-required', 12, 'session/resync-required']);
  assert.equal(frames[2].oldestSeq, 10);
  assert.equal(frames[2].final, undefined, '回放缺口只补权威历史，不关流（否则会重连风暴）');
});

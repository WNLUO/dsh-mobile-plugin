'use strict';

/**
 * 回归：实时 SSE 流「preamble 之后既不产出也不终止」。
 *
 * 现场（Defect D）：客户端只收到 `: connected`，之后连 15s 的 keepalive 都没有，
 * 连接一直挂到客户端自己的超时（实测 600s），relay 侧条目也一直挂着。
 * 根因是 stream.js 三处静默吞错：keepalive 写失败被吞、mux 循环抛错被吞、
 * res.end 失败被吞 —— 于是连接既不产出也不结束，host 永不发 T.httpEnd。
 *
 * 本用例锁死：任何一条退出路径都必须留下可 grep 的日志、清掉 keepalive 定时器、
 * 并且一定结束响应；非客户端主动断开时还要回写 `session/resync-required`，
 * 让客户端带 lastSeq 走 replay 重连，而不是把静默断流当成正常状态。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStream } = require('../lib/mobile/stream.js');

/** 可控的假响应：write 可配置在第 N 次之后开始抛错（模拟 socket 已断）。 */
function response({ failAfter = Infinity } = {}) {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    ended: false,
    writes: 0,
    writeHead() {},
    write(chunk) {
      if (this.writes >= failAfter) throw new Error('socket closed');
      this.writes += 1;
      chunks.push(String(chunk));
      return true;
    },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
  };
}

function request(url) {
  const req = new (require('node:events').EventEmitter)();
  req.url = url;
  req.headers = {};
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** mux 生成器：一直挂住，直到 release() 被调用（模拟「连接开着但一帧都没有」）。 */
function controllableMux() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { release, mux: async function* () { await gate; } };
}

function ctxWith(mux) {
  return {
    apiProxy: {
      events: { mux },
      sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
    },
  };
}

/** 把 setInterval/clearInterval 换成可手动触发的桩，并捕获 stderr。 */
function harness() {
  const intervals = [];
  const logs = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realWrite = process.stderr.write;
  global.setInterval = (fn, ms) => { const handle = { fn, ms, cleared: false, unref() { this.unreffed = true; } }; intervals.push(handle); return handle; };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  process.stderr.write = (chunk) => { logs.push(String(chunk)); return true; };
  return {
    intervals,
    logs,
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      process.stderr.write = realWrite;
    },
  };
}

test('keepalive tick writes a comment line while the stream is open', async () => {
  const h = harness();
  const ctl = controllableMux();
  try {
    const res = response();
    const pending = handleStream(ctxWith(ctl.mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);
    await flush();
    assert.equal(h.intervals.length, 1, 'SSE 流必须装一个 15s keepalive 定时器');
    assert.equal(h.intervals[0].ms, 15_000);
    assert.equal(h.intervals[0].unreffed, true, 'keepalive 定时器必须 unref，否则关停要等下一次 tick');
    h.intervals[0].fn();
    assert.ok(res.chunks.some((c) => c.includes(': keepalive')), 'keepalive 必须真的写出去');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

test('keepalive write failure ends the stream instead of spinning forever', async () => {
  const h = harness();
  const ctl = controllableMux();
  try {
    // 第 1 次写（`: connected`）成功，之后的写都抛错 —— 模拟客户端已经消失。
    const res = response({ failAfter: 1 });
    const pending = handleStream(ctxWith(ctl.mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);
    await flush();
    h.intervals[0].fn();
    assert.equal(res.ended, true, '写失败后必须结束响应，否则 relay 永远收不到 httpEnd');
    assert.equal(h.intervals[0].cleared, true, '写失败后必须清掉 keepalive 定时器');
    assert.ok(h.logs.some((l) => l.includes('keepalive write failed')), '写失败必须留下日志');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

test('a mux loop that throws ends the stream and signals a resync', async () => {
  const h = harness();
  try {
    const res = response();
    const mux = async function* () { throw new Error('mux transport died'); };
    await handleStream(ctxWith(mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);

    assert.equal(res.ended, true);
    assert.equal(h.intervals[0].cleared, true);
    assert.ok(
      h.logs.some((l) => l.includes('mux loop threw') && l.includes('mux transport died')),
      'mux 抛错必须留下日志（旧实现是静默 catch）',
    );
    const frames = dataFrames(res.chunks);
    assert.equal(frames.at(-1).type, 'session/resync-required', '必须让客户端带 lastSeq 重连重放');
    assert.equal(frames.at(-1).oldestSeq, 1);
  } finally { h.restore(); }
});

test('a mux loop that ends cleanly still terminates the response', async () => {
  const h = harness();
  try {
    // 旧实现在这里既没有事件也没有终止帧：客户端静默挂到超时。
    const res = response();
    const mux = async function* () { /* 立刻结束，一帧都不产出 */ };
    await handleStream(ctxWith(mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);

    assert.equal(res.ended, true, '循环正常结束也必须结束响应');
    assert.equal(h.intervals[0].cleared, true);
    const frames = dataFrames(res.chunks);
    assert.equal(frames.at(-1).type, 'session/resync-required');
    assert.equal(frames.at(-1).oldestSeq, 1);
  } finally { h.restore(); }
});

test('the resync signal resumes after the last delivered seq', async () => {
  const h = harness();
  try {
    const res = response();
    const mux = async function* () {
      yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 7, data: {}, time: 7 } } };
    };
    await handleStream(ctxWith(mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);
    const frames = dataFrames(res.chunks);
    assert.equal(frames.at(-1).type, 'session/resync-required');
    assert.equal(frames.at(-1).oldestSeq, 8, 'resync 必须从已交付水位 +1 开始，否则客户端会漏事件');
  } finally { h.restore(); }
});

test('a client-initiated disconnect does not emit a resync frame', async () => {
  const h = harness();
  try {
    const res = response();
    // 客户端断开 → res 'close' → ac.abort()；此时不该再往死 socket 里写 resync。
    const mux = async function* (_request, signal) {
      res.emit('close');
      await flush();
      if (signal.aborted) return;
      yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 1, data: {}, time: 1 } } };
    };
    await handleStream(ctxWith(mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);
    const frames = dataFrames(res.chunks);
    assert.deepEqual(frames, []);
    assert.equal(res.ended, true, '客户端断开也要把响应收尾，不能留着');
  } finally { h.restore(); }
});

test('stream.js keeps no silent catch on its failure paths', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'mobile', 'stream.js'), 'utf8');
  for (const needle of [
    "logStream(sessionId, 'keepalive write failed', error)",
    "logStream(sessionId, 'mux loop threw', error)",
    "logStream(sessionId, 'stream end failed', error)",
    "logStream(sessionId, 'replay failed', error)",
    "logStream(sessionId, 'writeHead failed', error)",
  ]) {
    assert.ok(source.includes(needle), `stream.js 缺少诊断日志：${needle}`);
  }
  assert.ok(!/catch\s*\{\s*\/\*\s*客户端断开或流结束/.test(source), 'mux 循环不得再静默吞错');
  // 保活定时器只是保活：它不该把进程退出按在 15s 一拍上（宿主/worker 关停时事件循环
  // 会被它拖住，收尾要等到下一次 tick）。设备级流同理，见 test/device-events.test.cjs。
  assert.ok(source.includes('keepAlive.unref()'), 'keepalive 定时器必须 unref');
  // close 与 error 都要 abort：Node 在连接坏掉时发的是 'error'，只绑 close 会漏。
  assert.ok(source.includes("res.on('error', () => ac.abort())"), 'res 的 error 事件没有中止订阅');
});

// 连接坏掉时 Node 在 res 上发 'error'，不一定会发 'close'。旧实现只绑了 close，于是
// 'error' 既没人接（未捕获异常）也没把订阅中止，收尾分支还以为客户端在、往死 socket
// 里写一帧 resync。
test('响应 error 也要中止订阅（不只是 close）', async () => {
  const h = harness();
  try {
    const res = response();
    const mux = async function* (_request, signal) {
      res.emit('error', new Error('socket hang up'));
      await flush();
      if (signal.aborted) return;
      yield { rpcId: 'mux-1', payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 1, data: {}, time: 1 } } };
    };
    await handleStream(ctxWith(mux), request('/api/mobile/v1/session/stream?sessionId=s-1'), res);
    assert.deepEqual(dataFrames(res.chunks), [], '连接已坏，不该再往死 socket 里写 resync');
    assert.equal(res.ended, true);
  } finally { h.restore(); }
});

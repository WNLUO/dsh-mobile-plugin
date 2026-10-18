'use strict';

/**
 * 回归：SSE 写缓冲没有上限，客户端读得慢时帧无限堆在 Node 的写队列里。
 *
 * 现场（2026-10-17 宿主 OOM）：堆快照里 17.6 万条 SSE 帧、466MB 挂在
 * `WriteWrap._chunks` 上，宿主七十分钟涨到 3.9G 被 4GB 上限杀掉。根因是 `writeSse`
 * 只捕获 `res.write()` 抛错，完全没看它的返回值 —— 而返回 false 恰恰是「内核/写队列
 * 已经满了，这一帧还在内存里排队」的唯一信号。每个 assistant/chunk 帧还带 2KB 填充，
 * 一轮生成上千个 chunk，手机停在一个正在生成的会话上、网又慢，就够撑爆堆。
 *
 * 两道闸的语义在这里钉住：
 *  - 软水位只丢**没有 seq** 的增量（可丢弃草稿：同一轮收尾的 assistant/message 带
 *    完整正文，重连回放能补齐），连接继续活着；
 *  - 硬水位才返回 ok:false 让上层收尾，客户端带 lastSeq 重连走 replaySince 补缺。
 *
 * 运行：node --test test/stream-backpressure.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleStream } = require('../lib/mobile/stream.js');

/**
 * 最小响应假体。`bufferedBytes` 模拟 Node 写队列里已经积压的字节数：
 * 真 `res.writableLength` 就是这么暴露的，这里只是把它做成可控的。
 */
function response({ bufferedBytes = 0, socketBufferedBytes = 0, acceptWrites = true } = {}) {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    // 响应对象自己那一层缓冲。真实宿主上它常常接近 0 —— 积压其实在 socket 上。
    writableLength: bufferedBytes,
    socket: { writableLength: socketBufferedBytes },
    acceptWrites,
    ended: false,
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return this.acceptWrites; },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    once(event, fn) { (listeners[event] ||= []).push(fn); },
    off(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
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

/** 一个把给定事件全部推完、然后挂住的 mux（挂住是为了让用例自己收尾）。 */
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

function ctxWith(mux) {
  return {
    apiProxy: {
      events: { mux },
      sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
    },
  };
}

/** 把 setInterval 换成桩，避免 15s keepalive 把用例拖住。 */
function harness() {
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unref() { this.unreffed = true; } };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  return {
    intervals,
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

/** 一条没有 seq 的增量（手机侧可丢弃的草稿块）。 */
const chunkEvent = (sessionId, text) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text } } },
});

/** 一条有 seq 的持久事件（水位的一部分，丢了就在手机侧留永久的洞）。 */
const seqEvent = (sessionId, seq) => ({
  type: 'session/event',
  sessionId,
  event: { type: 'turn/start', seq, data: { turn: 1 } },
});

test('写缓冲超过软水位时丢掉没有 seq 的增量帧，连接继续活着', async () => {
  const h = harness();
  const sessionId = 's-backpressure';
  // 4MB 是软水位；这里给 5MB，模拟「手机读得慢，队列里已经积压了五兆」。
  const res = response({ socketBufferedBytes: 5 * 1024 * 1024 });
  const ctl = muxOf([chunkEvent(sessionId, 'a'), chunkEvent(sessionId, 'b')]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    const frames = dataFrames(res.chunks).filter((f) => f.type === 'assistant/chunk');
    assert.equal(frames.length, 0, '软水位之上不能再往写队列里塞增量帧');
    assert.equal(res.ended, false, '丢增量不该把连接收掉 —— 它还能继续送有 seq 的帧');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

test('软水位只丢增量，有 seq 的事件照常送出去', async () => {
  const h = harness();
  const sessionId = 's-backpressure-seq';
  const res = response({ socketBufferedBytes: 5 * 1024 * 1024 });
  const ctl = muxOf([chunkEvent(sessionId, 'dropped'), seqEvent(sessionId, 7)]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    const frames = dataFrames(res.chunks).filter((f) => f.type === 'turn/start');
    assert.equal(frames.length, 1, '有 seq 的事件不能被丢：丢了不回放就在手机上留一个洞');
    assert.equal(frames[0].seq, 7);
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

test('写缓冲超过硬水位时收尾，让客户端带 lastSeq 重连补缺', async () => {
  const h = harness();
  const sessionId = 's-backpressure-close';
  // 16MB 是硬水位；给 20MB 表示连有 seq 的帧都塞不进去了。
  const res = response({ socketBufferedBytes: 20 * 1024 * 1024 });
  const ctl = muxOf([seqEvent(sessionId, 9)]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    const frames = dataFrames(res.chunks).filter((f) => f.type === 'turn/start');
    assert.equal(frames.length, 0, '硬水位之上一条都不该再塞');
    assert.equal(res.ended, true, '硬水位必须收尾：断流可恢复，堆内存不会');
    assert.equal(h.intervals[0].cleared, true, '收尾时必须清掉 keepalive 定时器');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

test('被丢掉的增量不推进交付水位，重连时才会被补齐', async () => {
  const h = harness();
  const sessionId = 's-backpressure-watermark';
  // 软水位之上：带 seq 的 chunk 帧（宿主偶尔会给增量补 seq）一旦没送出去，
  // 水位就不能前移，否则客户端带的 lastSeq 会跨过它，那段正文永久缺失。
  const withSeq = {
    type: 'session/event',
    sessionId,
    event: { type: 'assistant/chunk', seq: 12, data: { turn: 1, step: 1, chunk: { index: 0, text: 'x' } } },
  };
  const res = response({ socketBufferedBytes: 5 * 1024 * 1024 });
  const ctl = muxOf([withSeq, seqEvent(sessionId, 13)]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    const frames = dataFrames(res.chunks).filter((f) => Number.isFinite(f.seq));
    // 带 seq 的 chunk 不被 shed（它在软水位闸里算「有 seq」），所以它会照常送出。
    assert.equal(frames.length, 2, '带 seq 的帧一律照常送，水位才连得上');
    assert.deepEqual(frames.map((f) => f.seq), [12, 13]);
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

/**
 * 这一条钉的正是第一版修法漏掉的东西：响应的 `writableLength` 恒为 0（真实宿主就这样），
 * 积压全在底下的 socket 写队列里。只看前者 ⇒ 闸门一次都不触发 ⇒ 内存照涨（2026-10-18
 * 复测：修完仍从 410MB 涨到 1.4GB）。所以水位必须顺着 socket 看。
 */
test('积压只体现在 socket 队列上时，闸门同样要生效', async () => {
  const h = harness();
  const sessionId = 's-socket-only';
  // 响应对象自身缓冲为 0，socket 队列 20MB —— 正是线上真实的形状。
  const res = response({ bufferedBytes: 0, socketBufferedBytes: 20 * 1024 * 1024 });
  const ctl = muxOf([seqEvent(sessionId, 5)]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    const frames = dataFrames(res.chunks).filter((f) => f.type === 'turn/start');
    assert.equal(frames.length, 0, 'socket 队列已经 20MB，不该再塞');
    assert.equal(res.ended, true, '超过硬水位必须收尾');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

/**
 * `write()` 返回 false 时必须停下来等排空，而不是继续写。这是背压的正解 ——
 * 只靠字节水位迟早会漏（水位是事后判据），返回 false 才是「现在就已经满了」的实时信号。
 */
test('write 返回 false 时等 drain 再继续，不硬塞', async () => {
  const h = harness();
  const sessionId = 's-drain';
  // 第一条帧 write 就报 false（写不动），之后允许写完。
  let call = 0;
  const res = response({ socketBufferedBytes: 0 });
  const realWrite = res.write.bind(res);
  res.write = (chunk) => {
    call += 1;
    // 第 2 次调用（第一条真正的帧）返回 false，模拟写队列刚满：数据进去了，但写不动。
    if (call === 2) { res.chunks.push(String(chunk)); return false; }
    return realWrite(chunk);
  };
  const ctl = muxOf([seqEvent(sessionId, 1), seqEvent(sessionId, 2)]);
  try {
    const pending = handleStream(ctxWith(ctl.mux), request(`/api/mobile/v1/session/stream?sessionId=${sessionId}`), res);
    await flush();
    // 卡在等 drain：第二帧还没被写出去
    assert.equal(dataFrames(res.chunks).filter((f) => f.type === 'turn/start').length, 1, '写不动时不该继续塞第二帧');
    res.emit('drain');
    await flush();
    assert.equal(dataFrames(res.chunks).filter((f) => f.type === 'turn/start').length, 2, 'drain 之后必须继续');
    assert.equal(res.ended, false, '只是慢，不该收尾');
    ctl.release();
    await pending;
  } finally { h.restore(); }
});

/**
 * 写帧只能有一份实现。
 *
 * 两条流曾经各有一份几乎相同的 `writeSse` / `bufferedBytesOf` / `stableEventId`，于是
 * 2026-10-17 那次 OOM 修了会话流那份、隔一轮才发现设备流那份还漏着 —— 同一个坑修两遍。
 * 现在实现在 `lib/shared/sse-write.js`，两条流只声明自己的策略（丢帧口径、要不要填充、
 * 写不动时等不等 drain）。这条用例钉住「别再各自长回一份」。
 */
test('写帧、水位与稳定 id 只有一份实现，两条流只声明策略', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const MOBILE = path.join(__dirname, '..', 'lib', 'mobile');
  const SHARED = path.join(__dirname, '..', 'lib', 'shared', 'sse-write.js');
  const read = (file) => fs.readFileSync(file, 'utf8');

  const shared = read(SHARED);
  for (const name of ['bufferedBytesOf', 'stableEventId', 'writeSse', 'waitForDrain']) {
    assert.match(shared, new RegExp(`^function ${name}\\(`, 'm'), `${name} 应定义在 lib/shared/sse-write.js`);
  }

  // 两条流都必须从共享模块取，且不许再自带这些实现（薄封装 writeSse 可以留，它只是声明策略）。
  for (const file of ['stream.js', 'events.js']) {
    const source = read(path.join(MOBILE, file));
    assert.match(
      source,
      /require\(['"]\.\.\/shared\/sse-write\.js['"]\)/,
      `${file} 没有从 lib/shared/sse-write.js 取写帧实现`,
    );
    for (const name of ['bufferedBytesOf', 'stableEventId', 'waitForDrain']) {
      assert.doesNotMatch(
        source,
        new RegExp(`^function ${name}\\(`, 'm'),
        `${file} 又自己实现了一份 ${name} —— 写帧必须只有一份实现`,
      );
    }
    assert.doesNotMatch(source, /^const SSE_SHED_BUFFERED_BYTES =/m, `${file} 又自带了一份软水位常量`);
    assert.doesNotMatch(source, /^const SSE_CLOSE_BUFFERED_BYTES =/m, `${file} 又自带了一份硬水位常量`);
    assert.doesNotMatch(source, /crypto\.createHash/, `${file} 又自己算了一份事件 id 摘要`);
  }
});

'use strict';

/**
 * 隧道背压守卫：发送队列积压到上限时**只丢这一帧，绝不断开隧道**。
 *
 * 旧实现在 `sendFrame` / `sendJson` 的两个分支里都 `ws.terminate()`：一帧背压就把整条隧道
 * 掐掉，于是所有设备（包括正在正常转发的那些）一起掉线，还要等 5s 重连。而积压本身是「手机 /
 * 中转读得慢」，不是「隧道坏了」—— 中转侧的同名判定早就只 `return false`，两侧口径必须一致：
 * 丢一帧可以恢复，关一条隧道是全网断流。真正的死隧道由心跳兜底（`PONG_TIMEOUT_MS` 收不到
 * pong 才 terminate）。
 *
 * 这个 bug 的杀伤力全在「看不见」上：隧道被自己掐掉时宿主日志只有一行「连接断开」，看不出
 * 是背压导致的，所以这里既钉行为也钉日志。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { RelayTunnel } = require('../lib/relay/tunnel.js');
const { T, createFrameDecoder } = require('../lib/relay/protocol.js');

const MAX_TUNNEL_BUFFERED_BYTES = 16 * 1024 * 1024;
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'tunnel.js'), 'utf8');

/** 造一个不连网的隧道实例：ws 换成可观察的假对象。 */
function makeTunnel(bufferedAmount, readyState = WebSocket.OPEN) {
  const sent = [];
  const logs = [];
  let terminated = 0;
  const tunnel = new RelayTunnel({
    relayUrl: 'wss://relay.example.com/tunnel',
    instanceId: 'backpressure-test',
    pairingCode: 'pair-code',
    upstream: 'http://127.0.0.1:12345',
    onLog: (...args) => logs.push(args.join(' ')),
  });
  tunnel.ws = {
    readyState,
    bufferedAmount,
    send: (frame) => sent.push(frame),
    terminate: () => { terminated += 1; },
  };
  return { tunnel, sent, logs, terminated: () => terminated };
}

function withFakeTimers(run) {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  try {
    return run(timers);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
}

test('正常背压下照发，不丢帧也不断隧道', () => {
  const { tunnel, sent, terminated } = makeTunnel(0);
  assert.equal(tunnel.sendJson(0x17, 0, { kind: 'sync' }), true);
  assert.equal(sent.length, 1, '没超上限就该真的发出去');
  assert.equal(terminated(), 0, '正常发送不该 terminate');
});

test('积压已超上限：丢帧、记日志、隧道保持连接', () => {
  const { tunnel, sent, logs, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  assert.equal(tunnel.sendJson(0x17, 0, { kind: 'sync' }), false);
  assert.equal(sent.length, 0, '超限还发出去就会继续堆内存');
  assert.equal(terminated(), 0, '积压不是「隧道坏了」，不许 terminate');
  assert.equal(logs.length, 1, '丢帧必须留一行日志，否则「隧道怎么断了」查不出来');
  assert.match(logs[0], /发送队列积压/);
  assert.match(logs[0], /丢弃该帧（隧道保持连接）/);
});

test('本帧会让总量超上限：丢这一帧，隧道仍在', () => {
  // 差 1 字节就到上限，任何一帧都会越界。
  const { tunnel, sent, logs, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES - 1);
  assert.equal(tunnel.sendJson(0x17, 0, { kind: 'sync' }), false);
  assert.equal(sent.length, 0);
  assert.equal(terminated(), 0);
  assert.match(logs[0], /超过上限/);
});

test('未连接时不发送、不 terminate（更不该把「没连上」当故障掐一遍）', () => {
  const { tunnel, sent, terminated } = makeTunnel(0, WebSocket.CLOSED);
  assert.equal(tunnel.sendJson(0x17, 0, { kind: 'sync' }), false);
  assert.equal(sent.length, 0);
  assert.equal(terminated(), 0);
});

test('二进制帧走同一条预算判定', () => {
  const over = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  assert.equal(over.tunnel.sendFrame(0x17, 0, Buffer.from('x')), false);
  assert.equal(over.terminated(), 0);
  const ok = makeTunnel(0);
  assert.equal(ok.tunnel.sendFrame(0x17, 0, Buffer.from('x')), true);
  assert.equal(ok.sent.length, 1);
});

test('HTTP响应在背压期间按序排队、限帧并完整恢复', () => {
  const { tunnel, sent, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const events = [];
  const id = 81;
  const entry = tunnel.createHttpResponseEntry(null, {
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
    destroy: () => events.push('destroy'),
  });
  tunnel.reqClients.set(id, entry);
  const body = Buffer.alloc(600 * 1024, 0x61);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpHead, { status: 200, headers: {} }, true), true);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, body), true);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0)), true);
  assert.equal(entry.pendingFrames.length, 3);
  assert.equal(entry.bufferPaused, true);
  assert.ok(events.includes('pause'));

  tunnel.ws.bufferedAmount = MAX_TUNNEL_BUFFERED_BYTES / 2 - 1;
  for (let i = 0; i < 8 && !entry.done; i += 1) tunnel.pumpHttpResponses();
  assert.equal(entry.done, true, '终止帧发送后必须清理该 HTTP request');
  assert.equal(terminated(), 0, '单请求背压不能 terminate 共享隧道');
  assert.equal(tunnel.reqClients.has(id), false);
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.map((frame) => frame.type), [T.httpHead, T.httpChunk, T.httpChunk, T.httpChunk, T.httpEnd]);
  assert.deepEqual(Buffer.concat(frames.filter((frame) => frame.type === T.httpChunk).map((frame) => frame.payload)), body);
});

test('relay pause gates direct sends and queued pump frames; cancel clears the response queue', () => {
  const { tunnel, sent } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const events = [];
  const id = 82;
  const entry = tunnel.createHttpResponseEntry(
    { destroy: () => events.push('req-destroy') },
    { pause: () => events.push('pause'), resume: () => events.push('resume'), destroy: () => events.push('res-destroy') },
  );
  tunnel.reqClients.set(id, entry);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.from('queued-before-pause')), true);
  tunnel.handleFrame({ type: T.httpPause, id, payload: Buffer.alloc(0) });
  tunnel.ws.bufferedAmount = 0;
  tunnel.pumpHttpResponses();
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.from('queued-during-pause')), true);
  assert.equal(sent.length, 0, 'relay pause must block both queued frames and the fast path');
  assert.equal(entry.pendingFrames.length, 2);
  assert.equal(entry.bufferPaused, true);
  assert.equal(entry.relayPaused, true);
  assert.equal(events.includes('resume'), false, 'local queue drain must not bypass relay pause');
  tunnel.handleFrame({ type: T.httpResume, id, payload: Buffer.alloc(0) });
  for (let i = 0; i < 8 && entry.pendingFrames.length; i += 1) tunnel.pumpHttpResponses();
  assert.equal(sent.length, 2);
  assert.equal(entry.bufferPaused, false);
  assert.equal(events.filter((event) => event === 'resume').length, 1);

  tunnel.ws.bufferedAmount = MAX_TUNNEL_BUFFERED_BYTES + 1;
  tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.from('queued'));
  tunnel.handleFrame({ type: T.httpCancel, id, payload: Buffer.alloc(0) });
  assert.equal(entry.done, true);
  assert.equal(entry.pendingFrames.length, 0);
  assert.equal(tunnel.reqClients.has(id), false);
  assert.ok(events.includes('req-destroy'));
  assert.ok(events.includes('res-destroy'));
  assert.equal(tunnel.httpPumpTimer, null);
});

test('响应积压超限后仍保留请求直到 relay 收到终止错误帧', () => {
  const { tunnel, sent, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const id = 86;
  const events = [];
  const entry = tunnel.createHttpResponseEntry(
    { destroy: () => events.push('req-destroy') },
    { pause: () => {}, resume: () => {}, destroy: () => events.push('res-destroy') },
  );
  tunnel.reqClients.set(id, entry);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpHead, { status: 200, headers: {} }, true), true);
  assert.equal(tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.alloc(8 * 1024 * 1024 + 1)), true);
  assert.equal(entry.done, false, '超限时不能先移除请求再尝试 best-effort error');
  assert.equal(tunnel.reqClients.has(id), true);
  assert.deepEqual(entry.pendingFrames.map((item) => item.type), [T.httpError]);

  tunnel.ws.bufferedAmount = 0;
  tunnel.pumpHttpResponses();
  assert.equal(entry.done, true);
  assert.equal(tunnel.reqClients.has(id), false);
  assert.deepEqual(events.sort(), ['req-destroy', 'res-destroy']);
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.map((frame) => frame.type), [T.httpError]);
  assert.equal(terminated(), 0, '单请求错误不得关闭共享隧道');
});

test('普通响应 headers 后闲置会排队 httpError，SSE 不启用该超时', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  try {
    const { tunnel, sent } = makeTunnel(0);
      const id = 87;
    const entry = tunnel.createHttpResponseEntry(
      { destroy: () => {} },
      { pause: () => {}, resume: () => {}, destroy: () => {} },
    );
    tunnel.reqClients.set(id, entry);
    tunnel.queueHttpResponseFrame(id, entry, T.httpHead, { status: 200, headers: {} }, true);
    tunnel.armUpstreamResponseIdleTimeout(id, entry);
    const idleTimer = timers.find((timer) => timer.ms === 30_000 && !timer.cleared);
    assert.ok(idleTimer, '普通响应应设置 30 秒 post-header idle timeout');
    idleTimer.fn();
    assert.equal(entry.pendingFrames[0]?.type, T.httpError);
    tunnel.pumpHttpResponses();
    const frames = [];
    const push = createFrameDecoder((frame) => frames.push(frame));
    for (const frame of sent) push(frame);
    assert.deepEqual(frames.map((frame) => frame.type), [T.httpHead, T.httpError]);

    const sse = tunnel.createHttpResponseEntry(null, { pause: () => {}, resume: () => {}, destroy: () => {} }, true);
    const before = timers.filter((timer) => timer.ms === 30_000 && !timer.cleared).length;
    tunnel.armUpstreamResponseIdleTimeout(id + 1, sse);
    assert.equal(timers.filter((timer) => timer.ms === 30_000 && !timer.cleared).length, before);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('上游响应头 7s 超时会销毁仍未响应的本地请求', () => withFakeTimers((timers) => {
  const { tunnel } = makeTunnel(0);
  let destroyedWith = null;
  const entry = tunnel.createHttpResponseEntry({ destroy: (error) => { destroyedWith = error; } }, null);
  tunnel.reqClients.set(89, entry);
  tunnel.armUpstreamHeaderTimeout(89, entry);
  const headerTimer = timers.find((timer) => timer.ms === 7_000 && !timer.cleared);
  assert.ok(headerTimer, '上游请求应有 7 秒响应头期限');
  headerTimer.fn();
  assert.match(destroyedWith?.message || '', /upstream response headers timeout/);
  tunnel.finishHttpRequest(89, entry);
}));

test('待发响应 30s 背压超时会排队 httpError 并只清理该请求', () => withFakeTimers((timers) => {
  const { tunnel, sent, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const entry = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
  tunnel.reqClients.set(90, entry);
  tunnel.queueHttpResponseFrame(90, entry, T.httpHead, { status: 200, headers: {} }, true);
  const timeout = timers.find((timer) => timer.ms === 30_000 && !timer.cleared);
  assert.ok(timeout, '队列积压应有 30 秒期限');
  timeout.fn();
  assert.deepEqual(entry.pendingFrames.map((item) => item.type), [T.httpError]);
  tunnel.ws.bufferedAmount = 0;
  tunnel.pumpHttpResponses();
  assert.equal(entry.done, true);
  assert.equal(terminated(), 0, '单请求背压超时不得关闭共享隧道');
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.map((frame) => frame.type), [T.httpError]);
}));

test('relay pause 即使无待发帧也在 30s 后以 httpError 结束', () => withFakeTimers((timers) => {
  const { tunnel, sent } = makeTunnel(0);
  const entry = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
  tunnel.reqClients.set(91, entry);
  tunnel.handleFrame({ type: T.httpPause, id: 91, payload: Buffer.alloc(0) });
  assert.equal(entry.pendingFrames.length, 0);
  const pauseTimer = timers.find((timer) => timer.ms === 30_000 && !timer.cleared);
  assert.ok(pauseTimer, 'relay pause 必须独立于队列状态启动期限');
  pauseTimer.fn();
  assert.equal(entry.relayPaused, false, '超时终帧必须解除 pump 门控');
  assert.deepEqual(entry.pendingFrames.map((item) => item.type), [T.httpError]);
  tunnel.pumpHttpResponses();
  assert.equal(entry.done, true);
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.map((frame) => frame.type), [T.httpError]);
}));

test('relay pause 期限到达时优先送出已排队的错误终帧并释放积压', () => withFakeTimers((timers) => {
  const { tunnel, sent } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const entry = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
  tunnel.reqClients.set(92, entry);
  tunnel.queueHttpResponseFrame(92, entry, T.httpHead, { status: 200, headers: {} }, true);
  tunnel.queueHttpResponseFrame(92, entry, T.httpChunk, Buffer.from('stalled-body'));
  tunnel.queueHttpResponseFrame(92, entry, T.httpError, { message: 'upstream failed' }, true);
  tunnel.handleFrame({ type: T.httpPause, id: 92, payload: Buffer.alloc(0) });
  assert.equal(tunnel.pendingHttpResponseBytes, Buffer.byteLength('stalled-body'));
  const pauseTimer = timers.find((timer) => timer.ms === 30_000 && !timer.cleared && timer === entry.relayPauseTimer);
  assert.ok(pauseTimer);
  pauseTimer.fn();
  assert.equal(tunnel.pendingHttpResponseBytes, 0, '终帧替换旧数据后要归还总预算');
  assert.deepEqual(entry.pendingFrames.map((item) => item.type), [T.httpError]);
  assert.equal(entry.relayPaused, false);
  tunnel.ws.bufferedAmount = 0;
  tunnel.pumpHttpResponses();
  assert.equal(entry.done, true);
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.map((frame) => frame.type), [T.httpError]);
}));

test('全隧道待发 HTTP 正文上限 32MiB，超限只终止新超限请求', () => {
  const { tunnel, sent, terminated } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const entries = [];
  const MiB = 1024 * 1024;
  for (let index = 0; index < 4; index += 1) {
    const id = 100 + index;
    const entry = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
    entries.push([id, entry]);
    tunnel.reqClients.set(id, entry);
    tunnel.queueHttpResponseFrame(id, entry, T.httpHead, { status: 200, headers: {} }, true);
    tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.alloc(7 * MiB, index));
    tunnel.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0));
  }
  assert.equal(tunnel.pendingHttpResponseBytes, 28 * MiB);
  const overflowId = 104;
  const overflow = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
  entries.push([overflowId, overflow]);
  tunnel.reqClients.set(overflowId, overflow);
  tunnel.queueHttpResponseFrame(overflowId, overflow, T.httpHead, { status: 200, headers: {} }, true);
  tunnel.queueHttpResponseFrame(overflowId, overflow, T.httpChunk, Buffer.alloc(5 * MiB));
  assert.deepEqual(overflow.pendingFrames.map((item) => item.type), [T.httpError]);
  assert.equal(tunnel.pendingHttpResponseBytes, 28 * MiB, '拒绝超限正文后总账不能增长');

  tunnel.ws.bufferedAmount = 0;
  for (let i = 0; i < 40 && !entries.every(([, entry]) => entry.done); i += 1) tunnel.pumpHttpResponses();
  assert.equal(overflow.done, true);
  assert.equal(tunnel.pendingHttpResponseBytes, 0, '完整泵送后总预算应归零');
  assert.equal(terminated(), 0, '总预算超限不能终止共享隧道');
  for (const [id, entry] of entries) tunnel.finishHttpRequest(id, entry, true);
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.ok(frames.some((frame) => frame.id === overflowId && frame.type === T.httpError));
});

test('多个 HTTP 响应按轮转 cursor 公平交错发送', () => {
  const { tunnel, sent } = makeTunnel(MAX_TUNNEL_BUFFERED_BYTES + 1);
  const ids = [110, 111];
  for (const id of ids) {
    const entry = tunnel.createHttpResponseEntry(null, { pause() {}, resume() {}, destroy() {} });
    tunnel.reqClients.set(id, entry);
    tunnel.queueHttpResponseFrame(id, entry, T.httpHead, { status: 200, headers: {} }, true);
    tunnel.queueHttpResponseFrame(id, entry, T.httpChunk, Buffer.alloc(512 * 1024, id));
    tunnel.queueHttpResponseFrame(id, entry, T.httpEnd, Buffer.alloc(0));
  }
  tunnel.ws.bufferedAmount = 0;
  for (let i = 0; i < 8 && tunnel.reqClients.size; i += 1) tunnel.pumpHttpResponses();
  const frames = [];
  const push = createFrameDecoder((frame) => frames.push(frame));
  for (const frame of sent) push(frame);
  assert.deepEqual(frames.filter((frame) => frame.type === T.httpChunk).map((frame) => frame.id), [110, 111, 110, 111]);
  for (const id of ids) tunnel.finishHttpRequest(id, tunnel.reqClients.get(id), true);
});

test('sendFrame/sendJson共用预算实现，单帧背压不关闭共享隧道（源码契约）', () => {
  for (const [name, delegate] of [
    ['sendFrame(type, id, payload)', 'trySendFrame('],
    ['sendJson(type, id, obj)', 'trySendJson('],
  ]) {
    const start = SOURCE.indexOf(name);
    assert.notEqual(start, -1, `缺少 ${name}`);
    const body = SOURCE.slice(start, SOURCE.indexOf('\n  }', start));
    assert.ok(!body.includes('terminate'), `${name} 又出现 terminate：一次背压会打掉整条隧道`);
    assert.ok(body.includes(delegate), `${name} 必须走共享预算实现`);
  }
  const budgetStart = SOURCE.indexOf('trySendEncodedFrame(frame)');
  assert.notEqual(budgetStart, -1, '缺少统一的帧预算实现');
  const budgetBody = SOURCE.slice(budgetStart, SOURCE.indexOf('\n  }', budgetStart));
  assert.ok(budgetBody.includes('dropOverBudget('), '超预算必须集中记账');
  assert.ok(SOURCE.includes('dropOverBudget(bytes, frameLength)'), '缺少统一超预算日志出口');
});

/**
 * 设备级 SSE（`/api/v1/events/stream`）的两组守卫。
 *
 * 前半部分钉「这条流只放行列表相关的轻量帧」——白名单、slim、稳定 seq id、信封字段，
 * 以及客户端断开必须 abort 订阅。
 *
 * 后半部分是这次补的两件事，都属于「连着却一帧不发」那一类看不见的故障：
 *  1. **失败路径必须留 `device/stream` 日志**：循环抛错与正常收尾都要写，收尾那行带
 *     `loopEnded/aborted/clientGone/frames` 四个值；不许再出现裸 catch（否则宿主日志里
 *     分不出是客户端断开、正常收尾还是循环抛错）。
 *  2. **连上时必须 `replayKnownSignals()`**：这条流没有 Last-Event-ID 续传，断流窗口里
 *     的清单 revision 与各会话水位要照信号总线的快照补发一帧。补发**只读不 bump**，
 *     所以它不会制造新变更；也正因为读的是单例信号，**bump 过的用例必须排在本文件最后**
 *     （前面的用例都假设「连上时没有任何已知信号」，多一帧就红）。
 */

'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleDeviceStream } = require('../lib/mobile/events.js');
const { listSignal: sharedListSignal } = require('../lib/shared/list-signal.js');
const { sessionSignal: sharedSessionSignal } = require('../lib/shared/session-signal.js');
const { desktopViewSignal: sharedDesktopViewSignal } = require('../lib/shared/desktop-view-signal.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'events.js'), 'utf8');

function response() {
  const chunks = [];
  return {
    chunks,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(String(chunk)); },
    end() { this.ended = true; },
  };
}

function request() {
  return new EventEmitter();
}

function framesFrom(res) {
  const frames = [];
  for (const chunk of res.chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6).trim()));
    }
  }
  return frames;
}

async function streamWith(frames, req = request()) {
  const res = response();
  const ctx = { apiProxy: { events: { mux: async function* (_request, signal) {
    for (const frame of frames) {
      if (signal.aborted) return;
      yield frame;
    }
  } } } };
  await handleDeviceStream(ctx, req, res);
  return { req, res, events: framesFrom(res) };
}

test('forwards only list-relevant session/event frames, slimmed, with a stable seq id', async () => {
  const payload = { type: 'session/event', sessionId: 's-1', event: { type: 'turn/start', seq: 42, data: { type: 'turn/start', ok: true } } };
  const result = await streamWith([{ rpcId: 'mux-rpc', payload }]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    type: 'device/event', version: 1, eventId: 's-1:42', sessionId: 's-1', rpcId: 'mux-rpc',
    // Message content is stripped on the device-wide stream; only the signal
    // the sidebar needs survives.
    payload: { type: 'session/event', sessionId: 's-1', event: { type: 'turn/start', seq: 42, data: { type: 'turn/start' } } },
  });
});

test('drops assistant/message session events from the device-wide stream', async () => {
  const result = await streamWith([
    { payload: { type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', seq: 1, data: { content: 'big' } } } },
    { payload: { type: 'session/event', sessionId: 's-1', event: { type: 'turn/end', seq: 2, data: { type: 'turn/end' } } } },
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.event.seq, 2);
});

test('keeps session summary patches local and partial', async () => {
  const patch = { type: 'session/summary', sessionId: 's-1', summary: { sessionId: 's-1', title: '新标题', updatedAt: 99 } };
  const result = await streamWith([{ payload: patch }]);
  assert.match(result.events[0].eventId, /^s-1:session\/summary:[a-f0-9]{24}$/);
  assert.deepEqual(result.events[0].payload.summary, patch.summary);
  assert.equal(result.events[0].payload.summary.running, undefined);
});

test('keeps host/workspace and queue frames, drops projections', async () => {
  const result = await streamWith([
    { payload: { type: 'host/session-changed', sessionId: 's-1' } },
    { payload: { type: 'session/projection', sessionId: 's-1', data: { big: 'payload' } } },
    { payload: { type: 'session/queue', sessionId: 's-1' } },
  ]);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].payload.type, 'host/session-changed');
  assert.equal(result.events[1].payload.type, 'session/queue');
});

test('aborts the mux subscription when the client disconnects', async () => {
  const req = request();
  let observedSignal;
  const res = response();
  const ctx = { apiProxy: { events: { mux: async function* (_request, signal) {
    observedSignal = signal;
    yield { payload: { type: 'session/summary', sessionId: 's-1', summary: { sessionId: 's-1' } } };
    await new Promise((resolve) => req.once('close', resolve));
    assert.equal(signal.aborted, true);
  } } } };
  const pending = handleDeviceStream(ctx, req, res);
  setImmediate(() => req.emit('close'));
  await pending;
  assert.equal(observedSignal.aborted, true);
  assert.equal(res.ended, true);
});

test('keeps debug metadata separate from application payload and credentials', async () => {
  const payload = { type: 'session/event', sessionId: 's-1', event: { seq: 7, data: { type: 'turn/end' } } };
  const result = await streamWith([{ payload }]);
  const envelope = result.events[0];
  assert.deepEqual(Object.keys(envelope).sort(), ['eventId', 'payload', 'sessionId', 'type', 'version']);
  assert.equal(envelope.authorization, undefined);
  assert.equal(envelope.deviceCredential, undefined);
});

// —— 以下是「设备级流自己也要能自证」的两组守卫 ——
//
// 这条流过去在失败路径上是裸 catch：循环一旦抛错（底层 HTTP SSE 中断、返回非异步可迭代、
// signal abort），流就停在 preamble 之后既不产出也不终止，而宿主日志里一个字都没有。
// 手机侧表现为「侧栏不刷新、兜底轮询还被降到 60s」，排障时无从下手。

test('收尾与抛错都必须留下 device/stream 日志', async () => {
  const logs = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { logs.push(String(chunk)); return true; };
  try {
    await streamWith([]); // 正常收尾：loopEnded=true, frames=0
    const res = response();
    await handleDeviceStream({ apiProxy: { events: { mux: async function* () { throw new Error('mux transport died'); } } } }, request(), res);
  } finally {
    process.stderr.write = original;
  }
  const closed = logs.find((line) => line.includes('stream closed'));
  assert.ok(closed, '正常收尾也必须留痕，否则「连着却一帧不发」查不出是哪种');
  assert.match(closed, /loopEnded=true/);
  assert.match(closed, /clientGone=false/);
  assert.match(closed, /frames=0/);
  assert.ok(
    logs.some((line) => line.includes('mux loop threw') && line.includes('mux transport died')),
    'mux 抛错必须带原始错误信息写日志',
  );
});

test('events.js 的失败路径没有裸 catch（源码契约）', () => {
  assert.ok(SOURCE.includes("logDeviceStream('mux loop threw', error)"), 'mux 抛错路径未留痕');
  assert.ok(SOURCE.includes("logDeviceStream('stream end failed', error)"), 'res.end 失败路径未留痕');
  assert.ok(SOURCE.includes('logDeviceStream(`stream closed ('), '缺少收尾日志');
  assert.ok(
    !/catch\s*\{\s*\/\*\s*client disconnected or stream ended/.test(SOURCE),
    '裸 catch 又回来了：断流在宿主日志里会变成无声',
  );
});

// 设备级流没有 Last-Event-ID 续传（App 只把帧当「有东西变了」的信号），所以连上时
// 必须把信号总线里**已经广播过**的最近值补一帧，否则断流窗口里的变更要等下一次
// 真实变更才被看见 —— 而这时兜底轮询已经被降到 60s。
//
// 注意：listSignal 是模块级单例且没有 reset，所以 bump 过的用例必须排在本文件最后
// （前面的用例都假设「连上时没有任何已知信号」）。
test('连上补发：一帧清单变更 + 每个已知会话一帧水位，且只读不 bump', async () => {
  assert.equal(sharedListSignal.bump('rev-replay-1'), true, 'bump 失败则本用例无意义');
  assert.equal(sharedSessionSignal.bump('s-replay', 42), true);

  const first = await streamWith([]);
  const payloads = first.events.map((event) => event.payload);
  const list = payloads.find((payload) => payload.type === 'device/list-changed');
  const activity = payloads.find((payload) => payload.type === 'device/session-activity');
  assert.ok(list, '重连后没有补发清单 revision');
  assert.equal(list.revision, 'rev-replay-1');
  assert.ok(list.at > 0);
  assert.ok(activity, '重连后没有补发正文水位');
  assert.equal(activity.sessionId, 's-replay');
  assert.equal(activity.seq, 42);

  // 补发只读快照：它不能变成一次新变更（否则每次重连都会推高一次水位）。
  assert.equal(sharedListSignal.snapshot().revision, 'rev-replay-1');
  assert.equal(sharedSessionSignal.peek('s-replay'), 42);

  // 帧形状与实时帧完全一致（App 不需要为补发做任何区分）。
  for (const event of first.events) {
    assert.equal(event.type, 'device/event');
    assert.equal(event.version, 1);
  }

  // 再连一次：同样的两帧，App 侧按 revision/seq 判重即可（幂等）。
  const second = await streamWith([]);
  const secondPayloads = second.events.map((event) => event.payload);
  assert.equal(secondPayloads.filter((payload) => payload.type === 'device/list-changed').length, 1);
  assert.equal(secondPayloads.filter((payload) => payload.type === 'device/session-activity').length, 1);
  assert.equal(sharedSessionSignal.peek('s-replay'), 42, '补发不许把水位往上推');
});

// 桌面侧栏折叠态：手机过去按 5 分钟最短间隔去问 GET /desktop-view（因为列表 revision
// 不含它）。这条帧让它改成「变了才拉」，所以断流重连后也必须补一帧 —— 否则那一次变化
// 落在断流窗口里就丢了，而 App 那边已经没有任何轮询会把它捡回来。
test('连上补发：桌面折叠态变了也要补一帧（只发 updatedAt，不发内容）', async () => {
  assert.equal(sharedDesktopViewSignal.bump(1_700_000_333_000), true, 'bump 失败则本用例无意义');

  const result = await streamWith([]);
  const viewFrames = result.events
    .map((event) => event.payload)
    .filter((payload) => payload.type === 'device/desktop-view-changed');
  assert.equal(viewFrames.length, 1, '重连后没有补发折叠态变更');
  assert.equal(viewFrames[0].updatedAt, 1_700_000_333_000);
  assert.ok(viewFrames[0].at > 0);
  // 帧只带版本号：内容仍然由 App 去 GET /desktop-view 取，这条流不做数据同步。
  assert.equal(viewFrames[0].groupExpansion, undefined);
  assert.equal(sharedDesktopViewSignal.snapshot().updatedAt, 1_700_000_333_000, '补发不许前移基准');
});

test('events.js 收尾必须注销折叠态订阅（源码契约）', () => {
  assert.ok(SOURCE.includes('unsubscribeDesktopView'), '订阅了却不出现在收尾里，句柄会一直挂在信号总线上');
  assert.ok(SOURCE.includes('unsubscribeDesktopView();'), '收尾没有调用注销');
});

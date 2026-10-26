'use strict';

/**
 * 回归：**没打开**那个会话时，它的正文水位变化也必须到达手机。
 *
 * 根因：正文流是按会话订阅的（`app/src/hooks/useChatStream.ts` 里唯一的 openSessionStream
 * 调用点），只有当前打开的会话才有实时正文；没打开的会话在中转镜像里其实已有 200 条正文
 * （lib/mirror/pusher.cjs 每轮为高优先会话构建），缺的只是「这份正文又长了，你可以来取」
 * 这一句通知。
 *
 * 本用例跑真链路：镜像推送调度器推成功 → lib/shared/session-signal.js 广播水位 →
 * handleDeviceStream 写出 device/session-activity 帧。水位取快照里**真正装上的消息的最大
 * seq**（不是快照 lastSeq 那种事件水位），与 App 会话缓存的水位口径一致，手机据此带 afterSeq
 * 增量拉。
 *
 * 单独成文件：device-list-signal 钉的是「清单变了」（全局 revision）；这条是按会话的消息
 * 水位，判重、广播时机与消费口径都不一样。device-events.test.cjs 走假 ctx 直喂
 * session/event，覆盖不到这里的广播时机（必须**先推镜像再广播**）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');
const { createSessionSignal, sessionSignal: sharedSessionSignal, MAX_TRACKED } = require('../lib/shared/session-signal.js');
const { handleDeviceStream } = require('../lib/mobile/events.js');

const SID = 'session-activity-1';

const flush = async (turns = 20) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * 轮询等待一个条件成立。
 *
 * 为什么不能只 `await flush()`：推送链上有多次真实 await（清单 → 正文 → 统计 → 模型），
 * 同一个文件里前一个用例的收尾（unsubscribe、clearInterval、在飞推送）还在跑时，固定
 * 轮数的 setImmediate 会偶发不够 —— 于是守卫变成「偶尔红」的噪声，而不是契约。
 */
const waitFor = async (predicate, turns = 300) => {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return Boolean(predicate());
};

/** 与宿主 sessions.list 同形的摘要：标题在 projections.values.title 里。 */
function mkItem({ sessionId = SID, running = true, updatedAt = Date.now() } = {}) {
  return {
    sessionId,
    cwd: '/ws/a',
    updatedAt,
    running,
    blank: false,
    projections: { values: { title: '跑着的会话' } },
  };
}

/** 一条能派生出行（含 seq）的助手消息事件。 */
function assistantEvent(seq) {
  return {
    event: {
      type: 'assistant/message',
      seq,
      time: 1000 + seq,
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: `回复 ${seq}` }] } },
    },
  };
}

/**
 * 可推的宿主事件源：镜像调度器的 mux 循环要能被「宿主又发了一条会话事件」驱动，
 * 否则只能等 500ms 的后台 tick —— 而那个 tick 对高优先会话一条都不推。
 *
 * 注意 waiters 是个集合：同一条隧道上会有**两个**消费者（镜像调度器的 mux 循环与
 * 设备级 SSE 的 mergeHostAndMux），只记一个 wake 会让另一个永远挂着。
 */
function pushableMux() {
  const queue = [];
  const waiters = new Set();
  let closed = false;
  const wakeAll = () => { for (const resolve of [...waiters]) resolve(); waiters.clear(); };
  return {
    push(frame) { queue.push(frame); wakeAll(); },
    close() { closed = true; wakeAll(); },
    mux: async function* () {
      while (!closed) {
        if (queue.length === 0) { await new Promise((resolve) => { waiters.add(resolve); }); continue; }
        yield queue.shift();
      }
    },
  };
}

/** 一帧都不发的宿主事件源；gate 打开（收尾）后正常结束。 */
function idleMux(gate) {
  return { mux: async function* () { await gate; } };
}

/** 最小假 ctx：只喂 buildSessionsResponse / 镜像旁路快照真正读的宿主调用。 */
function makeCtx(state, events) {
  const passthrough = (overrides) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop];
      return async () => ({ result: { ok: true, value: {} } });
    },
  });
  return {
    apiProxy: {
      sessions: passthrough({
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: state.events } } }),
        projections: async () => ({ result: { ok: true, value: { values: {} } } }),
      }),
      workspace: passthrough({
        list: async () => ({
          result: {
            ok: true,
            value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds: [] },
          },
        }),
      }),
      // 两条流按 rpcId 分流：镜像调度器那条要能推，设备级那条一帧都不发（0.2.0 兼容桥的形状）。
      events: {
        mux: (request) => (request && request.rpcId === 'dsh-mirror-sync' ? events.mirror(request) : events.other(request)),
      },
    },
  };
}

/** 可控的假响应，带最小的事件监听器表（handleDeviceStream 会挂 'error'）。 */
function response() {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    ended: false,
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
  };
}

function request() {
  const req = new EventEmitter();
  req.url = '/api/mobile/v1/events/stream';
  req.headers = {};
  return req;
}

/** 从 SSE chunk 里取出所有 `data:` 行的 JSON（设备级信封）。 */
function framesFrom(res) {
  const out = [];
  for (const chunk of res.chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6).trim()));
    }
  }
  return out;
}

const payloadsOf = (res) => framesFrom(res).map((frame) => frame && frame.payload).filter(Boolean);
const activityOf = (res) => payloadsOf(res).filter((payload) => payload.type === 'device/session-activity');

/**
 * 数「这条流注册了几个水位订阅者」。
 *
 * A3-05 的坑之一就是收尾漏注销：漏了之后推送调度器永远以为有人在听，隧道断着也照常
 * 每 500ms 构建快照。bump 的幂等判重让「漏没漏」从帧上完全看不出来，只能直接数订阅者。
 */
function countSubscribers(signal) {
  const real = signal.onBump.bind(signal);
  let live = 0;
  signal.onBump = (fn) => {
    const release = real(fn);
    live += 1;
    let done = false;
    return () => { if (done) return; done = true; live -= 1; release(); };
  };
  return {
    get live() { return live; },
    restore() { signal.onBump = real; },
  };
}

/** 把 setInterval/clearInterval 换成可手动触发的桩。 */
function harness() {
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  return {
    intervals,
    tick(ms) {
      const handle = intervals.find((entry) => entry.ms === ms);
      assert.ok(handle, `没有找到 ${ms}ms 的定时器`);
      handle.fn();
      return handle;
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

test('正文水位经镜像推送广播到设备级 SSE（先推镜像再广播，且不因空转重复广播）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-activity-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // 空列表守卫会落盘，别污染真实 ~/.dsh

  const h = harness();
  const counter = countSubscribers(sharedSessionSignal);
  sharedSessionSignal.reset();
  const state = { items: [mkItem()], events: [assistantEvent(7)] };
  const ctl = pushableMux();
  let openGate = () => {};
  const gate = new Promise((resolve) => { openGate = resolve; });
  const ctx = makeCtx(state, { mirror: ctl.mux, other: idleMux(gate).mux });
  const pushed = [];
  const pusher = createMirrorPusher({
    ctx,
    tunnelConnected: () => true,
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
  });

  const res = response();
  const req = request();
  const pending = handleDeviceStream(ctx, req, res);
  await flush();
  assert.equal(counter.live, 1, 'SSE 一连上就必须订阅正文水位总线');

  const stop = pusher.start();
  try {
    // 用 waitFor 而不是固定轮数：推送链上有多层 await，够不够轮完全取决于这轮的事件
    // 循环，机器快慢不同结果就不同（2026-10-23 在 GitHub 的 Linux runner 上稳定红，
    // 本机连跑五遍全绿）。这里等的是「启动首推真的发生了」，不是「过了若干拍」。
    await waitFor(() => pushed.length >= 1);
    assert.ok(pushed.length >= 1, '运行中的会话必须在启动首推里带上正文快照');

    const first = activityOf(res);
    assert.equal(first.length, 1, '推成功后必须广播且只广播一次正文水位');
    assert.equal(first[0].sessionId, SID);
    assert.equal(first[0].seq, 7, '水位必须取快照里真正装上的消息的最大 seq');
    assert.ok(Number.isFinite(first[0].at) && first[0].at > 0, '水位帧必须带时间戳');

    // 内容没变的后台 tick：高优先会话一条都不推，因此不该再广播（否则变成 500ms 一次的假变更）。
    h.tick(500);
    await flush();
    assert.equal(activityOf(res).length, 1, '内容没变却又广播了一次正文水位');

    // 宿主又落了一条消息：会话事件驱动立即推送，水位必须跟着前移。
    state.events = [assistantEvent(7), assistantEvent(9)];
    ctl.push({ type: 'session/event', sessionId: SID, payload: { sessionId: SID, event: { type: 'assistant/message', seq: 9 } } });
    await waitFor(() => activityOf(res).length >= 2);
    const frames = activityOf(res);
    assert.equal(frames.length, 2, '新消息落盘后没有把新水位说给手机听');
    assert.equal(frames[1].seq, 9);
    assert.equal(sharedSessionSignal.peek(SID), 9);

    // 水位只增不减：同一份快照再推一次（指纹相同会被上层跳过，这里直接验总线语义）。
    assert.equal(sharedSessionSignal.bump(SID, 9), false, '同一水位重复广播会变成刷新风暴');

    // 完整清单确认会话已归档/删除后，pusher 应从重连回放集合中移除该会话。
    state.items = [];
    h.tick(500);
    await waitFor(() => sharedSessionSignal.peek(SID) === 0);
    assert.equal(sharedSessionSignal.peek(SID), 0, '归档会话的旧水位不应在重连时复活');
  } finally {
    stop();
    // 客户端断开（RN 侧切页面 / 重建连接）：流必须收尾并注销水位订阅者。
    req.emit('close');
    ctl.close();
    openGate();
    await flush();
    if (pending && typeof pending.then === 'function') await pending.catch(() => {});
    assert.equal(res.ended, true, '客户端断开后必须结束响应');
    assert.equal(counter.live, 0, '收尾没注销水位订阅者，推送调度器会永远以为有人在听');
    counter.restore();
    h.restore();
    sharedSessionSignal.reset();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

/**
 * 回归：隧道断着（或本来就是纯局域网模式，手机直接读本进程）时，正文水位一帧都不发。
 *
 * 现场：水位广播曾经挂在 `pushMirrorPayload` 的**成功分支**上，而那个函数第一步就是
 * 「隧道没连 → 记账后 return」。于是只要没走中转（局域网直连、或中转暂时不可用），
 * device/session-activity 这条通道就是死的：没打开的会话在手机上永远停在旧正文，
 * 只能等 60s 兜底轮询或用户点进去。可水位是**本机事实**（快照里装到第几条），
 * 与「镜像有没有推进中转」无关 —— 局域网读取是本地读，顺序天然满足「先落地后广播」。
 */
test('隧道断开/局域网模式：正文水位照样广播，且不往 sidecar 推镜像', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-activity-lan-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const h = harness();
  sharedSessionSignal.reset();
  const state = { items: [mkItem()], events: [assistantEvent(7)] };
  const ctl = pushableMux();
  let openGate = () => {};
  const gate = new Promise((resolve) => { openGate = resolve; });
  const ctx = makeCtx(state, { mirror: ctl.mux, other: idleMux(gate).mux });
  const pushed = [];
  const pusher = createMirrorPusher({
    ctx,
    // 局域网模式：宿主没连中转，pushMirrorPayload 会在推送前短路。
    tunnelConnected: () => false,
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
  });

  const res = response();
  const req = request();
  const pending = handleDeviceStream(ctx, req, res);
  await flush();

  const stop = pusher.start();
  try {
    // 等「首推把水位说出去」这件事真的发生，而不是赌固定轮数的 flush 够不够
    // （同一个文件里前面的用例还在收尾时，固定轮数会偶发不够）。
    assert.ok(await waitFor(() => activityOf(res).length >= 1), '首推之后没广播正文水位');
    assert.equal(pushed.length, 0, '隧道断着不该往 sidecar 推镜像');
    const first = activityOf(res);
    assert.equal(first[0].sessionId, SID);
    assert.equal(first[0].seq, 7);

    // 又落一条消息：水位跟着前移，仍然不推送。
    state.events = [assistantEvent(7), assistantEvent(9)];
    await new Promise((r) => setTimeout(r, 3));
    ctl.push({ type: 'session/event', sessionId: SID, payload: { sessionId: SID, event: { type: 'assistant/message', seq: 9 } } });
    assert.ok(await waitFor(() => activityOf(res).length >= 2), '局域网模式下新消息的水位必须补上');
    assert.equal(pushed.length, 0, '局域网模式下永远不该出现 pushSync 调用');
    assert.equal(activityOf(res)[1].seq, 9);

    // 空转 tick 不许重复广播（幂等靠水位单调，不靠推送成功）。
    h.tick(500);
    await flush();
    assert.equal(activityOf(res).length, 2, '内容没变却又广播了一次正文水位');
  } finally {
    stop();
    req.emit('close');
    ctl.close();
    openGate();
    await flush();
    if (pending && typeof pending.then === 'function') await pending.catch(() => {});
    h.restore();
    sharedSessionSignal.reset();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('水位总线：按会话判重、当前集合完整保留、非当前超限淘汰最早项', () => {
  const signal = createSessionSignal();
  const seen = [];
  const release = signal.onBump((event) => seen.push(event));

  assert.equal(signal.bump('a', 5), true);
  assert.equal(signal.bump('a', 5), false, '同一水位必须幂等');
  assert.equal(signal.bump('a', 4), false, '水位不许回退');
  assert.equal(signal.bump('a', 6), true);
  assert.equal(signal.bump('', 6), false, '空 sessionId 不是一次水位变化');
  assert.equal(signal.bump('b', 0), false);
  assert.equal(signal.bump('b', Number.NaN), false);
  assert.deepEqual(seen.map((event) => [event.sessionId, event.seq]), [['a', 5], ['a', 6]]);
  assert.equal(signal.peek('a'), 6);
  assert.equal(signal.peek('missing'), 0);
  assert.deepEqual(signal.snapshot(), { a: 6 });

  // 订阅者抛错不能把广播拖垮（调用方是镜像推送链）。
  const throwing = signal.onBump(() => { throw new Error('boom'); });
  assert.equal(signal.bump('c', 1), true, '一个订阅者抛错不该让整次广播失败');
  throwing();

  release();
  const beforeRelease = seen.length;
  assert.equal(signal.bump('a', 7), true, '退订之后水位照样前移，只是没人听');
  assert.equal(seen.length, beforeRelease, '退订后不该再收到回调');

  // 长跑插件见过成千上万个会话：水位表必须有上界，且淘汰不会误删刚更新的那条。
  for (let i = 0; i <= MAX_TRACKED; i += 1) signal.bump(`s-${i}`, 1);
  assert.equal(Object.keys(signal.snapshot()).length, MAX_TRACKED, '水位表必须被限制在上界内');
  assert.equal(signal.peek(`s-${MAX_TRACKED}`), 1, '刚广播的会话水位不能被淘汰');

  signal.reset();
  const currentIds = Array.from({ length: MAX_TRACKED + 16 }, (_, index) => `current-${index}`);
  signal.retain(currentIds);
  for (const id of currentIds) signal.bump(id, 1);
  assert.equal(Object.keys(signal.snapshot()).length, currentIds.length, '完整清单中的当前会话不受非当前LRU上限影响');
  assert.equal(signal.peek(currentIds[0]), 1, '超过512的当前会话水位仍可重连回放');
  signal.retain(currentIds.slice(16));
  assert.equal(signal.peek(currentIds[0]), 0, '权威清单移除的会话水位被清掉');
  assert.equal(Object.keys(signal.snapshot()).length, MAX_TRACKED, '移除前16个当前会话后保留其余完整水位');

  signal.reset();
  assert.deepEqual(signal.snapshot(), {});
});

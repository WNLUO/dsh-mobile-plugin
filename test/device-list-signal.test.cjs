'use strict';

/**
 * 回归：设备级 SSE「连着却一句话都不说」——会话状态变化到不了手机侧栏。
 *
 * 根因（两侧叠加）：插件侧这条流的帧源只有宿主的 mux/host 事件，而宿主的 0.2.0 兼容桥只
 * 订阅了 workspace/follow + session/control —— 会话状态变化表现为 session/projection，被
 * lib/mobile/events.js 的 listRelevantPayload 白名单丢掉；App 侧只要流 open 就把兜底轮询从
 * 15s 降到 60s。于是「流连着」被当成了「数据新鲜」，实际一个变化都传不过来。
 *
 * 本用例跑真链路：镜像推送调度器（lib/mirror/pusher.cjs）每 500ms 比一次会话清单的内容
 * 指纹 → lib/shared/list-signal.js 广播 → handleDeviceStream 写出 device/list-changed 帧 →
 * 手机立刻重拉列表。
 *
 * 单独成文件：device-events.test.cjs 用假 ctx 直接把 session/event 喂进 handleDeviceStream，
 * 绕开了宿主合成路径（那正是失效所在），也没有用例驱动过推送调度器的清单指纹判定。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');
const { listSignal: sharedListSignal } = require('../lib/shared/list-signal.js');
const { handleDeviceStream } = require('../lib/mobile/events.js');

const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** 与宿主 sessions.list 同形的摘要：标题在 projections.values.title 里（顶层 title 会被 listTitle 忽略）。 */
function mkItem({ sessionId, title, running, updatedAt }) {
  return {
    sessionId,
    cwd: '/ws/a',
    updatedAt,
    running,
    blank: false,
    projections: { values: { title } },
  };
}

/** 可控的事件源：一直挂住，直到 release() —— 模拟「设备级流开着但宿主一帧都没有」。 */
function controllableMux() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { release, mux: async function* () { await gate; } };
}

/**
 * 用 Proxy 补齐「本用例不关心」的宿主方法：镜像推送的旁路快照（warm messages / stats /
 * models）会去读别的 sessions.* 方法，缺一个就抛 TypeError 并在 stderr 留一条噪音。
 * 默认返回空值即可 —— 清单指纹这条路只读 list。
 */
function hostApi(overrides) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop];
      return async () => ({ result: { ok: true, value: {} } });
    },
  });
}

/** 最小假 ctx：只喂 buildSessionsResponse 真正读的宿主调用（list / history / workspace.list）。 */
function makeCtx(state, mux = async function* () { await new Promise(() => {}); }) {
  return {
    apiProxy: {
      sessions: hostApi({
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        projections: async () => ({ result: { ok: true, value: { values: {} } } }),
      }),
      workspace: hostApi({
        list: async () => ({
          result: {
            ok: true,
            value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds: [] },
          },
        }),
      }),
      // 设备级流在这里只挂住：宿主合成路径（0.2.0 桥）本来就发不出会话状态变化。
      events: { mux },
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

/** 把 setInterval/clearInterval 换成可手动触发的桩：推送调度器的 500ms tick 必须能手动点火。 */
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

test('会话清单变化经变更信号总线送到手机那条设备级 SSE 连接上', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-signal-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // 空列表守卫会落盘，别污染真实 ~/.dsh

  const h = harness();
  const state = {
    items: [mkItem({ sessionId: 'session-1', title: '跑着的会话', running: true, updatedAt: Date.now() })],
  };
  const ctl = controllableMux();
  const ctx = makeCtx(state, ctl.mux);
  const pushed = [];
  const pusher = createMirrorPusher({
    ctx,
    // 隧道断着（手机走局域网直连本进程）：镜像推不出去，但「清单变了」照样要说给手机听。
    tunnelConnected: () => false,
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
  });

  const res = response();
  const req = request();
  const pending = handleDeviceStream(ctx, req, res);
  await flush();
  assert.equal(sharedListSignal.watching(), true, 'SSE 一连上就必须让推送调度器知道有人在听，否则它 500ms 的空转会被早退掉');

  const stop = pusher.start();
  try {
    await flush();
    // 兜底轮询也会看到这条变化，但那是「最多 60 秒后」的事；这里要的是变更信号先到。
    res.chunks.length = 0;
    h.tick(500);
    await flush();

    const first = payloadsOf(res).find((payload) => payload.type === 'device/list-changed');
    assert.ok(first, '会话状态变了，设备级流必须推出一条 device/list-changed，否则手机只能等兜底轮询');
    assert.equal(typeof first.revision, 'string');
    assert.ok(first.revision.length > 0, '变更信号必须带上清单指纹，App 用它跳过没必要的重拉');

    // 清单内容没变时不许再广播（500ms 一次的空转不能变成 500ms 一次的刷新风暴）。
    const before = payloadsOf(res).filter((payload) => payload.type === 'device/list-changed').length;
    h.tick(500);
    await flush();
    const after = payloadsOf(res).filter((payload) => payload.type === 'device/list-changed').length;
    assert.equal(after, before, '清单内容没变却又广播了一次');

    // 会话跑完（running → completed 的方向），指纹必须变、广播必须再来一次。
    state.items = [mkItem({ sessionId: 'session-1', title: '跑完的会话', running: false, updatedAt: Date.now() + 1000 })];
    h.tick(500);
    await flush();
    const frames = payloadsOf(res).filter((payload) => payload.type === 'device/list-changed');
    assert.equal(frames.length, before + 1, '会话跑完这件事没有到达手机');
    assert.notEqual(frames[frames.length - 1].revision, first.revision, '两次广播的指纹相同，App 会把它当成同一次变更');
    assert.equal(pushed.length, 0, '隧道断着的时候不该往 sidecar 推镜像');

    // 心跳：App 只有「最近真的收到过帧」才敢把兜底轮询降频，所以心跳必须是数据帧。
    h.tick(15_000);
    await flush();
    const heartbeat = payloadsOf(res).find((payload) => payload.type === 'device/heartbeat');
    assert.ok(heartbeat, '设备级流必须发数据帧心跳，注释帧 App 看不见');
    assert.ok(Number.isFinite(heartbeat.at) && heartbeat.at > 0, '心跳必须带时间戳');
  } finally {
    stop();
    h.restore();
    ctl.release();
    await flush();
    if (pending && typeof pending.then === 'function') await pending.catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('设备级 SSE 收尾时必须注销变更信号的观众', async () => {
  const h = harness();
  const ctl = controllableMux();
  try {
    const res = response();
    const req = request();
    const pending = handleDeviceStream(makeCtx({ items: [] }, ctl.mux), req, res);
    await flush();
    assert.equal(sharedListSignal.watching(), true);
    // 客户端断开（RN 侧切页面/重建连接）：流必须收尾，否则调度器永远以为有人在听。
    req.emit('close');
    ctl.release();
    await pending;
    assert.equal(res.ended, true, '客户端断开后必须结束响应');
    assert.equal(sharedListSignal.watching(), false, '收尾没注销观众，推送调度器会一直空转构建');
    const keepAlive = h.intervals.find((entry) => entry.ms === 15_000);
    assert.ok(keepAlive, '设备级 SSE 必须装 15s 心跳定时器');
    assert.equal(keepAlive.cleared, true, '收尾必须清掉心跳定时器');
  } finally {
    h.restore();
  }
});

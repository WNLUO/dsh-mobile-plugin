// 清单独立先推；慢正文、重试与迟到确认共用真实调度行为及内存变异断言。
'use strict';

/**
 * 回归：后台 500ms 的镜像 tick 在「什么都没变」时还在整轮重建冷会话快照。
 *
 * 每一轮都要为一个冷会话拉 200 条消息正文 —— `lib/mobile/session-mirror.js` 的 2 分钟缓存
 * 要求指纹里的 updatedAt 一致，而 `lib/mirror/pusher.cjs` 的 buildSessionData 传的是合成
 * summary（updatedAt = Date.now()），指纹每轮都不同 ⇒ **缓存永远命中不了**；接着统计投影
 * （无缓存）、模型目录，最后算指纹时又常常因为内容逐字段相同被判重跳过：白烧宿主 CPU / 内存，
 * 一份镜像都没多推出去。
 *
 * 修法：清单与工作区的 revision 都没变、又没到轮转窗口时，这一轮到此为止
 * （BG_COLD_ROTATE_MIN_INTERVAL_MS = 5s）；一变就照旧立刻重建（App「最多旧 500ms」的新鲜度
 * 契约分毫不动）。冷会话按定义（没在跑、5 分钟没动过）正文不可能变，轮转退到 5s 只剩
 * 「补热还没热身的冷会话」和「让 pushedAt 继续走」两个作用。
 *
 * 本用例用假 ctx 数宿主调用次数，钉死三件事：没变就不许重建、变了必须 500ms 内重推、
 * 轮转窗口到点仍然要跑（pushedAt 不能冻结）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mobileSessions = require('../lib/mobile/sessions.js');
const { createListSignal } = require('../lib/shared/list-signal.js');
const { createSessionSignal } = require('../lib/shared/session-signal.js');

const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');
const { MIRROR_SNAPSHOT_TTL_MS } = require('../lib/mirror-snapshot.cjs');

const PLUGIN_ROOT = path.join(__dirname, '..');

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

/** 冷会话：没在跑、10 分钟没动过 —— isHighPriority 之外，正文按定义不会变。 */
const coldItem = (sessionId, title) => mkItem({
  sessionId,
  title,
  running: false,
  updatedAt: Date.now() - 10 * 60 * 1000,
});

/** 把 setInterval/clearInterval 换成可手动点火的桩：500ms tick 必须能手动跑一轮。 */
function harness() {
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; };
  global.clearInterval = (handle) => { if (handle) handle.cleared = true; };
  return {
    intervals,
    tick(ms = 500) {
      const handle = intervals.find((entry) => entry.ms === ms);
      assert.ok(handle, `没有找到 ${ms}ms 的定时器`);
      handle.fn();
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

/**
 * 假 ctx：记下每一扇宿主门的调用次数（sessions.list / sessions.history /
 * sessions.projections / workspace.list …）。计数比断言耗时可靠，也不依赖宿主的真实开销。
 */
function countingCtx(state, calls) {
  const wrap = (ns, impl) => new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return target[prop];
      const fn = prop in target ? target[prop] : async () => ({ result: { ok: true, value: {} } });
      return async (...args) => {
        const key = `${ns}.${prop}`;
        calls[key] = (calls[key] || 0) + 1;
        return fn(...args);
      };
    },
  });
  return {
    apiProxy: {
      sessions: wrap('sessions', {
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        projections: async () => ({ result: { ok: true, value: { values: {} } } }),
      }),
      workspace: wrap('workspace', {
        list: async () => ({
          result: {
            ok: true,
            value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: state.workspaceTitle || 'a', sessionIds: [] }], archivedSessionIds: [] },
          },
        }),
      }),
      // 事件流由测试自己往里推帧（emit）：清单「变没变」现在由它说了算，
      // 后台 tick 只在收到帧之后才重扫目录。
      events: { mux: (payload, signal) => state.stream(payload, signal) },
    },
  };
}

/** 把 Date.now 推快 ms：轮转窗口那 5s 不必真等。fn 里可以 await（tick 是异步的，必须等完再还原）。 */
async function withClockOffset(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

async function withPusher(run, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-tick-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // 空清单守卫会落盘，别污染真实 ~/.dsh
  const h = harness();
  const calls = {};
  const pushed = [];
  const state = {
    items: [
      mkItem({ sessionId: 'session-run', title: '跑着的会话', running: true, updatedAt: Date.now() }),
      coldItem('session-cold-1', '冷会话一'),
      coldItem('session-cold-2', '冷会话二'),
    ],
    // 事件流：测试用 emit() 往里推一帧宿主事件，模拟「清单可能变了」。
    queue: [],
    emit(frame) { state.queue.push(frame); },
    async *stream(_payload, signal) {
      for (;;) {
        if (signal && signal.aborted) return;
        if (state.queue.length) { yield state.queue.shift(); continue; }
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
  if (options.items) state.items = options.items;
  const ctx = countingCtx(state, calls);
  const listSignal = createListSignal();
  const sessionSignal = createSessionSignal();
  const sidecar = { fail: false, send: null };
  const announcements = [];
  listSignal.onBump(event => announcements.push(event.revision));
  const pusher = (options.createMirrorPusher || createMirrorPusher)({
    ctx,
    tunnelConnected: () => options.online !== false,
    getSidecar: () => ({ pushSync: async (payload) => {
      if (sidecar.fail) throw new Error('sidecar test failure');
      pushed.push(payload);
      if (sidecar.send) await sidecar.send(payload);
    } }),
    listSignal,
    sessionSignal,
  });
  const stop = pusher.start();
  try {
    await flush();
    return await run({ h, calls, pushed, state, pusher, ctx, listSignal, announcements, sidecar });
  } finally {
    stop();
    h.restore();
    await flush();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

const callsOf = (calls, name) => calls[name] || 0;
/** 冷会话正文那一趟真去宿主要数据的调用（buildMessagesSnapshot 走 sessions.history）。 */
const rebuilds = (calls) => callsOf(calls, 'sessions.history');
/** 统计投影（无缓存，每轮都会真打一次 sessions.projections）。 */
const projections = (calls) => callsOf(calls, 'sessions.projections');

test('清单与工作区都没变时，500ms tick 不再重建冷会话快照', async () => {
  await withPusher(async ({ h, calls, pushed, pusher }) => {
    // 第一轮：基准还是空的（lastPushedListRevision = ''），门必须开着，整轮重建并推送。
    h.tick();
    await flush();
    const baseline = { rebuilds: rebuilds(calls), projections: projections(calls), pushes: pushed.length };
    assert.ok(baseline.rebuilds > 0, '第一轮就该真的去拿冷会话正文，门不该把首轮也挡掉');
    assert.ok(baseline.pushes > 0, '第一轮清单与基准不同，必须推一份镜像出去');

    // 内容一点没变：接下来 8 轮（= 4s，还在轮转窗口内）不许再碰宿主的正文/统计。
    for (let i = 0; i < 8; i += 1) {
      h.tick();
      await flush();
    }
    assert.equal(
      rebuilds(calls),
      baseline.rebuilds,
      '清单与工作区都没变，却还在每 500ms 重建一次冷会话的 200 条正文（缓存永远命中不了，等于白烧宿主）',
    );
    assert.equal(projections(calls), baseline.projections, '清单没变还在每 500ms 打一次统计投影');
    assert.equal(pushed.length, baseline.pushes, '清单没变还在重复推送镜像');
  });
});

test('宿主说变了（会话事件）就必须在下一轮（500ms 内）重建并重推：新鲜度契约不能被节流打破', async () => {
  await withPusher(async ({ h, calls, pushed, state }) => {
    h.tick();
    await flush();
    const before = { rebuilds: rebuilds(calls), pushes: pushed.length };

    // 跑着的会话收到新消息：宿主会发一帧会话事件，清单与正文都该更新。
    // 「变没变」现在由事件流说了算 —— 没有这一帧时 tick 不会再每轮盲目重扫目录。
    state.items[0] = mkItem({ sessionId: 'session-run', title: '跑着的会话', running: true, updatedAt: Date.now() + 1000 });
    state.emit({ payload: { type: 'session/event', sessionId: 'session-run', event: { type: 'turn/start' } } });
    await flush();
    h.tick();
    await flush();

    assert.ok(rebuilds(calls) > before.rebuilds, '清单变了却没重建会话正文');
    assert.ok(pushed.length > before.pushes, '清单变了却没有在 500ms 内把新镜像推进中转');
    const listOnly = pushed.slice(before.pushes).filter(payload => Object.keys(payload.messages).length === 0);
    assert.equal(listOnly.length, 1, '清单独立推进只应新增一份，正文另行补齐');
    const last = pushed[pushed.length - 1];
    assert.equal(last.kind, 'sync');
    assert.ok(last.sessions && typeof last.sessions.revision === 'string' && last.sessions.revision.length > 0, '推送体必须带清单 revision');
  });
});

test('宿主什么都没说时，不许每 500ms 重扫一遍会话目录', async () => {
  await withPusher(async ({ h, calls }) => {
    h.tick();
    await flush();
    const baseline = { list: callsOf(calls, 'sessions.list'), ws: callsOf(calls, 'workspace.list') };
    // 20 轮 = 10 秒，这段时间里一条宿主事件都没有：清单一次都不该重扫。
    // 会话目录扫描是「列目录 + 每个会话开文件解压读头部」，1800 条的机器上一百多毫秒，
    // 半秒一次就是不管有没有人变都在烧 CPU。兜底窗是 5s，所以 10 秒里允许最多一次。
    for (let i = 0; i < 20; i += 1) {
      h.tick();
      await flush();
    }
    assert.ok(
      callsOf(calls, 'sessions.list') - baseline.list <= 1,
      `没有宿主事件却重扫了 ${callsOf(calls, 'sessions.list') - baseline.list} 次会话目录（兜底窗 5s 内最多一次）`,
    );
  });
});

test('持续500ms tick不续期清单缓存，5秒兜底仍会重建', async () => {
  await withPusher(async ({ h, calls }) => {
    h.tick(); await flush();
    const baseline = callsOf(calls, 'sessions.list');
    const realNow = Date.now;
    const start = realNow();
    try {
      for (let i = 1; i <= 9; i += 1) {
        Date.now = () => start + i * 500;
        h.tick(); await flush();
      }
      assert.equal(callsOf(calls, 'sessions.list'), baseline, '5秒窗内不应重复扫目录');
      Date.now = () => start + 5100;
      h.tick(); await flush();
      assert.equal(callsOf(calls, 'sessions.list'), baseline + 1, '缓存复用不能延后5秒重建期限');
    } finally { Date.now = realNow; }
  });
});

test('轮转窗口到点后仍然要跑一轮：pushedAt 不能被节流弄哑', async () => {
  await withPusher(async ({ h, calls, pusher }) => {
    h.tick();
    await flush();
    const baseline = { rebuilds: rebuilds(calls), pushedAt: pusher.getMirrorPush().pushedAt };
    assert.ok(baseline.pushedAt > 0, '镜像推送状态必须已经记过一次');

    // 内容没变、窗口没到：既不重建，也不该刷新 pushedAt（否则等于没节流）。
    h.tick();
    await flush();
    assert.equal(rebuilds(calls), baseline.rebuilds, '窗口内不该重建');
    assert.equal(pusher.getMirrorPush().pushedAt, baseline.pushedAt, '窗口内不该再记账');

    // 钟推快 5.1s：轮转窗口到点，即使内容一个字都没变也要跑一轮。
    // pushedAt 是运维与 App 判断「镜像是否还在更新」的唯一抓手（见 A3-14），
    // 节流不能把它弄成一潭死水。
    await withClockOffset(5100, async () => {
      h.tick();
      await flush();
    });
    assert.ok(rebuilds(calls) > baseline.rebuilds, '过了轮转窗口却没再跑一轮冷会话轮转');
    assert.ok(pusher.getMirrorPush().pushedAt > baseline.pushedAt, '轮转到点后必须刷新 pushedAt，否则状态面板看不出镜像还活着');
  });
});

function gate() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release };
}

function pusherWithMutation(before, after) {
  const filename = path.join(PLUGIN_ROOT, 'lib', 'mirror', 'pusher.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  assert.equal(source.split(before).length, 2, '变异必须命中唯一生产逻辑');
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(source.replace(before, after), filename);
  return instance.exports.createMirrorPusher;
}

async function assertListBeforeBody(create = createMirrorPusher) {
  const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
  const cold = gate();
  let coldStarted = false;
  mobileSessions.buildMirrorWarmSnapshots = async (...args) => {
    if (args[2] === 'session-cold-1') { coldStarted = true; await cold.pending; }
    return originalBuild(...args);
  };
  try {
    await withPusher(async ({ h, pushed, state, listSignal, announcements }) => {
      try {
        h.tick();
        await flush();
        assert.equal(coldStarted, true, '应当真的挂住冷正文构建');
        const before = pushed.length;
        state.items = [...state.items, mkItem({ sessionId: 'desktop-new', title: '桌面新会话', running: true, updatedAt: Date.now() })];
        await withClockOffset(5100, async () => { h.tick(); await flush(); });
        const latest = pushed.at(-1);
        assert.ok(pushed.length > before && latest.sessions.items.some(row => row.sessionId === 'desktop-new'), '冷正文未结束时，新清单也必须完成推送');
        assert.equal(listSignal.snapshot().revision, latest.sessions.revision, '只在新清单成功后广播对应版本');
        const revision = latest.sessions.revision;
        cold.release();
        await flush();
        assert.equal(pushed.at(-1).sessions.revision, revision, '迟到冷正文必须换挂最新清单');
        assert.equal(listSignal.snapshot().revision, revision, '迟到正文不许倒推变更信号');
        assert.equal(announcements.at(-1), revision);
      } finally { cold.release(); await flush(); }
    }, { createMirrorPusher: create });
  } finally { mobileSessions.buildMirrorWarmSnapshots = originalBuild; }
}

test('冷正文常驻不占清单轮次，迟到正文换挂新清单', async () => {
  await assertListBeforeBody();
});

async function assertEventBeforeBody(create = createMirrorPusher) {
  await withPusher(async ({ h, state, pushed, pusher }) => {
    const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
    const body = gate();
    let started = false;
    mobileSessions.buildMirrorWarmSnapshots = async (...args) => {
      if (args[2] === 'session-run') { started = true; await body.pending; }
      return originalBuild(...args);
    };
    try {
      const task = pusher.pushSessionImmediately('session-run');
      await flush();
      assert.equal(started, true, '事件正文应当挂在真实构建槽里');
      state.items[0] = { ...state.items[0], projections: { values: { title: '正文未完时改名' } } };
      state.emit({ payload: { type: 'session/projection', sessionId: 'session-run', values: { title: '正文未完时改名' } } });
      await flush();
      h.tick(); await flush();
      assert.equal(pushed.at(-1).sessions.items.find(row => row.sessionId === 'session-run').title, '正文未完时改名', '同会话正文未结束时，projection仍必须在下一tick推进清单');
      body.release();
      await task;
      await flush();
    } finally { body.release(); mobileSessions.buildMirrorWarmSnapshots = originalBuild; await flush(); }
  }, { createMirrorPusher: create });
}

test('同会话事件正文未结束时，projection仍在下一tick推进清单', async () => {
  await assertEventBeforeBody();
});

test('清单读取途中收到的新事件不会被旧在途list合流吞掉', async () => {
  await withPusher(async ({ h, state, pushed, ctx }) => {
    const originalList = ctx.apiProxy.sessions.list;
    const reading = gate();
    let started = false;
    ctx.apiProxy.sessions.list = async (...args) => {
      const snapshot = { result: { ok: true, value: { items: state.items.slice() } } };
      if (!started) { started = true; await reading.pending; }
      return snapshot;
    };
    try {
      state.items = [...state.items, mkItem({ sessionId: 'during-first-read', title: '先建', running: true, updatedAt: Date.now() })];
      state.emit({ payload: { type: 'session/projection', sessionId: 'session-run', values: {} } });
      await flush();
      assert.equal(started, true);
      state.items = [...state.items, mkItem({ sessionId: 'during-held-read', title: '读途中再建', running: true, updatedAt: Date.now() })];
      state.emit({ payload: { type: 'session/projection', sessionId: 'session-run', values: {} } });
      await flush();
      h.tick(); await flush();
      reading.release(); await flush(30);
      assert.ok(pushed.at(-1).sessions.items.some(row => row.sessionId === 'during-held-read'), '新事件必须促成旧读完成后的新list，不能退回等5秒兜底');
    } finally { reading.release(); ctx.apiProxy.sessions.list = originalList; await flush(); }
  });
});

test('全部近期活跃时仍独立推清单，失败不广播且下一tick补推', async () => {
  await withPusher(async ({ h, state, pushed, sidecar, listSignal }) => {
    const previous = listSignal.snapshot().revision;
    state.items = [...state.items, mkItem({ sessionId: 'new-hot', title: '新的活跃会话', running: true, updatedAt: Date.now() })];
    sidecar.fail = true;
    await withClockOffset(5100, async () => { h.tick(); await flush(); });
    assert.equal(listSignal.snapshot().revision, previous, '清单未推成功绝不能先广播');
    const before = pushed.length;
    sidecar.fail = false;
    h.tick();
    await flush();
    assert.ok(pushed.length > before, '所有会话都高优先也必须实际推清单');
    assert.ok(pushed.at(-1).sessions.items.some(row => row.sessionId === 'new-hot'));
    assert.equal(listSignal.snapshot().revision, pushed.at(-1).sessions.revision);
  }, { items: [mkItem({ sessionId: 'hot', title: '活跃会话', running: true, updatedAt: Date.now() })] });
});

test('工作区单独变化也独立推送且不重复发清单', async () => {
  await withPusher(async ({ h, state, pushed, listSignal }) => {
    const previous = listSignal.workspaceSnapshot().revision;
    const before = pushed.length;
    state.workspaceTitle = '工作区新名字';
    state.emit({ payload: { type: 'host/workspace' } });
    await flush();
    h.tick(); await flush();
    assert.ok(pushed.length > before);
    assert.equal(pushed.at(-1).workspaces.items[0].title, '工作区新名字');
    assert.notEqual(listSignal.workspaceSnapshot().revision, previous);
    const settled = pushed.length;
    h.tick(); await flush();
    assert.equal(pushed.length, settled, '工作区未再变化不重复发清单');
  });
});

async function assertAckOrder(create = createMirrorPusher) {
  await withPusher(async ({ h, state, pushed, sidecar, listSignal }) => {
    const oldAck = gate();
    const previous = listSignal.snapshot().revision;
    let held = false;
    sidecar.send = async () => { if (!held) { held = true; await oldAck.pending; } };
    state.items = [...state.items, mkItem({ sessionId: 'first', title: '先建', running: true, updatedAt: Date.now() })];
    try {
      await withClockOffset(5100, async () => { h.tick(); await flush(); });
      assert.equal(held, true);
      assert.equal(listSignal.snapshot().revision, previous, 'HTTP确认前不能广播新版本');
      state.items = [...state.items, mkItem({ sessionId: 'second', title: '后建', running: true, updatedAt: Date.now() })];
      state.emit({ payload: { type: 'session/event', sessionId: 'second', event: { type: 'turn/start' } } });
      await flush();
      const revision = pushed.at(-1).sessions.revision;
      assert.notEqual(revision, previous);
      assert.equal(listSignal.snapshot().revision, revision);
      oldAck.release();
      await flush();
      assert.equal(listSignal.snapshot().revision, revision, '更早请求的迟到确认不得再广播旧版本');
      const before = pushed.length;
      h.tick();
      await flush();
      assert.equal(pushed.length, before, '迟到确认不得倒推已推基准导致同清单重复发送');
    } finally { oldAck.release(); await flush(); }
  }, { createMirrorPusher: create, items: [mkItem({ sessionId: 'hot', title: '活跃会话', running: true, updatedAt: Date.now() })] });
}

test('清单等待ACK时不提前广播，迟到旧ACK不使信号倒退', async () => {
  await assertAckOrder();
});

test('到期定向重试正文未结束时，后续清单tick仍推进', async () => {
  await withPusher(async ({ h, state, pushed, sidecar, pusher }) => {
    state.items[0] = { ...state.items[0], updatedAt: state.items[0].updatedAt + 1 };
    sidecar.fail = true;
    await pusher.pushSessionImmediately('session-run');
    const [failure] = pusher.getPushFailures();
    assert.ok(failure, '必须先建立真实重试记录');
    sidecar.fail = false;
    const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
    const retry = gate();
    let started = false;
    mobileSessions.buildMirrorWarmSnapshots = async (...args) => {
      if (args[2] === 'session-run') { started = true; await retry.pending; }
      return originalBuild(...args);
    };
    try {
      const realNow = Date.now;
      Date.now = () => failure.dueAt + 1;
      try { h.tick(); await flush(); } finally { Date.now = realNow; }
      assert.equal(started, true, '应当真的挂住到期重试的正文');
      const before = pushed.length;
      state.items = [...state.items, mkItem({ sessionId: 'during-retry', title: '重试中新增', running: true, updatedAt: Date.now() })];
      await withClockOffset(10_200, async () => { h.tick(); await flush(); });
      assert.ok(pushed.length > before && pushed.at(-1).sessions.items.some(row => row.sessionId === 'during-retry'), '慢定向重试不能占住清单bgQueueBusy');
    } finally { retry.release(); mobileSessions.buildMirrorWarmSnapshots = originalBuild; await flush(); }
  });
});

test('变异：正文重新占住清单轮次会被同一新会话断言拒绝', async () => {
  const create = pusherWithMutation('void processBgBodies(listChanged);', 'await processBgBodies(listChanged);');
  await assert.rejects(() => assertListBeforeBody(create), { code: 'ERR_ASSERTION' });
});

test('变异：正文不换挂最新清单会被同一版本断言拒绝', async () => {
  const create = pusherWithMutation('if (latestLists) payload = { ...payload, ...latestLists.payload };', "if (latestLists && !payload.sessions) payload = { ...payload, ...latestLists.payload };");
  await assert.rejects(() => assertListBeforeBody(create), { code: 'ERR_ASSERTION' });
});

test('变异：旧ACK重新推进信号会被同一确认顺序断言拒绝', async () => {
  const create = pusherWithMutation(`    if (sendEpoch < mirrorSettledEpoch || (lists && (
      sessionsRevisionOf(lists.payload.sessions) !== sessionsRevisionOf(latestLists?.payload.sessions)
      || lists.payload.workspaces.revision !== latestLists?.payload.workspaces.revision
    ))) {`, '    if (false) {');
  await assert.rejects(() => assertAckOrder(create), { code: 'ERR_ASSERTION' });
});

test('变异：同会话正文忙时跳过清单tick会被同一projection断言拒绝', async () => {
  const create = pusherWithMutation('if (bgQueueBusy) return;', 'if (bgQueueBusy || sessionPushInFlight.size) return;');
  await assert.rejects(() => assertEventBeforeBody(create), { code: 'ERR_ASSERTION' });
});

test('轮转间隔必须明显小于 sidecar 镜像快照的 TTL，且不能压到等于没节流', () => {
  const pusherSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'mirror', 'pusher.cjs'), 'utf8');
  const raw = (pusherSrc.match(/const BG_COLD_ROTATE_MIN_INTERVAL_MS = ([\d_]+)/) || [])[1];
  const rotate = Number(String(raw).replace(/_/g, ''));
  const ttl = MIRROR_SNAPSHOT_TTL_MS; // sidecar 判「镜像快照是否新鲜」的那条线，直接从模块取真值
  assert.ok(rotate > 0, '缺少 BG_COLD_ROTATE_MIN_INTERVAL_MS：冷会话轮转的节流窗口');
  assert.ok(ttl > 0, '缺少 MIRROR_SNAPSHOT_TTL_MS：sidecar 侧镜像快照的过期时间');
  assert.ok(
    rotate <= ttl / 3,
    `轮转间隔 ${rotate}ms 必须明显小于镜像快照 TTL ${ttl}ms，否则冷会话的镜像会被 sidecar 判过期`,
  );
  assert.ok(rotate >= 1000, `轮转间隔 ${rotate}ms 太短，等于没节流`);
  // 500ms 的 tick 本身是新鲜度契约（清单指纹靠它发现变化）：不许被顺手改掉。
  assert.match(pusherSrc, /const BG_TICK_INTERVAL_MS = 500;/, '500ms 的 tick 是 App「最多旧 500ms」新鲜度契约的基础，不能改');
});

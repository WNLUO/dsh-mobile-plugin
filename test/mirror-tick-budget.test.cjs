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
            value: { items: [{ workspaceId: 'w1', path: '/ws/a', title: 'a', sessionIds: [] }], archivedSessionIds: [] },
          },
        }),
      }),
      // 事件流一直挂着：本用例只驱动 500ms 的后台 tick。
      events: { mux: async function* () { await new Promise(() => {}); } },
    },
  };
}

/** 把 Date.now 推快 ms：轮转窗口那 5s 不必真等。fn 里可以 await（tick 是异步的，必须等完再还原）。 */
async function withClockOffset(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

async function withPusher(run) {
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
  };
  const pusher = createMirrorPusher({
    ctx: countingCtx(state, calls),
    tunnelConnected: () => true,
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
  });
  const stop = pusher.start();
  try {
    await flush();
    return await run({ h, calls, pushed, state, pusher });
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

test('清单一变必须在下一轮（500ms 内）重建并重推：新鲜度契约不能被节流打破', async () => {
  await withPusher(async ({ h, calls, pushed, state }) => {
    h.tick();
    await flush();
    const before = { rebuilds: rebuilds(calls), pushes: pushed.length };

    // 跑着的会话收到新消息（updatedAt 前移 → 清单 revision 变）：正文该更新了。
    state.items[0] = mkItem({ sessionId: 'session-run', title: '跑着的会话', running: true, updatedAt: Date.now() + 1000 });
    h.tick();
    await flush();

    assert.ok(rebuilds(calls) > before.rebuilds, '清单变了却没重建会话正文');
    assert.equal(pushed.length, before.pushes + 1, '清单变了却没有在 500ms 内把新镜像推进中转');
    const last = pushed[pushed.length - 1];
    assert.equal(last.kind, 'sync');
    assert.ok(last.sessions && typeof last.sessions.revision === 'string' && last.sessions.revision.length > 0, '推送体必须带清单 revision');
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

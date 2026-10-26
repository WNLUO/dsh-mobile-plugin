'use strict';

/**
 * 推送恢复守卫：**失败之后**镜像怎么追上来。
 *
 * 三条都在同一条主路径的外围，失败时都表现为「手机上数据停在几分钟前」，从帧上完全看不出
 * 是哪一条坏了：
 *
 *  1. 定向重试：会话推送失败只记账、没有定向重试，下一个 tick 的冷轮转还会因为它是 running
 *     （高优先）而**跳过它** —— 那个会话要等用户再发一条消息才有救。
 *  2. 真被清空的清单：`list.length === 0` 曾经只广播 `device/list-changed` 不推镜像，手机
 *     重拉列表会命中中转那份**旧的非空**镜像，侧栏上删掉的会话永远不消失。
 *  3. 正文缓存：事件驱动路径必须绕开 `session-mirror` 的 2 分钟缓存。旧实现传 `Date.now()`
 *     当指纹来强制重建，而指纹是 `updatedAt:running:limit`，同一毫秒里的两次推送指纹相同，
 *     照样命中上一份正文 → 被判「内容未变，跳过推送」→ 水位永不广播。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createMirrorPusher } = require('../lib/mirror/pusher.cjs');
const mobileSessions = require('../lib/mobile/sessions.js');
const { createListSignal } = require('../lib/shared/list-signal.js');
const { createSessionSignal } = require('../lib/shared/session-signal.js');

const SID = 'mirror-recovery-1';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror', 'pusher.cjs'), 'utf8');

const flush = async (turns = 30) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const waitFor = async (predicate, turns = 400) => {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return Boolean(predicate());
};

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

function makeCtx(state) {
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
      events: { mux: async function* () { await new Promise(() => {}); } },
    },
  };
}

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
      return handle;
    },
    restore() {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    },
  };
}

/** 一次用例的完整脚手架：临时 DSH_HOME（空清单守卫会落盘）+ 独立信号总线。 */
async function withPusher(state, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-recovery-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const h = harness();
  const listSignal = createListSignal();
  const sessionSignal = createSessionSignal();
  const pushed = [];
  const sidecar = { fail: false };
  const ctx = makeCtx(state);
  const pusher = createMirrorPusher({
    ctx,
    tunnelConnected: () => true,
    getSidecar: () => ({
      pushSync: async (payload) => {
        if (sidecar.fail) throw new Error('sidecar facade request failed: 503 (tunnel not connected)');
        pushed.push(payload);
      },
    }),
    listSignal,
    sessionSignal,
  });
  const stop = pusher.start();
  try {
    await run({ pusher, pushed, sidecar, h, listSignal, sessionSignal, ctx });
  } finally {
    stop();
    h.restore();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

test('高优先会话镜像构建并发全局限制为2', async () => {
  const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
  let active = 0;
  let maxActive = 0;
  mobileSessions.buildMirrorWarmSnapshots = async (_ctx, _summaries, sessionId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { [sessionId]: { ok: true, items: [], lastSeq: 0 } };
  };
  try {
    const items = Array.from({ length: 8 }, (_, i) => mkItem({
      sessionId: `mirror-concurrency-${i}`,
      running: true,
      updatedAt: Date.now(),
    }));
    await withPusher({ items, events: [] }, async ({ pushed }) => {
      await waitFor(() => pushed.length >= 1);
      assert.equal(maxActive, 2, '全局会话构建应限制为两路并发，而不是按 highPrio 数量展开');
    });
  } finally {
    mobileSessions.buildMirrorWarmSnapshots = originalBuild;
  }
});

test('事件构建连续最多三项后让等待中的 batch 获得构建槽', async () => {
  const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
  const started = [];
  const releases = [];
  mobileSessions.buildMirrorWarmSnapshots = async (_ctx, _summaries, sessionId) => {
    started.push(String(sessionId));
    await new Promise((resolve) => releases.push(resolve));
    return { [sessionId]: { ok: true, items: [], lastSeq: 0 } };
  };
  try {
    const items = Array.from({ length: 8 }, (_, i) => mkItem({ sessionId: `batch-${i}`, running: true }));
    await withPusher({ items, events: [] }, async ({ pusher }) => {
      assert.ok(await waitFor(() => started.length === 2), '初始 batch 应先占满两个并发槽');
      await flush(30); // 让其余 batch 工作都排入共享队列。
      const eventTasks = Array.from({ length: 5 }, (_, i) => pusher.pushSessionImmediately(`event-${i}`));
      await flush(10);
      assert.equal(started.length, 2, '两个被阻塞的构建应暂时占满所有槽');

      releases[0]();
      assert.ok(await waitFor(() => started.length === 3));
      releases[1]();
      assert.ok(await waitFor(() => started.length === 4));
      releases[2]();
      assert.ok(await waitFor(() => started.length === 5));
      releases[3]();
      assert.ok(await waitFor(() => started.length === 6));
      assert.deepEqual(
        started.slice(2, 6),
        ['event-0', 'event-1', 'event-2', 'batch-2'],
        '三项连续 event 后必须让等待的 batch 先于第四项 event 执行',
      );

      let released = 0;
      for (let turn = 0; turn < 20 && released < releases.length; turn += 1) {
        const pending = releases.slice(released);
        released = releases.length;
        for (const release of pending) release();
        await flush(20);
      }
      await Promise.all(eventTasks);
      assert.equal(started.length, 13, '所有 8 个 batch 与 5 个 event 都应最终获得构建槽');
    });
  } finally {
    mobileSessions.buildMirrorWarmSnapshots = originalBuild;
  }
});

test('缺失单会话消息快照不再让整轮失败：清单照推、正文缺席', async () => {
  // 语义变更（2026-10-10，真机故障）：0.1.51 把「某个会话读不到正文」当成整轮失败抛错，
  // 于是真机上（活跃/子会话在生成期读不到历史是常态）**每一次推送都失败**：清单、工作区、
  // `device/list-changed` 广播全被一条坏会话拖住，手机侧表现为「列表停在几分钟前、像定时同步」。
  // 现在改成：清单/工作区照推，只有那个会话的正文缺席，并记一条独立的诊断
  // （`skippedBodies`/`skipReason`，见 mirror-push-status.test.cjs）。
  const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
  mobileSessions.buildMirrorWarmSnapshots = async () => ({});
  try {
    const state = { items: [mkItem()], events: [assistantEvent(7)] };
    await withPusher(state, async ({ pusher, pushed }) => {
      await waitFor(() => pushed.length > 0);
      assert.ok(pushed.length > 0, '一个会话读不到正文就把整份清单挡在门外 = 镜像停止更新');
      const payload = pushed.at(-1);
      assert.equal(payload.messages[SID], undefined, '读不到正文时不得塞一份空的正文快照进去');
      assert.ok(payload.sessions && Array.isArray(payload.sessions.items), '清单必须照推');
      await waitFor(() => pusher.getPushFailures().length === 0);
      assert.deepEqual(pusher.getPushFailures(), [], '正文缺席不算推送失败，不许进失败账本（进了就会每 30s 占掉一次 tick）');
      const diag = pusher.getMirrorPush();
      assert.ok(diag.skippedBodies > 0, '正文缺席必须有独立计数，否则运维只看到一句 snapshot missing');
      assert.match(diag.skipReason, /session message snapshot unavailable/);
    });
  } finally {
    mobileSessions.buildMirrorWarmSnapshots = originalBuild;
  }
});

test('失败的会话只按退避到期重试（冷轮转不许绕过）', async () => {
  const state = { items: [mkItem()], events: [assistantEvent(7)] };
  const originalBuild = mobileSessions.buildMirrorWarmSnapshots;
  let buildCount = 0;
  mobileSessions.buildMirrorWarmSnapshots = async (...args) => {
    buildCount += 1;
    return originalBuild(...args);
  };
  try {
    await withPusher(state, async ({ pusher, pushed, sidecar, h }) => {
      sidecar.fail = true;
      await waitFor(() => pusher.getPushFailures().length === 1);
      const failures = pusher.getPushFailures();
      assert.equal(failures.length, 1, '失败必须被记账，否则没有任何定向重试的依据');
      assert.equal(failures[0].sessionId, SID);
      assert.equal(failures[0].attempts, 1);
      assert.ok(failures[0].dueAt > 0, '必须带退避到期时间');
      assert.equal(pushed.length, 0);

      const realNow = Date.now;
      try {
        Date.now = () => failures[0].dueAt - 1;
        h.tick(500);
        await flush();
        assert.equal(pusher.getPushFailures()[0]?.attempts, 1, '未到 dueAt 不得重试');
        assert.equal(buildCount, 1, '未到 dueAt 的 500ms 冷轮转不得重建失败会话');

        // 到期后恢复隧道。会话仍是 running（高优先），必须由定向重试恢复。
        sidecar.fail = false;
        Date.now = () => realNow() + 60_000;
        h.tick(500);
        await flush();
      } finally {
        Date.now = realNow;
      }
      assert.ok(pushed.length >= 1, '失败的会话没有被定向重试，只能等用户再发一条消息');
      assert.equal(pushed.at(-1).messages[SID] !== undefined, true, '重试必须带上那个会话的正文');
      await waitFor(() => pusher.getPushFailures().length === 0);
      assert.deepEqual(pusher.getPushFailures(), [], '重试成功后必须清账，否则每 tick 都重试一次');
    });
  } finally {
    mobileSessions.buildMirrorWarmSnapshots = originalBuild;
  }
});

test('冷会话 sidecar 推送失败也写入定向重试账', async () => {
  const state = {
    items: [mkItem({ running: false, updatedAt: Date.now() - 10 * 60 * 1000 })],
    events: [],
  };
  await withPusher(state, async ({ pusher, pushed, sidecar, h }) => {
    assert.ok(await waitFor(() => pushed.length >= 1), '初始清单镜像应先成功');
    const before = pushed.length;
    sidecar.fail = true;
    h.tick(500);
    assert.ok(await waitFor(() => pusher.getPushFailures().length === 1), '冷会话推送失败应进入定向重试账');
    const [failure] = pusher.getPushFailures();
    assert.equal(failure.sessionId, SID);
    assert.equal(failure.attempts, 1);
    assert.ok(failure.dueAt > Date.now(), '首次失败应遵守 2s 退避');
    assert.equal(pushed.length, before, '失败的冷推送不能被当作已发出');
  });
});

test('真被清空的清单也要推镜像（带 emptyConfirmed），不能只广播', async () => {
  const state = { items: [mkItem()], events: [assistantEvent(7)] };
  await withPusher(state, async ({ pushed, h, listSignal }) => {
    await waitFor(() => pushed.length >= 1);
    const before = pushed.length;

    state.items = []; // 用户把最后一个会话删/归档了
    h.tick(500);
    await waitFor(() => pushed.length > before);
    assert.ok(pushed.length > before, '空清单只广播不推送：手机重拉会命中中转那份旧的非空镜像');

    const last = pushed.at(-1);
    assert.deepEqual(last.sessions.items, []);
    assert.equal(last.sessions.emptyConfirmed, true, '中转只认 emptyConfirmed===true 的空覆盖');
    assert.ok(listSignal.snapshot().revision, '空清单同样要广播清单变更');
  });
});

test('同一会话连续两次推送不许复用旧正文（noCache）', async () => {
  const state = { items: [mkItem()], events: [assistantEvent(7)] };
  await withPusher(state, async ({ pusher, pushed }) => {
    await waitFor(() => pushed.length >= 1);

    // 把时钟钉住：旧实现是「传 Date.now() 当指纹」，同一毫秒里的两次推送指纹完全相同，
    // 必然命中 2 分钟缓存。钉住时钟让这个坑**确定性**复现，而不是靠跑得快。
    const realNow = Date.now;
    Date.now = () => realNow();
    try {
      state.events = [assistantEvent(7), assistantEvent(9)];
      pusher.pushSessionImmediately(SID);
      await waitFor(() => pushed.length >= 2);
    } finally {
      Date.now = realNow;
    }

    assert.ok(pushed.length >= 2, '第二次推送被判成「内容未变」：正文缓存没绕开');
    const seqs = (pushed.at(-1).messages[SID]?.items || []).map((item) => item.seq);
    assert.ok(seqs.includes(9), `第二次推送复用了旧正文（拿到 ${JSON.stringify(seqs)}）`);
  });
});

test('恢复相关的三条语义都有源码契约钉着', () => {
  assert.ok(
    SOURCE.includes('noCache: !reuseCache'),
    '事件驱动路径必须显式绕开正文缓存，不能靠伪造 updatedAt 撞指纹',
  );
  assert.ok(SOURCE.includes('const sessionPushFailures = new Map()'), '缺少失败台账');
  assert.ok(SOURCE.includes('const dueRetries = ('), '缺少退避到期判定');
  assert.ok(
    /if \(!s \|\| sessionPushFailures\.has\(candidateId\) \|\| isHighPriority\(s\)\) continue;/.test(SOURCE),
    '失败会话只能由到期定向重试处理，冷轮转不能绕过退避',
  );
  assert.ok(
    SOURCE.indexOf('const retryId = dueRetries(now)') < SOURCE.indexOf('const coldRotateDue ='),
    '到期重试必须先于冷轮转门判定',
  );
  // 重试是「额外补一次」，不能替代这一轮的正常推送：旧实现在 retry 之后直接 return，
  // 于是账本里只要有一个到期失败会话（活跃/子会话读不到历史是常态），冷轮转与整份
  // 清单推送就永远轮不到——真机上表现为镜像彻底不更新（2026-10-10）。
  assert.ok(
    !/if \(retryId\) \{[\s\S]{0,120}?return;/.test(SOURCE),
    '到期重试不许让这一轮提前返回（那会把冷轮转与清单推送一起饿死）',
  );
  assert.ok(
    /if \(retryId\) await pushSessionNow\(retryId, 'batch'\);/.test(SOURCE),
    '重试应当就地进行，然后继续走这一轮的冷轮转',
  );
  assert.ok(
    SOURCE.includes('const hasPendingRetry = sessionPushFailures.size > 0'),
    '有待重试的会话时，tick 不能因为指纹没变就早退',
  );
  assert.ok(
    /if \(!\(sessionsBody\?\.status === 200\) \|\| wsBlocked\) \{[\s\S]*?noteSessionPushFailure\(sessionId, new Error\(reason\)\)/.test(SOURCE),
    '事件路径快照/守卫失败必须进入定向重试账',
  );
  // 单个会话构建失败只影响它自己：以前冷轮转里 rethrow，等于让一个读不到的会话把这一
  // tick 的整份清单推送一起带走（外层 catch 既不推也不广播）。
  assert.ok(
    !/data = await buildSessionData\(id, s, \{ priority: 'cold' \}\);\s*\} catch \(error\) \{[\s\S]{0,120}?throw error;/.test(SOURCE),
    '冷轮转里构建失败又 rethrow：一个坏会话会把整轮清单推送带走',
  );
});

/**
 * 子会话的正文**刻意不建** —— 它不是「读失败」，别记进故障账。
 *
 * 镜像读子会话正文永远被宿主拒（`session/agent-busy: subagent Sessions require their durable
 * parent address`），`skippedBodies` 一路涨，日志里那条 skip 永远说不清哪坏了。手机读子代理
 * 走的是子代理那条专用通道（带父会话地址与 mode），镜像这份正文没人用，所以正解是**提前
 * 认出清单行、根本不发那次请求**，并且不把它算成失败。
 *
 * 断言必须成对：子会话不读普通历史，而普通会话照旧读 —— 少了后半条，「整条读取路径都坏了」
 * 也能让前半条变绿。
 */
test('子会话正文刻意不建：不发那次注定被拒的读，也不进 skippedBodies', async () => {
  const CHILD = 'mirror-subagent-child';
  const parent = mkItem({ sessionId: SID });
  const child = { ...mkItem({ sessionId: CHILD }), origin: 'subagent', parentSessionId: SID };
  await withPusher({ items: [parent, child], events: [] }, async ({ pusher, pushed, ctx }) => {
    // 初始那次推送（start() 里的 pushMirror）已经把两个会话都过了一遍：用它钉载荷形状。
    await waitFor(() => pushed.length >= 1);
    const first = pushed[0];
    // 清单规模也要真的记下来：自检台账读的就是这三个数（记漏了台账就永远 0）。
    const diag = pusher.getMirrorPush();
    assert.equal(diag.listSessions, 2, '清单里的会话总数要记下来');
    assert.equal(diag.listSubagents, 1, '其中子会话数要记下来');
    assert.ok(diag.listActiveSessions >= 1, '在跑的会话要算进活跃数');
    assert.ok(diag.listAt > 0, '要记下这份读数的时间，否则看不出它是不是陈的');
    assert.equal(first.messages[SID] !== undefined, true, '普通会话的正文照旧进镜像（对照）');
    assert.equal(first.messages[CHILD], undefined, '子会话不该有正文槽位');
    assert.equal(
      ((first.sessions && first.sessions.items) || []).some((row) => row.sessionId === CHILD),
      true,
      '清单行本身照旧推给手机：App 靠 origin/parentSessionId 认子代理',
    );

    // 再装探针单独驱一次，才能确定「那一次读到底发没发」。
    // 注意信封形状：`ctx.apiProxy.sessions.history` 收到的是 `{ rpcId, method, payload }`
    // （见 lib/mobile/rpc.js 的 callSessions），会话 id 在 `payload` 里。
    const readIds = [];
    const realHistory = ctx.apiProxy.sessions.history;
    ctx.apiProxy.sessions.history = async (envelope, signal) => {
      readIds.push(String(envelope && envelope.payload && envelope.payload.sessionId));
      return realHistory(envelope, signal);
    };

    pusher.pushSessionImmediately(CHILD);
    await flush(80);
    assert.equal(readIds.includes(CHILD), false,
      `子会话不该去读普通历史（宿主会按 durable parent address 拒掉），实际读了 ${JSON.stringify(readIds)}`);
    assert.equal(pusher.getMirrorPush().skippedBodies, 0,
      '按设计跳过的子会话不是失败，不许进 skippedBodies（真机上就是这个计数一直涨）');

    pusher.pushSessionImmediately(SID);
    await flush(80);
    assert.equal(readIds.includes(SID), true,
      `普通会话必须照旧读历史，否则上面那条「没读」可能只是整条路径坏了，实际读了 ${JSON.stringify(readIds)}`);
  });
});

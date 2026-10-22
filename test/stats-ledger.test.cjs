'use strict';

/**
 * 统计账本的守卫：按天归账、水位差、范围折算、以及「归档 / 清理之后历史还在」。
 *
 * 这一组全部跑真实现（不喂桩逻辑），因为最容易坏的地方不是公式，而是**口径**：
 * 首次采集该不该把历史全量补进来、会话消失之后那天账上的数字要不要留、多出来的
 * 会话会不会把卡片列表撑爆。每一条都对应一个用户会直接看到的后果。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../lib/mobile/stats-ledger.cjs');
const { collectStats, diffUsage, hostUsageOf } = require('../lib/mobile/stats-collect.cjs');
const { handleStatsOverview, normalizeRange } = require('../lib/mobile/stats.js');

/**
 * 在临时 DSH_HOME 里跑一段：账本文件按调用时的 DSH_HOME 解析，测完还原。
 *
 * **必须是 async 并在 promise 落地之后才还原环境**：账本的读写走模块级内存缓存，
 * 而 `saveLedger` 把当前 DSH_HOME 拼成路径。先前写成同步版（`return run(home)` 直接进
 * finally），异步用例的采集体在环境还原之后才写盘，于是把测试数据写进了**真的**
 * `~/.dsh/mobile-stats.json`，真机上会看见一条 title 为 `x` 的假会话。
 */
async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stats-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  ledger.forgetLedger();
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    ledger.forgetLedger();
  }
}

function usage(overrides = {}) {
  return { ...ledger.emptyUsage(), ...overrides };
}

function bookWith(entries) {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  for (const entry of entries) ledger.applyDelta(book, entry);
  return book;
}

/** 一个只回会话清单与投影的假 ctx（够采集跑完一轮）。 */
function fakeCtx({ items, projectionsById = {}, workspaces = [] }) {
  return {
    apiProxy: {
      sessions: {
        list: () => ({ result: { ok: true, value: { items } } }),
        projections: (request) => ({
          result: { ok: true, value: { values: projectionsById[request.payload.sessionId] || {} } },
        }),
      },
      workspace: {
        list: () => ({ result: { ok: true, value: { workspaces } } }),
      },
    },
  };
}

function tokenProjection(uncached, output, extra = {}) {
  return {
    tokenUsage: { uncachedInputTokens: uncached, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output },
    sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0, ...extra },
  };
}

test('按天归账：两条增量落在各自日期，卡片累计等于两者之和', () => {
  const first = Date.UTC(2026, 9, 20, 4, 0);
  const second = Date.UTC(2026, 9, 22, 4, 0);
  const book = bookWith([
    { sessionId: 's1', at: first, delta: usage({ uncachedInputTokens: 100, outputTokens: 10 }), title: 'A' },
    { sessionId: 's1', at: second, delta: usage({ uncachedInputTokens: 50, outputTokens: 5 }) },
  ]);
  assert.equal(Object.keys(book.days).length, 2, '两条增量落在两天');
  assert.equal(book.days[ledger.dayKeyOf(first)].uncachedInputTokens, 100);
  assert.equal(book.days[ledger.dayKeyOf(second)].uncachedInputTokens, 50);
  assert.equal(book.sessions.s1.billed.uncachedInputTokens, 150);
  assert.equal(book.sessions.s1.billed.outputTokens, 15);
  assert.equal(book.sessions.s1.lastAt, second, '最后活动时间跟着往后走');
});

test('最后一句摘要：存进记录、裁到上限、随卡片出去', () => {
  const now = Date.now();
  const long = '这句话很长'.repeat(60);
  const book = bookWith([{ sessionId: 's1', at: now, delta: usage({ uncachedInputTokens: 5 }), lastText: long }]);
  assert.equal(book.sessions.s1.lastText.length, ledger.LAST_TEXT_MAX, '按卡片一行的容量裁断');
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.sessions[0].lastText, long.slice(0, ledger.LAST_TEXT_MAX));

  ledger.forgetLedger();
});

test('模型请求数按步的增量记（宿主没有独立的请求计数）', () => {
  const book = bookWith([{ sessionId: 's1', at: Date.UTC(2026, 9, 22), delta: usage({ steps: 3, turns: 2 }) }]);
  const day = book.days[ledger.dayKeyOf(Date.UTC(2026, 9, 22))];
  assert.equal(day.requests, 3);
  assert.equal(day.turns, 2);
});

test('水位差：正常取差、水位缺失按全量、累计倒退按新值全额入账', () => {
  const host = usage({ uncachedInputTokens: 120, outputTokens: 30, turns: 2, steps: 4 });
  const fresh = diffUsage(host, null);
  assert.deepEqual(fresh, host, '没有水位就是首采：全量');

  const incremental = diffUsage(host, usage({ uncachedInputTokens: 20, outputTokens: 10, turns: 1, steps: 2 }));
  assert.equal(incremental.uncachedInputTokens, 100);
  assert.equal(incremental.outputTokens, 20);
  assert.equal(incremental.steps, 2);

  const rewound = diffUsage(host, usage({ uncachedInputTokens: 500, outputTokens: 500 }));
  assert.equal(rewound.uncachedInputTokens, 120, '累计变小只可能是日志被重写：按新值记，不要从此永远少记');
  assert.equal(rewound.outputTokens, 30);
});

test('宿主投影缺口径时按 0 处理，不猜字段', () => {
  assert.deepEqual(hostUsageOf(null), ledger.emptyUsage());
  assert.deepEqual(hostUsageOf({ tokenUsage: { uncachedInputTokens: 5 } }), usage({ uncachedInputTokens: 5 }));
});

test('范围折算：7d 固定七列、补零、KPI 与活跃天数只算窗口内', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    { sessionId: 'old', at: now - 40 * 86400000, delta: usage({ uncachedInputTokens: 999 }) },
    { sessionId: 's1', at: now, delta: usage({ uncachedInputTokens: 100, outputTokens: 20, turns: 1, llmMs: 500, toolMs: 200 }) },
  ]);
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.days.length, 7, '逐日序列补齐到七列');
  assert.equal(overview.days[6].day, ledger.dayKeyOf(now));
  assert.equal(overview.kpi.uncachedInputTokens, 100, '窗口外的用量不进 KPI');
  assert.equal(overview.kpi.activeMs, 700);
  assert.equal(overview.kpi.days, 1);
  assert.equal(overview.kpi.sessions, 1, '窗口外那条会话不上卡片');
  assert.equal(overview.heatmap.length, 56, '热力图固定八周');

  const all = ledger.summarize(book, 'all', now);
  assert.equal(all.kpi.sessions, 2, 'all 把老会话也带出来');
  assert.ok(all.days.length >= 40, 'all 从账本最早那天开始铺');
});

test('会话消失（归档后清理）之后历史数字还在，只标成已清理', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([{ sessionId: 's1', at: now, delta: usage({ uncachedInputTokens: 80 }), title: '要删的那条' }]);
  book.sessions.s1.gone = true;
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.kpi.uncachedInputTokens, 80, '按天的账不因为会话消失而缩水');
  assert.equal(overview.sessions.length, 1);
  assert.equal(overview.sessions[0].gone, true);

  // 已清理的排在最后：用户先看到能点进去的那些。
  bookWith([{ sessionId: 'live', at: now, delta: usage({ uncachedInputTokens: 10 }) }]);
  const mixed = { ...book, sessions: { ...book.sessions, live: { ...book.sessions.s1, gone: false, billed: usage({ uncachedInputTokens: 10 }) } } };
  const sorted = ledger.summarize(mixed, '7d', now);
  assert.equal(sorted.sessions[0].sessionId, 'live', '活着的排在已清理前面');
  assert.equal(sorted.sessions[1].gone, true);
});

test('会话卡片有上限，超出的从最老的裁掉；按天的账不受裁剪影响', () => {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  const baseAt = Date.UTC(2026, 9, 1);
  for (let index = 0; index < ledger.MAX_SESSIONS + 12; index += 1) {
    ledger.applyDelta(book, {
      sessionId: `s${index}`,
      at: baseAt + index * 60000,
      delta: usage({ uncachedInputTokens: 1 }),
    });
  }
  ledger.trim(book);
  assert.equal(Object.keys(book.sessions).length, ledger.MAX_SESSIONS);
  assert.ok(!book.sessions.s0, '最老的被裁掉');
  assert.ok(book.sessions[`s${ledger.MAX_SESSIONS + 11}`], '最新的留着');
  const total = Object.values(book.days).reduce((sum, day) => sum + day.uncachedInputTokens, 0);
  assert.equal(total, ledger.MAX_SESSIONS + 12, '总量还在（裁剪只动卡片，不动账）');
});

test('落盘再读回：结构一致，坏文件当空账本', async () => {
  await withHome((home) => {
    const book = bookWith([{ sessionId: 's1', at: Date.UTC(2026, 9, 22), delta: usage({ uncachedInputTokens: 42 }) }]);
    ledger.trim(book);
    ledger.saveLedger(book);
    assert.ok(fs.existsSync(path.join(home, 'mobile-stats.json')));

    ledger.forgetLedger();
    const reloaded = ledger.readLedger();
    assert.equal(reloaded.sessions.s1.billed.uncachedInputTokens, 42);

    fs.writeFileSync(path.join(home, 'mobile-stats.json'), '{ not json');
    ledger.forgetLedger();
    assert.deepEqual(ledger.readLedger().days, {}, '坏文件当空账本，统计页不能因此报错');
  });
});

test('采集：首采回填到会话最后活动那天，第二次只补增量', async () => {
  await withHome(async () => {
    const lastActive = Date.UTC(2026, 9, 19, 3, 0);
    const items = [{ sessionId: 's1', title: '老会话', cwd: '/tmp/proj', updatedAt: lastActive }];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(300, 60) } });

    const first = await collectStats(ctx, { force: true });
    assert.equal(first.sessions.s1.billed.uncachedInputTokens, 300);
    assert.equal(Object.keys(first.days).length, 1);
    assert.equal(Object.keys(first.days)[0], ledger.dayKeyOf(lastActive), '回填落在最后活动日，不是今天');

    // 投影涨了：第二次只记差额。
    const grown = fakeCtx({ items, projectionsById: { s1: tokenProjection(400, 80) } });
    const second = await collectStats(grown, { force: true });
    assert.equal(second.sessions.s1.billed.uncachedInputTokens, 400);
    assert.equal(second.sessions.s1.billed.outputTokens, 80);

    // 投影没变：一个字都不许动。
    const third = await collectStats(grown, { force: true });
    assert.equal(third.sessions.s1.billed.uncachedInputTokens, 400);
    assert.equal(Object.keys(third.days).length, 2, '有增量那天才多一行');
  });
});

test('采集：60 秒内重复请求不再读投影', async () => {
  await withHome(async () => {
    let reads = 0;
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(10, 1) } });
    const projections = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = (request) => {
      reads += 1;
      return projections(request);
    };
    await collectStats(ctx, {});
    const afterFirst = reads;
    await collectStats(ctx, {});
    assert.equal(reads, afterFirst, '一分钟内的第二次采集不该再打宿主');
  });
});

test('采集有时间预算：到点就停，已采到的照常入账、不抛错', async () => {
  await withHome(async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `s${index}`,
      title: `t${index}`,
      updatedAt: Date.now() - index * 1000,
    }));
    const ctx = fakeCtx({
      items,
      projectionsById: Object.fromEntries(items.map((item) => [item.sessionId, tokenProjection(10, 1)])),
    });
    // 每次读投影慢 25ms：预算 15ms 时只有第一轮那四条来得及开始。
    const slow = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return slow(request);
    };
    const book = await collectStats(ctx, { force: true, budgetMs: 15 });
    const collected = Object.keys(book.sessions).length;
    assert.ok(collected > 0, '预算内至少采到一条');
    assert.ok(collected < items.length, `预算到点必须停手（实际采了 ${collected} 条）`);
    const total = Object.values(book.sessions).reduce((sum, row) => sum + row.billed.uncachedInputTokens, 0);
    assert.equal(total, collected * 10, '采到的那部分已经入账，没有半截数据');
  });
});

test('采集：列表里没了的会话标成已清理，但账上的数字留着', async () => {
  await withHome(async () => {
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    await collectStats(fakeCtx({ items, projectionsById: { s1: tokenProjection(70, 7) } }), { force: true });
    const afterGone = await collectStats(fakeCtx({ items: [], projectionsById: {} }), { force: true });
    assert.equal(afterGone.sessions.s1.gone, true);
    assert.equal(afterGone.sessions.s1.billed.uncachedInputTokens, 70);
  });
});

test('采集：项目名来自工作区表，cwd 末尾斜杠不影响匹配', async () => {
  await withHome(async () => {
    const items = [{ sessionId: 's1', title: 'x', cwd: '/tmp/proj/', updatedAt: Date.now() }];
    const ctx = fakeCtx({
      items,
      projectionsById: { s1: tokenProjection(1, 1) },
      workspaces: [{ name: '我的项目', cwd: '/tmp/proj' }],
    });
    const book = await collectStats(ctx, { force: true });
    assert.equal(book.sessions.s1.workspaceName, '我的项目');
  });
});

test('路由：range 归一化，返回 { ok, overview }', async () => {
  await withHome(async () => {
    const ctx = fakeCtx({ items: [] });
    const req = { url: '/api/mobile/v1/stats/overview?range=30d' };
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(payload) { this.body = JSON.parse(payload); } };
    await handleStatsOverview(ctx, req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.overview.range, '30d');
    assert.equal(res.body.overview.days.length, 30);
    assert.deepEqual(res.body.overview.sessions, []);
  });
  assert.equal(normalizeRange('999d'), '7d', '认不出来的范围退回七天');
  assert.equal(normalizeRange(undefined), '7d');
});

test('采集失败不影响出数：账本还在就照常回', async () => {
  await withHome(async () => {
    const good = fakeCtx({ items: [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }], projectionsById: { s1: tokenProjection(9, 1) } });
    await collectStats(good, { force: true });

    const broken = { apiProxy: { sessions: { list() { throw new Error('宿主挂了'); }, projections() { throw new Error('宿主挂了'); } }, workspace: { list() { throw new Error('宿主挂了'); } } } };
    const req = { url: '/api/mobile/v1/stats/overview?range=all' };
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(payload) { this.body = JSON.parse(payload); } };
    await handleStatsOverview(broken, req, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.overview.kpi.uncachedInputTokens, 9, '采集挂了也要把账本里的数字给出去');
  });
});

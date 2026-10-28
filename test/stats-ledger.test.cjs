'use strict';

/**
 * 统计账本的守卫：按天归账、水位差、范围折算、模型维度、以及「归档 / 清理之后历史还在」。
 *
 * 这一组全部跑真实现（不喂桩逻辑），因为最容易坏的地方不是公式，而是**口径**：
 * 首次采集该不该把历史全量补进来、会话消失之后那天账上的数字要不要留、多出来的
 * 会话会不会把卡片列表撑爆、模型卡的数字是不是与按天账同一份。每一条都对应一个用户
 * 会直接看到的后果。
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
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, models: {}, composition: null };
  for (const entry of entries) ledger.applyDelta(book, entry);
  return book;
}

/** 宿主 `session.models` 的值：当前选择 + 可用目录（模型卡要画的名字从这里对上）。 */
function modelCatalog(provider, model, providerName, modelName) {
  return {
    current: { provider, model },
    groups: [{ id: provider, name: providerName, models: [{ id: model, name: modelName }] }],
  };
}

/** 一个只回会话清单、投影与当前模型的假 ctx（够采集跑完一轮）；没配模型时回 null。 */
function fakeCtx({ items, projectionsById = {}, workspaces = [], modelsById = {} }) {
  return {
    apiProxy: {
      sessions: {
        list: () => ({ result: { ok: true, value: { items } } }),
        projections: (request) => ({
          result: { ok: true, value: { values: projectionsById[request.payload.sessionId] || {} } },
        }),
        models: (request) => ({ result: { ok: true, value: modelsById[request.payload.sessionId] || {} } }),
      },
      workspace: {
        // 宿主的形状是「数组或 { items }」，条目上目录叫 path、展示名是 title。
        list: () => ({ result: { ok: true, value: { items: workspaces } } }),
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
  assert.equal(overview.heatmap.length, ledger.HEATMAP_DAYS, '热力图给满数据窗口，页面按宽度截');

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

test('记录池上限只删最老的整条；卡片条数就是真实会话数，没有展示上限', () => {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  const baseAt = Date.UTC(2026, 9, 1);
  const total = ledger.MAX_RECORDS + 12;
  for (let index = 0; index < total; index += 1) {
    ledger.applyDelta(book, {
      sessionId: `s${index}`,
      at: baseAt + index * 60000,
      delta: usage({ uncachedInputTokens: 1 }),
    });
    // 采集会把宿主累计值记成水位；删记录时它跟着一起没，所以这道上限必须抬得够高。
    book.sessions[`s${index}`].watermark = usage({ uncachedInputTokens: 1 });
  }
  ledger.trim(book);
  assert.equal(Object.keys(book.sessions).length, ledger.MAX_RECORDS, '记录池按上限留');
  assert.equal(book.sessions.s0, undefined, '最老的那条真删');
  assert.ok(book.sessions[`s${total - 1}`], '最新的还在');
  const overview = ledger.summarize(book, 'all', baseAt + 60 * 86400000);
  assert.equal(overview.sessions.length, ledger.MAX_RECORDS, '范围内有量的会话全部上卡片');
  assert.equal(overview.kpi.sessions, ledger.MAX_RECORDS, '「会话」这一格等于卡片条数，不被裁到某个展示数字');
  const daySum = Object.values(book.days).reduce((sum, day) => sum + day.uncachedInputTokens, 0);
  assert.equal(daySum, total, '按天的账不受记录池裁剪影响');
});

test('老记录只瘦身、不删条数：明细与摘要丢掉，累计与水位留着', () => {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  const longAgo = Date.now() - 100 * 86400000;
  ledger.applyDelta(book, { sessionId: 'old', at: longAgo, delta: usage({ uncachedInputTokens: 40, turns: 2 }), lastText: '很久以前那句' });
  book.sessions.old.watermark = usage({ uncachedInputTokens: 40, turns: 2 });
  ledger.applyDelta(book, { sessionId: 'fresh', at: Date.now(), delta: usage({ uncachedInputTokens: 7, turns: 1 }) });
  ledger.trim(book);

  assert.equal(Object.keys(book.sessions).length, 2, '条数一条都不少');
  assert.deepEqual(book.sessions.old.daily, {}, '按天明细丢掉（它只服务最近那段范围）');
  assert.equal(book.sessions.old.lastText, '', '最后一句也丢掉');
  assert.equal(book.sessions.old.billed.uncachedInputTokens, 40, '累计值留着');
  assert.ok(book.sessions.old.watermark, '水位在：它再活跃不会被当成首采重记一遍');

  const all = ledger.summarize(book, 'all', Date.now());
  assert.equal(all.kpi.sessions, 2, '全部那档两条都算');
  assert.equal(all.sessions.find((row) => row.sessionId === 'old').billedTokens, 40, '累计值照旧给得出');
  const week = ledger.summarize(book, '7d', Date.now());
  assert.equal(week.kpi.sessions, 1, '近 7 天只剩真在动的那条');
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

test('采集：定期那一轮跳过一点没动的会话，空闲时连账本都不重写', async () => {
  await withHome(async (home) => {
    let reads = 0;
    // 两分钟前动过：越过 60 秒最小间隔，这一轮真正读投影的是它。
    const items = [{ sessionId: 's1', cwd: '/tmp/proj', updatedAt: Date.now() - 120_000 }];
    // 带上当前模型：记录一落地就有模型，跳过分支里那条「老记录补模型」不会插进来改动账本。
    const ctx = fakeCtx({
      items,
      projectionsById: { s1: tokenProjection(10, 1) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
    });
    const projections = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = (request) => { reads += 1; return projections(request) };

    await collectStats(ctx, {});
    assert.equal(reads, 1, '第一轮读到它');
    const file = path.join(home, 'mobile-stats.json');
    const before = fs.readFileSync(file, 'utf8');

    // 摘要的 `updatedAt` 一点没变：这一轮连投影都不该读，账本文件也不该被整份重写。
    await collectStats(ctx, {});
    assert.equal(reads, 1, '没变动就不读投影');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '没有改动就不重写整份 JSON');
  });
});

test('定期采集的定时器归 stats-scheduler：start 交回一个停表的函数', () => {
  const scheduler = require('../lib/mobile/stats-scheduler.cjs');
  const stop = scheduler.start(fakeCtx({ items: [] }));
  assert.equal(typeof stop, 'function', 'ctx.effect 的清理那一半必须是函数');
  assert.ok(scheduler.PERIODIC_INTERVAL_MS >= 60_000, '一轮几分钟：按天归属靠的就是这个节奏');
  stop();
  stop(); // 重复清理由 effect 卸载路径兜底，不许抛
});

test('老记录补模型：没模型又没新动作的会话，跳过分支里读一次当前模型把累计量挂上去，只补一份', async () => {
  await withHome(async () => {
    const items = [{ sessionId: 's1', title: 't', updatedAt: Date.now() - 120_000 }];
    // 第一轮：宿主还读不到模型（升级前那段时间的样子）—— 量入账，模型一栏为空。
    const first = fakeCtx({ items, projectionsById: { s1: tokenProjection(300, 3) } });
    await collectStats(first, {});
    assert.equal(ledger.readLedger().sessions.s1.model, null, '这一轮确实没有模型');

    // 第二轮：摘要一点没变（水位差是 0），但宿主现在读得到模型了。
    let modelReads = 0;
    const second = fakeCtx({
      items,
      projectionsById: { s1: tokenProjection(300, 3) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
    });
    const models = second.apiProxy.sessions.models;
    second.apiProxy.sessions.models = (request) => { modelReads += 1; return models(request) };

    await collectStats(second, {});
    const book = ledger.readLedger();
    const key = ledger.modelKeyOf('p1', 'm1');
    assert.equal(modelReads, 1, '补模型只读一次宿主');
    assert.equal(book.sessions.s1.model.provider, 'p1', '模型落在记录上，之后的增量会记到它名下');
    assert.equal(book.models[key].billed.uncachedInputTokens, 300, '累计量补进模型桶，只补一份');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 300, '会话账不因为补模型而变');

    // 第三轮：已经有模型了，不再问宿主。
    await collectStats(second, {});
    assert.equal(modelReads, 1, '补过就不再问');
    assert.equal(ledger.readLedger().models[key].billed.uncachedInputTokens, 300, '也不会补第二遍');
  });
});

test('老记录补模型：读不到就记下尝试时间，当天不再为同一条再问一次', async () => {
  await withHome(async () => {
    const items = [{ sessionId: 's1', title: 't', updatedAt: Date.now() - 120_000 }];
    let modelReads = 0;
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(300, 3) } });
    const models = ctx.apiProxy.sessions.models;
    ctx.apiProxy.sessions.models = (request) => { modelReads += 1; return models(request) };

    await collectStats(ctx, {});
    await collectStats(ctx, {});
    const after = ledger.readLedger();
    assert.ok(after.sessions.s1.modelTriedAt > 0, '试过要落盘，否则下一轮还会再问');
    assert.equal('p1\u0000m1' in after.models, false, '读不到模型就不往模型表里写');
    const reads = modelReads;
    await collectStats(ctx, {});
    assert.equal(modelReads, reads, '同一天内不再重复问');
  });
});

test('清理前补采（skipPreview）只读投影，不为卡片摘要读历史', async () => {
  await withHome(async () => {
    let historyReads = 0;
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(33, 3) } });
    ctx.apiProxy.sessions.history = () => {
      historyReads += 1;
      return { result: { ok: true, value: { events: [] } } };
    };

    const book = await collectStats(ctx, { force: true, skipPreview: true });

    assert.equal(historyReads, 0, '清理前补采不许再读会话日志');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 33, '数字照常入账');
    assert.equal(book.sessions.s1.lastText, '', '首次见到的会话没有最后一句');
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
      workspaces: [{ title: '我的项目', path: '/tmp/proj' }],
    });
    const book = await collectStats(ctx, { force: true });
    assert.equal(book.sessions.s1.workspaceName, '我的项目');
  });
});

test('采集：卡片标题取摘要里的 title 投影（顶层 title 是真机上不存在的字段）', async () => {
  await withHome(async () => {
    const items = [
      // 真机摘要：标题在 projections.values.title，顶层只有 sessionId / cwd / updatedAt。
      { sessionId: 's1', cwd: '/tmp/proj', updatedAt: Date.now(), projections: { values: { title: '给统计页加个按钮' } } },
      // 顶层那个假字段一律不认：以前照着它读，账本里几百条标题全是空串。
      { sessionId: 's2', title: '假的', cwd: '/tmp/proj', updatedAt: Date.now() },
    ];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(1, 1), s2: tokenProjection(1, 1) } });
    const book = await collectStats(ctx, { force: true });
    assert.equal(book.sessions.s1.title, '给统计页加个按钮');
    assert.equal(book.sessions.s2.title, '', '取不到就留空，由 App 拿目录末段兜底');
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
    assert.deepEqual(res.body.overview.models, [], '没有模型桶时也要给空数组（App 缺这个字段整块不画）');
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

test('卡片数字跟着范围走：同一张卡在 7d 与 all 下就是两个数', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    { sessionId: 's1', at: now - 20 * 86400000, delta: usage({ uncachedInputTokens: 900, outputTokens: 100, turns: 9 }) },
    { sessionId: 's1', at: now, delta: usage({ uncachedInputTokens: 60, outputTokens: 40, turns: 1 }) },
  ]);
  const week = ledger.summarize(book, '7d', now);
  const all = ledger.summarize(book, 'all', now);
  assert.equal(week.sessions[0].billedTokens, 100, '近 7 天只剩今天那一笔');
  assert.equal(week.sessions[0].turns, 1);
  assert.equal(all.sessions[0].billedTokens, 1100, '全部仍是累计值');
  assert.equal(all.sessions[0].turns, 10);
});

test('卡片加起来能对上 KPI：差额只剩「无明细」那一笔', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    { sessionId: 'a', at: now, delta: usage({ uncachedInputTokens: 100, outputTokens: 100 }) },
    { sessionId: 'b', at: now, delta: usage({ uncachedInputTokens: 50, outputTokens: 50 }) },
  ]);
  // 模拟一条被老版本删掉记录的会话：只有按天的账，没有 sessions 记录。
  book.days[ledger.dayKeyOf(now)].uncachedInputTokens += 30;

  const overview = ledger.summarize(book, '7d', now);
  const rangeBilled = ledger.billedOf(overview.kpi);
  const cardSum = overview.sessions.reduce((sum, row) => sum + row.billedTokens, 0);
  assert.equal(cardSum, 300, '两条都在卡片上，一条都不许被裁掉');
  assert.equal(overview.untrackedBilled, 30, '没明细的那截单独报量');
  assert.equal(cardSum + overview.untrackedBilled, rangeBilled, '两笔相加等于总量');
  assert.equal(overview.kpi.sessions, 2, '会话数就是卡片条数');
});

test('范围内没有量的会话不上卡片（切到 7d 不显示两个月前的老会话）', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    { sessionId: 'stale', at: now - 20 * 86400000, delta: usage({ uncachedInputTokens: 500, turns: 5 }) },
    { sessionId: 'fresh', at: now, delta: usage({ uncachedInputTokens: 10, turns: 1 }) },
  ]);
  const week = ledger.summarize(book, '7d', now);
  assert.equal(week.sessions.length, 1);
  assert.equal(week.sessions[0].sessionId, 'fresh');
  assert.equal(ledger.summarize(book, '30d', now).sessions.length, 2, '放宽范围它就回来了');
});

test('构成快照跟着会话走，取最近活跃的那条', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    { sessionId: 'a', at: now - 7200000, delta: usage({ uncachedInputTokens: 10 }) },
    { sessionId: 'b', at: now, delta: usage({ uncachedInputTokens: 20 }) },
  ]);
  book.sessions.a.composition = { systemTokens: 1, toolsTokens: 2, messageTokens: 3, at: now - 7200000 };
  book.sessions.b.composition = { systemTokens: 100, toolsTokens: 200, messageTokens: 300, at: now };
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.compositionSessionId, 'b', '取最后有动作的那条，不是谁后回是谁');
  assert.equal(overview.composition.systemTokens, 100);
});

test('采集串行：两个请求同时进来不会把同一段增量记两遍', async () => {
  await withHome(async () => {
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(100, 10) } });
    const slow = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return slow(request);
    };
    await Promise.all([collectStats(ctx, { force: true }), collectStats(ctx, { force: true })]);
    const book = ledger.readLedger();
    assert.equal(book.days[ledger.dayKeyOf(Date.now())].uncachedInputTokens, 100, '只该记一遍');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 100);
  });
});

test('采集：老会话不会被每轮预算饿死（先近后远，轮着往下走）', async () => {
  await withHome(async () => {
    const now = Date.now();
    // 一条很老、两条很新：按最后活动时间倒序扫时，老的永远排在队尾。
    const items = [
      { sessionId: 'ancient', title: 'old', updatedAt: now - 200 * 86400000 },
      { sessionId: 'new1', title: 'n1', updatedAt: now },
      { sessionId: 'new2', title: 'n2', updatedAt: now - 1000 },
    ];
    const ctx = fakeCtx({
      items,
      projectionsById: Object.fromEntries(items.map((item) => [item.sessionId, tokenProjection(10, 1)])),
    });
    // 第一轮预算只够两条：老的排在最后，采不到。把它记成「很久没采过」才会被下一轮先捡。
    const first = await collectStats(ctx, { force: true, budgetMs: 1 });
    const collectedFirst = Object.keys(first.sessions);
    const second = await collectStats(ctx, { force: true });
    assert.ok(Object.keys(second.sessions).includes('ancient'), '第二轮一定把它补上');
    // 第一轮到底采到几条取决于调度，这里只钉「两轮之后全都在」。
    assert.equal(Object.keys(second.sessions).length, 3, `第一轮 ${collectedFirst.length} 条`);
  });
});

test('模型维度：一次采集把同一份增量同时记进按天账、会话账与模型桶', async () => {
  await withHome(async () => {
    const now = Date.now();
    const items = [{ sessionId: 's1', cwd: '/tmp/proj', updatedAt: now }];
    const ctx = fakeCtx({
      items,
      projectionsById: { s1: tokenProjection(100, 20) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
    });

    const book = await collectStats(ctx, { force: true });
    const key = 'p1\u0000m1';
    const bucket = book.models[key];
    assert.ok(bucket, '按「渠道 + 模型」建桶');
    assert.equal(bucket.providerName, '渠道一', '渠道名从宿主目录对上');
    assert.equal(bucket.modelName, '模型一');
    assert.equal(bucket.billed.uncachedInputTokens, 100);
    assert.equal(bucket.billed.outputTokens, 20);
    assert.equal(bucket.daily[ledger.dayKeyOf(now)].outputTokens, 20, '按天明细与总量同一个日期');
    assert.ok(bucket.lastAt >= now, '最后活动时间记在采集这一刻');
    assert.equal(book.days[ledger.dayKeyOf(now)].uncachedInputTokens, 100);
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 100);
    assert.equal(book.sessions.s1.model.provider, 'p1', '会话记录上落下此刻的模型');
    assert.equal(book.sessions.s1.model.modelName, '模型一');

    const overview = ledger.summarize(book, '7d', now);
    assert.equal(overview.models.length, 1);
    const row = overview.models[0];
    assert.equal(row.provider, 'p1');
    assert.equal(row.providerName, '渠道一');
    assert.equal(row.model, 'm1');
    assert.equal(row.modelName, '模型一');
    assert.equal(row.uncachedInputTokens, 100);
    assert.equal(row.cacheReadTokens, 0);
    assert.equal(row.cacheWriteTokens, 0);
    assert.equal(row.outputTokens, 20);
    assert.equal(row.billedTokens, 120, '四个桶之和');
    assert.equal(row.turns, 1);
    assert.equal(row.requests, 1, '请求数取 steps，与按天账一个口径');
  });
});

test('模型维度：模型读不到时只记会话与按天账，什么都不往模型表里写', async () => {
  await withHome(async () => {
    const now = Date.now();
    const items = [{ sessionId: 's1', updatedAt: now }];
    // 不配 modelsById：宿主这一轮没给当前模型（或那一趟读失败）。
    const book = await collectStats(fakeCtx({ items, projectionsById: { s1: tokenProjection(30, 3) } }), { force: true });
    assert.deepEqual(book.models, {}, '宁可不记，也不造一个空渠道的垃圾桶');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 30, '数字照常入账');
    assert.equal(book.sessions.s1.model, null, '读不到就留空，下一轮再试');
    assert.deepEqual(ledger.summarize(book, '7d', now).models, [], '没有桶时给空数组');
  });
});

test('老账本升级：第一次采到模型就把这条会话的累计量回填进模型桶，且只回填一份', async () => {
  await withHome(async (home) => {
    const lastActive = Date.UTC(2026, 9, 19, 3, 0);
    const billed = usage({ uncachedInputTokens: 300, outputTokens: 60, turns: 2, steps: 3 });
    // 升级前的账本：会话累计与水位都在，没有 models 表，记录上也没有 model 字段。
    const old = {
      version: 1,
      updatedAt: 0,
      days: { [ledger.dayKeyOf(lastActive)]: { ...billed, requests: 3 } },
      sessions: {
        s1: {
          title: '老会话',
          firstAt: lastActive,
          lastAt: lastActive,
          collectedAt: 0,
          billed,
          daily: { [ledger.dayKeyOf(lastActive)]: billed },
          watermark: billed,
        },
      },
      composition: null,
    };
    fs.writeFileSync(path.join(home, 'mobile-stats.json'), JSON.stringify(old));
    ledger.forgetLedger();

    const items = [{ sessionId: 's1', title: '老会话', updatedAt: lastActive }];
    // 宿主累计值与水位一致：这一轮没有增量，只有「升级回填」这一件事要做。
    const ctx = fakeCtx({
      items,
      // 投影与水位逐项相等（含耗时字段）：这一轮真的没有增量。
      projectionsById: { s1: {
        tokenUsage: { uncachedInputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60 },
        sessionStats: { turns: 2, steps: 3, llmMs: 0, toolMs: 0 },
      } },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
    });

    const first = await collectStats(ctx, { force: true });
    const key = 'p1\u0000m1';
    assert.equal(first.models[key].billed.uncachedInputTokens, 300, '回填的是这条会话的累计量');
    assert.equal(first.models[key].billed.outputTokens, 60);
    assert.deepEqual(
      Object.keys(first.models[key].daily),
      [ledger.dayKeyOf(lastActive)],
      '回填落在会话最后活动那天，与按天账同一天',
    );
    assert.ok(first.models[key].lastAt > 0, '没有更细的时刻，落到那天零点也算有');
    assert.equal(first.sessions.s1.model.provider, 'p1');
    assert.equal(first.days[ledger.dayKeyOf(lastActive)].uncachedInputTokens, 300, '按天账没被回填再动一次');
    assert.equal(first.sessions.s1.billed.uncachedInputTokens, 300, '会话累计也没翻倍');

    // 再采一轮：model 已经记在记录上，回填条件不再成立。
    const second = await collectStats(ctx, { force: true });
    assert.equal(second.models[key].billed.uncachedInputTokens, 300, '回填只做一次，不翻倍');
    assert.equal(Object.keys(second.models[key].daily).length, 1);
  });
});

test('模型桶跟着页面范围折算：7d 只有窗口内的天，all 用累计值', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([]);
  const model = { provider: 'p1', providerName: '渠道一', model: 'm1', modelName: '模型一' };
  ledger.applyModelUsage(book, { model, day: ledger.dayKeyOf(now - 20 * 86400000), usage: usage({ uncachedInputTokens: 900 }) });
  ledger.applyModelUsage(book, { model, day: ledger.dayKeyOf(now), usage: usage({ uncachedInputTokens: 60, outputTokens: 40, turns: 1 }) });
  // 一个只有日期、没有量的桶：范围折算后什么都不剩，不该上卡。
  ledger.applyModelUsage(book, { model: { provider: 'p2', providerName: '', model: 'm2', modelName: '' }, day: ledger.dayKeyOf(now), usage: usage() });

  const week = ledger.summarize(book, '7d', now);
  assert.equal(week.models.length, 1, '零量的桶整块不出现');
  assert.equal(week.models[0].billedTokens, 100, '近 7 天只剩今天那一笔');
  assert.equal(week.models[0].turns, 1);
  const month = ledger.summarize(book, '30d', now);
  assert.equal(month.models[0].billedTokens, 1000, '放宽到 30 天就把 20 天前那笔加回来');
  const all = ledger.summarize(book, 'all', now);
  assert.equal(all.models[0].billedTokens, 1000, 'all 直接用累计 billed');
  assert.deepEqual(book.days, {}, '模型桶不往按天总账里写');
  assert.deepEqual(book.sessions, {}, '也不往会话账里写');
});

test('模型卡排序：计费量降序，相同再按最后活动时间降序', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([]);
  const older = { provider: 'p1', providerName: '', model: 'm1', modelName: '' };
  const newer = { provider: 'p2', providerName: '', model: 'm2', modelName: '' };
  const small = { provider: 'p3', providerName: '', model: 'm3', modelName: '' };
  ledger.applyModelUsage(book, { model: older, day: ledger.dayKeyOf(now - 86400000), usage: usage({ uncachedInputTokens: 100 }) });
  ledger.applyModelUsage(book, { model: newer, day: ledger.dayKeyOf(now), usage: usage({ uncachedInputTokens: 100 }) });
  ledger.applyModelUsage(book, { model: small, day: ledger.dayKeyOf(now), usage: usage({ uncachedInputTokens: 50 }) });
  const rows = ledger.summarize(book, '7d', now).models;
  assert.deepEqual(rows.map((row) => row.model), ['m2', 'm1', 'm3']);
});

test('成本：按模型桶的四档价折算，合计只含有价的那些行，没价的落进 unpricedBilled', () => {
  // 价目从真表里取一条：具体数字会随快照变，所以只拿「这一条自己」当基准。
  const table = require('../lib/mobile/model-prices-table.cjs');
  const key = Object.keys(table.BY_PROVIDER_MODEL)[0];
  const split = key.indexOf('/');
  const price = table.BY_PROVIDER_MODEL[key];
  const priced = { provider: key.slice(0, split), providerName: '渠道', model: key.slice(split + 1), modelName: '模型' };
  const unpriced = { provider: 'route-model-a', providerName: '', model: 'nobody-knows-this-one', modelName: '' };

  const now = Date.UTC(2026, 9, 22, 6, 0);
  // 走 `applyDelta`（按天账 + 会话 + 模型三件事一起记）：`unpricedBilled` 是拿按天总账减去
  // 有价的那几行算出来的，只往模型表里写、按天账空着，这个差就没有意义。
  const book = bookWith([
    {
      sessionId: 's1',
      at: now,
      model: priced,
      delta: usage({ uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }),
    },
    {
      sessionId: 's2',
      at: now,
      model: unpriced,
      delta: usage({ uncachedInputTokens: 500 }),
    },
  ]);

  const overview = ledger.summarize(book, '7d', now);
  const pricedRow = overview.models.find((row) => row.model === priced.model);
  const unpricedRow = overview.models.find((row) => row.model === unpriced.model);
  const expected = Math.round((price[0] + price[1] + price[2] + price[3]) * 1e6) / 1e6;

  assert.equal(pricedRow.cost, expected, '四档各乘各的价、除以一百万');
  assert.equal('cost' in unpricedRow, false, '查不到价的模型不画一个 0');
  assert.equal(overview.cost.currency, 'USD');
  assert.equal(overview.cost.total, expected);
  assert.equal(overview.cost.pricedBilled, 4e6);
  assert.equal(overview.cost.unpricedBilled, 500, '没价的那一截 token 要单独说出来');
  assert.match(overview.cost.asOf, /^\d{4}-\d{2}-\d{2}$/, '页面要写清按哪天的价估的');
  const rowsTotal = overview.models
    .filter((row) => typeof row.cost === 'number')
    .reduce((sum, row) => sum + row.cost, 0);
  assert.ok(Math.abs(rowsTotal - overview.cost.total) < 1e-6, '合计就是各行之合');
  assert.equal(JSON.stringify(book).includes('"cost"'), false, '金额不落盘（价格变了下次出数就该跟着变）');
});

test('成本：一台机器一个模型都查不到价时，整项不给（页面据此不画）', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([]);
  ledger.applyModelUsage(book, {
    model: { provider: 'route-model-a', providerName: '', model: 'nobody-knows-this-one', modelName: '' },
    day: ledger.dayKeyOf(now),
    usage: usage({ uncachedInputTokens: 5, outputTokens: 5 }),
  });
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.models.length, 1);
  assert.equal('cost' in overview, false, '没有一行有价时整项不出，别给一个 $0');
});

test('读盘清洗：坏模型桶与坏 record.model 丢掉，老账本缺这两块按空处理', () => {
  const good = { provider: 'p1', providerName: '渠道一', model: 'm1', modelName: '模型一' };
  const raw = {
    version: 1,
    days: {},
    sessions: {
      s1: { billed: { uncachedInputTokens: 5 }, model: good },
      s2: { billed: { uncachedInputTokens: 5 }, model: { provider: 'p1', model: 'm1' } },
      s3: { billed: { uncachedInputTokens: 5 } },
    },
    models: {
      'p1\u0000m1': {
        ...good,
        billed: { uncachedInputTokens: 5 },
        daily: { '2026-10-01': { outputTokens: 1 }, '不是日期': { outputTokens: 9 } },
        lastAt: 7,
      },
      // provider 空：垃圾桶，丢掉。
      emptyProvider: { provider: '', model: 'm1', billed: { uncachedInputTokens: 9 } },
      nothing: 'not-an-object',
    },
  };
  const book = ledger.sanitizeLedger(raw);
  assert.deepEqual(Object.keys(book.models), ['p1\u0000m1'], '只认 provider + model 都齐的桶');
  assert.equal(book.models['p1\u0000m1'].billed.uncachedInputTokens, 5);
  assert.deepEqual(Object.keys(book.models['p1\u0000m1'].daily), ['2026-10-01'], '坏日期丢掉');
  assert.equal(book.models['p1\u0000m1'].lastAt, 7);
  assert.deepEqual(book.sessions.s1.model, good);
  assert.equal(book.sessions.s3.model, null, '老记录没有这一栏是 null');

  // 展示名缺失不是「这条归属作废」：目录里那条模型下架了、渠道被卸载了都会给空名。若这里
  // 读回 null，下一轮采集会把它当成「还没记过模型」再回填一次，同一段累计量在模型桶里翻倍。
  assert.deepEqual(
    book.sessions.s2.model,
    { provider: 'p1', providerName: '', model: 'm1', modelName: '' },
    '只有渠道 id + 模型 id 时，读盘仍然是同一条模型归属',
  );

  const old = ledger.sanitizeLedger({ version: 1, days: {}, sessions: {} });
  assert.deepEqual(old.models, {}, '老账本没有 models 也照常读，不许整份丢弃');
});

test('trim 只裁模型桶的按天明细，桶本身按组合留着；空桶删掉', () => {
  const book = bookWith([]);
  const model = { provider: 'p1', providerName: '渠道一', model: 'm1', modelName: '模型一' };
  const start = '2026-01-01';
  const total = ledger.MAX_DAILY_DAYS + 8;
  for (let index = 0; index < total; index += 1) {
    ledger.applyModelUsage(book, { model, day: ledger.addDays(start, index), usage: usage({ uncachedInputTokens: 1 }) });
  }
  // 只有日期、没有量的桶：裁完就该消失，别在页面上占一张全 0 的卡。
  book.models['p9\u0000m9'] = {
    provider: 'p9', providerName: '', model: 'm9', modelName: '', billed: ledger.emptyUsage(), daily: {}, lastAt: 0,
  };

  ledger.trim(book);
  const kept = book.models['p1\u0000m1'];
  assert.equal(Object.keys(kept.daily).length, ledger.MAX_DAILY_DAYS, '明细裁到与每条会话同一档');
  assert.equal(Object.keys(kept.daily).sort()[0], ledger.addDays(start, total - ledger.MAX_DAILY_DAYS), '裁掉最老的几天');
  assert.equal(kept.billed.uncachedInputTokens, total, '累计值不裁');
  assert.equal(book.models['p9\u0000m9'], undefined, 'billed 为 0 且明细空了就删掉');
});

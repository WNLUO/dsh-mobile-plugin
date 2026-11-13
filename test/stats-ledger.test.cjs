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
const { collectStats, diffUsage, hostUsageOf, foldSessionEvents } = require('../lib/mobile/stats-collect.cjs');
const { handleStatsOverview, normalizeRange, settleWake } = require('../lib/mobile/stats.js');

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

/** 一个只回会话清单、投影、当前模型与历史事件的假 ctx（够采集跑完一轮）。 */
function fakeCtx({ items, projectionsById = {}, workspaces = [], modelsById = {}, historyById = {} }) {
  return {
    apiProxy: {
      sessions: {
        list: () => ({ result: { ok: true, value: { items } } }),
        projections: (request) => ({
          result: { ok: true, value: { values: projectionsById[request.payload.sessionId] || {} } },
        }),
        models: (request) => ({ result: { ok: true, value: modelsById[request.payload.sessionId] || {} } }),
        // 历史事件：值可以是 `{ events }` 对象（一次给全），也可以是函数（按 maxMessages/beforeSeq
        // 分页回放，见 pagedHistory）。没配就当这条会话没有事件。
        history: (request) => {
          const entry = historyById[request.payload.sessionId];
          if (typeof entry === 'function') {
            const reply = entry(request);
            return reply && reply.result ? reply : { result: { ok: true, value: reply } };
          }
          if (entry) return { result: { ok: true, value: entry } };
          return { result: { ok: true, value: { events: [] } } };
        },
      },
      workspace: {
        // 宿主的形状是「数组或 { items }」，条目上目录叫 path、展示名是 title。
        list: () => ({ result: { ok: true, value: { items: workspaces } } }),
      },
    },
  };
}

/* --------------------------------------------------------------------------------------------
 * 造会话事件与分页回放（守卫直接喂假事件，不用起宿主）
 * ------------------------------------------------------------------------------------------ */

/** 一段会话事件包成宿主 history 的返回形状（`{ event }` 包一层，与真机一致）。 */
function historyOf(events) {
  return { events: events.map((event) => ({ event })) };
}

/**
 * 按宿主的分页语义回放一整个事件数组：尾窗取最后 maxMessages 条，带 beforeSeq 时取它之前的
 * 一窗 —— 用来钉「断层靠 beforeSeq 补齐」那条守卫。
 */
function pagedHistory(allEvents) {
  return (request) => {
    const max = Number.isSafeInteger(request.payload.maxMessages) ? request.payload.maxMessages : 400;
    const beforeSeq = request.payload.beforeSeq;
    const list = Number.isSafeInteger(beforeSeq) ? allEvents.filter((event) => event.seq < beforeSeq) : allEvents;
    const tail = list.slice(-max);
    return { events: tail.map((event) => ({ event })), hasMore: list.length > tail.length };
  };
}

/**
 * 会话事件积木：按顺序发 seq 与时间，拼出一段真机形状的事件流。
 * `step()` 造一个完整 step（step/start → request/header → assistant/message → step/end），
 * `turn()` 造 turn/start。默认 p1/m1（与 modelCatalog 对上）。
 */
function eventLog(startTime = Date.UTC(2026, 9, 22, 6, 0)) {
  const events = [];
  let seq = 0;
  let time = startTime;
  const api = {
    events,
    at(t) { time = t; return api; },
    advance(ms) { time += ms; return api; },
    turn(turn = 1) { events.push({ seq: seq++, type: 'turn/start', time, data: { turn } }); return api; },
    step({ turn = 1, step = 1, input = 0, output = 0, cacheRead, provider = 'p1', model = 'm1', ms = 1000 } = {}) {
      const start = time;
      events.push({ seq: seq++, type: 'step/start', time: start, data: { turn, step } });
      if (provider) events.push({ seq: seq++, type: 'request/header', time: start, data: { header: { config: { provider, model } } } });
      const usage = { inputTokens: input, outputTokens: output };
      if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
      events.push({
        seq: seq++,
        type: 'assistant/message',
        time: start + Math.floor(ms * 0.8),
        data: { turn, step, usage, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      });
      time = start + ms;
      events.push({ seq: seq++, type: 'step/end', time, data: { turn, step } });
      return api;
    },
  };
  return api;
}

/** 一段事件折叠出的用量 → 宿主投影（tokenUsage/sessionStats），让「差额」为 0。 */
function projectionOf(events) {
  const total = foldSessionEvents(events, {}).total;
  return {
    tokenUsage: {
      uncachedInputTokens: total.uncachedInputTokens,
      cacheReadTokens: total.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens,
      outputTokens: total.outputTokens,
    },
    sessionStats: { turns: total.turns, steps: total.steps, llmMs: total.llmMs, toolMs: total.toolMs },
  };
}


function tokenProjection(uncached, output, extra = {}) {
  return {
    tokenUsage: { uncachedInputTokens: uncached, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output },
    sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0, ...extra },
  };
}

/** 一条真的一点量都没有的会话：只用来立水位（首采那笔是 0，不会进任何账）。 */
function emptyProjection() {
  return {
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    sessionStats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0 },
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

test('范围折算：今天 / 昨天 / 近 3 天各自只看自己的窗口', () => {
  const now = Date.UTC(2026, 10, 5, 6, 0);
  const book = bookWith([
    { sessionId: 'today', at: now, delta: usage({ uncachedInputTokens: 100, turns: 1 }) },
    { sessionId: 'yesterday', at: now - 86400000, delta: usage({ uncachedInputTokens: 200, turns: 1 }) },
    { sessionId: 'before', at: now - 2 * 86400000, delta: usage({ uncachedInputTokens: 400, turns: 1 }) },
  ]);

  const today = ledger.summarize(book, 'today', now);
  assert.equal(today.days.length, 1);
  assert.equal(today.days[0].day, ledger.dayKeyOf(now));
  assert.equal(today.kpi.uncachedInputTokens, 100, '今天只看今天');
  assert.equal(today.kpi.sessions, 1, '昨天与前天那两条不上卡片');

  const yesterday = ledger.summarize(book, 'yesterday', now);
  assert.equal(yesterday.days.length, 1, '昨天是单天窗口，不是「最近两天」');
  assert.equal(yesterday.days[0].day, ledger.dayKeyOf(now - 86400000));
  assert.equal(yesterday.kpi.uncachedInputTokens, 200, '今天那一段不许算进昨天');
  assert.equal(yesterday.sessions.length, 1);

  const three = ledger.summarize(book, '3d', now);
  assert.equal(three.days.length, 3);
  assert.equal(three.days[0].day, ledger.dayKeyOf(now - 2 * 86400000), '窗口从三天前起');
  assert.equal(three.kpi.uncachedInputTokens, 700, '近 3 天含今天');
  assert.equal(three.kpi.sessions, 3);
  assert.equal(
    three.sessions.reduce((sum, row) => sum + row.billedTokens, 0),
    three.kpi.uncachedInputTokens,
    '卡片与 KPI 是同一个窗口',
  );
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

test('采集：首采的历史量不进按天账（决策：首采不再压当天），能折到的新事件按真实日记', async () => {
  await withHome(async () => {
    const lastActive = Date.UTC(2026, 9, 19, 3, 0);
    const items = [{ sessionId: 's1', title: '老会话', cwd: '/tmp/proj', updatedAt: lastActive }];
    // 第一次采：窗口里一条事件都翻不到，宿主累计 300 —— 全进 history（无日期），按天账一个字节不写。
    const bare = fakeCtx({ items, projectionsById: { s1: tokenProjection(300, 60) } });
    const first = await collectStats(bare, { force: true });
    assert.equal(first.sessions.s1.billed.uncachedInputTokens, 300, '累计值仍然是这条会话的全部');
    assert.equal(first.sessions.s1.history.uncachedInputTokens, 300, '这段历史单独记一格');
    assert.deepEqual(first.days, {}, '按天账一个字节都不写：当天 / 近几天 KPI 不含这一笔');
    assert.deepEqual(first.sessions.s1.daily, {}, '卡片那份按天明细同样是空的');
    assert.equal(ledger.summarize(first, 'all', Date.now()).kpi.uncachedInputTokens, 300, 'all 那档等于累计');
    assert.equal(ledger.summarize(first, '7d', Date.now()).kpi.uncachedInputTokens, 0, '近 7 天不含首采那笔历史');

    // 第二次采：现在能翻到一个新 step（100 / 20）。它按真实日入账；宿主累计 400 里剩下的 300 / 60
    // 是本轮翻不到的老历史，仍走 history。重置再折叠，不叠加（旧数据源换掉时最怕记两遍）。
    const today = ledger.dayKeyOf(Date.now());
    const log = eventLog(Date.now());
    log.turn().step({ input: 100, output: 20, ms: 1000 });
    const grown = fakeCtx({
      items,
      projectionsById: { s1: tokenProjection(400, 80) },
      historyById: { s1: historyOf(log.events) },
    });
    const second = await collectStats(grown, { force: true });
    assert.equal(second.sessions.s1.billed.uncachedInputTokens, 400, '累计仍是宿主口径（折叠 + 差额）');
    assert.equal(second.sessions.s1.billed.outputTokens, 80);
    assert.equal(second.sessions.s1.history.uncachedInputTokens, 300, '翻不到的老历史留在 history，没翻倍');
    assert.equal(second.days[today].uncachedInputTokens, 100, '新事件按真实日入账');
    assert.equal(second.days[today].outputTokens, 20);
    assert.equal(second.days[today].requests, 1, 'requests 就是真实请求条数（一条 assistant/message）');

    // 事件没变：一个字都不许动。
    const third = await collectStats(grown, { force: true });
    assert.equal(third.sessions.s1.billed.uncachedInputTokens, 400);
    assert.equal(third.days[today].uncachedInputTokens, 100, '不重复折叠同一条事件');
  });
});

test('采集：60 秒内重复请求不再读宿主的投影与事件', async () => {
  await withHome(async () => {
    let projectionReads = 0;
    let historyReads = 0;
    const log = eventLog(Date.now());
    log.turn().step({ input: 10, output: 1 });
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    const ctx = fakeCtx({
      items,
      projectionsById: { s1: projectionOf(log.events) },
      historyById: { s1: historyOf(log.events) },
    });
    const projections = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = (request) => { projectionReads += 1; return projections(request); };
    const history = ctx.apiProxy.sessions.history;
    ctx.apiProxy.sessions.history = (request) => { historyReads += 1; return history(request); };

    await collectStats(ctx, {});
    assert.ok(historyReads > 0, '第一轮真的读了事件');
    const afterFirst = { projectionReads, historyReads };
    await collectStats(ctx, {});
    assert.equal(projectionReads, afterFirst.projectionReads, '一分钟内的第二次采集不该再打投影');
    assert.equal(historyReads, afterFirst.historyReads, '也不该再读事件');
  });
});

test('采集：定期那一轮跳过一点没动的会话，空闲时连账本都不重写', async () => {
  await withHome(async (home) => {
    let historyReads = 0;
    const log = eventLog(Date.now() - 130_000);
    log.turn().step({ input: 10, output: 1 });
    // 两分钟前动过：越过 60 秒最小间隔，这一轮真正读事件的是它。
    const items = [{ sessionId: 's1', cwd: '/tmp/proj', updatedAt: Date.now() - 120_000 }];
    // 带上当前模型：记录一落地就有模型，跳过分支里那条「老记录补模型」不会插进来改动账本。
    const ctx = fakeCtx({
      items,
      projectionsById: { s1: projectionOf(log.events) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
      historyById: { s1: historyOf(log.events) },
    });
    const history = ctx.apiProxy.sessions.history;
    ctx.apiProxy.sessions.history = (request) => { historyReads += 1; return history(request); };

    await collectStats(ctx, {});
    assert.ok(historyReads > 0, '第一轮读到它');
    const afterFirst = historyReads;
    const file = path.join(home, 'mobile-stats.json');
    const before = fs.readFileSync(file, 'utf8');

    // 摘要的 `updatedAt` 一点没变：这一轮连事件都不该读，账本文件也不该被整份重写。
    await collectStats(ctx, {});
    assert.equal(historyReads, afterFirst, '没变动就不读事件（也不读预览）');
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

test('定期采集有自己那份更大的预算，请求路径仍是 1.5 秒', () => {
  const scheduler = require('../lib/mobile/stats-scheduler.cjs');
  const collect = require('../lib/mobile/stats-collect.cjs');
  assert.equal(scheduler.PERIODIC_BUDGET_MS, collect.PERIODIC_BUDGET_MS, '两份导出是同一个数');
  assert.equal(collect.DEFAULT_BUDGET_MS, 1500, '统计页那 1.5 秒不动：那是「别让手机上转圈」的约束');
  assert.ok(
    scheduler.PERIODIC_BUDGET_MS >= 20_000,
    `定期那一轮要能扫完积压（现在是 ${scheduler.PERIODIC_BUDGET_MS}ms）：占空比不到 1% 时几百条会话追不完`,
  );
  assert.ok(scheduler.PERIODIC_BUDGET_MS < scheduler.PERIODIC_INTERVAL_MS, '一轮不能长到吃掉下一个周期');

  // 定期那一路必须真的用大预算、并标成 periodic（否则它会把请求堵在后面）。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'stats-scheduler.cjs'), 'utf8');
  assert.match(source, /budgetMs: PERIODIC_BUDGET_MS/);
  assert.match(source, /periodic: true/);
  // 请求路径必须还是那个 1.5 秒，且**不**标 periodic（它就是那个「有人在等」的一侧）。
  const route = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'stats.js'), 'utf8');
  assert.match(route, /budgetMs: DEFAULT_BUDGET_MS/);
  assert.equal(/periodic/.test(route), false, '请求路径不设让位：它跑满自己的短预算');
});

test('定期那一轮遇到有人在等就让位，不把请求堵在 25 秒后面', async () => {
  await withHome(async () => {
    const now = Date.now();
    const items = Array.from({ length: 6 }, (_, index) => ({
      sessionId: `s${index}`,
      cwd: '/tmp/proj',
      updatedAt: now - 120_000,
    }));
    const projectionsById = {};
    const historyById = {};
    for (const item of items) {
      const log = eventLog(now - 60_000);
      log.turn().step({ input: 10, output: 1 });
      projectionsById[item.sessionId] = projectionOf(log.events);
      historyById[item.sessionId] = historyOf(log.events);
    }
    const ctx = fakeCtx({ items, projectionsById, historyById });
    // 每条会话要读一次事件（+ 读一次模型），这里只让历史慢一点，够长到让位发生。
    const slow = ctx.apiProxy.sessions.history;
    ctx.apiProxy.sessions.history = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return slow(request);
    };

    // 定期轮先跑起来（大预算），紧接着一个请求路径的短预算轮进来。
    const periodic = collectStats(ctx, { budgetMs: 30_000, periodic: true, force: true });
    // 让定期轮真的进到 worker 循环里，再插请求。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const request = collectStats(ctx, { budgetMs: 20, force: true });

    const startedAt = Date.now();
    await Promise.all([periodic, request]);
    const waited = Date.now() - startedAt;
    assert.ok(
      waited < 3_000,
      `请求不该等满定期那一轮的 30 秒预算（实际等了 ${waited}ms）`,
    );

    // 让位只是「少采几条」，不是丢数：事件游标是接着走的，下一轮一定补得上。
    await collectStats(ctx, { force: true, budgetMs: 30_000 });
    const book = ledger.readLedger();
    assert.equal(Object.keys(book.sessions).length, items.length, '让位之后下一轮把这些会话全补上');
    const total = Object.values(book.sessions).reduce((sum, row) => sum + row.billed.uncachedInputTokens, 0);
    assert.equal(total, items.length * 10, '一条都不重复记，也一条都不少');
  });
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

test('清理前补采（skipPreview）读一次事件折叠，跳过「最后一句」那次历史读', async () => {
  await withHome(async () => {
    let historyReads = 0;
    const items = [{ sessionId: 's1', title: 'x', updatedAt: Date.now() }];
    const ctx = fakeCtx({ items, projectionsById: { s1: tokenProjection(33, 3) } });
    const history = ctx.apiProxy.sessions.history;
    ctx.apiProxy.sessions.history = (request) => { historyReads += 1; return history(request); };

    const book = await collectStats(ctx, { force: true, skipPreview: true });

    assert.equal(historyReads, 1, '折叠读一次事件窗；skipPreview 不再为摘要多读一次');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 33, '数字照常入账');
    assert.equal(book.sessions.s1.lastText, '', '跳过预览就没有最后一句');
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
    // 回包之后那一发后台采集要等它落地再退出临时 DSH_HOME（见 settleWake）。
    await settleWake();
  });
  assert.equal(normalizeRange('999d'), '7d', '认不出来的范围退回七天');
  assert.equal(normalizeRange(undefined), '7d');
  assert.equal(normalizeRange('today'), 'today');
  assert.equal(normalizeRange('yesterday'), 'yesterday');
  assert.equal(normalizeRange('3d'), '3d');
});

test('路由：一发请求把六档全带回去（切标签不再发请求）', async () => {
  await withHome(async () => {
    const now = Date.now();
    const ctx = fakeCtx({ items: [{ sessionId: 's1', title: 'x', cwd: '/tmp/p', updatedAt: now }], projectionsById: { s1: tokenProjection(6, 3) } });
    await collectStats(ctx, { force: true });
    const req = { url: '/api/mobile/v1/stats/overview?range=today' };
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(payload) { this.body = JSON.parse(payload); } };
    await handleStatsOverview(ctx, req, res);

    assert.equal(res.body.overview.range, 'today');
    assert.ok(res.body.ranges && typeof res.body.ranges === 'object', '必须带上 ranges');
    assert.deepEqual(
      Object.keys(res.body.ranges).sort(),
      ['30d', '3d', '7d', 'all', 'today', 'yesterday'],
      '六档一档都不许少：少一档，App 切到它就还得再发一次请求',
    );
    // 请求那一档与顶层 overview 是同一份（经过序列化后比内容，不是比引用）。
    assert.deepEqual(res.body.ranges.today, res.body.overview, 'ranges 里那一档就是顶层那份，不另折一遍');
    for (const key of Object.keys(res.body.ranges)) {
      assert.equal(res.body.ranges[key].range, key, `${key} 那一份自己的 range 要对得上`);
    }
    // 窗口确实不一样：今天一天，近 30 天是三十天。
    assert.equal(res.body.ranges.today.days.length, 1);
    assert.equal(res.body.ranges['30d'].days.length, 30);
    await settleWake();
  });
});

test('路由：回包不等采集（账本是多少就给多少，采集在后台跑）', async () => {
  await withHome(async () => {
    const now = Date.now();
    // 宿主很慢：每条会话的投影要 200ms。要是还像以前那样先采一轮再回包，这一发必然拖到秒级。
    const ctx = fakeCtx({
      items: Array.from({ length: 6 }, (_, index) => ({
        sessionId: `s${index}`,
        title: `t${index}`,
        updatedAt: now,
      })),
      projectionsById: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`s${index}`, tokenProjection(10, 1)]),
      ),
    });
    const slow = ctx.apiProxy.sessions.projections;
    ctx.apiProxy.sessions.projections = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return slow(request);
    };

    const req = { url: '/api/mobile/v1/stats/overview?range=today' };
    const res = { status: null, body: null, writeHead(status) { this.status = status; }, end(payload) { this.body = JSON.parse(payload); } };
    const startedAt = Date.now();
    await handleStatsOverview(ctx, req, res);
    const elapsed = Date.now() - startedAt;

    assert.equal(res.status, 200);
    // 账本还是空的（没人采过），回包就该是空的 —— 不是「等采集采完再给」。
    assert.equal(res.body.overview.kpi.uncachedInputTokens, 0, '回包里是账本现状');
    assert.ok(elapsed < 150, `回包不许等采集（实际用了 ${elapsed}ms）`);

    // 回包之后那一轮确实在跑，跑完账本就有数了：下一次打开就看得见。
    await settleWake();
    const book = ledger.readLedger();
    assert.ok(Object.keys(book.sessions).length > 0, '后台那一轮把账本补上了');
  });
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
    await settleWake();
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
    // 决策：首采那笔不进按天账（见上一条），所以「只记一遍」看的是累计值。
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 100, '只该记一遍');
    assert.equal(book.sessions.s1.history.uncachedInputTokens, 100, '历史那一格也只记一遍');
    assert.deepEqual(book.days, {}, '首采不写按天账：并发两轮同样不许在那里落下任何量');
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

test('模型维度：一次采集把同一份事件同时记进按天账、会话账与模型桶', async () => {
  await withHome(async () => {
    const now = Date.now();
    const today = ledger.dayKeyOf(now);
    const log = eventLog(now);
    log.turn().step({ input: 100, output: 20, ms: 2000 });
    const ctx = fakeCtx({
      items: [{ sessionId: 's1', cwd: '/tmp/proj', updatedAt: now }],
      projectionsById: { s1: projectionOf(log.events) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
      historyById: { s1: historyOf(log.events) },
    });

    const book = await collectStats(ctx, { force: true });
    const key = 'p1\u0000m1';
    const bucket = book.models[key];
    assert.ok(bucket, '按「渠道 + 模型」建桶（模型来自 request/header）');
    assert.equal(bucket.providerName, '渠道一', '渠道名从宿主目录对上');
    assert.equal(bucket.modelName, '模型一');
    assert.equal(bucket.billed.uncachedInputTokens, 100);
    assert.equal(bucket.billed.outputTokens, 20);
    assert.equal(bucket.daily[today].outputTokens, 20, '按天明细与总量同一个日期');
    assert.ok(bucket.lastAt >= now, '最后活动时间记在事件发生那一刻');
    assert.equal(book.days[today].uncachedInputTokens, 100);
    assert.equal(book.days[today].requests, 1, 'requests 是真实请求条数');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 100);
    assert.equal(book.sessions.s1.model.provider, 'p1', '会话记录上落下认到的模型');
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

test('模型维度：事件里没有 request/header 就不往模型表里写，会话模型留空', async () => {
  await withHome(async () => {
    const now = Date.now();
    const log = eventLog(now);
    log.turn().step({ input: 30, output: 3, provider: null }); // 没有 header
    // 也不配 modelsById：宿主这一轮没给当前模型。
    const book = await collectStats(fakeCtx({
      items: [{ sessionId: 's1', updatedAt: now }],
      projectionsById: { s1: projectionOf(log.events) },
      historyById: { s1: historyOf(log.events) },
    }), { force: true });
    assert.deepEqual(book.models, {}, '宁可不记，也不造一个空渠道的垃圾桶');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 30, '数字照常入账');
    assert.equal(book.sessions.s1.model, null, '没模型就留空');
    assert.deepEqual(ledger.summarize(book, '7d', now).models, [], '没有桶时给空数组');
  });
});

test('老账本升级：没有 lastSeq 的记录按事件重算一遍，不叠加、不重复计', async () => {
  await withHome(async (home) => {
    const dayA = Date.UTC(2026, 9, 20, 4, 0);
    const dayB = Date.UTC(2026, 9, 21, 4, 0);
    const dayKeyA = ledger.dayKeyOf(dayA);
    const dayKeyB = ledger.dayKeyOf(dayB);
    // 升级前的账本：水位差口径把 300 / 60 记在 dayA（采集那天）——按天账与记录 daily 都是这笔。
    const billed = usage({ uncachedInputTokens: 300, outputTokens: 60, turns: 2, steps: 2 });
    const old = {
      version: 1,
      updatedAt: 0,
      days: { [dayKeyA]: { ...billed, requests: 2 } },
      sessions: {
        s1: {
          title: '老会话',
          firstAt: dayA,
          lastAt: dayA,
          collectedAt: 0,
          billed,
          daily: { [dayKeyA]: billed },
          watermark: billed,
        },
      },
      composition: null,
    };
    fs.writeFileSync(path.join(home, 'mobile-stats.json'), JSON.stringify(old));
    ledger.forgetLedger();

    // 真实事件：dayA 与 dayB 各一个 step，合计正好 300 / 60（与旧累计一样）。
    const log = eventLog(dayA);
    log.turn(1).step({ input: 150, output: 30, ms: 1000 });
    log.at(dayB).turn(2).step({ input: 150, output: 30, ms: 1000 });
    const ctx = fakeCtx({
      items: [{ sessionId: 's1', title: '老会话', updatedAt: dayB }],
      projectionsById: { s1: projectionOf(log.events) },
      modelsById: { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') },
      historyById: { s1: historyOf(log.events) },
    });

    const book = await collectStats(ctx, { force: true });
    const key = 'p1\u0000m1';
    // 关键：重算而不是叠加 —— 旧口径那 300 先被撤掉，再按事件记 150 + 150，仍然是 300。
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 300, '重算而不是叠加');
    assert.equal(book.sessions.s1.billed.outputTokens, 60);
    assert.equal(book.days[dayKeyA].uncachedInputTokens, 150, 'dayA 只剩事件真实的那 150');
    assert.equal(book.days[dayKeyB].uncachedInputTokens, 150, 'dayB 按事件真实日入账');
    assert.equal(book.days[dayKeyA].requests, 1, '旧口径记的 2 次请求也撤掉了，不是 2+1');
    assert.equal(book.models[key].billed.uncachedInputTokens, 300, '模型按 header 归因，一份');
    assert.equal(book.sessions.s1.model.provider, 'p1');

    // 再采一轮：游标已推进、事件没新增，绝不翻倍。
    const again = await collectStats(ctx, { force: true });
    assert.equal(again.sessions.s1.billed.uncachedInputTokens, 300, '第二次不翻倍');
    assert.equal(again.models[key].billed.uncachedInputTokens, 300);
    assert.equal(again.days[dayKeyA].uncachedInputTokens, 150);
  });
});

test('老账本升级：模型按天明细落在事件真实日，窄范围里与 KPI 同数', async () => {
  const priced = { provider: 'p1', providerName: '渠道', model: 'm1', modelName: '模型' };
  await withHome(async (home) => {
    const now = Date.now();
    const oldAt = now - 20 * 86400000;
    const recentAt = now - 2 * 86400000;
    const oldDay = ledger.dayKeyOf(oldAt);
    // 升级前的账本：累计 10M 全压在 oldDay（老口径只知道采集那天），没有模型这一栏。
    const billed = usage({ uncachedInputTokens: 10_000_000, turns: 4 });
    const old = {
      version: 1,
      updatedAt: 0,
      days: { [oldDay]: { ...billed, requests: 4 } },
      sessions: {
        s1: {
          title: '老会话',
          firstAt: oldAt,
          lastAt: recentAt,
          collectedAt: 0,
          billed,
          daily: { [oldDay]: billed },
          watermark: billed,
        },
      },
      composition: null,
    };
    fs.writeFileSync(path.join(home, 'mobile-stats.json'), JSON.stringify(old));
    ledger.forgetLedger();

    // 真实事件：20 天前 9M、2 天前 1M —— 折叠后按事件真实日摊开。
    const log = eventLog(oldAt);
    log.turn(1).step({ input: 9_000_000, output: 0, ms: 1000, provider: priced.provider, model: priced.model });
    log.at(recentAt).turn(2).step({ input: 1_000_000, output: 0, ms: 1000, provider: priced.provider, model: priced.model });
    const ctx = fakeCtx({
      items: [{ sessionId: 's1', updatedAt: recentAt }],
      projectionsById: { s1: projectionOf(log.events) },
      modelsById: { s1: modelCatalog(priced.provider, priced.model, priced.providerName, priced.modelName) },
      historyById: { s1: historyOf(log.events) },
    });
    const book = await collectStats(ctx, { force: true });

    const week = ledger.summarize(book, '7d', now);
    assert.equal(week.kpi.uncachedInputTokens, 1_000_000, '7d 只有两天前那一笔');
    assert.equal(week.models.length, 1, '模型行照常出现');
    assert.equal(week.models[0].billedTokens, 1_000_000, '模型行与 KPI 同一个数，不是整段累计');
    const all = ledger.summarize(book, 'all', now);
    assert.equal(all.models[0].billedTokens, 10_000_000, '全部那档仍是累计，一笔不少');
  });
});

test('已有模型的会话：某轮 window 里没有 header，那一截仍沿用记录上已知的模型', async () => {
  await withHome(async () => {
    const now = Date.now();
    const catalog = { s1: modelCatalog('p1', 'm1', '渠道一', '模型一') };
    // 第一轮：一个带 header 的 step，110 记进 p1/m1，记录上落下已知模型。
    const firstLog = eventLog(now - 60_000);
    firstLog.turn().step({ input: 110, output: 0, ms: 1000 });
    const first = await collectStats(fakeCtx({
      items: [{ sessionId: 's1', updatedAt: now - 60_000 }],
      projectionsById: { s1: projectionOf(firstLog.events) },
      modelsById: catalog,
      historyById: { s1: historyOf(firstLog.events) },
    }), { force: true });
    assert.equal(first.models['p1\u0000m1'].billed.uncachedInputTokens, 110);
    assert.equal(first.sessions.s1.model.model, 'm1', '记录上留着已知模型');

    // 第二轮：又来一个 step（+220），但这一轮窗口里没有 request/header，而且宿主 models 也读不到。
    const secondLog = eventLog(now - 60_000);
    secondLog.turn().step({ input: 110, output: 0, ms: 1000 });
    secondLog.at(now).turn(2).step({ input: 220, output: 0, ms: 1000, provider: null });
    const second = await collectStats(fakeCtx({
      items: [{ sessionId: 's1', updatedAt: now }],
      projectionsById: { s1: projectionOf(secondLog.events) },
      historyById: { s1: historyOf(secondLog.events) },
    }), { force: true });
    assert.equal(second.sessions.s1.billed.uncachedInputTokens, 330, '会话与按天账照常入账');
    assert.equal(
      second.models['p1\u0000m1'].billed.uncachedInputTokens,
      330,
      '没有 header 就沿用已知模型，那一截不许停在模型卡与成本之外',
    );
    const all = ledger.summarize(second, 'all', now);
    assert.equal(all.models[0].billedTokens, ledger.billedOf(all.kpi), '模型行加起来等于总量');
  });
});

test('trim 瘦身过的按天明细不会在读盘时长回来（`daily: {}` 不是「老账本缺这一栏」）', async () => {
  await withHome(async (home) => {
    const longAgo = Date.now() - 100 * 86400000;
    const book = bookWith([{ sessionId: 'old', at: longAgo, delta: usage({ uncachedInputTokens: 40, turns: 2 }) }]);
    book.sessions.old.watermark = usage({ uncachedInputTokens: 40, turns: 2 });
    ledger.trim(book);
    assert.deepEqual(book.sessions.old.daily, {}, '瘦身之后没有明细');
    ledger.saveLedger(book);
    ledger.forgetLedger();
    assert.ok(fs.existsSync(path.join(home, 'mobile-stats.json')));

    const reread = ledger.readLedger();
    assert.deepEqual(reread.sessions.old.daily, {}, '读盘不替它编一天：编了卡片就会大于总量');
    assert.equal(ledger.summarize(reread, 'all', Date.now()).sessions[0].billedTokens, 40, '累计值照旧给得出');
    // 「all」用累计值；按范围看时它本来就不该出现，差额由 untrackedBilled 交代。
    const week = ledger.summarize(reread, '30d', Date.now());
    assert.equal(week.sessions.length, 0);
    assert.equal(week.untrackedBilled, ledger.billedOf(week.kpi), '按天账上的量由差额交代');
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

test('成本估算已经拆掉：总览与模型行都不再带金额字段', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0);
  const book = bookWith([
    {
      sessionId: 's1',
      at: now,
      model: { provider: 'deepseek', providerName: '渠道', model: 'deepseek-chat', modelName: '模型' },
      delta: usage({ uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }),
    },
  ]);
  const overview = ledger.summarize(book, '7d', now);
  assert.equal(overview.models.length, 1);
  assert.equal('cost' in overview, false, '总览不再带估算金额');
  assert.equal('cost' in overview.models[0], false, '模型行也不再带金额');
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

/* --------------------------------------------------------------------------------------------
 * 设计文件「守卫」一节的五条：事件折叠的四条硬约束 + 断层补齐
 * ------------------------------------------------------------------------------------------ */

test('守卫·跨零点：两条 assistant/message 分属两天，各记各的日期', () => {
  // 用本地时间构造（dayKeyOf 走本地时区）：23:50 与次日 00:10 只差 20 分钟，但必须落在两天。
  const late = new Date(2026, 9, 20, 23, 50).getTime();
  const next = new Date(2026, 9, 21, 0, 10).getTime();
  const fold = foldSessionEvents([
    { seq: 0, type: 'assistant/message', time: late, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } },
    { seq: 1, type: 'assistant/message', time: next, data: { turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 2 } } },
  ], {});
  assert.equal(Object.keys(fold.usageByDay).length, 2, '跨零点就是两天');
  assert.equal(fold.usageByDay[ledger.dayKeyOf(late)].uncachedInputTokens, 10);
  assert.equal(fold.usageByDay[ledger.dayKeyOf(next)].uncachedInputTokens, 20);
});

test('守卫·同一会话未变时不重复折叠：lastSeq 之后没有事件就什么都不记', () => {
  const now = Date.now();
  const log = eventLog(now);
  log.turn().step({ input: 50, output: 5 });
  const first = foldSessionEvents(log.events, { lastSeq: -1 });
  assert.equal(first.total.uncachedInputTokens, 50);
  // 拿第一次的游标再折同一段：seq > lastSeq 的事件一个都没有，不能把同一段记两遍。
  const again = foldSessionEvents(log.events, { lastSeq: first.lastSeq });
  assert.deepEqual(again.usageByDay, {}, '游标之后没有新事件');
  assert.equal(again.lastSeq, first.lastSeq, '游标不倒退');
});

test('守卫·request/header 的模型落到正确的 assistant/message 上', () => {
  const now = Date.now();
  const log = eventLog(now);
  log.turn().step({ step: 1, input: 10, output: 1, provider: 'pA', model: 'mA', ms: 500 });
  log.step({ step: 2, input: 20, output: 2, provider: 'pB', model: 'mB', ms: 500 });
  const fold = foldSessionEvents(log.events, { lastSeq: -1 });
  const day = fold.modelUsageByDay[ledger.dayKeyOf(now)];
  assert.equal(day[ledger.modelKeyOf('pA', 'mA')].usage.uncachedInputTokens, 10, '第一条归 pA/mA');
  assert.equal(day[ledger.modelKeyOf('pB', 'mB')].usage.uncachedInputTokens, 20, '第二条归 pB/mB');
  assert.equal(fold.model.provider, 'pB', '折叠结束时认到的模型是最后一条 header 的');
});

test('守卫·首采历史不污染当天：翻得到的历史按真实旧日，翻不到的进 history', async () => {
  await withHome(async () => {
    const oldAt = Date.now() - 10 * 86400000;
    const log = eventLog(oldAt);
    log.turn().step({ input: 100, output: 0 });
    // 宿主累计 300：只有 100 能翻到（10 天前的 step），剩下 200 是更老、翻不到的历史。
    const ctx = fakeCtx({
      items: [{ sessionId: 's1', updatedAt: oldAt }],
      projectionsById: {
        s1: { tokenUsage: { uncachedInputTokens: 300 }, sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 } },
      },
      historyById: { s1: historyOf(log.events) },
    });
    const book = await collectStats(ctx, { force: true });
    const today = ledger.dayKeyOf(Date.now());
    assert.equal(book.days[today], undefined, '当天不许被历史量污染');
    assert.equal(book.days[ledger.dayKeyOf(oldAt)].uncachedInputTokens, 100, '翻得到的那段落在真实旧日');
    assert.equal(book.sessions.s1.history.uncachedInputTokens, 200, '翻不到的那段进 history（无日期）');
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 300, '累计仍是宿主口径');
    assert.equal(ledger.summarize(book, '7d', Date.now()).kpi.uncachedInputTokens, 0, '近 7 天不受影响');
  });
});

test('守卫·断层靠 beforeSeq 补齐：跨过窗口的一整段事件不重复、不少记', async () => {
  await withHome(async () => {
    const base = Date.now() - 3600_000;
    const full = [];
    let seq = 0;
    for (let index = 0; index < 300; index += 1) {
      const time = base + index * 1000;
      const data = { turn: index + 1, step: 1 };
      full.push({ seq: seq++, type: 'turn/start', time, data: { turn: index + 1 } });
      full.push({ seq: seq++, type: 'step/start', time, data });
      full.push({ seq: seq++, type: 'request/header', time, data: { header: { config: { provider: 'p1', model: 'm1' } } } });
      full.push({ seq: seq++, type: 'assistant/message', time, data: { turn: index + 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } });
      full.push({ seq: seq++, type: 'step/end', time, data });
    }
    const total = full.length; // 1500 条事件、300 个 step

    // 第一轮只让它看到前 500 条（前 100 个 step）—— 游标停在中段。
    const firstCtx = fakeCtx({
      items: [{ sessionId: 's1', updatedAt: base }],
      projectionsById: { s1: projectionOf(full.slice(0, 500)) },
      historyById: { s1: { events: full.slice(0, 500).map((event) => ({ event })), hasMore: false } },
    });
    await collectStats(firstCtx, { force: true });
    const afterFirst = ledger.readLedger();
    assert.equal(afterFirst.sessions.s1.billed.uncachedInputTokens, 100, '第一轮折了前 100 个 step');

    // 第二轮：整段事件都在，但尾部窗口（400）够不到游标 —— 必须靠 beforeSeq 往旧翻补齐。
    const secondCtx = fakeCtx({
      items: [{ sessionId: 's1', updatedAt: base + 300 * 1000 }],
      projectionsById: { s1: projectionOf(full) },
      historyById: { s1: pagedHistory(full) },
    });
    const book = await collectStats(secondCtx, { force: true });
    assert.equal(book.sessions.s1.billed.uncachedInputTokens, 300, '300 个 step 全部入账，既不重复也不少记');
    assert.equal(total, 1500, '前提：整段 1500 条事件跨过了尾部窗口');
    const dayTotal = Object.values(book.days).reduce((sum, day) => sum + day.requests, 0);
    assert.equal(dayTotal, 300, '按天账上的请求数也是 300，没有把同一段折两遍');
  });
});

test('读盘：老账本 daily 缺 requests 时不补 0，撤销才能按 steps 的口径算回去', () => {
  // 坑：`sanitizeDailyUsage` 若给缺失的 `requests` 补成 0，`resetSessionUsage` 就分不出
  // 「老账本没有这一栏」与「这一天真的 0 次请求」，撤销时那笔请求数会永远留在按天账上 ——
  // 升级重算一次就多一截。这里直接钉住「缺就让它缺着」。
  const day = '2026-10-20';
  const book = ledger.sanitizeLedger({
    version: 1,
    days: { [day]: { uncachedInputTokens: 300, steps: 2, requests: 2 } },
    // 老账本：daily 里只有四桶与 steps，没有 requests。
    sessions: { s1: { billed: { uncachedInputTokens: 300, steps: 2 }, daily: { [day]: { uncachedInputTokens: 300, steps: 2 } } } },
    models: {},
    composition: null,
  });
  assert.equal(book.sessions.s1.daily[day].requests, undefined, '缺这一栏就让它缺着，不补 0');
  assert.equal(book.sessions.s1.daily[day].steps, 2, 'steps 照旧读得出来');

  // 新口径写进去的那一天，requests 正常落盘、读盘也在。
  const fresh = ledger.sanitizeLedger({
    version: 1,
    days: {},
    sessions: { s2: { billed: {}, daily: { [day]: { outputTokens: 5, steps: 1, requests: 3 } } } },
    models: {},
    composition: null,
  });
  assert.equal(fresh.sessions.s2.daily[day].requests, 3, '新账本的 requests 原样读回');
});

// ── 2026-11-10：记录池淘汰先删「日志还在」的那些 ────────────────────────────────
// 用户反馈「归档之后有时还会删除，删掉之后那些数据就没了」。`gone` 的记录背后已经
// 没有任何日志，删了就是永久丢；活着的会话删了还能从日志重采。所以淘汰顺序换成
// 「先删活的、最老先走」，`gone` 只在超过一半上限时才开始动。
test('记录池淘汰：先删活的记录，已删除会话（gone）排在后面', () => {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  const baseAt = Date.UTC(2026, 9, 1);
  const half = ledger.MAX_RECORDS;
  // 一半 gone（日志已经没有了，删了就永久丢）+ 一半活的，都塞到超上限。
  for (let index = 0; index < half; index += 1) {
    ledger.applyDelta(book, { sessionId: `gone${index}`, at: baseAt + index * 60000, delta: usage({ uncachedInputTokens: 1 }) });
    book.sessions[`gone${index}`].gone = true;
  }
  for (let index = 0; index < half + 12; index += 1) {
    ledger.applyDelta(book, { sessionId: `live${index}`, at: baseAt + index * 60000, delta: usage({ uncachedInputTokens: 1 }) });
  }
  const total = Object.keys(book.sessions).length;
  assert.ok(total > ledger.MAX_RECORDS, '先确认这一轮确实超了上限');

  ledger.trim(book);

  assert.equal(Object.keys(book.sessions).length, ledger.MAX_RECORDS, '仍然只留上限那么多条');
  const remaining = Object.keys(book.sessions);
  assert.equal(remaining.filter((id) => id.startsWith('live')).length, 0,
    '活的记录先被删干净（它们有日志，删了还能重采）');
  assert.equal(remaining.filter((id) => id.startsWith('gone')).length, ledger.MAX_RECORDS,
    'gone 的记录一条不动：它们的日志已经没了，删掉就是永久丢');
  assert.ok(book.sessions.gone0, '最老的 gone 也留着');
  assert.equal(book.sessions.live0, undefined, '最老的活的先走');
});

// 全账本都是 gone 时仍要有个封顶，否则长期使用会被永不变化的记录填满。
test('记录池淘汰：gone 超过一半上限时才开始按最老先删，且留住最新的那一半', () => {
  const book = { version: 1, updatedAt: 0, days: {}, sessions: {}, composition: null };
  const baseAt = Date.UTC(2026, 9, 1);
  const total = ledger.MAX_RECORDS + 100;
  for (let index = 0; index < total; index += 1) {
    ledger.applyDelta(book, { sessionId: `g${index}`, at: baseAt + index * 60000, delta: usage({ uncachedInputTokens: 1 }) });
    book.sessions[`g${index}`].gone = true;
  }

  ledger.trim(book);

  assert.equal(Object.keys(book.sessions).length, ledger.MAX_RECORDS, '按上限留');
  const kept = Object.keys(book.sessions).map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  assert.equal(kept[0], total - ledger.MAX_RECORDS, '留下的是最新的那批，最老的先走');
});

// ── 2026-11-10：`seenSeq` 落盘 ───────────────────────────────────────────────
// 采集靠「`lastSeq` 追上 `seenSeq`」判断这条会话真没有新事件，才允许跳过。这个字段
// 必须读盘后还在，否则重启一次就退化成「没有可信游标」，等于每轮都白读一遍历史。
test('seenSeq 落盘并读回：老账本没有这一栏按 0 处理（升级后第一轮必真读）', () => {
  const day = '2026-11-10';
  const book = ledger.sanitizeLedger({
    version: 1,
    days: {},
    sessions: {
      fresh: { billed: {}, daily: {}, lastSeq: 42, seenSeq: 42 },
      // 升级前写的记录：只有 lastSeq，没有 seenSeq。
      old: { billed: {}, daily: {}, lastSeq: 900 },
    },
    models: {},
    composition: null,
  });
  assert.equal(book.sessions.fresh.seenSeq, 42, 'seenSeq 原样读回');
  assert.equal(book.sessions.old.seenSeq, 0, '缺这一栏就是 0（没有可信游标，不跳过）');
  assert.equal(book.sessions.old.lastSeq, 900, 'lastSeq 不受影响');
  // 空记录的初始形状也要带上它。
  assert.equal(ledger.emptySession(Date.now()).seenSeq, 0, 'emptySession 带这一栏');
  assert.equal(day === '2026-11-10', true);
});

test('跳过采集的判据必须看磁盘：摘要与游标都停在旧值、日志却一直在写时不许跳过', async () => {
  // 2026-11-13：真账本上 1134 条活会话里 779 条的 `seenUpdatedAt` 停在最后提示那一刻，
  // 其中 393 条日志在那之后仍在增长。摘要 `updatedAt` 不变、游标也追平，两个判据同时成立，
  // 这条会话于是被永久跳过 —— 那一截用量永远记不上，页面上就是「统计不全」。
  await withHome(async (home) => {
    // 日志目录照宿主的布局摆：sessions/<cwd 目录>/<sessionId>/session.v4.jsonl.zstd。
    const directory = path.join(home, 'sessions', '--tmp-proj--', 's1');
    fs.mkdirSync(directory, { recursive: true });
    const logFile = path.join(directory, 'session.v4.jsonl.zstd');
    fs.writeFileSync(logFile, 'v1');

    const start = Date.now() - 200_000;
    const first = eventLog(start);
    first.turn(1).step({ turn: 1, step: 1, input: 10, output: 1 });
    const items = [{ sessionId: 's1', cwd: '/tmp/proj', updatedAt: start }];

    // 宿主的 history：内容由闭包里的 `all` 决定，好让「日志后来又写了」表现为真实的事件增量。
    let all = first.events;
    let reads = 0;
    const ctx = fakeCtx({ items, projectionsById: { s1: projectionOf(first.events) } });
    ctx.apiProxy.sessions.history = () => {
      reads += 1;
      return { result: { ok: true, value: { events: all.map((event) => ({ event })) } } };
    };

    // 第一轮：真读一遍，把游标与日志指纹都建起来。
    await collectStats(ctx, { force: true });
    assert.ok(reads > 0, '第一轮读到它');
    const book = ledger.readLedger();
    assert.ok(book.sessions.s1.seenLogSize > 0, '日志指纹落盘');
    assert.ok(book.sessions.s1.seenLogMtime > 0, '修改时刻也落盘');

    // 两轮之间把 `collectedAt` 拨老：真实场景是「上一轮采集已经过去几分钟」，而 `force`
    // 会跳过 60 秒最小间隔那条路 —— 这里要测的是**跳过判据**本身，不是那条节流。
    const ageOut = () => {
      const current = ledger.readLedger();
      current.sessions.s1.collectedAt = Date.now() - 120_000;
      ledger.saveLedger(current);
    };

    // 第二轮：日志一个字节都没变，摘要与游标也都停着 —— 这一轮可以跳过（空闲时不该反复解日志）。
    const settled = reads;
    ageOut();
    await collectStats(ctx, {});
    assert.equal(reads, settled, '日志没长过就不读事件');

    // 第三轮：摘要 `updatedAt` 一点没变、游标也追平了上一轮，日志却继续写 —— 旧判据这时会
    // 跳过；新判据必须发现磁盘变了，把新事件折进来。
    // 第二段事件的 seq 必须接在第一段后面（同一个会话的日志是一条连续的序号流）。
    const offset = first.events[first.events.length - 1].seq + 1;
    const second = eventLog(start + 100_000);
    second.turn(2).step({ turn: 2, step: 1, input: 777, output: 33 });
    const tail = second.events.map((event) => ({ ...event, seq: event.seq + offset }));
    all = first.events.concat(tail);
    fs.writeFileSync(logFile, 'v2-much-longer');
    ageOut();
    await collectStats(ctx, {});
    assert.ok(reads > settled, '日志长过就必须真读一遍');
    const after = ledger.readLedger();
    const expected = ledger.num(first.events[first.events.length - 1].seq);
    assert.ok(after.sessions.s1.lastSeq > expected, '游标推进到新事件');
  });
});

test('定期采集一轮只翻有限页，有人打开统计页那一轮才翻到底', async () => {
  // 600 个 step × 4 条事件 = 2400 条，按 400 一页要翻 6 页才到底。首采（没有游标）才会往旧翻，
  // 所以两条路各用一个干净的账本跑一遍。
  const build = () => {
    const log = eventLog(Date.now() - 60 * 60 * 1000);
    for (let index = 0; index < 600; index += 1) log.turn().step({ input: 10, output: 1 });
    const reads = [];
    const ctx = fakeCtx({
      items: [{ sessionId: 's1', title: '大会话', cwd: '/tmp/proj', updatedAt: Date.now() }],
      projectionsById: { s1: projectionOf(log.events) },
      historyById: {
        s1: (request) => {
          reads.push(request.payload.beforeSeq || 0);
          return pagedHistory(log.events)(request);
        },
      },
    });
    // 往旧翻的次数 = 带 beforeSeq 的那些读（首窗那一发与「最后一句」预览都不带）。
    return { ctx, paged: () => reads.filter((beforeSeq) => beforeSeq > 0).length };
  };

  await withHome(async () => {
    const { ctx, paged } = build();
    await collectStats(ctx, { periodic: true, budgetMs: 25_000 });
    assert.equal(
      paged(),
      3,
      `定期那一轮最多往旧翻 3 页，实际翻了 ${paged()} 页 —— 一次翻到底就是把宿主压住的那种写法`,
    );
  });

  await withHome(async () => {
    const { ctx, paged } = build();
    await collectStats(ctx, { force: true });
    assert.ok(
      paged() > 3,
      `有人正等着看数字（短预算轮）必须用完整的 20 页上限，实际只翻了 ${paged()} 页`,
    );
  });
});

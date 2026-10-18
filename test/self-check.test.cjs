'use strict';

/**
 * 内存自检台账的守卫。
 *
 * 这份台账是「事后排查内存」的唯一抓手，所以它有两个比功能本身更要紧的性质，都在这里钉死：
 *
 *   1. **口径不许被包装**：插件住在宿主进程里，没有独立内存可测。`hostProcess` 报的是
 *      **整个宿主进程**，不是「插件占了多少」。谁把 `scope` 改成 `plugin`、把 caveat 删掉，
 *      下一个看这个数的人就会把 3.5G 读成「插件吃了 3.5G」——那是错的结论。这条断言就是
 *      防这个的。
 *   2. **「不知道」不许写成 0**：0 是「一条流都没有 / 一次都没跳过」，与「拿不到这个数」
 *      在排查时结论正好相反。拿不到一律 `null` + 记进 `unavailable`。
 *
 * 另外照 `desktop-half-stats.test.cjs` 的做法钉**源码契约**：control-plane 与 impl.js
 * 真的接上了这套取值器（「加了模块但忘了接线」会让台账永远全 0，比没有台账更误导人）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSelfCheck, estimateBytes } = require('../lib/mobile/self-check.cjs');
const { mirrorHistoryStateOf } = require('../lib/mobile/session-cache.js');
const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');
const IMPL = path.join(__dirname, '..', 'lib', 'impl.js');

/** 把 fake ctx 的镜像缓存塞成「两条会话、各 200 条消息」。 */
function seedMirrorCache(ctx, sessions = 2, messagesPerSession = 200) {
  const cache = mirrorHistoryStateOf(ctx);
  cache.clear();
  for (let index = 0; index < sessions; index += 1) {
    const items = [];
    for (let seq = 0; seq < messagesPerSession; seq += 1) {
      items.push({ seq, role: 'assistant', text: 'x'.repeat(50) });
    }
    cache.set(`session-${index}`, { fingerprint: 'f', at: Date.now(), body: { ok: true, items, lastSeq: messagesPerSession } });
  }
  return cache;
}

const FULL_DEPS = (ctx) => ({
  ctx,
  getSidecarSnapshot: () => ({
    process: { memoryUsage: { rss: 1234, heapUsed: 100, heapTotal: 200, external: 5, arrayBuffers: 7 } },
    streams: { relaySseOpen: 3 },
  }),
  getLanProxyStats: () => ({ upstreamOpen: 11, sseOpen: 4 }),
  getMirrorPush: () => ({ pushedAt: 1700000000000, ok: true, error: null, skippedBodies: 2, skipReason: 'body missing' }),
  getMirrorPushFailures: () => [{ sessionId: 'a' }, { sessionId: 'b' }],
  credentials: { listActive: () => [{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }] },
});

test('宿主内存那一块如实标注「宿主进程」口径，不许被包装成「插件内存」', () => {
  const body = createSelfCheck(FULL_DEPS({})).snapshot();
  assert.equal(body.hostProcess.scope, 'host-process', 'scope 必须说明这是宿主进程，不是插件自己');
  assert.match(body.hostProcess.caveat, /宿主/, 'caveat 必须写明这里报的是宿主进程');
  assert.match(body.hostProcess.caveat, /没有独立内存|不是插件/, 'caveat 必须写明插件没有独立内存可测');
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers', 'heapSizeLimit']) {
    assert.equal(Number.isFinite(body.hostProcess[key]), true, `${key} 必须是有限数（进程内存总是可测的）`);
  }
  assert.ok(body.hostProcess.rss > 0, 'rss 应当来自真实的 process.memoryUsage()');
  assert.ok(body.hostProcess.heapSizeLimit > 0, 'heapSizeLimit 应当来自 v8.getHeapStatistics()');
});

test('字段是白名单：status 视图里只出现约定的那些键，不整块透传任何入参', () => {
  const deps = FULL_DEPS({});
  // 塞一些不该出现的东西：有没有 ctx、原始快照对象、注入项本身。
  deps.getSidecarSnapshot = () => ({
    process: { memoryUsage: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1, arrayBuffers: 1 } },
    streams: { relaySseOpen: 1 },
    secret: { token: 'should-not-leak' },
    lan: { pairingCode: '123456' },
  });
  const body = createSelfCheck(deps).snapshot();
  assert.deepEqual(
    Object.keys(body).sort(),
    ['credentials', 'hostProcess', 'mirror', 'sidecarProcess', 'since', 'streams', 'unavailable'],
    '顶层键集变了：新增字段要想清楚是不是要给手机面板看',
  );
  assert.deepEqual(
    Object.keys(body.hostProcess).sort(),
    ['arrayBuffers', 'caveat', 'external', 'heapSizeLimit', 'heapTotal', 'heapUsed', 'rss', 'scope', 'startedAt'],
  );
  assert.deepEqual(
    Object.keys(body.sidecarProcess.memory).sort(),
    ['arrayBuffers', 'external', 'heapSizeLimit', 'heapTotal', 'heapUsed', 'rss'],
  );
  assert.equal(JSON.stringify(body).includes('should-not-leak'), false, '原始快照里的东西不许整块透传进来');
  assert.equal(JSON.stringify(body).includes('123456'), false, '配对码这类字段不许被带进来');
});

test('快照是副本：调用方改它，不影响下一次读取', () => {
  const check = createSelfCheck(FULL_DEPS({}));
  const first = check.snapshot();
  first.hostProcess.rss = -1;
  first.streams.relaySseOpen = -1;
  first.mirror.cachedSessions = -1;
  first.unavailable.push('编的');
  const second = check.snapshot();
  assert.notEqual(second.hostProcess.rss, -1);
  assert.notEqual(second.mirror.cachedSessions, -1);
  assert.equal(second.streams.relaySseOpen, 3);
  assert.equal(second.unavailable.some((item) => item === '编的'), false, 'unavailable 也必须每次新建');
});

test('「拿不到」报 null 并记进 unavailable，绝不拿 0 顶替', () => {
  const body = createSelfCheck({}).snapshot();  // 什么依赖都没给
  assert.equal(body.sidecarProcess.memory, null);
  assert.equal(body.streams.relaySseOpen, null);
  assert.equal(body.streams.lanUpstreamOpen, null);
  assert.equal(body.streams.lanSseOpen, null);
  assert.equal(body.mirror.pushedAt, null, '拿不到镜像记账时不能报 0：0 会被读成「从来没推过」');
  assert.equal(body.mirror.skippedBodies, null);
  assert.equal(body.mirror.pushFailures, null);
  assert.equal(body.mirror.cachedSessions, null);
  assert.equal(body.credentials.active, null);
  // 每一处「不知道」都必须能在 unavailable 里找到对应字段名。
  const joined = body.unavailable.join('\n');
  for (const field of ['sidecarProcess.memory', 'streams.relaySseOpen', 'streams.lanUpstreamOpen',
    'mirror.cachedSessions', 'mirror.pushedAt', 'mirror.pushFailures', 'credentials.active']) {
    assert.ok(joined.includes(field), `unavailable 里没有说明 ${field} 为什么是空的`);
  }
});

test('接入真值时不报 unavailable，且数字真的来自依赖', () => {
  const ctx = {};
  const cache = seedMirrorCache(ctx, 2, 200);
  const body = createSelfCheck(FULL_DEPS(ctx)).snapshot();
  assert.equal(body.sidecarProcess.memory.rss, 1234);
  assert.equal(body.streams.relaySseOpen, 3);
  assert.equal(body.streams.lanUpstreamOpen, 11);
  assert.equal(body.streams.lanSseOpen, 4);
  assert.equal(body.mirror.pushedAt, 1700000000000);
  assert.equal(body.mirror.ok, true);
  assert.equal(body.mirror.skippedBodies, 2);
  assert.equal(body.mirror.pushFailures, 2);
  assert.equal(body.mirror.cachedSessions, 2, '镜像缓存条目数要读的是 ctx 上那张真表');
  assert.equal(body.mirror.cachedMessages, 400);
  assert.ok(body.mirror.cachedBytes > 400 * 50, '估算字节至少要覆盖消息正文');
  assert.equal(body.credentials.active, 3);
  assert.deepEqual(body.unavailable, []);
  cache.clear();
});

test('非法入参不让任何数字变成 NaN（NaN 会让「有没有在涨」彻底失效）', () => {
  const body = createSelfCheck({
    ctx: {},
    getSidecarSnapshot: () => ({ process: { memoryUsage: { rss: 'x', heapUsed: NaN, heapTotal: undefined, external: Infinity, arrayBuffers: null } }, streams: { relaySseOpen: 'many' } }),
    getLanProxyStats: () => ({ upstreamOpen: NaN, sseOpen: 'x' }),
    getMirrorPush: () => ({ pushedAt: 'x', ok: 'yes', skippedBodies: NaN }),
    getMirrorPushFailures: () => 'not-an-array',
    credentials: { listActive: () => 'nope' },
  }).snapshot();
  const numbers = [];
  const collect = (value) => {
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') {
        if (Array.isArray(item)) for (const entry of item) numbers.push([key, entry]);
        else collect(item);
      } else numbers.push([key, item]);
    }
  };
  collect(body);
  for (const [key, item] of numbers) {
    if (typeof item === 'number') {
      assert.equal(Number.isFinite(item), true, `${key} 变成了 ${item}`);
      continue;
    }
    // 允许的值只有：null（拿不到）、字符串（错误原因一类）、布尔（cachedBytesComplete）。
    assert.equal(item === null || typeof item === 'string' || typeof item === 'boolean', true,
      `${key} 是意料之外的类型：${typeof item}`);
  }
  assert.equal(body.mirror.ok, null, '非布尔不许当成 true/false');
  assert.equal(body.mirror.pushFailures, null);
  assert.equal(body.credentials.active, null);
  assert.equal(body.streams.relaySseOpen, null);
});

test('镜像缓存估算：规模对得上，节点预算用尽时如实标成下限', () => {
  const small = estimateBytes({ items: [{ text: 'a'.repeat(100) }] });
  assert.equal(small.complete, true);
  assert.ok(small.bytes > 100, `估算没过正文长度：${small.bytes}`);

  const huge = estimateBytes({ items: Array.from({ length: 5000 }, () => ({ text: 'y'.repeat(20) })) }, 500);
  assert.equal(huge.complete, false, '节点预算用尽必须标成不完整（此时数字是下限，不是总量）');
  assert.ok(huge.bytes > 0);

  const cycle = { name: 'loop' };
  cycle.self = cycle;
  const cycled = estimateBytes(cycle);
  assert.equal(cycled.complete, true, '自引用不许把估算挂死');
});

/** 每条路由：`path` 后面到下一个 `path:` 之前的那段 handler（与 desktop-half-stats.test.cjs 同法）。 */
function routeSegments(source) {
  const hits = [...source.matchAll(/path:\s*'([^']+)'/g)];
  return hits.map((m, i) => ({
    path: m[1],
    handler: source.slice(m.index + m[0].length, i + 1 < hits.length ? hits[i + 1].index : source.length),
  }));
}

test('status 路由真的带出了台账（加了模块没接线 = 台账永远全空，比没有更误导）', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  assert.ok(source.includes("require('../mobile/self-check.cjs')"), 'control-plane 没引台账模块');
  const segments = new Map(routeSegments(source).map((r) => [r.path, r.handler]));
  const status = segments.get('/api/relay/status');
  assert.ok(status, '控制面少了 /api/relay/status');
  assert.ok(status.includes('selfCheck: selfCheck.snapshot()'), '/api/relay/status 的返回体里没有 selfCheck');
});

test('装配层把四个取值器真的转交下去了（台账拿不到 ctx 之外的就等于空壳）', () => {
  const src = fs.readFileSync(IMPL, 'utf8');
  for (const wiring of [
    /getSidecarSnapshot:\s*sidecarLifecycle\.getSnapshot/,
    /getMirrorPush:\s*mirror\.getMirrorPush/,
    /getMirrorPushFailures:\s*mirror\.getPushFailures/,
    /getLanProxyStats:/,
  ]) {
    assert.match(src, wiring, `impl.js 没把取值器转交给控制面：${wiring}`);
  }
});

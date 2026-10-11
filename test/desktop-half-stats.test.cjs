'use strict';

/**
 * 客户端半边活体台账的守卫。
 *
 * 绿点的两条同步通道（手机读过 → 桌面灭灯、桌面读过 → 手机灭灯）都是「单向轮询 + 无
 * 回执」：桌面页面里的客户端半边每 2s 去宿主敲一次门，宿主收下就完事。于是**通道有没有
 * 在跑，在宿主侧零痕迹** —— 2026-10-10 的绿点不同步故障里，这一点让「通道断了」和
 * 「通道通了但没清掉」两种可能一直分不开（桌面看得见绿点、手机也看得见绿点，却没人能
 * 说出桌面那一半到底来没来）。
 *
 * 这里钉两件事：
 *   1. 计数本身的行为（累加、快照是副本，调用方改不动内部状态）；
 *   2. 三条路由与 status 视图**确实接上了**这套计数（源码契约）——「加了模块但忘了接线」
 *      会让台账永远全 0，那比没有台账更误导人。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATS = require('../lib/desktop-half-stats.cjs');
const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');
const STATUS = path.join(__dirname, '..', 'lib', 'relay', 'status.js');

test('计数只累加，快照是副本（调用方改不动内部状态）', () => {
  const before = STATS.snapshot();
  STATS.noteReadReceiptGet();
  STATS.noteReadReceiptGet();
  STATS.noteDesktopRead({ ids: 3, cleared: 2 });
  STATS.noteDesktopViewPost();
  const after = STATS.snapshot();

  assert.equal(after.readReceiptGets, before.readReceiptGets + 2);
  assert.equal(after.desktopReadPosts, before.desktopReadPosts + 1);
  assert.equal(after.desktopReadIds, before.desktopReadIds + 3);
  assert.equal(after.desktopReadCleared, before.desktopReadCleared + 2);
  assert.equal(after.desktopViewPosts, before.desktopViewPosts + 1);
  assert.ok(after.readReceiptLastAt > 0, '最近时刻要记下来：只涨计数看不出「刚来过」还是「半小时前来过」');
  assert.ok(after.desktopReadLastAt > 0);
  assert.ok(after.desktopViewLastAt > 0);

  // 副本：改它不影响下一次读取。
  after.readReceiptGets = -1;
  assert.notEqual(STATS.snapshot().readReceiptGets, -1);
});

test('自检上报只收白名单字段（页面递进来的东西不许整块灌进 status 视图）', () => {
  const clean = STATS.noteClientHalf({
    loaded: true,
    getUiSession: 'object',
    getSessions: 'object:no-retain',
    receiptGets: 12,
    evil: { nested: 'should be dropped' },
    lastError: 'x'.repeat(400),
  });
  assert.equal(clean.loaded, true);
  assert.equal(clean.getSessions, 'object:no-retain');
  assert.equal(clean.receiptGets, 12);
  assert.equal('evil' in clean, false, '白名单外的键必须丢掉');
  assert.equal(clean.lastError.length, 120, '长字符串要截断');
  const snapshot = STATS.snapshot();
  assert.equal(snapshot.clientReports >= 1, true);
  assert.deepEqual(snapshot.client.getSessions, 'object:no-retain');
});

test('非法入参不让计数变成 NaN（NaN 会让「有没有在跑」的判断彻底失效）', () => {
  const before = STATS.snapshot();
  STATS.noteDesktopRead();
  STATS.noteDesktopRead({ ids: 'x', cleared: undefined });
  const after = STATS.snapshot();
  assert.equal(Number.isFinite(after.desktopReadIds), true);
  assert.equal(Number.isFinite(after.desktopReadCleared), true);
  assert.equal(after.desktopReadIds, before.desktopReadIds);
  assert.equal(after.desktopReadCleared, before.desktopReadCleared);
});

/** 每条路由：`path` 后面到下一个 `path:` 之前的那段 handler（与 control-plane-routes.test.cjs 同法）。 */
function routeSegments(source) {
  const hits = [...source.matchAll(/path:\s*'([^']+)'/g)];
  return hits.map((m, i) => ({
    path: m[1],
    handler: source.slice(m.index + m[0].length, i + 1 < hits.length ? hits[i + 1].index : source.length),
  }));
}

test('三条出入口都真的接了台账（加了模块没接线 = 台账永远全 0，比没有更误导）', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const segments = new Map(routeSegments(source).map((r) => [r.path, r.handler]));
  const expected = [
    ['/api/relay/desktop-view', 'desktopHalf.noteDesktopViewPost()'],
    ['/api/relay/read-receipt', 'desktopHalf.noteReadReceiptGet()'],
    ['/api/relay/desktop-read', 'desktopHalf.noteDesktopRead('],
  ];
  for (const [route, call] of expected) {
    const handler = segments.get(route);
    assert.ok(handler, `控制面少了 ${route}`);
    assert.ok(handler.includes(call), `${route} 的 handler 里没有 ${call}：这条通道又变成不可观测的了`);
  }
});

test('status 视图带出这份台账（否则只能在进程内存里干看）', () => {
  const source = fs.readFileSync(STATUS, 'utf8');
  assert.ok(source.includes("require('../desktop-half-stats.cjs')"), 'status.js 没引台账模块');
  assert.ok(source.includes('desktopHalf: desktopHalf.snapshot()'), 'status() 的返回体里没有 desktopHalf');
});

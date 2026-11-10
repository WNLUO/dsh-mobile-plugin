'use strict';

/**
 * 父会话在子代理还在跑的时候，必须仍然算「进行中」。
 *
 * 真机现象（2026-11-11）：主对话把正文输出完、顺手派了几个子代理，子代理还要跑几十秒；
 * 这期间手机上那一行已经变成「已完成待读」绿点、后台还会弹一条「跑完了」—— 而活明明还
 * 没干完。桌面端看的是整棵会话树还有没有活动，所以两边对同一时刻给出不同答案。
 *
 * 根因不在渲染层：宿主 `session.list` 只按主轮报 `running`，主轮 `turn/end` 一落它就是
 * false。插件原样透传，App 那边只能照这个数画。
 *
 * 这里钉三件事：
 *   1. 子代理在跑 → 它的父会话报 running=true（列表这条路的真实 handler，不是转写）；
 *   2. 往上一层层顶（子代理还能派子代理），链上有环也不死循环；
 *   3. 与侧栏/后台同一条判据：`/monitor` 也顶，而且顶完照样把子会话从监控视图里剔掉；
 *   4. 没有子在跑的父会话、普通会话、只有 inactive 子代理的父会话，一个都不许被改成在跑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withActiveParents } = require('../lib/mobile/session-active.js');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');

const sub = (id, parent, running, extra = {}) => ({
  sessionId: id,
  parentSessionId: parent,
  origin: 'subagent',
  running,
  updatedAt: 10,
  blank: false,
  ...extra,
});

const plain = (id, running, extra = {}) => ({
  sessionId: id, running, updatedAt: 10, blank: false, ...extra,
});

test('withActiveParents：子代理在跑，父会话被顶成运行中', () => {
  const items = [plain('parent', false), sub('child', 'parent', true)];
  const next = withActiveParents(items);
  assert.equal(next.find((i) => i.sessionId === 'parent').running, true);
  // 子会话自己那格照旧。
  assert.equal(next.find((i) => i.sessionId === 'child').running, true);
  // 不需要改的那几条保持原引用（侧栏树按行 memo，白造对象就是白重画）。
  assert.equal(next.find((i) => i.sessionId === 'child'), items[1]);
});

test('withActiveParents：子代理不在跑时父会话不动', () => {
  const items = [plain('parent', false), sub('child', 'parent', false)];
  assert.equal(withActiveParents(items), items);
});

test('withActiveParents：子代理再派子代理时，整条祖先链都顶起来', () => {
  const items = [plain('root', false), sub('mid', 'root', false), sub('leaf', 'mid', true)];
  const next = withActiveParents(items);
  const byId = new Map(next.map((i) => [i.sessionId, i]));
  assert.equal(byId.get('root').running, true);
  assert.equal(byId.get('mid').running, true);
});

test('withActiveParents：父链有环时不死循环，也不乱标', () => {
  const items = [
    plain('a', false, { origin: 'subagent', parentSessionId: 'b' }),
    plain('b', false, { origin: 'subagent', parentSessionId: 'a' }),
    sub('c', 'a', true),
  ];
  const next = withActiveParents(items);
  const byId = new Map(next.map((i) => [i.sessionId, i]));
  assert.equal(byId.get('a').running, true);
  assert.equal(byId.get('b').running, true);
});

test('withActiveParents：形状不对时原样返回，不崩', () => {
  assert.equal(withActiveParents(null), null);
  assert.equal(withActiveParents(undefined), undefined);
  const items = [null, {}, plain('x', false)];
  assert.equal(withActiveParents(items), items);
});

test('会话列表：子代理在跑的那一轮，父会话下发给手机时是 running', async () => {
  const items = [
    plain('parent', false, { cwd: '/ws' }),
    sub('child', 'parent', true, { cwd: '/ws' }),
  ];
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
    },
  };
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  const byId = new Map(response.body.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('parent').running, true);
  // 子会话那行仍在（App 侧栏靠 origin 跳过它），只是它自己也是 running。
  assert.equal(byId.get('child').running, true);
  assert.equal(byId.get('child').origin, 'subagent');
});

test('会话列表：子代理已经停了，父会话回到不在跑', async () => {
  const items = [plain('parent', false, { cwd: '/ws' }), sub('child', 'parent', false, { cwd: '/ws' })];
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
    },
  };
  const response = await buildSessionsResponse(ctx);
  const byId = new Map(response.body.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('parent').running, false);
});

test('监控视图：父会话被顶成运行中，子会话本身仍不进监控清单', async () => {
  const { buildMonitorState } = require('../lib/mobile/monitor.js');
  const items = [plain('parent', false, { cwd: '/ws' }), sub('child', 'parent', true, { cwd: '/ws' })];
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    },
  };
  const state = await buildMonitorState(ctx, 'device-x');
  assert.ok(Array.isArray(state.items), JSON.stringify(state));
  assert.deepEqual(state.items.map((item) => item.sessionId), ['parent']);
  assert.equal(state.items[0].running, true);
  // 还在跑的一轮不算「已完成待读」。
  assert.equal(state.items[0].completed, false);
});

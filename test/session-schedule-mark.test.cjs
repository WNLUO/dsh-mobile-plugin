'use strict';

/**
 * 侧栏会话行行首那只时钟（`scheduled` 标记）的判据守卫。
 *
 * 标记本身在 App 侧（`StatusSlot`），这一侧只负责「哪些会话还有活动的自动化任务」：
 * `buildSessionsResponse` 每 10 秒重建一次列表时顺手问一次宿主目录，命中的行带
 * `scheduled: true`。最容易写错的是**会话归属从哪读** —— 2026-11-07 定时任务页刚踩过
 * 同一个坑：v2 宿主把归属从行上的 `sessionId` 挪进了 `target` / `involvedSessionIds`，
 * 只认旧位置就把每条任务都当成「不属于任何会话」，接口照常 200、页面上一条都不显示。
 * 时钟这一侧是同一个病根，而且更隐蔽：列表照常回来，只是没有那个标记。
 *
 * 另外两条一直钉着的取舍：只认 `status === 'active'`（一次性任务投完转 inactive，
 * 时钟要跟着消失）；服务缺失 / 读失败一律当没有任务（时钟是提示性信息，不许拖垮列表）。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionsResponse } = require('../lib/mobile/sessions.js');
const { activeScheduleSessions } = require('../lib/mobile/session-schedule-mark.js');
const { scheduleRowSessionIds } = require('../lib/mobile/schedule.js');

/** 一条能开出时钟的最小任务行（字段与真宿主 catalog 一致）。 */
function taskRow(overrides) {
  return {
    id: 'schedule-1',
    kind: 'every',
    title: '每小时的检查',
    prompt: 'p',
    everySeconds: 3600,
    scheduledAt: '2026-11-08T01:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

/** 带 `schedule` 服务的 ctx，其余部分与会话列表测试同一套假体。 */
function makeCtx({ records = null, throws = false, missing = false, sessionIds = [] } = {}) {
  const items = sessionIds.map((sessionId, index) => ({
    sessionId,
    cwd: '/ws/a',
    updatedAt: 1000 + index,
    running: false,
    blank: false,
  }));
  const ctx = {
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: {
        list: async () => ({
          result: { ok: true, value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } },
        }),
      },
    },
  };
  if (missing) return ctx;
  ctx.get = (name) => {
    if (name !== 'schedule') return null;
    return {
      catalog: async () => {
        if (throws) throw new Error('catalog exploded');
        return records;
      },
    };
  };
  return ctx;
}

function makeReq() {
  const req = Readable.from([Buffer.from('{}')]);
  req.headers = {};
  return req;
}

test('v2 行：会话归属从 target 里读，时钟照样挂上', async () => {
  const ctx = makeCtx({
    records: [taskRow({ target: { kind: 'session', sessionId: 'session-v2' } })],
    sessionIds: ['session-v2'],
  });
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].scheduled, true);
});

test('v1 行：行上的 sessionId 仍然认', async () => {
  const ctx = makeCtx({ records: [taskRow({ sessionId: 'session-v1' })], sessionIds: ['session-v1'] });
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.body.items[0].scheduled, true);
});

test('一条任务参与过几条会话，那几条都挂时钟（与桌面 taskInvolvesSession 同口径）', async () => {
  const ctx = makeCtx({
    records: [taskRow({
      target: { kind: 'new', create: {} },
      involvedSessionIds: ['session-a', 'session-b'],
    })],
    sessionIds: ['session-a', 'session-b', 'session-c'],
  });
  const response = await buildSessionsResponse(ctx);
  const byId = new Map(response.body.items.map(item => [item.sessionId, item]));
  assert.equal(byId.get('session-a').scheduled, true);
  assert.equal(byId.get('session-b').scheduled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(byId.get('session-c'), 'scheduled'), false);
});

test('new 目标：最近一次投递到的那个会话也算这条任务的归属', async () => {
  const ctx = makeCtx({
    records: [taskRow({
      target: { kind: 'new', create: {} },
      lastDelivery: { scheduledAt: '2026-11-07T01:00:00.000Z', deliveredAt: '2026-11-07T01:00:02.000Z', targetSessionId: 'session-delivered' },
    })],
    sessionIds: ['session-delivered'],
  });
  const response = await buildSessionsResponse(ctx);
  assert.equal(response.body.items[0].scheduled, true);
});

test('只有 active 才挂时钟：paused / ended / inactive 一律不挂', async () => {
  for (const status of ['paused', 'ended', 'inactive']) {
    const ctx = makeCtx({
      records: [taskRow({ status, target: { kind: 'session', sessionId: 'session-x' } })],
      sessionIds: ['session-x'],
    });
    const response = await buildSessionsResponse(ctx);
    assert.equal(
      Object.prototype.hasOwnProperty.call(response.body.items[0], 'scheduled'),
      false,
      `${status} 的任务不该留下时钟`,
    );
  }
});

test('服务缺失 / 目录读失败都不影响列表：照常 200、只是没有标记', async () => {
  for (const options of [{ missing: true }, { throws: true }]) {
    const ctx = makeCtx({ ...options, sessionIds: ['session-a'] });
    const response = await buildSessionsResponse(ctx);
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 1);
    assert.equal(response.body.items[0].scheduled, undefined);
  }
  assert.equal((await activeScheduleSessions({})).size, 0);
  assert.equal((await activeScheduleSessions({ get: () => null })).size, 0);
});

test('归属解析：四处来源去重后按顺序给出，坏值一律丢掉', () => {
  assert.deepEqual(
    scheduleRowSessionIds({
      sessionId: 's0',
      target: { kind: 'new_once', sessionId: 's1' },
      involvedSessionIds: ['s1', 's2', 42, ''],
      lastDelivery: { targetSessionId: 's3' },
    }),
    ['s0', 's1', 's2', 's3'],
  );
  assert.deepEqual(scheduleRowSessionIds({ id: 'x', target: { kind: 'new' } }), []);
  assert.deepEqual(scheduleRowSessionIds(null), []);
  assert.deepEqual(scheduleRowSessionIds('nope'), []);
});

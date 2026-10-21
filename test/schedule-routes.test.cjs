'use strict';

/**
 * 定时任务四条移动端路由的契约（catalog / list / history / delete）。
 *
 * 手机端要在对话之外看到「这个会话排了什么、上次跑到什么时候、删掉一条排错的任务」，
 * 数据全在宿主的 `ScheduleService` 里。这个代理最容易写错的地方不是转发，而是**形状**：
 *
 *  1. 宿主 `catalog()` 的每项是「裸记录 + sessionId + status + 可选 lastDelivery」，
 *     而 `list()` 只回裸记录。手机只认一种 `ScheduleEntry` —— list 出来的条目必须补上
 *     请求里的 sessionId、`state` 恒为 active，否则 App 拿到的两批数据没法共用一套渲染。
 *  2. 宿主没有这个服务（老宿主）时必须回 503 `schedule-unavailable`，**不能**回空列表：
 *     App 要能分辨「这台电脑没有这个功能」和「一条任务都没有」。
 *  3. 收敛按 jobs.js 的口径：必填坏了丢整条，可选字段坏了只丢字段，超长截断不丢整条。
 *  4. `history` 的 `limit` 缺省 20、只收 1–100；两类宿主结果码（任务不存在 / 游标失效）
 *     分别是 404 与 409，`delete` 的 not_found 反而是 2xx —— 删一条已经不存在的任务
 *     不算失败，App 刷新一下就行。
 *
 * 本测试驱动真实 handler（起一个只挂这四条的 http 服务、走真 req/res），宿主那一侧
 * 换成假对象，不连真宿主。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  handleScheduleCatalog,
  handleScheduleList,
  handleScheduleHistory,
  handleScheduleDelete,
} = require('../lib/mobile/schedule.js');
const { readWiring } = require('./lib/wiring.cjs');

const BASE = '/api/mobile/v1/schedule';

const HANDLERS = {
  [`${BASE}/catalog`]: handleScheduleCatalog,
  [`${BASE}/list`]: handleScheduleList,
  [`${BASE}/history`]: handleScheduleHistory,
  [`${BASE}/delete`]: handleScheduleDelete,
};

/** 宿主 history 的空结果（字段与真宿主一致）。 */
const emptyHistory = (id) => ({
  id,
  records: [],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
  retention: { days: 7, records: 100 },
});

/**
 * 起一个只挂四条路由的真 http 服务；宿主一侧是假 `schedule` 服务。
 *
 * `options.missing` 让 `ctx.get('schedule')` 回 undefined（老宿主）；否则四个方法各自
 * 调 `options.*` 的实现，缺省给合法空值。所有调用参数都记在 `calls` 里。
 */
async function serve(options = {}) {
  const calls = { catalog: 0, list: [], history: [], delete: [] };
  let service;
  if (!options.missing) {
    service = {
      catalog: async () => {
        calls.catalog += 1;
        return options.catalog ? options.catalog() : [];
      },
      list: async (payload) => {
        calls.list.push(payload);
        return options.list ? options.list(payload) : [];
      },
      history: async (payload) => {
        calls.history.push(payload);
        return options.history ? options.history(payload) : emptyHistory(payload.id);
      },
      delete: async (payload) => {
        calls.delete.push(payload);
        return options.delete ? options.delete(payload) : { id: payload.id, deleted: true };
      },
    };
  }
  const ctx = { get: (name) => (name === 'schedule' ? service : undefined) };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const handler = HANDLERS[pathname];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    Promise.resolve(handler(ctx, req, res)).catch((error) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    get: async (path, query = '') => {
      const response = await fetch(`${origin}${path}${query}`);
      return { status: response.status, body: await response.json() };
    },
    post: async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 起宿主、跑断言、收尾。 */
async function withHost(options, run) {
  const host = await serve(options);
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

/** 宿主 catalog 里的一条（裸记录 + sessionId + status + lastDelivery）。 */
function weekly(over = {}) {
  return {
    id: 'schedule-weekly',
    kind: 'weekly',
    title: '每周周报',
    prompt: '整理这一周的改动',
    scheduledAt: '2026-10-26T01:00:00.000Z',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
    weekdays: [1, 3],
    sessionId: 'session-a',
    status: 'active',
    lastDelivery: { scheduledAt: '2026-10-19T01:00:00.000Z', deliveredAt: '2026-10-19T01:00:03.000Z' },
    ...over,
  };
}

test('catalog：手机形状（state 由 status 收敛），并带 serverNow', async () => {
  const cron = {
    id: 'schedule-cron',
    kind: 'cron',
    title: '每天九点',
    prompt: '晨报',
    scheduledAt: '2026-10-22T01:00:00.000Z',
    expression: '0 9 * * *',
    timeZone: 'UTC',
    sessionId: 'session-b',
    status: 'inactive',
  };
  await withHost({ catalog: () => [weekly(), cron] }, async (host) => {
    const before = Date.now();
    const res = await host.get(`${BASE}/catalog`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.serverNow, 'number');
    assert.ok(Math.abs(res.body.serverNow - before) < 10_000, 'serverNow 应该是宿主此刻的时间');
    assert.equal(res.body.records.length, 2);

    const [first, second] = res.body.records;
    // 精确键集合：多一个 status / 少一个 prompt 都算契约破了。
    assert.deepEqual(
      Object.keys(first).sort(),
      ['id', 'kind', 'lastDelivery', 'prompt', 'scheduledAt', 'sessionId', 'state', 'time', 'timeZone', 'title', 'weekdays'],
    );
    assert.equal(first.id, 'schedule-weekly');
    assert.equal(first.sessionId, 'session-a');
    assert.equal(first.kind, 'weekly');
    assert.equal(first.title, '每周周报');
    assert.equal(first.prompt, '整理这一周的改动');
    assert.equal(first.scheduledAt, '2026-10-26T01:00:00.000Z');
    assert.equal(first.state, 'active');
    assert.equal(first.time, '09:00:00.000');
    assert.equal(first.timeZone, 'Asia/Shanghai');
    assert.deepEqual(first.weekdays, [1, 3]);
    assert.deepEqual(first.lastDelivery, {
      scheduledAt: '2026-10-19T01:00:00.000Z',
      deliveredAt: '2026-10-19T01:00:03.000Z',
    });
    assert.equal('status' in first, false, '宿主的 status 不该原样漏给手机');

    assert.equal(second.state, 'inactive');
    assert.equal(second.expression, '0 9 * * *');
    assert.equal(second.timeZone, 'UTC');
    assert.equal('time' in second, false, 'cron 不带 time');
    assert.equal('lastDelivery' in second, false);
  });
});

test('list：裸记录补上请求里的 sessionId，state 恒为 active', async () => {
  const bare = {
    id: 'schedule-every',
    kind: 'every',
    title: '每小时看一次构建',
    prompt: '看构建',
    scheduledAt: '2026-10-21T03:00:00.000Z',
    everySeconds: 3600,
  };
  await withHost({ list: () => [bare] }, async (host) => {
    const res = await host.get(`${BASE}/list`, '?sessionId=session-b');
    assert.equal(res.status, 200);
    assert.deepEqual(host.calls.list, [{ sessionId: 'session-b' }]);
    assert.equal(res.body.records.length, 1);
    const record = res.body.records[0];
    assert.equal(record.sessionId, 'session-b');
    assert.equal(record.state, 'active');
    assert.equal(record.everySeconds, 3600);
    assert.deepEqual(
      Object.keys(record).sort(),
      ['everySeconds', 'id', 'kind', 'prompt', 'scheduledAt', 'sessionId', 'state', 'title'],
    );
    assert.equal('lastDelivery' in record, false);
    assert.equal('status' in record, false);
  });
});

test('history：默认 limit 20，游标 / 保留策略 / 两条标记原样回给手机', async () => {
  const hostResult = () => ({
    id: 'schedule-weekly',
    records: [
      { scheduledAt: '2026-10-19T01:00:00.000Z', deliveredAt: '2026-10-19T01:00:03.000Z', messageId: 'm-3', prompt: '实际跑的内容' },
      { scheduledAt: '2026-10-12T01:00:00.000Z', deliveredAt: '2026-10-12T01:00:02.000Z', messageId: 'm-2' },
    ],
    earlierRecordsUnavailable: true,
    earlierRecordsPruned: false,
    retention: { days: 7, records: 300 },
    nextBefore: 'm-2',
  });
  await withHost({ history: hostResult }, async (host) => {
    const res = await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly');
    assert.equal(res.status, 200);
    assert.deepEqual(host.calls.history[0], { sessionId: 'session-a', id: 'schedule-weekly', limit: 20 });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.id, 'schedule-weekly');
    assert.equal(res.body.earlierRecordsUnavailable, true);
    assert.equal(res.body.earlierRecordsPruned, false);
    assert.deepEqual(res.body.retention, { days: 7, records: 300 });
    assert.equal(res.body.nextBefore, 'm-2');
    assert.equal(res.body.records.length, 2);
    assert.deepEqual(
      Object.keys(res.body.records[0]).sort(),
      ['deliveredAt', 'messageId', 'prompt', 'scheduledAt'],
    );
    assert.equal(res.body.records[0].messageId, 'm-3');
    assert.equal('prompt' in res.body.records[1], false, '记录里的 prompt 是可选的');

    // 带游标与显式 limit 时原样转给宿主。
    await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly&limit=5&before=m-2');
    assert.deepEqual(host.calls.history[1], { sessionId: 'session-a', id: 'schedule-weekly', limit: 5, before: 'm-2' });
  });
});

test('delete：命中时回 deleted: true，参数原样带给宿主', async () => {
  await withHost({}, async (host) => {
    const res = await host.post(`${BASE}/delete`, { sessionId: 'session-a', id: 'schedule-weekly' });
    assert.equal(res.status, 200);
    assert.deepEqual(host.calls.delete, [{ sessionId: 'session-a', id: 'schedule-weekly' }]);
    assert.deepEqual(res.body, { ok: true, id: 'schedule-weekly', deleted: true });
  });
});

test('宿主没有 schedule 服务：四条都是 503 schedule-unavailable，不是空列表', async () => {
  await withHost({ missing: true }, async (host) => {
    const cases = [
      [`${BASE}/catalog`, ''],
      [`${BASE}/list`, '?sessionId=session-a'],
      [`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly'],
    ];
    for (const [path, query] of cases) {
      const res = await host.get(path, query);
      assert.equal(res.status, 503, `${path} 在无 schedule 服务的宿主上应回 503`);
      assert.deepEqual(res.body, { ok: false, error: { code: 'schedule-unavailable', message: '宿主没有定时任务服务' } });
      assert.equal('records' in res.body, false, '不能回一个看起来像空列表的 200');
    }
    const del = await host.post(`${BASE}/delete`, { sessionId: 'session-a', id: 'schedule-weekly' });
    assert.equal(del.status, 503);
    assert.equal(del.body.error.code, 'schedule-unavailable');
    assert.deepEqual(del.body, { ok: false, error: { code: 'schedule-unavailable', message: '宿主没有定时任务服务' } });
  });
});

test('宿主调用抛错：502 + 原文；带已知码就透传那个码', async () => {
  await withHost({ catalog: () => { throw new Error('宿主磁盘满了'); } }, async (host) => {
    const res = await host.get(`${BASE}/catalog`);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { ok: false, error: { code: 'schedule_failed', message: '宿主磁盘满了' } });
  });

  await withHost({
    history: () => {
      throw Object.assign(new Error('limit 不在 1–100'), { code: 'invalid_rule' });
    },
  }, async (host) => {
    const res = await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly');
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'invalid_rule');
    assert.equal(res.body.error.message, 'limit 不在 1–100');
    assert.equal(res.body.ok, false);
  });

  await withHost({ delete: () => { throw new Error('写盘失败'); } }, async (host) => {
    const res = await host.post(`${BASE}/delete`, { sessionId: 'session-a', id: 'schedule-weekly' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.message, '写盘失败');
  });
});

test('缺参数与 limit 越界：400，且压根不往宿主发请求', async () => {
  await withHost({}, async (host) => {
    for (const [path, query] of [
      [`${BASE}/list`, ''],
      [`${BASE}/history`, '?id=schedule-weekly'],
      [`${BASE}/history`, '?sessionId=session-a'],
    ]) {
      const res = await host.get(path, query);
      assert.equal(res.status, 400, `${path}${query} 应回 400`);
      assert.equal(res.body.error.code, 'invalid_selector');
    }
    for (const limit of ['0', '101', 'abc', '1.5', '-3', '']) {
      const res = await host.get(`${BASE}/history`, `?sessionId=session-a&id=schedule-weekly&limit=${encodeURIComponent(limit)}`);
      assert.equal(res.status, 400, `limit=${JSON.stringify(limit)} 应回 400`);
      assert.equal(res.body.error.code, 'invalid_limit');
    }
    assert.equal(host.calls.list.length, 0, '参数不合法时不该去问宿主');
    assert.equal(host.calls.history.length, 0);

    for (const body of [{}, { sessionId: 'session-a' }, { id: 'schedule-weekly' }]) {
      const res = await host.post(`${BASE}/delete`, body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'invalid_selector');
    }
    assert.equal(host.calls.delete.length, 0);

    // 两个端点值必须真的收：1 与 100。
    for (const limit of ['1', '100']) {
      const res = await host.get(`${BASE}/history`, `?sessionId=session-a&id=schedule-weekly&limit=${limit}`);
      assert.equal(res.status, 200, `limit=${limit} 是合法边界`);
    }
    assert.deepEqual(host.calls.history.map((c) => c.limit), [1, 100]);
  });
});

test('history 的两类宿主结果码：任务不存在 404、游标失效 409', async () => {
  await withHost({ history: () => ({ id: 'schedule-weekly', code: 'schedule_not_found' }) }, async (host) => {
    const res = await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'schedule_not_found');
  });

  await withHost({ history: () => ({ id: 'schedule-weekly', code: 'delivery_cursor_not_found' }) }, async (host) => {
    const res = await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly&before=m-9');
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'delivery_cursor_not_found');
  });
});

test('delete 的 not_found 不算失败：200 + deleted: false + 码', async () => {
  await withHost({
    delete: () => ({ id: 'schedule-weekly', deleted: false, code: 'schedule_not_found' }),
  }, async (host) => {
    const res = await host.post(`${BASE}/delete`, { sessionId: 'session-a', id: 'schedule-weekly' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, id: 'schedule-weekly', deleted: false, code: 'schedule_not_found' });
  });
});

test('收敛：必填（id / kind / title / sessionId）坏了丢整条', async () => {
  const rows = [
    weekly(),
    weekly({ id: null }),
    weekly({ id: '   ' }),
    weekly({ kind: 'monthly' }),
    weekly({ kind: undefined }),
    weekly({ title: '   ' }),
    weekly({ sessionId: undefined }),
    null,
    'oops',
    [],
  ];
  await withHost({ catalog: () => rows }, async (host) => {
    const res = await host.get(`${BASE}/catalog`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.records.map((r) => r.id), ['schedule-weekly']);
  });
});

test('收敛：可选字段坏了只丢字段，超长截断不丢整条', async () => {
  const rows = [
    weekly({
      scheduledAt: 1_792_544_544_077,
      weekdays: [1, '3'],
      timeZone: 'T'.repeat(100),
      title: '标'.repeat(300),
      prompt: 'p'.repeat(5000),
    }),
    { id: 'schedule-every', kind: 'every', title: '每小时', prompt: 'p', everySeconds: 0, sessionId: 'session-a', status: 'active' },
    { id: 'schedule-after', kind: 'after', title: '一分钟后', prompt: 'p', afterSeconds: '60', sessionId: 'session-a', status: 'active' },
    // at 没有专有字段：宿主残留的 expression / time 不许顺手转发。
    { id: 'schedule-at', kind: 'at', title: '到点一次', prompt: 'p', expression: '0 9 * * *', time: '09:00:00.000', sessionId: 'session-a', status: 'active' },
  ];
  await withHost({ catalog: () => rows }, async (host) => {
    const res = await host.get(`${BASE}/catalog`);
    assert.equal(res.status, 200);
    assert.equal(res.body.records.length, 4, '可选字段坏掉不该连累整条');
    const [first, every, after, at] = res.body.records;
    assert.equal('scheduledAt' in first, false, 'scheduledAt 不是字符串 → 只丢这个字段');
    assert.equal('weekdays' in first, false, 'weekdays 混字符串 → 只丢这个字段');
    assert.equal(first.timeZone.length, 64);
    assert.equal(first.title.length, 200);
    assert.equal(first.prompt.length, 4000);
    assert.equal('everySeconds' in every, false, 'everySeconds=0 不是正数');
    assert.equal('afterSeconds' in after, false, 'afterSeconds 是字符串不算数');
    assert.equal(after.kind, 'after');
    assert.deepEqual(
      Object.keys(at).sort(),
      ['id', 'kind', 'prompt', 'sessionId', 'state', 'title'],
      'at 只该有基础字段',
    );
  });
});

test('收敛：按 id 去重、单帧最多 500 条', async () => {
  const many = Array.from({ length: 501 }, (_, i) => weekly({ id: `schedule-${i}` }));
  await withHost({ catalog: () => [weekly(), weekly(), ...many] }, async (host) => {
    const res = await host.get(`${BASE}/catalog`);
    assert.equal(res.status, 200);
    assert.equal(res.body.records.length, 500);
    assert.equal(res.body.records[0].id, 'schedule-weekly');
    assert.equal(res.body.records.at(-1).id, 'schedule-498', '去重后共 501 条，截到 500');
    assert.equal(new Set(res.body.records.map((r) => r.id)).size, 500, '同 id 只留先出现的那条');
  });
});

test('history 记录也收敛：缺 messageId 的丢掉，条数封顶 100', async () => {
  const records = Array.from({ length: 150 }, (_, i) => ({
    scheduledAt: '2026-10-19T01:00:00.000Z',
    deliveredAt: '2026-10-19T01:00:03.000Z',
    messageId: `m-${i}`,
  }));
  await withHost({
    history: () => ({ id: 'schedule-weekly', records: [{ scheduledAt: 'x' }, ...records], retention: { days: 7, records: 300 } }),
  }, async (host) => {
    const res = await host.get(`${BASE}/history`, '?sessionId=session-a&id=schedule-weekly');
    assert.equal(res.status, 200);
    assert.equal(res.body.records.length, 100);
    assert.equal(res.body.records[0].messageId, 'm-0', '缺 messageId 的记录被丢掉，不是占个头');
    assert.equal(res.body.records.at(-1).messageId, 'm-99');
  });
});

test('四条路由真的挂在路由表上，schedule 模块也被引入了', () => {
  const wiring = readWiring();
  for (const path of Object.keys(HANDLERS)) {
    assert.ok(wiring.includes(`route('${path}',`), `路由表里没有 ${path}`);
  }
  assert.match(wiring, /require\(['"](?:\.\.?\/mobile)\/schedule(?:\.js)?['"]\)/);
});

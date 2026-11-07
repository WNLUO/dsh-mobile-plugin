'use strict';

/**
 * 定时任务管理面 / 文件写操作 / 后台任务取消 三组移动端路由的契约。
 *
 * 三个模块都只新建、由路由表（`lib/routes/mobile-api.js`，另一处接线）挂上；这里直接驱动
 * handler、宿主一侧换成假对象，不连真宿主。覆盖的是最容易被写错的地方：
 *
 *  - schedule-edit：新建 / 编辑把 App 的 timing 收成宿主 wire 形状再转发；暂停恢复就是
 *    patch `{active}`；CAS 用 expectedUpdatedAt 透传；宿主回 code（conflict / not_found /
 *    execution_pending）时的状态码与文案。
 *  - file-ops：只允许在允许区内动；已存在默认 409、overwrite 才覆盖；删符号链接直接拒绝；
 *    父目录经符号链接指到区外时连新建都挡下来。
 *  - jobs-control：取消转发到 jobController.kill；任务不存在 404；没有服务 503；启动 501。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const nodePath = require('node:path');

const scheduleEdit = require('../lib/mobile/schedule-edit.js');
const fileOps = require('../lib/mobile/file-ops.js');
const jobsControl = require('../lib/mobile/jobs-control.js');

/** 起一个只挂给定路由的真 http 服务；ctx 由调用方给。 */
async function serve(routes, ctx) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const handler = routes[pathname];
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
    post: async (p, body) => {
      const response = await fetch(`${origin}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── schedule-edit ────────────────────────────────────────────────────────────

const SCHED = '/api/mobile/v1/schedule';
const SCHED_ROUTES = {
  [`${SCHED}/create`]: scheduleEdit.handleScheduleCreate,
  [`${SCHED}/update`]: scheduleEdit.handleScheduleEdit,
  [`${SCHED}/pause`]: scheduleEdit.handleSchedulePause,
  [`${SCHED}/resume`]: scheduleEdit.handleScheduleResume,
  [`${SCHED}/run`]: scheduleEdit.handleScheduleRun,
};

/** 宿主回的一条 v2 catalog entry。 */
function catalogEntry(over = {}) {
  return {
    id: 'schedule-every',
    kind: 'every',
    title: '每小时看构建',
    prompt: '看构建',
    everySeconds: 3600,
    scheduledAt: '2026-11-08T02:00:00.000Z',
    status: 'active',
    updatedAt: '2026-11-08T01:00:00.000Z',
    target: { kind: 'session', sessionId: 'session-a' },
    involvedSessionIds: ['session-a'],
    ...over,
  };
}

function scheduleCtx(service) {
  return { get: (name) => (name === 'schedule' ? service : undefined) };
}

test('create：timing 收成宿主 wire 形状、默认落到当前会话，返回 record（带 status/updatedAt）', async () => {
  const calls = [];
  const service = {
    remoteCreate: async (request) => {
      calls.push(request);
      return catalogEntry({ kind: 'every', everySeconds: request.timing.every_seconds });
    },
  };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    const res = await host.post(`${SCHED}/create`, {
      sessionId: 'session-a',
      title: '每小时看构建',
      prompt: '看构建',
      timing: { kind: 'every', everySeconds: 3600 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(calls[0], {
      title: '每小时看构建',
      prompt: '看构建',
      timing: { kind: 'every', every_seconds: 3600 },
      target: { kind: 'session', sessionId: 'session-a' },
    });
    assert.equal(res.body.record.id, 'schedule-every');
    assert.equal(res.body.record.sessionId, 'session-a');
    assert.equal(res.body.record.state, 'active');
    assert.equal(res.body.record.status, 'active');
    assert.equal(res.body.record.updatedAt, '2026-11-08T01:00:00.000Z');
    assert.equal(res.body.record.everySeconds, 3600);
  } finally {
    await host.close();
  }
});

test('create：target 显式给 new_once 时按原样转发；缺 target 且无 session 时不带 target', async () => {
  const calls = [];
  const service = { remoteCreate: async (request) => { calls.push(request); return catalogEntry({ target: { kind: 'new', create: {} }, involvedSessionIds: ['session-x'] }); } };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    await host.post(`${SCHED}/create`, {
      title: '每天晨报',
      prompt: '晨报',
      timing: { kind: 'daily', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } },
      target: { kind: 'new_once', create: { cwd: '/tmp/x', agentPreset: 'default' } },
    });
    assert.deepEqual(calls[0].target, { kind: 'new_once', create: { cwd: '/tmp/x', agentPreset: 'default' } });
    assert.doesNotMatch(JSON.stringify(calls[0]), /sessionId/, '没传 sessionId 就不该冒出会话目标');

    await host.post(`${SCHED}/create`, {
      title: 'x', prompt: 'y', timing: { kind: 'after', after_seconds: 60 },
    });
    assert.equal('target' in calls[1], false);
  } finally {
    await host.close();
  }
});

test('create：标题空 / 指令空 / timing 不合法都是 400，且不碰宿主', async () => {
  const calls = [];
  const service = { remoteCreate: async (request) => { calls.push(request); return catalogEntry(); } };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    const cases = [
      [{ title: '   ', prompt: 'p', timing: { kind: 'after', after_seconds: 60 } }, 'invalid_title'],
      [{ title: 't', prompt: '   ', timing: { kind: 'after', after_seconds: 60 } }, 'invalid_prompt'],
      [{ title: 't', prompt: 'p', timing: { kind: 'monthly' } }, 'invalid_timing'],
      [{ title: 't', prompt: 'p', timing: { kind: 'every', every_seconds: 0 } }, 'invalid_timing'],
      [{ title: 't', prompt: 'p', timing: { kind: 'weekly', weekly: { time: '09:00', time_zone: 'UTC', weekdays: [0, 8] } } }, 'invalid_timing'],
    ];
    for (const [body, code] of cases) {
      const res = await host.post(`${SCHED}/create`, body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, code);
    }
    assert.equal(calls.length, 0);
  } finally {
    await host.close();
  }
});

test('update：patch 归一化后转发，expectedUpdatedAt 原样带上做 CAS', async () => {
  const calls = [];
  const service = { remoteEdit: async (request) => { calls.push(request); return catalogEntry({ title: '新标题' }); } };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    const res = await host.post(`${SCHED}/update`, {
      id: 'schedule-every',
      expectedUpdatedAt: '2026-11-08T01:00:00.000Z',
      patch: {
        title: '新标题',
        timing: { kind: 'cron', cron: { expression: '0 9 * * *', timeZone: 'UTC' } },
        active: true,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0], {
      id: 'schedule-every',
      action: 'update',
      expectedUpdatedAt: '2026-11-08T01:00:00.000Z',
      patch: {
        title: '新标题',
        timing: { kind: 'cron', cron: { expression: '0 9 * * *', time_zone: 'UTC' } },
        active: true,
      },
    });
    assert.equal(res.body.record.title, '新标题');
  } finally {
    await host.close();
  }
});

test('update：空 patch / 未知目标形状 400，宿主错误码 conflict 转 409', async () => {
  const service = { remoteEdit: async () => ({ id: 'schedule-every', code: 'schedule_conflict' }) };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    let res = await host.post(`${SCHED}/update`, { id: 'schedule-every', patch: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_patch');

    res = await host.post(`${SCHED}/update`, { id: 'schedule-every', patch: { target: { kind: 'nope' } } });
    assert.equal(res.status, 400);

    res = await host.post(`${SCHED}/update`, { id: 'schedule-every', patch: { title: 't' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'schedule_conflict');
  } finally {
    await host.close();
  }
});

test('pause / resume：patch 固定 active=false / true', async () => {
  const calls = [];
  const service = {
    remoteEdit: async (request) => {
      calls.push(request);
      return catalogEntry({ status: request.patch.active === false ? 'paused' : 'active' });
    },
  };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    const pause = await host.post(`${SCHED}/pause`, { id: 'schedule-every' });
    assert.equal(pause.status, 200);
    assert.deepEqual(calls[0], { id: 'schedule-every', action: 'update', patch: { active: false } });
    assert.equal(pause.body.record.state, 'inactive');
    assert.equal(pause.body.record.status, 'paused');

    const resume = await host.post(`${SCHED}/resume`, { id: 'schedule-every', expectedUpdatedAt: null });
    assert.equal(resume.status, 200);
    assert.deepEqual(calls[1], { id: 'schedule-every', action: 'update', expectedUpdatedAt: null, patch: { active: true } });
    assert.equal(resume.body.record.status, 'active');
  } finally {
    await host.close();
  }
});

test('run：命中回 ran:true；执行中回 ran:false；不存在 404', async () => {
  let next;
  const service = { run: async (request) => next };
  const host = await serve(SCHED_ROUTES, scheduleCtx(service));
  try {
    next = catalogEntry();
    let res = await host.post(`${SCHED}/run`, { id: 'schedule-every' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ran, true);
    assert.equal(res.body.record.id, 'schedule-every');

    next = { id: 'schedule-every', code: 'schedule_execution_pending' };
    res = await host.post(`${SCHED}/run`, { id: 'schedule-every' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ran, false);
    assert.equal(res.body.code, 'schedule_execution_pending');

    next = { id: 'schedule-every', code: 'schedule_not_found' };
    res = await host.post(`${SCHED}/run`, { id: 'schedule-every' });
    assert.equal(res.status, 404);
  } finally {
    await host.close();
  }
});

test('没有 schedule 服务 / 没有写方法：写路由统一 503', async () => {
  // 每条路由单独给一份**合法**请求体：handler 先做参数校验、再探宿主写能力，参数不合法
  // 时本来就该 400（与有没有这个服务无关）。这里要测的是「参数都对、宿主没能力」那一档。
  const bodies = {
    create: { title: 't', prompt: 'p', timing: { kind: 'after', after_seconds: 60 } },
    update: { id: 'schedule-every', patch: { title: 't' } },
    pause: { id: 'schedule-every' },
    resume: { id: 'schedule-every' },
    run: { id: 'schedule-every' },
  };
  for (const ctx of [scheduleCtx(undefined), scheduleCtx({})]) {
    const host = await serve(SCHED_ROUTES, ctx);
    try {
      for (const [p, body] of Object.entries(bodies)) {
        const res = await host.post(`${SCHED}/${p}`, body);
        assert.equal(res.status, 503, `${p} 在无写能力的宿主上应回 503`);
        assert.equal(res.body.error.code, 'schedule-unavailable');
      }
    } finally {
      await host.close();
    }
  }
});

// ── file-ops ─────────────────────────────────────────────────────────────────

const FILE = '/api/mobile/v1/file';
const FILE_ROUTES = {
  [`${FILE}/create`]: fileOps.handleFileCreate,
  [`${FILE}/delete`]: fileOps.handleFileDelete,
  [`${FILE}/rename`]: fileOps.handleFileRename,
};

function fileCtx(root) {
  return {
    apiProxy: {
      workspace: {
        list: async () => ({ result: { ok: true, value: [{ path: root }] } }),
      },
    },
  };
}

test('file-ops：新建 / 覆盖 / 删除 / 改名都在允许区内完成', async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-fileops-'));
  const host = await serve(FILE_ROUTES, fileCtx(root));
  try {
    const target = nodePath.join(root, 'note.txt');
    let res = await host.post(`${FILE}/create`, { path: target, content: '你好' });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, true);
    assert.equal(await fs.readFile(target, 'utf8'), '你好');

    res = await host.post(`${FILE}/create`, { path: target, content: 'again' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'file-exists');

    res = await host.post(`${FILE}/create`, { path: target, content: '覆盖', overwrite: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.overwritten, true);
    assert.equal(await fs.readFile(target, 'utf8'), '覆盖');

    res = await host.post(`${FILE}/rename`, { path: target, name: 'renamed.txt' });
    assert.equal(res.status, 200);
    assert.equal(res.body.renamed, true);
    await fs.stat(nodePath.join(root, 'renamed.txt'));
    await assert.rejects(fs.stat(target));

    res = await host.post(`${FILE}/delete`, { path: nodePath.join(root, 'renamed.txt') });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    await assert.rejects(fs.stat(nodePath.join(root, 'renamed.txt')));
  } finally {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('file-ops：区外路径 / 符号链接父目录逃逸一律 403', async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-fileops-'));
  const outside = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-fileops-out-'));
  const host = await serve(FILE_ROUTES, fileCtx(root));
  try {
    let res = await host.post(`${FILE}/create`, { path: '/etc/dsh-should-not-exist.txt', content: 'x' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'outside-allowed');

    // 工作区里放一个指向区外的软链目录：字面上在区内，物理上在外面。
    const linkDir = nodePath.join(root, 'link-dir');
    await fs.symlink(outside, linkDir, 'dir');
    res = await host.post(`${FILE}/create`, { path: nodePath.join(linkDir, 'evil.txt'), content: 'x' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'outside-allowed');
    await assert.rejects(fs.stat(nodePath.join(outside, 'evil.txt')), '不该在区外落文件');

    res = await host.post(`${FILE}/delete`, { path: '/etc/hosts' });
    assert.equal(res.status, 403);
  } finally {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('file-ops：删除符号链接被拒绝（不删链接本身、更不顺着删目标）', async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-fileops-'));
  const host = await serve(FILE_ROUTES, fileCtx(root));
  try {
    const real = nodePath.join(root, 'real.txt');
    await fs.writeFile(real, 'data');
    const link = nodePath.join(root, 'alias.txt');
    await fs.symlink(real, link);

    const res = await host.post(`${FILE}/delete`, { path: link });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'symlink-refused');
    // 链接还在、它指向的真文件也还在。
    await fs.lstat(link);
    assert.equal(await fs.readFile(real, 'utf8'), 'data');
  } finally {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('file-ops：改名到已存在的名字默认 409，坏名字 400', async () => {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-fileops-'));
  const host = await serve(FILE_ROUTES, fileCtx(root));
  try {
    await fs.writeFile(nodePath.join(root, 'a.txt'), 'a');
    await fs.writeFile(nodePath.join(root, 'b.txt'), 'b');

    let res = await host.post(`${FILE}/rename`, { path: nodePath.join(root, 'a.txt'), name: 'b.txt' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'file-exists');

    res = await host.post(`${FILE}/rename`, { path: nodePath.join(root, 'a.txt'), name: '../escape.txt' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid-name');

    res = await host.post(`${FILE}/rename`, { path: nodePath.join(root, 'missing.txt'), name: 'c.txt' });
    assert.equal(res.status, 404);
  } finally {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── jobs-control ─────────────────────────────────────────────────────────────

const JOBS = '/api/mobile/v1/jobs';
const JOB_ROUTES = {
  [`${JOBS}/cancel`]: jobsControl.handleJobsCancel,
  [`${JOBS}/start`]: jobsControl.handleJobsStart,
};

test('jobs/cancel：转发到 jobController.kill 并回 outcome', async () => {
  const calls = [];
  const service = { kill: async (request) => { calls.push(request); return { outcome: 'requested' }; } };
  const ctx = { get: (name) => (name === 'jobController' ? service : undefined) };
  const host = await serve(JOB_ROUTES, ctx);
  try {
    const res = await host.post(`${JOBS}/cancel`, { sessionId: 'session-a', jobId: 'job-1' });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0], { sessionId: 'session-a', jobId: 'job-1' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.outcome, 'requested');

    const done = await serve(JOB_ROUTES, { get: () => ({ kill: async () => ({ outcome: 'already-finished' }) }) });
    try {
      const r2 = await done.post(`${JOBS}/cancel`, { jobId: 'job-2' });
      assert.equal(r2.body.outcome, 'already-finished');
    } finally {
      await done.close();
    }
  } finally {
    await host.close();
  }
});

test('jobs/cancel：任务不存在 404、缺 jobId 400、没有服务 503', async () => {
  const missing = { get: () => ({ kill: async () => { throw Object.assign(new Error('no such job'), { code: 'job/not-found' }); } }) };
  let host = await serve(JOB_ROUTES, missing);
  try {
    let res = await host.post(`${JOBS}/cancel`, { sessionId: 's', jobId: 'gone' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'job-not-found');

    res = await host.post(`${JOBS}/cancel`, { sessionId: 's' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_selector');
  } finally {
    await host.close();
  }

  host = await serve(JOB_ROUTES, { get: () => undefined });
  try {
    const res = await host.post(`${JOBS}/cancel`, { jobId: 'job-1' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'jobs-unavailable');
  } finally {
    await host.close();
  }
});

test('jobs/start：宿主不支持，显式 501', async () => {
  const host = await serve(JOB_ROUTES, {});
  try {
    const res = await host.post(`${JOBS}/start`, {});
    assert.equal(res.status, 501);
    assert.equal(res.body.error.code, 'jobs-start-unsupported');
  } finally {
    await host.close();
  }
});

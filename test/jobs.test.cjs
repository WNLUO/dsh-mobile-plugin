'use strict';
// 后台任务帧 → 手机端任务面板的数据源。
//
// 真机现象：桌面端会话头部有一个任务触发器（进行中 N / 共 M，展开是一行一个任务），
// 手机端从头到尾看不到任何后台任务。根因是移动端 SSE 转发只认
// session/event / session/queue / session/projection / question / approval，
// 宿主的 `session/jobs` 整帧落进 else 被静默丢掉。
//
// 这里直接驱动导出的 normalizeJob / normalizeJobs（不经过 HTTP），用宿主
// taskViewSchema 的真实形状验证收敛规则：必填字段坏了丢整条，可选字段坏了只丢字段，
// 以及空数组必须原样保留（它是「任务都结束了」的唯一信号）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeJob, normalizeJobs } = require('../lib/mobile/jobs.js');

/** 一条宿主 taskViewSchema 形状的任务。 */
function job(overrides = {}) {
  return {
    id: 'job-1',
    kind: 'bash',
    label: 'npm test',
    status: 'running',
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('任务：真实形状原样通过，键集合恰好是六个', () => {
  const out = normalizeJob(job());
  assert.deepEqual(Object.keys(out).sort(), ['id', 'kind', 'label', 'startedAt', 'status']);
  assert.equal(out.id, 'job-1');
  assert.equal(out.kind, 'bash');
  assert.equal(out.label, 'npm test');
  assert.equal(out.status, 'running');
  assert.equal(out.startedAt, 1_700_000_000_000);
});

test('任务：detail 与 finishedAt 是可选字段，有就带、没有就不带', () => {
  const bare = normalizeJob(job());
  assert.equal('detail' in bare, false);
  assert.equal('finishedAt' in bare, false);

  const full = normalizeJob(job({ detail: '第 3 步', finishedAt: 1_700_000_001_000 }));
  assert.equal(full.detail, '第 3 步');
  assert.equal(full.finishedAt, 1_700_000_001_000);
  assert.deepEqual(Object.keys(full).sort(), ['detail', 'finishedAt', 'id', 'kind', 'label', 'startedAt', 'status']);
});

test('任务：宿主 wire 的五个状态全收，其它一律丢整条', () => {
  for (const status of ['running', 'stopping', 'completed', 'killed', 'failed']) {
    assert.equal(normalizeJob(job({ status })).status, status);
  }
  for (const status of ['paused', 'RUNNING', '', '   ', 7, null, undefined, true, {}]) {
    assert.equal(normalizeJob(job({ status })), null, `status=${JSON.stringify(status)} 应被丢掉`);
  }
});

test('任务：id / kind / label 缺失或空白就丢整条', () => {
  for (const key of ['id', 'kind', 'label']) {
    for (const value of [undefined, null, '', '   ', 7, [], {}, true]) {
      assert.equal(normalizeJob(job({ [key]: value })), null, `${key}=${JSON.stringify(value)} 应被丢掉`);
    }
  }
});

test('任务：startedAt 必须是非负安全整数，否则丢整条', () => {
  assert.equal(normalizeJob(job({ startedAt: 0 })).startedAt, 0);
  for (const startedAt of [-1, 1.5, '5', null, undefined, NaN, Infinity, 2 ** 53]) {
    assert.equal(normalizeJob(job({ startedAt })), null, `startedAt=${JSON.stringify(startedAt)} 应被丢掉`);
  }
});

test('任务：可选的 detail / finishedAt 坏了只丢字段，不丢任务', () => {
  for (const detail of [7, null, [], {}, '', '   ', true]) {
    const out = normalizeJob(job({ detail }));
    assert.ok(out, `detail=${JSON.stringify(detail)} 不该丢任务`);
    assert.equal('detail' in out, false);
  }
  for (const finishedAt of [-1, 1.5, '9', null, NaN, Infinity]) {
    const out = normalizeJob(job({ finishedAt }));
    assert.ok(out, `finishedAt=${JSON.stringify(finishedAt)} 不该丢任务`);
    assert.equal('finishedAt' in out, false);
  }
});

test('任务：非对象（含数组）一律 null', () => {
  for (const value of [null, undefined, 'x', 7, true, [], [job()]]) {
    assert.equal(normalizeJob(value), null);
  }
});

test('任务：超长文本被收窄，id/kind/label 截断、detail 补省略号', () => {
  const out = normalizeJob(job({
    id: 'i'.repeat(300),
    kind: 'k'.repeat(300),
    label: 'l'.repeat(300),
    detail: 'd'.repeat(500),
  }));
  assert.equal(out.id.length, 200);
  assert.equal(out.kind.length, 60);
  assert.equal(out.label.length, 200);
  assert.equal(out.detail.length, 301);
  assert.ok(out.detail.endsWith('…'));
});

test('一帧：非数组一律空数组', () => {
  for (const value of [null, undefined, 'x', 7, {}, { jobs: [] }, true]) {
    assert.deepEqual(normalizeJobs(value), []);
  }
});

test('一帧：坏条目丢掉，好条目按原顺序留下', () => {
  const out = normalizeJobs([null, job({ id: 'a' }), 'nope', job({ id: 'b', status: 'nope' }), job({ id: 'c', status: 'completed' }), 7]);
  assert.deepEqual(out.map((item) => item.id), ['a', 'c']);
});

test('一帧：按 id 去重，保留先出现的（宿主 last-wins，帧内不该有重复）', () => {
  const out = normalizeJobs([job({ id: 'same', label: '第一次' }), job({ id: 'same', label: '第二次' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, '第一次');
});

test('一帧：条数封顶 50，避免畸形宿主撑爆手机列表', () => {
  const many = Array.from({ length: 80 }, (_, index) => job({ id: `job-${index}` }));
  const out = normalizeJobs(many);
  assert.equal(out.length, 50);
  assert.equal(out[0].id, 'job-0');
  assert.equal(out[49].id, 'job-49');
});

test('一帧：空数组保持空数组（「任务都结束了」的唯一信号）', () => {
  assert.deepEqual(normalizeJobs([]), []);
});

test('一帧：不修改入参', () => {
  const input = [job({ detail: 'x' })];
  const snapshot = JSON.stringify(input);
  normalizeJobs(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('源码契约：/session/stream 必须把 session/jobs 整帧转发出去', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mobile', 'stream.js'), 'utf8');
  assert.ok(source.includes("const { normalizeJobs } = require('./jobs.js');"), 'stream.js 应导入 normalizeJobs');
  assert.ok(source.includes("p.type === 'session/jobs'"), 'stream.js 应有 session/jobs 分支');
  assert.ok(
    source.includes("const value = { type: 'session/jobs', sessionId, jobs: normalizeJobs(p.jobs) };"),
    'session/jobs 帧应经 normalizeJobs 收敛后再转发',
  );
});

// 端到端：真正挂起 /session/stream 的处理器，用一个假的上游 mux 发帧，
// 再从真实 HTTP 客户端读 SSE 正文。这是「帧确实出了网关」的直接证据 ——
// 源码契约只能证明那一行在，证明不了它会被走到。
test('端到端：session/jobs 整帧到达 SSE 客户端（空数组也到，别的会话不发）', async () => {
  const http = require('node:http');
  const { handleStream } = require('../lib/mobile/stream.js');

  const upstream = [
    {
      rpcId: 'r1',
      payload: {
        type: 'session/jobs',
        sessionId: 'session-x',
        jobs: [{
          id: 'j1',
          kind: 'bash',
          label: 'npm test',
          status: 'running',
          startedAt: 1_000,
          detail: '第 3 步',
          whenToUse: '不该出现在移动端',
        }],
      },
    },
    // 别的会话的帧必须被丢掉（处理器按 sessionId 过滤）。
    { payload: { type: 'session/jobs', sessionId: 'session-other', jobs: [{ id: 'j9', kind: 'bash', label: 'x', status: 'running', startedAt: 1 }] } },
    // 空数组：宿主靠它通知「任务都结束了」，绝不能吞。
    { payload: { type: 'session/jobs', sessionId: 'session-x', jobs: [] } },
  ];
  async function* mux() {
    for (const frame of upstream) yield frame;
  }
  const ctx = { apiProxy: { events: { mux: () => mux() } } };

  const server = http.createServer((req, res) => { void handleStream(ctx, req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/mobile/v1/session/stream?sessionId=session-x' },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
  server.close();

  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const jobsFrames = dataLines.filter((item) => item.type === 'session/jobs');

  assert.equal(jobsFrames.length, 2, '有任务与空数组两帧都应到达客户端');
  assert.equal(jobsFrames[0].sessionId, 'session-x');
  assert.equal(jobsFrames[0].jobs.length, 1);
  assert.deepEqual(
    Object.keys(jobsFrames[0].jobs[0]).sort(),
    ['detail', 'id', 'kind', 'label', 'startedAt', 'status'],
    '未声明的字段（whenToUse）必须被收敛掉',
  );
  assert.equal(jobsFrames[0].jobs[0].detail, '第 3 步');
  assert.deepEqual(jobsFrames[1].jobs, [], '空数组必须原样转发');
  assert.ok(!dataLines.some((item) => item.sessionId === 'session-other'), '别的会话的帧不该出现');
});

'use strict';

/**
 * 移动端「引用发现」（@文件 / @会话 补全）的透传契约。
 *
 * 桌面端输入 @ 会同时发起 fileReferences/list 与 sessionReferenceResolver/candidates
 * 两个 Remote 调用，文件排在会话前面。手机端此前完全没有这条入口。这两个宿主服务
 * 不在 apiProxy 上，是 Typert Remote 服务，同进程经 ctx.get('typertGateway') 到达。
 *
 * 这条链路每一条都容易写错：
 *
 *  1. **参数名是宿主生成的 wire 名**。两个方法的声明参数都是
 *     agent(wire=agentId) + query(wire=query)，所以 args 必须是
 *     `{ agentId, query }`；query 是普通 JSON 字符串（messageFeedback 则是
 *     `{ request: {…} }` 包装），写成 `{sessionId}` 会被宿主 arguments-invalid 拒绝；
 *  2. 方法是 `list` / `candidates`，命名空间是 `fileReferences` /
 *     `sessionReferenceResolver`——写成 sessionReferences 之类就 service-unavailable；
 *  3. 宿主返回的是 **数组**（不是 {items}），畸形行必须丢掉而不是原样透传；
 *  4. 会话候选的 mention 是宿主规范写法，缺 mention 的行等于不可用，必须丢；
 *  5. 两个域各自独立降级：一个域不可用不影响另一个域；
 *  6. 网关缺失（宿主没装 dsh-api-gateway 或对应服务）是 503，不是 400。
 *
 * 本测试驱动真实的 handler（不是转写实现）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');
const { readWiring } = require('./lib/wiring.cjs')

const {
  handleFileReferences,
  handleSessionReferences,
  normalizeFileCandidate,
  normalizeSessionCandidate,
  normalizeId,
  normalizeQuery,
  statusOf,
  REFERENCE_QUERY_MAX_CHARS,
  REFERENCE_MAX_ITEMS,
  REFERENCE_UNAVAILABLE,
} = require('../lib/mobile/references.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 假宿主：记录每一次网关调用，按 endpoint 给假实现
//
// 注意 invoke 的返回形状：它回的是 decode 后的业务结果本体，不是 {ok,value} 外壳
// （那层壳是浏览器传输加的）。fileReferences.list / sessionReferenceResolver.candidates
// 声明的 result 是数组，所以真实宿主回来就是裸数组——假实现照抄这一点。
// ---------------------------------------------------------------------------

function makeGateway(impl = {}) {
  const calls = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const key = `${request.namespace}/${request.method}`;
      const fn = impl[key];
      if (fn) return fn(request);
      return [];
    },
  };
}

/** 复刻宿主侧 typertGateway 的注册方式：ctx.get('typertGateway')。 */
function makeCtx(gateway) {
  return { get: (name) => (name === 'typertGateway' ? gateway : undefined) };
}

function makeReq(url) {
  const req = Readable.from([Buffer.from('{}')]);
  req.headers = {};
  req.url = url;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

async function call(handler, ctx, url) {
  const res = makeRes();
  await handler(ctx, makeReq(url), res);
  assert.notEqual(res.status, null, 'handler 必须写回响应');
  return res;
}

const q = (sessionId, query) =>
  `/api/mobile/v1/x?sessionId=${encodeURIComponent(sessionId)}&query=${encodeURIComponent(query === undefined ? '' : query)}`;

// ---------------------------------------------------------------------------
// 1. query 归一化：缺失等同空串，超长本地拒绝
// ---------------------------------------------------------------------------

test('normalizeQuery 把缺失当空串，超长本地拒绝', () => {
  assert.deepEqual(normalizeQuery(null), { query: '' });
  assert.deepEqual(normalizeQuery(undefined), { query: '' });
  assert.deepEqual(normalizeQuery(''), { query: '' });
  assert.deepEqual(normalizeQuery('src/ind'), { query: 'src/ind' });
  assert.deepEqual(normalizeQuery('a'.repeat(REFERENCE_QUERY_MAX_CHARS)), { query: 'a'.repeat(REFERENCE_QUERY_MAX_CHARS) });
  assert.match(normalizeQuery('a'.repeat(REFERENCE_QUERY_MAX_CHARS + 1)).error, /query 过长/);
  assert.match(normalizeQuery(123).error, /query 必须是字符串/);
});

// ---------------------------------------------------------------------------
// 2. sessionId 归一化
// ---------------------------------------------------------------------------

test('normalizeId 拒绝空、空白和超长 sessionId', () => {
  assert.deepEqual(normalizeId('session-a', 'sessionId'), { id: 'session-a' });
  assert.deepEqual(normalizeId('  session-a  ', 'sessionId'), { id: 'session-a' });
  assert.match(normalizeId(null, 'sessionId').error, /缺少 sessionId/);
  assert.match(normalizeId('   ', 'sessionId').error, /缺少 sessionId/);
  assert.match(normalizeId('a'.repeat(201), 'sessionId').error, /sessionId 过长/);
  assert.match(normalizeId(7, 'sessionId').error, /sessionId 必须是字符串/);
});

// ---------------------------------------------------------------------------
// 3. 候选行规范化：畸形一律丢掉
// ---------------------------------------------------------------------------

test('normalizeFileCandidate 只认 { path, kind }', () => {
  assert.deepEqual(normalizeFileCandidate({ path: 'src/a.ts', kind: 'file' }), { path: 'src/a.ts', kind: 'file' });
  assert.deepEqual(normalizeFileCandidate({ path: 'src', kind: 'directory' }), { path: 'src', kind: 'directory' });
  assert.equal(normalizeFileCandidate({ path: 'src', kind: 'symlink' }), null);
  assert.equal(normalizeFileCandidate({ path: '', kind: 'file' }), null);
  assert.equal(normalizeFileCandidate({ kind: 'file' }), null);
  assert.equal(normalizeFileCandidate(null), null);
  assert.equal(normalizeFileCandidate(['src/a.ts']), null);
});

test('normalizeSessionCandidate 丢掉没有 mention 的行，label 退回 sessionId', () => {
  const full = normalizeSessionCandidate({
    sessionId: 's-1', label: 'RENAMED-FRESH', mention: '@[RENAMED-FRESH](dsh-session:InNlc3Npb24p)',
    cwd: '/private/tmp/x', createdAt: 1790705111657,
  });
  assert.deepEqual(full, {
    sessionId: 's-1', label: 'RENAMED-FRESH', mention: '@[RENAMED-FRESH](dsh-session:InNlc3Npb24p)',
    cwd: '/private/tmp/x', createdAt: 1790705111657,
  });
  // mention 缺失 = 客户端无法原样发送，等于不可用
  assert.equal(normalizeSessionCandidate({ sessionId: 's-1', label: 'x' }), null);
  assert.equal(normalizeSessionCandidate({ sessionId: 's-1', mention: '' }), null);
  assert.equal(normalizeSessionCandidate({ label: 'x', mention: '@[x](dsh-session:Ingp)' }), null);
  // label 缺失退回 sessionId；cwd 缺失不写空串；createdAt 非数字写 0
  assert.deepEqual(normalizeSessionCandidate({ sessionId: 's-2', mention: '@[s-2](dsh-session:InMy0p)' }), {
    sessionId: 's-2', label: 's-2', mention: '@[s-2](dsh-session:InMy0p)', createdAt: 0,
  });
});

// ---------------------------------------------------------------------------
// 4. file-references 走对 endpoint，参数用 wire 名
// ---------------------------------------------------------------------------

test('file-references 用 fileReferences/list + { agentId, query } 调网关', async () => {
  const gateway = makeGateway({
    'fileReferences/list': () => [
      { path: 'PHONE-GOAL-PROBE.md', kind: 'file' },
      { path: 'src', kind: 'directory' },
      { path: 'nope', kind: 'symlink' },   // 畸形的丢掉
    ],
  });
  const res = await call(handleFileReferences, makeCtx(gateway), q('session-eacb', 'PHONE'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    items: [
      { path: 'PHONE-GOAL-PROBE.md', kind: 'file' },
      { path: 'src', kind: 'directory' },
    ],
  });
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].namespace, 'fileReferences');
  assert.equal(gateway.calls[0].method, 'list');
  assert.deepEqual(gateway.calls[0].args, { agentId: 'session-eacb', query: 'PHONE' });
  // 引用发现声明了 cancellation.signal，必须给一个真的取消边界
  assert.equal(typeof gateway.calls[0].signal, 'object');
  assert.equal(gateway.calls[0].signal.aborted, false);
});

test('file-references 空 query 就是列出全部', async () => {
  // 真实宿主这里回来的是裸数组（见文件头对 invoke 形状的说明）
  const gateway = makeGateway({ 'fileReferences/list': () => [{ path: 'a', kind: 'file' }] });
  const res = await call(handleFileReferences, makeCtx(gateway), q('session-eacb'));
  assert.equal(res.status, 200);
  assert.deepEqual(gateway.calls[0].args, { agentId: 'session-eacb', query: '' });
});

// ---------------------------------------------------------------------------
// 5. session-references 走 candidates（不是 list）
// ---------------------------------------------------------------------------

test('session-references 用 sessionReferenceResolver/candidates 调网关', async () => {
  const gateway = makeGateway({
    'sessionReferenceResolver/candidates': () => [
      { sessionId: 's-1', label: 'A', mention: '@[A](dsh-session:InNp)', cwd: '/tmp', createdAt: 5 },
      { sessionId: '', label: 'B', mention: '@[B](dsh-session:InBp)' },  // 无 id 丢掉
    ],
  });
  const res = await call(handleSessionReferences, makeCtx(gateway), q('session-eacb', 'A'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    items: [{ sessionId: 's-1', label: 'A', mention: '@[A](dsh-session:InNp)', cwd: '/tmp', createdAt: 5 }],
  });
  assert.equal(gateway.calls[0].namespace, 'sessionReferenceResolver');
  assert.equal(gateway.calls[0].method, 'candidates');
  assert.deepEqual(gateway.calls[0].args, { agentId: 'session-eacb', query: 'A' });
});

// ---------------------------------------------------------------------------
// 6. 结果限量：宿主自己也有 candidateLimit，手机侧再兜一层
// ---------------------------------------------------------------------------

test('候选超过上限时截断到 REFERENCE_MAX_ITEMS', async () => {
  const rows = Array.from({ length: 80 }, (unused, i) => ({ path: `f${i}`, kind: 'file' }));
  const gateway = makeGateway({ 'fileReferences/list': () => rows });
  const res = await call(handleFileReferences, makeCtx(gateway), q('s'));
  assert.equal(res.body.items.length, REFERENCE_MAX_ITEMS);
  assert.equal(res.body.items[0].path, 'f0');
});

// ---------------------------------------------------------------------------
// 7. 缺 sessionId 本地 400，不打扰宿主
// ---------------------------------------------------------------------------

test('缺 sessionId 时本地 400，不调用网关', async () => {
  const gateway = makeGateway();
  const res = await call(handleFileReferences, makeCtx(gateway), '/api/mobile/v1/file-references?query=a');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad-request');
  assert.match(res.body.error.message, /缺少 sessionId/);
  assert.equal(gateway.calls.length, 0);
});

test('query 超长时本地 400，不调用网关', async () => {
  const gateway = makeGateway();
  const res = await call(handleFileReferences, makeCtx(gateway), q('s', 'a'.repeat(REFERENCE_QUERY_MAX_CHARS + 1)));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /query 过长/);
  assert.equal(gateway.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 8. 网关缺失 / 服务缺失 = 503，业务失败 = 400
// ---------------------------------------------------------------------------

test('宿主没装网关时 503 且不炸', async () => {
  const res = await call(handleFileReferences, { get: () => undefined }, q('s'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, REFERENCE_UNAVAILABLE.code);
  assert.match(res.body.error.message, /引用发现服务/);
});

test('网关抛 service-unavailable 也翻成 503', async () => {
  const gateway = makeGateway({
    'fileReferences/list': () => { const e = new Error('typert gateway: fileReferences/list: service unavailable'); e.code = 'service-unavailable'; throw e; },
  });
  const res = await call(handleFileReferences, makeCtx(gateway), q('s'));
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, REFERENCE_UNAVAILABLE.code);
});

test('其它网关异常按原话回报 400', async () => {
  const gateway = makeGateway({
    'fileReferences/list': () => { const e = new Error('typert gateway: fileReferences/list: arguments-invalid'); e.code = 'arguments-invalid'; throw e; },
  });
  const res = await call(handleFileReferences, makeCtx(gateway), q('s'));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'reference-error');
  assert.match(res.body.error.message, /arguments-invalid/);
});

test('宿主的业务失败 { ok:false, error } 原样回报', async () => {
  const gateway = makeGateway({
    'sessionReferenceResolver/candidates': () => ({ ok: false, error: { code: 'session-not-found', message: '会话不存在：s' } }),
  });
  const res = await call(handleSessionReferences, makeCtx(gateway), q('s'));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'session-not-found');
  assert.equal(res.body.error.message, '会话不存在：s');
});

test('宿主若把结果包成 { ok:true, value } 也认（容错，防 schema 改回联合）', async () => {
  const gateway = makeGateway({
    'fileReferences/list': () => ({ ok: true, value: [{ path: 'wrapped.md', kind: 'file' }] }),
  });
  const res = await call(handleFileReferences, makeCtx(gateway), q('s'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [{ path: 'wrapped.md', kind: 'file' }]);
});

test('statusOf：能力缺失 503，其余 400', () => {
  assert.equal(statusOf({ code: REFERENCE_UNAVAILABLE.code }), 503);
  assert.equal(statusOf({ code: 'reference-error' }), 400);
  assert.equal(statusOf(null), 400);
});

// ---------------------------------------------------------------------------
// 9. 两个域各自独立降级
// ---------------------------------------------------------------------------

test('文件域不可用时会话域照常工作（各自独立降级）', async () => {
  const gateway = makeGateway({
    'fileReferences/list': () => { const e = new Error('service unavailable'); e.code = 'service-unavailable'; throw e; },
    'sessionReferenceResolver/candidates': () => [{ sessionId: 's-1', label: 'A', mention: '@[A](dsh-session:InNp)' }],
  });
  const ctx = makeCtx(gateway);
  const files = await call(handleFileReferences, ctx, q('s'));
  const sessions = await call(handleSessionReferences, ctx, q('s'));
  assert.equal(files.status, 503);
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body.items.length, 1);
});

// ---------------------------------------------------------------------------
// 10. 源码契约：路由挂上去了，且没有绕回 apiProxy
// ---------------------------------------------------------------------------

test('index.js 挂了两条路由并 require 了新模块', () => {
  const src = readWiring();
  assert.match(src, /require\('(?:\.\.\/mobile|\.\/mobile)\/references\.js'\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/file-references', references\.handleFileReferences\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/session-references', references\.handleSessionReferences\)/);
});

test('references.js 不碰 apiProxy，只走 typertGateway', () => {
  const src = readSource('lib/mobile/references.js');
  assert.match(src, /ctx\.get\('typertGateway'\)/);
  // 注释里可以提 apiProxy（解释为什么不能走它），但不能真的调用
  assert.equal(src.includes('ctx.apiProxy'), false);
  assert.equal(/apiProxy\s*\./.test(src), false);
  assert.match(src, /namespace: 'fileReferences'/);
  assert.match(src, /namespace: 'sessionReferenceResolver'/);
  assert.match(src, /method: 'candidates'/);
});

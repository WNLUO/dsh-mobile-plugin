// 条件刷新只认未失效的构建，桌面变更期间迟到的旧列表不能登记为最新。
'use strict';

/**
 * 变更型操作必须让「会话列表缓存」立刻失效（真机回归）。
 *
 * 真机现象：手机侧栏里对会话点 ⋯ →「重命名」，改成 RENAMED-BY-PHONE →「保存」，
 * 标题栏（聊天页）立刻变了，但**侧栏那一行纹丝不动**，还是旧名字；过上十来秒才自己好。
 * 「归档会话」同款：宿主那边已经归档成功，侧栏那一行却还留着，看着像没生效。
 *
 * 根因：`/sessions` 的完整响应会按设备缓存 SESSION_LIST_CACHE_MS（10 秒），用来压住
 * 手机轮询对桌面的冲击。`handleSessionRead` 早就知道「状态变了要清缓存」，
 * 但 rename / fork / new 以及 workspaces.js 的 archive / move 全都漏了这一步：
 * App 保存后紧接着的 `load(true)` 正好落进那个 10 秒窗口，于是把自己刚改的数据
 * 又用旧值覆盖回屏幕上。宿主侧数据一直是对的（用 curl 查 title 已经是新值）。
 *
 * 本测试驱动真实的 handle* 函数，不转写实现。
 *
 * 注意：会话标题来自宿主摘要的 `projections.values.title`（见 sessions.js 的 listTitle），
 * 不是顶层 `title` 字段——夹具必须照宿主的真实形状造，否则 listTitle 会退化成 cwd 目录名。
 */

const { Readable } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { listSignal } = require('../lib/shared/list-signal.js');
const {
  handleSessions,
  buildSessionsResponse,
  handleRename,
  handleFork,
  handleNew,
  invalidateSessionList,
} = require('../lib/mobile/sessions.js');
const { handleArchiveSession, handleMoveSession } = require('../lib/mobile/workspaces.js');
const { dropSessionListCache, completionGenerationOf, sessionListResponseState } = require('../lib/mobile/session-cache.js');

function makeReq(body, deviceHeader) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = {};
  if (deviceHeader) req.headers['x-dsh-device'] = deviceHeader;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

/** 造一条与宿主 sessions.list 同形的摘要：标题在 projections.values.title 里。 */
function mkSession(sessionId, title, cwd, updatedAt, extra = {}) {
  return {
    sessionId,
    cwd,
    updatedAt,
    running: false,
    blank: false,
    projections: { values: { title } },
    ...extra,
  };
}

/** 改标题也必须改 projections，否则 listTitle 读不到。 */
function retitle(item, title) {
  return { ...item, projections: { ...item.projections, values: { ...item.projections.values, title } } };
}

const initialItems = () => [
  mkSession('session-a', '旧标题', '/ws/a', 2000),
  mkSession('session-kept', '留下的会话', '/ws/a', 1000),
];

/**
 * 假宿主：items / archivedSessionIds 都是活对象，handler 改动它们之后，
 * 下一次 buildSessionsResponse 才能看到「宿主已经被改过了」。
 */
function makeCtx() {
  const state = {
    items: initialItems(),
    archivedSessionIds: [],
    modelCatalogCalls: 0,
  };
  const ctx = {
    state,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        rename: async () => {
          state.items = state.items.map(it => (it.sessionId === 'session-a' ? retitle(it, '新标题') : it));
          return { result: { ok: true, value: { title: '新标题', seq: 3 } } };
        },
        fork: async () => {
          state.items = [...state.items, mkSession('session-fork', '旧标题 (1)', '/ws/a', 3000)];
          return { result: { ok: true, value: { sessionId: 'session-fork' } } };
        },
        create: async () => {
          state.items = [...state.items, mkSession('session-new', '', '/ws/a', 4000, { blank: true })];
          return { result: { ok: true, value: { sessionId: 'session-new' } } };
        },
        models: async () => {
          state.modelCatalogCalls += 1;
          return { result: { ok: false, error: { code: 'internal', message: '模型目录不可用' } } };
        },
      },
      workspace: {
        // items 里要真有那两条会话所在的目录：`/session/new` 现在要求 cwd 落在已登记
        // 的工作区里（见 session-new-cwd.test.cjs），空清单会让新建那一条直接 403。
        list: async () => ({
          result: {
            ok: true,
            value: { items: [{ workspaceId: 'w1', path: '/ws/a' }], archivedSessionIds: state.archivedSessionIds },
          },
        }),
        archiveSession: async () => {
          state.archivedSessionIds = [...state.archivedSessionIds, 'session-a'];
          return { result: { ok: true, value: { ok: true } } };
        },
        insertSessionBefore: async () => {
          state.items = state.items.map(it => (it.sessionId === 'session-a' ? { ...it, cwd: '/ws/b' } : it));
          return { result: { ok: true, value: { workspace: { workspaceId: 'w1' } } } };
        },
      },
    },
  };
  return ctx;
}

/** 走一次真实的 GET /sessions（带同一台设备的头），返回响应体。 */
async function readSessions(ctx, deviceKey, revision, handler = handleSessions) {
  const res = makeRes();
  const req = makeReq({}, deviceKey);
  req.url = '/api/mobile/v1/sessions' + (revision ? `?rev=${encodeURIComponent(revision)}` : '');
  await handler(ctx, req, res);
  assert.equal(res.status, 200, `GET /sessions 应返回 200，实际 ${res.status}`);
  return res.body;
}

const titlesOf = (body) => body.items.map(item => item.title);
const idsOf = (body) => body.items.map(item => item.sessionId);

test('重命名之后列表立刻是新标题（真机缺陷）', async () => {
  const ctx = makeCtx();
  assert.deepEqual(titlesOf(await readSessions(ctx)), ['旧标题', '留下的会话']);

  const res = makeRes();
  await handleRename(ctx, makeReq({ sessionId: 'session-a', title: '新标题' }), res);
  assert.equal(res.status, 200);

  assert.deepEqual(titlesOf(await readSessions(ctx)), ['新标题', '留下的会话']);
});

test('对照：没有变更时缓存仍然生效（证明上面那条抓的不是「本来就不缓存」）', async () => {
  const ctx = makeCtx();
  assert.deepEqual(titlesOf(await readSessions(ctx)), ['旧标题', '留下的会话']);
  // 绕过 handler 直接改宿主数据：没有任何变更动作 → 10 秒窗口内仍应返回缓存。
  ctx.state.items = [retitle(ctx.state.items[0], '绕过插件改的标题'), ctx.state.items[1]];
  assert.deepEqual(titlesOf(await readSessions(ctx)), ['旧标题', '留下的会话']);
});

test('归档之后那一行立刻消失', async () => {
  const ctx = makeCtx();
  assert.deepEqual(idsOf(await readSessions(ctx)), ['session-a', 'session-kept']);

  const res = makeRes();
  await handleArchiveSession(ctx, makeReq({ sessionId: 'session-a' }), res);
  assert.equal(res.status, 200);

  assert.deepEqual(idsOf(await readSessions(ctx)), ['session-kept']);
});

test('分叉之后新会话立刻出现', async () => {
  const ctx = makeCtx();
  await readSessions(ctx);

  const res = makeRes();
  await handleFork(ctx, makeReq({ sessionId: 'session-a' }), res);
  assert.equal(res.status, 200);

  assert.deepEqual(idsOf(await readSessions(ctx)), ['session-a', 'session-kept', 'session-fork']);
});

test('新建会话之后它立刻出现在列表里', async () => {
  const ctx = makeCtx();
  await readSessions(ctx);

  const res = makeRes();
  await handleNew(ctx, makeReq({ cwd: '/ws/a' }), res);
  assert.equal(res.status, 200);
  assert.equal(ctx.state.modelCatalogCalls, 0, '新建会话不得同步查询宿主模型目录');

  assert.deepEqual(idsOf(await readSessions(ctx)), ['session-a', 'session-kept', 'session-new']);
});

test('移动/重排会话之后 cwd 立刻更新', async () => {
  const ctx = makeCtx();
  assert.deepEqual((await readSessions(ctx)).items.map(i => i.cwd), ['/ws/a', '/ws/a']);

  const res = makeRes();
  await handleMoveSession(ctx, makeReq({ workspaceId: 'w1', sessionId: 'session-a' }), res);
  assert.equal(res.status, 200);

  assert.deepEqual((await readSessions(ctx)).items.map(i => i.cwd), ['/ws/b', '/ws/a']);
});

test('invalidateSessionList() 不带设备时清掉所有设备', async () => {
  const ctx = makeCtx();
  await readSessions(ctx, 'phone-a');
  await readSessions(ctx, 'phone-b');
  ctx.state.items = [retitle(ctx.state.items[0], '改过了'), ctx.state.items[1]];

  invalidateSessionList(ctx);

  assert.deepEqual(titlesOf(await readSessions(ctx, 'phone-a')), ['改过了', '留下的会话']);
  assert.deepEqual(titlesOf(await readSessions(ctx, 'phone-b')), ['改过了', '留下的会话']);
});

test('invalidateSessionList(deviceKey) 只清这一台设备', async () => {
  const ctx = makeCtx();
  await readSessions(ctx, 'phone-a');
  await readSessions(ctx, 'phone-b');
  ctx.state.items = [retitle(ctx.state.items[0], '改过了'), ctx.state.items[1]];

  invalidateSessionList(ctx, 'phone-a');

  assert.deepEqual(titlesOf(await readSessions(ctx, 'phone-a')), ['改过了', '留下的会话']);
  // phone-b 的缓存没被动过：窗口内继续拿旧值，说明上面那条不是「清了个寂寞」。
  assert.deepEqual(titlesOf(await readSessions(ctx, 'phone-b')), ['旧标题', '留下的会话']);
});

test('缓存按 ctx 隔离，别把另一个宿主的一起清了', async () => {
  const ctxA = makeCtx();
  const ctxB = makeCtx();
  await readSessions(ctxA);
  await readSessions(ctxB);
  ctxB.state.items = [retitle(ctxB.state.items[0], 'B 改了'), ctxB.state.items[1]];

  invalidateSessionList(ctxA);

  assert.deepEqual(titlesOf(await readSessions(ctxA)), ['旧标题', '留下的会话']);   // A 只是被清了缓存，重建后仍是旧值
  assert.deepEqual(titlesOf(await readSessions(ctxB)), ['旧标题', '留下的会话']);   // B 的缓存没被 A 波及
});

test('有构建在飞时失效，旧构建不会把过期数据写回缓存', async () => {
  const ctx = makeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realList = ctx.apiProxy.sessions.list;
  // 必须在放开闸门**之前**就把宿主数据抓成快照：这次构建代表「变更之前的那一次」，
  // 否则它读到的其实是变更之后的数据，用例也就抓不到任何东西。
  ctx.apiProxy.sessions.list = async (request) => {
    const snapshot = { result: { ok: true, value: { items: ctx.state.items } } };
    await gate;
    return snapshot;
  };

  const inFlight = readSessions(ctx);            // 开始构建（此刻读到的是旧 items）
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  ctx.state.items = [retitle(ctx.state.items[0], '新标题'), ctx.state.items[1]];
  invalidateSessionList(ctx);                    // 清缓存 + 抬 generation
  release();
  await inFlight;                                // 旧构建返回，但 generation 已变 → 不落缓存

  assert.deepEqual(titlesOf(await readSessions(ctx)), ['新标题', '留下的会话']);
});

/**
 * 下面两条针对「桌面侧自己动的手」（会话跑完、标题被桌面改掉……）：这类变更没有经过
 * 插件的任何 handler，所以既不会被 invalidateSessionList 清掉，也不该抬完成态朝代号
 * （generation 一变，sessions.js 就不再折叠 completed / lastTurnError，红点永远不亮）。
 * 唯一的清缓存入口是变更信号总线调用的 dropSessionListCache。
 */
test('变更信号丢缓存：手机下一次拉列表立刻看到桌面改的内容，且不动完成态朝代号', async () => {
  const ctx = makeCtx();
  await readSessions(ctx);                                     // 先填上这层 10s 缓存
  const generation = completionGenerationOf(ctx, 'legacy');
  ctx.state.items = [retitle(ctx.state.items[0], '桌面改的标题'), ctx.state.items[1]];

  dropSessionListCache(ctx);

  assert.deepEqual(titlesOf(await readSessions(ctx)), ['桌面改的标题', '留下的会话'],
    '变更信号到了却没丢缓存：手机要等满 10 秒才看得到');
  assert.equal(completionGenerationOf(ctx, 'legacy'), generation,
    '丢缓存绝不能抬完成态朝代号，否则 completed / lastTurnError 永远不会被折出来');
});

test('变更信号挡住在飞构建把变更前的清单写回缓存', async () => {
  const ctx = makeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realList = ctx.apiProxy.sessions.list;
  // 必须在放开闸门**之前**就把宿主数据抓成快照：这次构建代表「变更之前的那一次」，
  // 否则它读到的其实是变更之后的数据，用例也就抓不到任何东西。
  ctx.apiProxy.sessions.list = async (request) => {
    const snapshot = { result: { ok: true, value: { items: ctx.state.items } } };
    await gate;
    return snapshot;
  };

  const inFlight = readSessions(ctx);            // 变更之前发起的构建，手里是旧 items
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  ctx.state.items = [retitle(ctx.state.items[0], '变更后的标题'), ctx.state.items[1]];
  dropSessionListCache(ctx);                     // 变更信号到达（此时构建还在飞）
  release();
  await inFlight;

  assert.deepEqual(titlesOf(await readSessions(ctx)), ['变更后的标题', '留下的会话'],
    '变更前发起的构建把旧清单按新时间戳写回了缓存，又会多活 10 秒');
});

async function lateConditionalReadContract(handler = handleSessions, invalidate = dropSessionListCache) {
  const ctx = makeCtx();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  let listCalls = 0;
  ctx.apiProxy.sessions.list = async () => {
    const items = ctx.state.items;
    listCalls += 1;
    started();
    if (listCalls === 1) await gate;
    return { result: { ok: true, value: { items } } };
  };
  const unwatch = listSignal.watch();
  listSignal.bump('conditional-before');
  try {
    const pending = readSessions(ctx, undefined, undefined, handler);
    await reading;
    ctx.state.items = [...ctx.state.items, mkSession('desktop-new', '电脑新建', '/ws/a', 3000)];
    invalidate(ctx);
    listSignal.bump('conditional-after');
    release();
    const old = await pending;
    assert.equal(old.items.length, 2);
    const latest = await readSessions(ctx, undefined, old.revision, handler);
    assert.notEqual(latest.unchanged, true, '旧构建不能把新变更登记为已同步');
    assert.ok(latest.items.some((item) => item.sessionId === 'desktop-new'), '条件刷新必须拿回桌面新会话');
    assert.equal(listCalls, 2, '有新信号时必须重新读取宿主');
  } finally {
    release();
    unwatch();
  }
}

test('构建期间桌面新建会话，带旧 revision 的下一读不能短路', async () => {
  await lateConditionalReadContract();
  await lateConditionalReadContract(handleSessions, invalidateSessionList);
});

function mutatedSessions(before, after) {
  const file = path.join(__dirname, '../lib/mobile/sessions.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, '变异必须命中唯一列表缓存判据');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source.replace(before, after), file);
  return mod.exports;
}

test('变异：旧构建仍登记条件刷新基准，会被同一桌面新建断言拒绝', async () => {
  const broken = mutatedSessions(
    '      if (!archivedOnly) rememberListBuild(cache, response.body, generation);',
    '    }\n    if (response.status === 200) rememberListBuild(cache, response.body, completionGenerationOf(ctx, deviceKey));\n    if (false) {',
  );
  await assert.rejects(lateConditionalReadContract(broken.handleSessions), { code: 'ERR_ASSERTION' });
});

async function conditionalPreviewContract(handler = handleSessions) {
  const ctx = makeCtx();
  const old = await readSessions(ctx, undefined, undefined, handler);
  ctx.state.items = [...ctx.state.items, mkSession('preview-new', '新对话', '/ws/a', 4000)];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ctx.apiProxy.sessions.history = async () => {
    await gate;
    return { result: { ok: true, value: { events: [
      { event: { type: 'assistant/message', seq: 1, time: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: '预览补齐' }] } } } },
    ] } } };
  };
  dropSessionListCache(ctx);
  let response;
  const pending = readSessions(ctx, undefined, old.revision, handler).then((body) => { response = body; });
  try {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(response?.items.some((item) => item.sessionId === 'preview-new'), '实时条件读必须先显示新会话');
    release(); await pending;
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const latest = await readSessions(ctx, undefined, response.revision, handler);
    assert.notEqual(latest.unchanged, true, '异步预览补齐后必须作废条件短路基准');
    assert.equal(latest.items.find((item) => item.sessionId === 'preview-new').lastMessage.text, '预览补齐');
  } finally { release(); await pending; }
}

test('实时条件读先显示新会话，异步预览补齐后能再次读到', () => conditionalPreviewContract());

test('变异：条件读等待预览或不作废旧短路，均被同一新对话断言拒绝', async () => {
  for (const [before, after] of [
    ['const buildOptions = revEligible && rev ? {', 'const buildOptions = false ? {'],
    ['onPreviewsReady: () => dropSessionListCache(ctx, deviceKey),', 'onPreviewsReady: () => {},'],
  ]) {
    await assert.rejects(conditionalPreviewContract(mutatedSessions(before, after).handleSessions), { code: 'ERR_ASSERTION' });
  }
});

async function deferredPreviewContract(build = buildSessionsResponse) {
  const ctx = makeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ctx.apiProxy.sessions.history = async () => {
    await gate;
    return { result: { ok: true, value: { events: [
      { event: { type: 'assistant/message', seq: 1, time: 5, data: { message: { id: 'preview', role: 'assistant', content: [{ type: 'text', text: '最后一句' }] } } } },
    ] } } };
  };
  let ready = 0, response;
  const options = { awaitPreviews: false, onPreviewsReady: () => { ready += 1; } };
  const pending = build(ctx, 'legacy', undefined, false, false, null, options).then((value) => { response = value; });
  try {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(response, '清单不得等消息预览读取结束');
    assert.equal(response.body.items.length, 2);
    const original = JSON.stringify(response.body);
    release(); await pending;
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, 1, '预览补齐后必须通知下一轮清单');
    assert.equal(JSON.stringify(response.body), original, '预览补齐不能偷偷修改已发清单与revision');
    const next = await build(ctx, 'legacy', undefined, false, false, null, options);
    assert.equal(next.body.items[0].lastMessage.text, '最后一句');
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, 1, '预览没变不能每轮重扫清单');
  } finally { release(); await pending; }
}

test('实时清单不等慢消息预览，补齐后仅通知一次且保持已发快照不变', async () => {
  await deferredPreviewContract();
});

test('变异：清单重新等待预览，会被同一慢历史断言拒绝', async () => {
  const broken = mutatedSessions('const deferPreviews = buildOptions.awaitPreviews === false;', 'const deferPreviews = false;');
  await assert.rejects(deferredPreviewContract(broken.buildSessionsResponse), { code: 'ERR_ASSERTION' });
});

test('变异：异步预览修改已发清单，会被同一快照断言拒绝', async () => {
  const broken = mutatedSessions('const base = deferPreviews ? { ...listed } : listed;', 'const base = listed;');
  await assert.rejects(deferredPreviewContract(broken.buildSessionsResponse), { code: 'ERR_ASSERTION' });
});

async function underlyingRpcContract(handler = handleSessions, invalidate = dropSessionListCache) {
  const ctx = makeCtx();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  ctx.apiProxy.sessions.list = async () => {
    const items = ctx.state.items;
    calls += 1;
    started();
    if (calls === 1) await gate;
    return { result: { ok: true, value: { items } } };
  };
  const old = readSessions(ctx, undefined, undefined, handler);
  await reading;
  ctx.state.items = [...ctx.state.items, mkSession('rpc-new', '新会话', '/ws/a', 5000)];
  invalidate(ctx);
  let response;
  const latest = readSessions(ctx, undefined, 'old', handler).then((body) => { response = body; });
  try {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(response?.items.some((item) => item.sessionId === 'rpc-new'), '新构建不得加入变更前的底层宿主RPC');
    assert.equal(calls, 2);
  } finally { release(); await Promise.all([old, latest]); }
}

test('失效后的新构建不加入底层旧宿主 RPC', async () => {
  await underlyingRpcContract();
  await underlyingRpcContract(handleSessions, invalidateSessionList);
});

test('变异：底层宿主 RPC 跨失效代次合流，会被同一新会话断言拒绝', async () => {
  const rpcFile = path.join(__dirname, '../lib/mobile/rpc.js');
  const source = fs.readFileSync(rpcFile, 'utf8');
  const before = 'if (existing && existing.epoch === epoch) return existing.promise;';
  assert.equal(source.split(before).length, 2);
  const rpc = new Module(rpcFile, module);
  rpc.filename = rpcFile; rpc.paths = Module._nodeModulePaths(path.dirname(rpcFile));
  rpc._compile(source.replace(before, 'if (existing) return existing.promise;'), rpcFile);
  const file = path.join(__dirname, '../lib/mobile/sessions.js');
  const mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = mod.require.bind(mod);
  mod.require = (name) => name === './rpc.js' ? rpc.exports : originalRequire(name);
  mod._compile(fs.readFileSync(file, 'utf8'), file);
  await assert.rejects(underlyingRpcContract(mod.exports.handleSessions), { code: 'ERR_ASSERTION' });
});

async function detachedConstructionContract(drop = dropSessionListCache) {
  const ctx = makeCtx();
  let release;
  const old = new Promise((resolve) => { release = resolve; });
  const state = sessionListResponseState(ctx);
  state.promise = old;
  const generation = completionGenerationOf(ctx, 'legacy');
  drop(ctx);
  const pending = readSessions(ctx);
  let response;
  pending.then((value) => { response = value; });
  try {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(response, '变更后的新请求不能再搭旧构建');
    assert.equal(completionGenerationOf(ctx, 'legacy'), generation, '不能为清缓存抹掉完成态');
  } finally {
    release({ status: 200, body: { ok: true, items: [], revision: 'old' } });
    await pending;
  }
}

test('清单信号断开旧构建合流，后来的读取直接重建', () => detachedConstructionContract());

test('变异：清单信号只清结果不清在途合流，会被后续读取断言拒绝', async () => {
  const file = path.join(__dirname, '../lib/mobile/session-cache.js');
  const source = fs.readFileSync(file, 'utf8');
  const before = "    state.promise = null;\n    state.lastRevision = '';\n    state.droppedAt =";
  assert.equal(source.split(before).length, 2);
  const mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source.replace(before, "    state.lastRevision = '';\n    state.droppedAt ="), file);
  // 独立加载的WeakMap仍要喂同一份真实状态入口。
  const drop = (ctx) => {
    const actual = sessionListResponseState(ctx);
    const isolated = mod.exports.sessionListResponseState(ctx);
    Object.assign(isolated, actual);
    mod.exports.dropSessionListCache(ctx);
    Object.assign(actual, isolated);
  };
  await assert.rejects(detachedConstructionContract(drop), { code: 'ERR_ASSERTION' });
});

test('变异：补齐不通知或重复通知，均被同一预览断言拒绝', async () => {
  for (const predicate of ['false', 'true']) {
    const broken = mutatedSessions('previewsBefore !== JSON.stringify(completed)', predicate);
    await assert.rejects(deferredPreviewContract(broken.buildSessionsResponse), { code: 'ERR_ASSERTION' });
  }
});

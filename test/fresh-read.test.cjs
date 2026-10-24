'use strict';

/**
 * 写操作之后的刷新必须「读己所写」：`?fresh=1` 跳过所有代读副本（真机回归）。
 *
 * 真机现象：手机上对会话点 ⋯ →「归档会话」→「归档」，宿主侧立刻归档成功，但侧栏那一行
 * 还赖在列表里，一直到下一次 15 秒轮询才消失（重命名同样时快时慢，看运气）。上一轮修的
 * 是宿主插件自己那层 10 秒列表缓存（rename/fork/new/archive/move 后清缓存），但真机上
 * 归档仍然复现——说明还有一层挡在更前面。
 *
 * 探针实测（Mac 宿主 + MI 9，时间戳相对点击「归档」）：
 *   + 311ms  HOST archive-session session-63acd828-…   ← 宿主插件已经把写入做完了
 *   + 375ms  SNAPSHOT /api/mobile/v1/sessions fresh     ← App 那次刷新被 sidecar 的镜像
 *                                                         快照顶掉：+286ms 推来的旧镜像里
 *                                                         这一行还在
 *   +17233ms SNAPSHOT /api/mobile/v1/sessions fresh     ← 直到 15s 轮询才拿到新列表
 * 也就是说宿主是对的、宿主缓存也清对了，坏的是**这次刷新走的是代读副本**：sidecar 的镜像
 * 快照（桌面每 500ms 推一次，正常最多旧 500ms）挡在任何回源之前。
 *
 * 修法：写后刷新带 `?fresh=1`，两端都跳过副本直接回源（见 lib/shared/fresh-request.js）——
 * lan-proxy / tunnel 的镜像拦截，以及宿主插件的 10s 列表缓存。轮询/首屏/下拉刷新不带这个
 * 标记，快路径照旧。
 *
 * 本测试驱动真实的 handleSessions 与**真实的 lan-proxy HTTP 监听**（就是 App 打进来的那条
 * 路），不转写实现。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');

// 必须在 require credentials.js（lan-proxy 的依赖）之前指向临时文件，否则会污染真实凭据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fresh-read-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

const { isFreshRequest } = require('../lib/shared/fresh-request.js');
const { handleSessions } = require('../lib/mobile/sessions.js');
const { createLanProxy } = require('../lib/relay/lan-proxy.js');
const core = require('../lib/relay/core.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 1. 标记本身的判定：必须是完整的 fresh=1，不能把别的 query 误判进来
// ---------------------------------------------------------------------------

test('isFreshRequest 只认完整的 fresh=1', () => {
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?fresh=1'), true);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?a=1&fresh=1'), true);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?fresh=1&b=2'), true);
  assert.equal(isFreshRequest('?fresh=1'), true);

  assert.equal(isFreshRequest('/api/mobile/v1/sessions'), false);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?fresh=0'), false);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?afresh=1'), false);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?nofresh=1'), false);
  assert.equal(isFreshRequest('/api/mobile/v1/sessions?fresh=10'), false);
  assert.equal(isFreshRequest(undefined), false);
  assert.equal(isFreshRequest(null), false);
});

// ---------------------------------------------------------------------------
// 2. 宿主插件那层 10s 列表缓存：fresh 请求必须跳过它
// ---------------------------------------------------------------------------

function mkSession(sessionId, title, cwd, updatedAt) {
  // 标题来自宿主摘要的 projections.values.title（见 sessions.js 的 listTitle），不是顶层字段。
  return { sessionId, cwd, updatedAt, running: false, blank: false, projections: { values: { title } } };
}

function makeReq(body, deviceHeader, url) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.headers = {};
  if (deviceHeader) req.headers['x-dsh-device'] = deviceHeader;
  req.url = url || '/api/mobile/v1/sessions';
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

function makeCtx() {
  const state = {
    items: [
      mkSession('session-a', '旧标题', '/ws/a', 2000),
      mkSession('session-kept', '留下的会话', '/ws/a', 1000),
    ],
  };
  return {
    state,
    apiProxy: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: state.items } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: {
        list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
      },
    },
  };
}

async function readSessions(ctx, url, deviceKey) {
  const res = makeRes();
  await handleSessions(ctx, makeReq({}, deviceKey, url), res);
  assert.equal(res.status, 200, `GET ${url} 应返回 200，实际 ${res.status}`);
  return res.body;
}

const titlesOf = (body) => body.items.map(item => item.title);

test('宿主 10s 列表缓存：普通读拿缓存，?fresh=1 直接回源', async () => {
  const ctx = makeCtx();
  assert.deepEqual(titlesOf(await readSessions(ctx, '/api/mobile/v1/sessions')), ['旧标题', '留下的会话']);

  // 绕过 handler 直接改宿主数据：模拟「写入已在别处完成」。
  ctx.state.items = [mkSession('session-a', '宿主已改', '/ws/a', 2000), ctx.state.items[1]];

  // 普通读落在 10s 窗口内 → 还是旧值（证明这层缓存真的在挡）。
  assert.deepEqual(titlesOf(await readSessions(ctx, '/api/mobile/v1/sessions')), ['旧标题', '留下的会话']);

  // 写后刷新 → 必须看到宿主的最新状态。
  assert.deepEqual(titlesOf(await readSessions(ctx, '/api/mobile/v1/sessions?fresh=1')), ['宿主已改', '留下的会话']);
});

test('宿主缓存：?fresh=1 也不搭在途构建的车', async () => {
  const ctx = makeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  // 关键：把「调用当刻」的宿主状态冻结下来。否则等在途构建醒来时再去读 state.items，
  // 它也会读到新值，这条测试就变成了假通过（正是它第一次跑成 3004ms 的原因）。
  ctx.apiProxy.sessions.list = async () => {
    calls += 1;
    const captured = ctx.state.items;
    if (calls === 1) await gate;
    return { result: { ok: true, value: { items: captured } } };
  };
  const bail = setTimeout(() => release(), 5000);   // 兜底：断言失败也要放行，否则挂到超时

  const inFlight = readSessions(ctx, '/api/mobile/v1/sessions');   // 起飞（冻结的是旧 items）
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  ctx.state.items = [mkSession('session-a', '宿主已改', '/ws/a', 2000), ctx.state.items[1]];

  // 在途构建还挂着（读到的是改动前的旧数据），fresh 读必须自己重建、当场给出新值。
  const raced = await Promise.race([
    readSessions(ctx, '/api/mobile/v1/sessions?fresh=1').then(body => ({ done: true, titles: titlesOf(body) })),
    new Promise((resolve) => { setTimeout(() => resolve({ done: false, titles: null }), 1000); }),
  ]);
  clearTimeout(bail);
  release();
  const inFlightBody = await inFlight;

  assert.deepEqual(raced, { done: true, titles: ['宿主已改', '留下的会话'] }, 'fresh 读不能等在途构建（否则会把旧列表再显示一遍）');
  // 对照：挂在途的那次构建读到的确实是改动前的旧数据——说明上面那条不是「本来就没有在途」。
  assert.deepEqual(titlesOf(inFlightBody), ['旧标题', '留下的会话']);
});

// ---------------------------------------------------------------------------
// 3. 真实 lan-proxy 监听：镜像命中时普通读走快照，?fresh=1 必须回源
// ---------------------------------------------------------------------------

const INSTANCE = 'freshe2e';
const CODE = '246810';
const SECRET = 'fresh-read-secret-0123456789';
const LAN_PORT = Number(process.env.FRESH_LAN_PORT || 18733);

/** 假宿主：只记录被回源的请求，返回一个可区分的标记。 */
function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, from: 'upstream', path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function call(port, { method = 'GET', path: p, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('lan-proxy：镜像命中时普通读走快照，?fresh=1 回源（真机缺陷）', async () => {
  const upstream = await startUpstream();
  const snapshotPaths = [];
  const proxy = createLanProxy({
    lanPort: LAN_PORT,
    pairingCode: CODE,
    instanceId: INSTANCE,
    lanSecret: SECRET,
    upstreamPort: upstream.port,
    // 模拟 sidecar 的镜像快照：只认列表类读，其余回 null（= 回源）。
    readSnapshot: ({ path: p }) => {
      snapshotPaths.push(p);
      return String(p).includes('/api/mobile/v1/sessions') ? { ok: true, from: 'snapshot' } : null;
    },
    onApprove: async () => ({ approved: false }),
    onLog: () => {},
  });
  await proxy.start();
  try {
    const token = core.signLanToken(SECRET, INSTANCE, 3600);
    const headers = { authorization: `Bearer ${token}` };

    // 普通读：命中镜像，完全不打扰宿主。
    const cached = await call(LAN_PORT, { path: '/api/mobile/v1/sessions', headers });
    assert.equal(cached.status, 200, `普通读应 200，实际 ${cached.status}`);
    assert.equal(JSON.parse(cached.body).from, 'snapshot', '普通读应命中镜像快照（快路径不能被这次修复关掉）');
    assert.equal(upstream.seen.length, 0, '普通读不应回源');

    // 写后刷新：必须绕过镜像、回源宿主。
    const fresh = await call(LAN_PORT, { path: '/api/mobile/v1/sessions?fresh=1', headers });
    assert.equal(fresh.status, 200, `fresh 读应 200，实际 ${fresh.status}`);
    assert.equal(JSON.parse(fresh.body).from, 'upstream', '?fresh=1 必须回源，不能被镜像顶掉');
    assert.equal(upstream.seen.length, 1, '应恰好回源一次');
    assert.match(upstream.seen[0].url, /fresh=1/, '回源时必须把 fresh 标记透传下去，宿主那层缓存才认得出');

    // 镜像里没有的路径照旧回源（不受影响）。
    const other = await call(LAN_PORT, { path: '/api/mobile/v1/workspaces?fresh=1', headers });
    assert.equal(JSON.parse(other.body).from, 'upstream');

    // 而且 fresh 请求根本不该去问镜像（问了就等于又给了它一次挡路的机会）。
    assert.equal(snapshotPaths.some(p => String(p).includes('fresh=1')), false, '?fresh=1 不应去问镜像');
  } finally {
    proxy.stop();
    upstream.server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 另外几处源码契约：中转隧道（公网那条路）与宿主 handler
// ---------------------------------------------------------------------------

test('中转隧道的镜像拦截也认 fresh 标记', () => {
  const tunnel = readSource('lib/relay/tunnel.js');
  assert.match(tunnel, /const \{ isFreshRequest \} = require\('\.\.\/shared\/fresh-request'\)/);
  assert.match(tunnel, /this\.readSnapshot && !isFreshRequest\(msg\.path\)/, '隧道侧必须跳过镜像');
});

test('lan-proxy 与宿主 handler 都接了 fresh 标记', () => {
  const lan = readSource('lib/relay/lan-proxy.js');
  assert.match(lan, /const \{ isFreshRequest \} = require\('\.\.\/shared\/fresh-request'\)/);
  assert.match(lan, /isFreshRequest\(req\.url\) \? null : readSnapshot\(/, '局域网侧必须跳过镜像');

  const sessions = readSource('lib/mobile/sessions.js');
  assert.match(sessions, /const \{ isFreshRequest \} = require\('\.\.\/shared\/fresh-request'\)/);
  assert.match(sessions, /const wantFresh = isFreshRequest\(req\.url\);/);
  // 2026-10-13 起 `?archived=1`（App 的「只看已归档」筛选）也绕开这层 10s 缓存——它取的是
  // 同一批会话的另一个子集，与默认视图共用缓存会串味，所以两个绕行判定收在一个
  // bypassCache 上；下面两条「fresh 读必须跳过」的语义不变。
  assert.match(sessions, /const bypassCache = wantFresh \|\| archivedOnly;/, 'fresh 读（与只看已归档）必须跳过 10s 缓存的判定入口');
  assert.match(sessions, /if \(!bypassCache && cache\.value && now - cache\.updatedAt < SESSION_LIST_CACHE_MS\)/, 'fresh 读必须跳过 10s 缓存');
  assert.match(sessions, /if \(!bypassCache && cache\.promise\)/, 'fresh 读必须跳过在途构建');
});

test('协议 v2 的读不许走镜像快照捷径（那条路不封信封、也不验信封）', () => {
  // 2026-10-24 现场：加密会话的列表 / 工作区 / 消息 / 统计全部由工人从快照直接回，
  // 绕开了主进程的守卫 —— 响应明文过中转，而且 App 收到明文只是安静降级。
  const worker = readSource('lib/sidecar-facade-worker.cjs');
  assert.match(worker, /info\.headers/, '工人侧必须能看到请求头');
  assert.match(worker, /x-dsh-proto/i, '按协议版本判');
  assert.match(worker, /=== '2'\) return null/, 'v2 必须回源主进程');
  const lan = readSource('lib/relay/lan-proxy.js');
  assert.match(lan, /readSnapshot\(\{ method: req\.method, path: req\.url, headers: req\.headers \}\)/, '局域网侧要把请求头带进判断');
  const tunnel = readSource('lib/relay/tunnel.js');
  assert.match(tunnel, /readSnapshot\(\{ method: msg\.method, path: msg\.path, headers: msg\.headers \}\)/, '中转侧同样');
});

// ZeroNews 线路：自动下载→浏览器登录→起客户端→建隧道→读域名，整条链用注入假体验证。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  platformId, downloadUrlOf, runDir, extractFromTar, ensureZeroNews,
} = require('../lib/zeronews/provision.cjs');
const {
  endpointUrl, pickEndpoint, createZeroNewsRunner,
} = require('../lib/zeronews/runner.cjs');

// ── provision：四平台地址 + 缓存 / 下载优先级 ──────────────────────────────

test('四平台有官方地址，错误平台如实标不支持', () => {
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    assert(platformId(p, a), `${p}-${a} 应支持`);
    assert(downloadUrlOf(p, a).startsWith('https://'), '地址是 https');
  }
  assert.equal(platformId('plan9', 'x64'), '');
  assert.equal(downloadUrlOf('plan9', 'x64'), '');
});

test('ensure 按 PATH → 缓存 → 下载的优先级，用户不动手装', async () => {
  const files = { '/cache/zeronews': Buffer.from('cached'), '/usr/bin/zeronews': Buffer.from('system') };
  const fsImpl = {
    statSync(p) { if (!(p in files)) throw new Error('no'); return { isFile: () => true }; },
    mkdirSync() {},
    writeFileSync(p, data) { files[p] = data; },
  };
  // PATH 命中
  const fromPath = await ensureZeroNews({ env: (k) => k === 'PATH' ? '/usr/bin' : '', fsImpl,
    platform: { platform: 'darwin', arch: 'arm64' }, root: '/cache' });
  assert.equal(fromPath.source, 'path');
  // 缓存命中
  const fromCache = await ensureZeroNews({ env: () => '', fsImpl,
    platform: { platform: 'darwin', arch: 'arm64' }, root: '/cache' });
  assert.equal(fromCache.source, 'cache');
  // 下载
  const fromNet = await ensureZeroNews({ env: () => '', fsImpl,
    platform: { platform: 'darwin', arch: 'arm64' }, root: '/fresh',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from('downloaded')).buffer }) });
  assert.equal(fromNet.source, 'downloaded');
  assert.equal(files['/fresh/zeronews'].toString(), 'downloaded');
});

test('Linux 的 tar 只挑出 zeronews 可执行文件', () => {
  const name = Buffer.alloc(100); name.write('zeronews/zeronews');
  const size = Buffer.alloc(12); size.write(String(Buffer.from('BIN').length).padStart(11, '0') + '\0');
  const header = Buffer.alloc(512);
  name.copy(header, 0); size.copy(header, 124); header[156] = 0x30;
  const body = Buffer.concat([Buffer.from('BIN'), Buffer.alloc(509)]);
  assert.equal(extractFromTar(Buffer.concat([header, body])).toString(), 'BIN');
});

// ── runner：整条链 ─────────────────────────────────────────────────────────

function harness({ endpoint = 'https://abc.hn.takin.cc', loggedAfter = 0 } = {}) {
  const calls = [];
  let checkCount = 0;
  // 登录状态来自 CLI `status --json`（不是本地 HTTP API —— 两者实测不一致）。
  const runImpl = async (bin, args) => {
    calls.push({ cli: args.join(' ') });
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: ++checkCount > loggedAfter }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const apiResponses = {
    '/api/v1/endpoints': () => ({ code: 200, data: { items: endpoint ? [{ type: 'HTTPS', domain: endpoint, status: 'active' }] : [] } }),
    '/api/v1/tunnels': () => ({ code: 200 }),
    '/healthz': () => ({ ok: true }),
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET' });
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    const fn = apiResponses[key];
    return fn ? { ok: true, json: async () => fn() } : { ok: false };
  };
  const spawnImpl = (bin, args) => { calls.push({ spawn: args[0] }); return { on() {}, unref() {}, kill() {} }; };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/cache/zeronews' }),
    portOf: () => 49906,
    fetchImpl, spawnImpl, runImpl,
    sleepImpl: () => Promise.resolve(),
  });
  return { runner, calls };
}

test('域名识别只认 active 的 HTTPS', () => {
  assert.equal(endpointUrl('https://a.example.com/'), 'https://a.example.com');
  assert.equal(endpointUrl('http://a.example.com'), '');
  assert.equal(pickEndpoint({ data: { items: [{ type: 'TCP', domain: 'x:1', status: 'active' }] } }), '');
  assert.equal(pickEndpoint({ data: { items: [{ type: 'HTTPS', domain: 'b.example.com', status: 'inactive' }] } }), '');
  assert.equal(pickEndpoint({ data: { items: [{ type: 'HTTPS', public_url: 'https://c.example.com', status: 'active' }] } }), 'https://c.example.com');
});

test('已登录：跳过浏览器登录，起客户端→复用已有隧道→拿到域名', async () => {
  const { runner, calls } = harness({ loggedAfter: 0 });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.url, 'https://abc.hn.takin.cc');
  assert(calls.some((c) => c.spawn === 'start'), '起了本地客户端');
  assert(!calls.some((c) => c.spawn === 'login'), '已登录不必再拉浏览器');
  assert(!calls.some((c) => c.cli && c.cli.includes('authtoken')), '全程不碰 authtoken');
});

test('未登录：拉起浏览器 login，确认后继续', async () => {
  // 第一次 cliStatus（快路判断）返回未登录，之后返回已登录 —— 模拟用户点完浏览器确认。
  let statusCalls = 0;
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') { statusCalls += 1; return { code: 0, stdout: JSON.stringify({ login: statusCalls > 1 }), stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const spawnCalls = [];
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'ok.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl, runImpl, spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {} }; }, sleepImpl: () => Promise.resolve() });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert(spawnCalls.includes('login'), '未登录时要拉起浏览器登录');
});

test('没有隧道时用 CLI add 建一条，解析 public_url', async () => {
  let added = false;
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    if (args[0] === 'add') { added = true; return { code: 0, stdout: JSON.stringify({ public_url: 'https://new.example.com' }), stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl, runImpl, spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(added, true, '用 CLI add 建了隧道');
  assert.equal(s.url, 'https://new.example.com', '从 add 的 public_url 拿到域名');
});

test('已有隧道不重复建（免费档只有一条额度）', async () => {
  let added = false;
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'exists.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    if (args[0] === 'add') { added = true; return { code: 0, stdout: '{}', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl, runImpl, spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(added, false, '已有隧道绝不重复建');
});

test('登录超时与下载失败都给出明确错误，不假装连上', async () => {
  const { runner } = harness({ loggedAfter: 999 });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert(s.error.includes('浏览器'), '登录超时说清去浏览器确认');

  const failed = createZeroNewsRunner({
    ensure: async () => ({ ok: false, code: 'unsupported-platform' }),
    fetchImpl: async () => ({ ok: false }), spawnImpl: () => ({ on() {} }), sleepImpl: () => Promise.resolve(),
  });
  const f = await failed.start();
  assert.equal(f.phase, 'error');
  assert(f.error.includes('不支持'), '不支持的平台说清');
});

test('stop 撤状态，可重复调用', async () => {
  const { runner } = harness();
  await runner.start();
  const s = runner.stop();
  assert.equal(s.phase, 'off');
  assert.equal(s.url, '');
  assert.equal(runner.stop().phase, 'off');
});

test('重载 / 自动更新后有客户端已在跑：复用，不再重复起第二个', async () => {
  const spawnCalls = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: true, running: true }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'reuse.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl, runImpl,
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.ok(!spawnCalls.includes('start'), '已有客户端在跑就不再 spawn 第二个（重复拉起会自己退出，表现成崩溃）');
  assert.equal(runner.status().running, true, '复用的客户端视为在跑');
});

test('连上后客户端意外退出：状态转 error 并回调交接线层自愈', async () => {
  let exitHandler = null;
  const exits = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'x.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    return { ok: false };
  };
  const spawnImpl = () => ({ on(ev, fn) { if (ev === 'exit') exitHandler = fn; }, unref() {}, kill() {} });
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl, runImpl, spawnImpl,
    sleepImpl: () => Promise.resolve(), onUnexpectedExit: (message) => exits.push(message),
  });
  await runner.start();
  assert.equal(runner.status().phase, 'connected');
  exitHandler(); // 模拟子进程退出
  assert.equal(runner.status().phase, 'error');
  assert.equal(runner.status().running, false);
  assert.equal(exits.length, 1, '意外退出要回调交接线层，安排自愈重连');
});

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

test('完整链路：登录→起客户端→复用已有隧道→拿到域名', async () => {
  const { runner, calls } = harness({ loggedAfter: 0 });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.url, 'https://abc.hn.takin.cc');
  assert(calls.some((c) => c.spawn === 'login'), '走了浏览器登录，没用 token/authtoken');
  assert(calls.some((c) => c.spawn === 'start'), '起了本地客户端');
  assert(!calls.some((c) => c.url && c.url.includes('authtoken')), '全程不碰 token');
  assert(!calls.some((c) => c.method === 'POST' && c.url.includes('tunnels')), '已有隧道就不重复建');
});

test('没有隧道时才建一条，指向本机端口', async () => {
  let made = false;
  const fetchImpl = async (url, init) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => made ? { data: { items: [{ type: 'HTTPS', domain: 'new.example.com', status: 'active' }] } } : { data: { items: [] } } };
    if (key === '/api/v1/tunnels') { made = true; return { ok: true, json: async () => ({ code: 200 }) }; }
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runImpl = async (bin, args) => (args[0] === 'status'
    ? { code: 0, stdout: JSON.stringify({ login: true }), stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl, runImpl, spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(made, true, '没有隧道时建了一条');
  assert.equal(s.url, 'https://new.example.com');
});

test('已有隧道不重复建（免费档只有一条额度）', async () => {
  let posted = false;
  const fetchImpl = async (url, init) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'exists.example.com', status: 'active' }] } }) };
    if (key === '/api/v1/tunnels') { posted = true; return { ok: true, json: async () => ({ code: 200 }) }; }
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runImpl = async (bin, args) => (args[0] === 'status' ? { code: 0, stdout: '{"login":true}', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl, runImpl, spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(posted, false, '已有隧道绝不重复建');
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

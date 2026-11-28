// 2026-11-27：复用本机客户端前比对身份，另一个身份占位就报错，不冒充已连接。
// 2026-11-26：体检要探隧道落点端口，没监听就判失效；只看 CLI 的 running 会把死线路当可用。
// 2026-11-25：新版 CLI 只报 connected 不报 running，体检仍要认出客户端活着。
// 2026-11-25：端口失配给错误打上 reason，接线层据此清掉状态里的旧地址。
// 2026-11-25：体检守卫——守护进程死了打回 error 并自愈；CLI 读不到时别抖线路。
// 2026-11-25：端口失配守卫：旧端口隧道不复用、字段缺失仍复用。
// ZeroNews 线路：自动下载→浏览器登录→起客户端→建隧道→读域名，整条链用注入假体验证。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  platformId, downloadUrlOf, runDir, extractFromTar, ensureZeroNews,
} = require('../lib/zeronews/provision.cjs');
const {
  endpointUrl, pickEndpoint, createZeroNewsRunner,
} = require('../lib/zeronews/runner.cjs');

/** 运行中客户端与当前配置共用的身份：status --json 的 client_id / cloud_server_addr（account.cjs 同名字段）。 */
const OWN_IDENTITY = { clientId: 'cid-own', node: 'zns1012.fzv2.zeronews.cc:7000' };
const runningStatus = (extra = {}) => JSON.stringify({
  login: true, running: true,
  client_id: OWN_IDENTITY.clientId, cloud_server_addr: OWN_IDENTITY.node,
  ...extra,
});

for (const boundary of ['ensure', 'status', 'authtoken', 'login-status', 'login-sleep', 'login-after',
  'health', 'health-sleep', 'endpoints', 'add', 'endpoint-poll', 'endpoint-sleep']) {
  test(`stop during ${boundary} prevents further CLI, spawn and tunnel work`, { timeout: 1000 }, async (t) => {
    let entered;
    let release;
    const reached = new Promise((resolve) => { entered = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const calls = [];
    let paused = false;
    let statuses = 0;
    let endpoints = 0;
    const loginPending = boundary.startsWith('login-');
    async function pause(key) {
      if (!paused && boundary === key) { paused = true; entered(); await pending; }
    }
    const runner = createZeroNewsRunner({
      portOf: () => 51887,
      ensure: async () => { calls.push('ensure'); await pause('ensure'); return { ok: true, path: '/synthetic/zeronews' }; },
      runImpl: async (_binary, args) => {
        calls.push(args[0]);
        let key = args[0];
        if (args[0] === 'status' && ++statuses > 1) {
          key = boundary === 'login-after' && statuses > 2 ? 'login-after' : 'login-status';
        }
        await pause(key);
        if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({
          login: !loginPending, login_pending: loginPending && statuses < 3,
          login_error: boundary === 'login-after' && statuses === 2 ? 'denied' : '',
        }) };
        return { code: 0, stdout: '' };
      },
      spawnImpl: () => { calls.push('spawn'); return { on() {}, unref() {}, kill() {} }; },
      fetchImpl: async (url) => {
        const key = url.endsWith('/healthz') ? 'health' : ++endpoints > 1 ? 'endpoint-poll' : 'endpoints';
        calls.push(key);
        await pause(key);
        return { ok: key !== 'health' || boundary !== 'health-sleep', json: async () => ({ data: [] }) };
      },
      sleepImpl: async () => {
        calls.push('sleep');
        await pause(loginPending ? 'login-sleep' : endpoints > 0 ? 'endpoint-sleep' : 'health-sleep');
      },
    });
    t.after(() => { runner.stop(); release(); });
    const starting = runner.start(boundary === 'authtoken' ? { token: 'synthetic-only' } : {});
    await reached;
    const before = [...calls];
    runner.stop();
    release();
    const result = await starting;
    assert.deepEqual(calls, before, '停止后不再发起后续操作');
    assert.equal(result.phase, 'off');
    assert.equal(result.running, false);
    assert.equal(result.url, '');
    assert.equal(result.tunnelLocalPort, 0);
    assert.equal(result.clientId, '');
    assert.equal(result.node, '');
  });
}

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

test('给了 AuthToken：先写客户端配置，不再拉浏览器', async () => {
  const { runner, calls } = harness({ loggedAfter: 0 });
  const s = await runner.start({ token: 'demo-auth-token-123' });
  assert.equal(s.phase, 'connected');
  assert(calls.some((c) => c.cli === 'authtoken demo-auth-token-123'), '按官方 CLI 的 authtoken 子命令写入');
  assert(!calls.some((c) => c.spawn === 'login'), '有 token 就不该再弹浏览器登录');
});

test('写过 token 之后，状态里记住「这台机器有身份」', async () => {
  const { runner } = harness({});
  assert.equal(runner.status().configured, false, '一开始没有身份');
  await runner.start({ token: 'demo-auth-token-123' });
  assert.equal(runner.status().configured, true, '写成功之后要记住，面板才不用再要一次');
});

test('AuthToken 写失败：如实报错，不起隧道的后续步骤', async () => {
  const calls = [];
  const fetchImpl = async () => ({ ok: false });
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }),
    portOf: () => 49906,
    fetchImpl,
    spawnImpl: (b, args) => { calls.push(args[0]); return { on() {}, unref() {} }; },
    runImpl: async (bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: false }), stderr: '' };
      if (args[0] === 'authtoken') return { code: 1, stdout: '', stderr: 'invalid token' };
      return { code: 0, stdout: '', stderr: '' };
    },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start({ token: 'bad' });
  assert.equal(s.phase, 'error');
  assert.match(s.error, /无效|失效|token/, '无效 token 要讲清去重新复制');
  assert(!calls.includes('login'), '写 token 失败不该退回浏览器登录');
});

test('未登录且无 token：不静默拉起 login，返回待登录让面板打开确认页', async () => {
  const spawnCalls = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: false }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }), runImpl,
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'login', '停在待登录，而不是当失败或假装连上');
  assert.match(s.error, /开始接入|登录/, '要说清去点「开始接入」完成浏览器确认');
  assert.ok(!spawnCalls.includes('login'), '不能在后台静默拉起 login —— 用户看不到确认页只会干等到超时');
});

test('正在等浏览器确认（login_pending）：不重开登录，轮询到 login:true 后继续连上', async () => {
  let n = 0;
  const spawnCalls = [];
  const runImpl = async (bin, args) => {
    if (args[0] !== 'status') return { code: 0, stdout: '', stderr: '' };
    n += 1;
    // 头部几次仍是 pending，之后完成登录。退出码 3 是官方的「等待中」，不是失败。
    return n < 3
      ? { code: 3, stdout: JSON.stringify({ login: false, login_pending: true }), stderr: '' }
      : { code: 0, stdout: JSON.stringify({ login: true, login_pending: false }), stderr: '' };
  };
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'ok.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl, runImpl,
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.ok(!spawnCalls.includes('login'), 'pending 时不该重新拉起 login（会顶掉设备码）');
});

test('登录被拒（quota_exceeded / denied）：立刻按原因报错，不空等', async () => {
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }),
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 1, stdout: JSON.stringify({ login: false, login_error: 'quota_exceeded' }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: () => ({ on() {}, unref() {} }),
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /一台设备|名额|控制台/, '配额满要说清去控制台停用另一台或升级');
  assert.equal(s.retryable, false, '配额满属于确定性错误，不该再无限重试');
});

test('AuthToken 因本机已有配置被忽略：如实报错，不假装写成功', async () => {
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }),
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: false }), stderr: '' };
      if (args[0] === 'authtoken') return { code: 0, stdout: 'Local config file already exists, token update ignored', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: () => ({ on() {}, unref() {} }),
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start({ token: 'x' });
  assert.equal(s.phase, 'error');
  assert.match(s.error, /已有|重置/, '要说明旧配置还在、这个 token 没写进去');
});

test('AuthToken 认证撞上免费套餐客户端数量上限：翻成可选流程，不甩英文原文', async () => {
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }),
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: false }), stderr: '' };
      if (args[0] === 'authtoken') return { code: 1, stdout: '', stderr: 'auth client failed: client count limit reached for this plan' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: () => ({ on() {}, unref() {} }),
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start({ token: 'x' });
  assert.equal(s.phase, 'error');
  assert.match(s.error, /名额|控制台|恢复客户端/, '要说清怎么释放名额 / 换机');
  assert.doesNotMatch(s.error, /client count limit/, '不要把英文原文直接抛给用户');
  assert.equal(s.retryable, false);
});

test('客户端被禁用：直接说去控制台启用，不继续 start', async () => {
  const spawnCalls = [];
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }),
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: true, client_enabled: false }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /禁用|启用/);
  assert.ok(!spawnCalls.includes('start'), '被禁用就别再起客户端');
  assert.equal(s.retryable, false);
});

test('status 只有 stderr 的数量上限报错：也认出来，不当作没登录去开浏览器', async () => {
  const spawnCalls = [];
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }),
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 1, stdout: '', stderr: 'auth client failed: client count limit reached for this plan' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /名额|控制台/, '数量上限要直接说清，不能退回待登录');
  assert(!spawnCalls.includes('login'), '不该再去开浏览器登录');
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

/** 隧道复用假体：endpoints 里那条 active 的 HTTPS 隧道可带 local_port / tunnel_id，setLocal 注入改端口结果。 */
function tunnelHarness({ localPort, port = 28787, tunnelId, setLocal } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    if (key !== '/api/v1/endpoints') return { ok: false };
    const item = { type: 'HTTPS', domain: 'old.example.com', status: 'active' };
    if (localPort !== undefined) item.local_port = localPort;
    if (tunnelId !== undefined) item.tunnel_id = tunnelId;
    return { ok: true, json: async () => ({ data: { items: [item] } }) };
  };
  const runImpl = async (_bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    if (args[0] === 'add') return { code: 0, stdout: JSON.stringify({ public_url: 'https://new.example.com' }), stderr: '' };
    if (args[0] === 'tunnel' && typeof setLocal === 'function') return setLocal(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => port,
    fetchImpl, runImpl, spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve(),
  });
  return { runner, calls };
}

test('旧隧道指向旧端口：标 error、不可重试，且不猜命令去删/建云端隧道', async () => {
  const { runner, calls } = tunnelHarness({ localPort: 18787 });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /旧隧道指向旧端口.*删除后重试/);
  assert.equal(s.errorReason, 'port-mismatch', '给出可识别的 reason，接线层据此清掉旧地址');
  assert.equal(s.retryable, false, '换端口后旧隧道不会自己变，自动重试只会反复超时');
  assert.ok(!calls.some((c) => c.startsWith('add ')), '失配时不自动建新隧道（免费档只有一条额度）');
});

test('旧隧道指向旧端口：用官方 set-local 原地改到当前端口，不删不建', async () => {
  const { runner, calls } = tunnelHarness({
    localPort: 18787, tunnelId: 'tid-1',
    setLocal: async (args) => {
      assert.deepEqual(args, ['tunnel', 'tid-1', 'set-local', '127.0.0.1', '28787', '--json'], '命令按官方推荐形状：隧道 ID 在前');
      return { code: 0, stdout: '{"ok":true,"tunnel_id":"tid-1","local_ip":"127.0.0.1","local_port":28787}', stderr: '' };
    },
  });
  const s = await runner.start();
  assert.equal(s.phase, 'connected', '改好端口就直接复用这条隧道，不再报错');
  assert.equal(s.url, 'https://old.example.com', '域名不变，还是原来那条隧道');
  assert.ok(calls.includes('tunnel tid-1 set-local 127.0.0.1 28787 --json'), '要真的去改端口');
  assert.ok(!calls.some((c) => c.startsWith('add ')), '改端口不是新建隧道（免费档只有一条额度）');
});

test('老客户端没有 set-local：只打帮助、退出码仍是 0，也不能当成功', async () => {
  const { runner } = tunnelHarness({
    localPort: 18787, tunnelId: 'tid-1',
    // 4.1.0 实测就是这个形状：不认识的子命令打帮助，退出码 0。
    setLocal: async () => ({ code: 0, stdout: 'Manage account tunnels on the control plane\n\nUsage:\n  zeronews tunnel [flags]', stderr: '' }),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error', '帮助文本不是成功回执');
  assert.equal(s.errorReason, 'port-mismatch');
  assert.match(s.error, /不支持自动改端口/);
  assert.match(s.error, /4\.1\.1/, '告诉用户升级客户端，或去控制台改');
});

test('账号侧拒绝改端口：把原文透出来，别假装改好了', async () => {
  const { runner } = tunnelHarness({
    localPort: 18787, tunnelId: 'tid-1',
    setLocal: async () => ({ code: 1, stdout: '', stderr: 'set local port failed: forbidden' }),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.equal(s.errorReason, 'port-mismatch');
  assert.match(s.error, /自动改到当前端口失败.*forbidden/);
});

test('endpoints 没有 local_port 仍复用（老数据不误报失配）', async () => {
  const { runner, calls } = tunnelHarness({});
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.url, 'https://old.example.com');
  assert.ok(!calls.some((c) => c.startsWith('add ')), '字段缺失按老数据复用');
});

test('local_port 与当前端口一致仍复用', async () => {
  const { runner, calls } = tunnelHarness({ localPort: 28787 });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.url, 'https://old.example.com');
  assert.ok(!calls.some((c) => c.startsWith('add ')));
});

test('账号侧那套嵌套后端端口形状也能判失配', () => {
  // 直接验端口读取：嵌套形状同样来自 ZeroNews，不能只在平铺字段上做比对。
  const payload = { data: { items: [{ type: 'HTTPS', domain: 'old.example.com', status: 'active',
    route_rules: [{ forward_rules: [{ load_balance_policy: { backend_endpoints: [{ local_port: 18787 }] } }] }] }] } };
  const runner = createZeroNewsRunner({ ensure: async () => ({ ok: true, path: '/x' }) });
  assert.equal(runner.pickEndpoint(payload), 'https://old.example.com', '没传当前端口时照旧返回');
  assert.equal(runner.pickEndpoint(payload, 28787), '', '显式传当前端口时旧端口隧道不算可用');
});

test('变异证明：拿掉 local_port 比对，旧端口隧道就会继续被静默复用', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /found\.localPort > 0 && found\.localPort !== current/, '失配判据要在复用分支里');
  assert.match(source, /旧隧道指向旧端口.*请删除后重试/, '报错要说清是旧端口、要手动删');
});

test('变异证明：端口失配必须带 reason，接线层才清得掉旧地址', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /terminalError\(`旧隧道指向旧端口[^`]*`, 'port-mismatch'\)/, '失配错误要打上 port-mismatch');
  assert.match(source, /error\.reason = reason \|\| ''/, '错误要带上 reason');
  assert.match(source, /errorReason,/, 'status 要把 reason 交给接线层');
});

test('一直没登录也不假装连上，下载失败也给出明确错误', async () => {
  const { runner } = harness({ loggedAfter: 999 });
  const s = await runner.start();
  assert.equal(s.phase, 'login', '没登录停在待登录，不谎报 connected / error');
  assert.match(s.error, /开始接入|登录/, '要说清去点「开始接入」完成登录');

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

test('重载 / 自动更新后有客户端已在跑：身份一致就复用，不再重复起第二个', async () => {
  const spawnCalls = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: runningStatus(), stderr: '' };
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
    identityOf: () => OWN_IDENTITY,
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.ok(!spawnCalls.includes('start'), '已有客户端在跑就不再 spawn 第二个（重复拉起会自己退出，表现成崩溃）');
  assert.equal(runner.status().running, true, '复用的客户端视为在跑');
});

test('另一个身份的客户端占了本机端口：不 attach、明确报错、不冒充已连接', async () => {
  const spawnCalls = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: runningStatus({ client_id: 'cid-other', cloud_server_addr: 'zns-other.example:7000' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetchCalls = [];
  const fetchImpl = async (url) => { fetchCalls.push(url); return { ok: false }; };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl, runImpl,
    identityOf: () => OWN_IDENTITY,
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error', '不是 connected：别人的客户端不能算自己的');
  assert.equal(s.running, false, 'running 不能为真，面板不能显示已连接');
  assert.match(s.error, /另一个身份.*让开端口|让开端口.*另一个身份/, '要说清是另一个身份占位、让用户让开端口');
  assert.doesNotMatch(s.error, /DNS|dns|lookup|网络故障/, '不能把身份冲突说成 DNS / 网络故障');
  assert.equal(s.errorReason, 'identity-mismatch', '给出可识别原因');
  assert.equal(s.retryable, false, '身份不会自己变，别无限自动重试');
  assert.ok(!spawnCalls.includes('start'), '不另起一个客户端去抢端口');
  assert.ok(!fetchCalls.some((u) => u.includes('/api/v1/endpoints')), '不读别人的隧道、不建隧道');
});

test('运行中客户端身份读不出来：明确报错，不静默 attach', async () => {
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: true, running: true }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906,
    fetchImpl: async () => ({ ok: false }), runImpl,
    identityOf: () => OWN_IDENTITY,
    spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve(),
  });
  const s = await runner.start();
  assert.equal(s.phase, 'error');
  assert.equal(s.running, false);
  assert.equal(s.errorReason, 'identity-mismatch', '读不到身份按无法确认处理，不当成自己人');
});

test('变异证明：attach 前必须比身份，错配报 identity-mismatch 且不 attach', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /if \(externalRunning && !sameIdentity\(/, '复用分支前要有身份校验');
  assert.match(source, /identity-mismatch/, '错配要打可识别 reason');
  assert.match(source, /clientId: typeof obj\.client_id/, 'CLI status 的身份字段要解析进来');
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

test('连上后守护进程死了：体检把 connected 打回 error 并回调自愈', async () => {
  let daemonAlive = true;
  const exits = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: true, running: daemonAlive, client_id: OWN_IDENTITY.clientId, cloud_server_addr: OWN_IDENTITY.node }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'x.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl, runImpl,
    identityOf: () => OWN_IDENTITY,
    spawnImpl: () => ({ on() {}, unref() {}, kill() {} }), sleepImpl: () => Promise.resolve(),
    onUnexpectedExit: (message) => exits.push(message),
  });
  const connected = await runner.start();
  assert.equal(connected.phase, 'connected');
  assert.equal(connected.running, true, '连上后报的是守护进程在跑，不是那个早退出的启动进程');
  daemonAlive = false;
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'error', '客户端没了就不能继续报已连接');
  assert.equal(runner.status().url, '');
  assert.equal(runner.status().running, false);
  assert.equal(exits.length, 1, '要交接线层安排自愈重连，别让线路卡在旧状态');
});

test('体检读不到 CLI 状态时不抖掉一条还能用的线路', async () => {
  let failCli = false;
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'x.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl,
    runImpl: async (bin, args) => {
      if (args[0] === 'status' && failCli) throw new Error('status 暂时读不到');
      if (args[0] === 'status') return { code: 0, stdout: runningStatus(), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: () => ({ on() {}, unref() {}, kill() {} }), sleepImpl: () => Promise.resolve(),
    identityOf: () => OWN_IDENTITY,
    onUnexpectedExit: () => { throw new Error('不该安排重连'); },
  });
  await runner.start();
  failCli = true;
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'connected', '读不到状态不等于客户端死了，别抖线路');
});

test('新版 CLI 只报 connected 不报 running：体检不误判掉线、不重复拉起客户端', async () => {
  const exits = [];
  const spawnCalls = [];
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'x.example.com', status: 'active' }] } }) };
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    return { ok: false };
  };
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => 49906, fetchImpl,
    // 厂商 4.1.0 的 status --json 报的是 connected:true，没有 running 字段。
    runImpl: async (bin, args) => {
      if (args[0] === 'status') return { code: 0, stdout: runningStatus({ running: undefined, connected: true }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
    identityOf: () => OWN_IDENTITY,
    onUnexpectedExit: (message) => exits.push(message),
  });
  const connected = await runner.start();
  assert.equal(connected.phase, 'connected');
  assert.ok(!spawnCalls.includes('start'), 'CLI 报 connected 就该认出本机已有客户端，不再重复拉起');
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'connected', 'connected 就是活着，别十几秒抖成掉线');
  assert.equal(exits.length, 0, '不该安排自愈重连');
});

test('已有隧道时把它的端口报出来，接线层据此原地复用', async () => {
  const { runner } = tunnelHarness({ localPort: 28787 });
  const before = runner.status();
  assert.equal(before.tunnelLocalPort, 0, '还没查过 endpoints 时是 0');
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.tunnelLocalPort, 28787, '连上之后要记住这条隧道用的端口');
});

test('变异证明：不记录隧道端口，接线层就会把在用的隧道改到新端口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /tunnelLocalPort = Number\.isInteger\(found\.localPort\)/, '复用分支要记下隧道端口');
  assert.match(source, /tunnelLocalPort,\s*\n\s*\}/, 'status 要把这个端口交给接线层');
});

/** 体检探活用的假体：endpoints 带 local_port，CLI 报在跑，落点可注入有没有人监听。 */
function aliveHarness({ localPort = 18787, port = 52831, listen = true } = {}) {
  const exits = [];
  const probed = [];
  const cmds = [];
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/healthz') return { ok: true, json: async () => ({}) };
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [{ type: 'HTTPS', domain: 'old.example.com', status: 'active', local_port: localPort }] } }) };
    return { ok: false };
  };
  const runImpl = async (_bin, args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'status') return { code: 0, stdout: runningStatus(), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  // 复刻 wiring.tunnelPort() 的稳态：已有隧道时 portOf() 返回隧道自己的落点端口，
  // 所以 ensureTunnel 的 current 与 endpoints 的 localPort 恒等，失配分支永远不触发。
  const runner = createZeroNewsRunner({
    ensure: async () => ({ ok: true, path: '/x' }), portOf: () => (localPort > 0 ? localPort : port), fetchImpl, runImpl,
    identityOf: () => OWN_IDENTITY,
    spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve(),
    onUnexpectedExit: (message) => exits.push(message),
    probePort: async (p) => { probed.push(p); return listen; },
  });
  return { runner, exits, probed, cmds };
}

test('体检：CLI 说在跑、旧隧道还在，但落点端口没人监听就判失效、不删不建', async () => {
  const { runner, exits, probed, cmds } = aliveHarness({ listen: false });
  const s = await runner.start();
  assert.equal(s.phase, 'connected');
  assert.equal(s.tunnelLocalPort, 18787, '隧道仍落在旧端口，没改端口也没重建');
  await runner.checkAlive();
  const after = runner.status();
  assert.equal(after.phase, 'error', '落点没人听就不能继续报已连接');
  assert.equal(after.errorReason, 'port-dead', '给出可识别的 reason，接线层据此清旧地址');
  assert.match(after.error, /18787.*没有服务监听/, '提示里带上失效端口，别只说「连不上」');
  assert.match(after.error, /删除旧隧道/, '给出下一步：去控制台删旧隧道');
  assert.equal(after.retryable, false, '重试不会让旧端口长出服务，别无限重连');
  assert.deepEqual(probed, [18787], '探的是隧道自己的落点，不是当前首选端口');
  assert.equal(exits.length, 0, '不交接线层自愈重连，免得反复起客户端');
  assert.ok(!cmds.some((c) => c.startsWith('add ')), '失效不新建云端隧道（删/建都不做）');
});

test('体检：落点端口还有人监听时维持已连接，不误判失效', async () => {
  const { runner, exits, probed } = aliveHarness({ listen: true });
  assert.equal((await runner.start()).phase, 'connected');
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'connected');
  assert.equal(runner.status().errorReason, '');
  assert.deepEqual(probed, [18787], '在跑就探一次落点');
  assert.equal(exits.length, 0);
});

test('体检：没有落点端口字段（老数据）时不探、不误判', async () => {
  const { runner, probed } = aliveHarness({ localPort: 0, listen: false });
  assert.equal((await runner.start()).phase, 'connected');
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'connected');
  assert.deepEqual(probed, [], '没有端口就不探，按老数据复用');
});

test('变异证明：体检探的是落点端口，失效打 port-dead 且不自愈重建', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /await probePort\(port\)/, '体检必须探隧道端口，不能只看 CLI 的 running');
  assert.match(source, /errorReason = 'port-dead'/, '失效要打可识别的 reason');
  assert.match(source, /retryable = false/, '失效不安排自动重建');
});

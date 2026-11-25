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

/** 隧道复用假体：endpoints 里那条 active 的 HTTPS 隧道可带 local_port。 */
function tunnelHarness({ localPort, port = 28787 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    if (key !== '/api/v1/endpoints') return { ok: false };
    const item = { type: 'HTTPS', domain: 'old.example.com', status: 'active' };
    if (localPort !== undefined) item.local_port = localPort;
    return { ok: true, json: async () => ({ data: { items: [item] } }) };
  };
  const runImpl = async (_bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    if (args[0] === 'add') return { code: 0, stdout: JSON.stringify({ public_url: 'https://new.example.com' }), stderr: '' };
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

test('连上后守护进程死了：体检把 connected 打回 error 并回调自愈', async () => {
  let daemonAlive = true;
  const exits = [];
  const runImpl = async (bin, args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ login: true, running: daemonAlive }), stderr: '' };
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
      if (args[0] === 'status') return { code: 0, stdout: '{"login":true,"running":true}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: () => ({ on() {}, unref() {}, kill() {} }), sleepImpl: () => Promise.resolve(),
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
      if (args[0] === 'status') return { code: 0, stdout: '{"login":true,"connected":true}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnImpl: (b, args) => { spawnCalls.push(args[0]); return { on() {}, unref() {}, kill() {} }; },
    sleepImpl: () => Promise.resolve(),
    onUnexpectedExit: (message) => exits.push(message),
  });
  const connected = await runner.start();
  assert.equal(connected.phase, 'connected');
  assert.ok(!spawnCalls.includes('start'), 'CLI 报 connected 就该认出本机已有客户端，不再重复拉起');
  await runner.checkAlive();
  assert.equal(runner.status().phase, 'connected', 'connected 就是活着，别十几秒抖成掉线');
  assert.equal(exits.length, 0, '不该安排自愈重连');
});

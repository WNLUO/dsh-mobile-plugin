// 控制器绑定、租期与模式持久化使用异步真实接口。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once, EventEmitter } = require('node:events');
const { createRemoteController } = require('../lib/remote/controller.cjs');
const { LEASE_MS } = require('../lib/remote/local.cjs');

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async list() { return [...rows.values()]; },
    async get(id) { return rows.get(id); },
    async put(binding) { rows.set(binding.id, structuredClone(binding)); return binding; },
    async delete(id) { rows.delete(id); },
    async update(id, fn) { const next = { ...rows.get(id), ...await fn(rows.get(id)) }; rows.set(id, next); return next; },
  };
}

async function fixture(t, options = {}) {
  const sockets = new Set();
  const state = { probes: 0, dials: 0, renewals: [], writes: 0, closes: [], failure: null, connectionInfo: null, dialRoutes: [] };
  const target = http.createServer((req, res) => {
    if (req.url === '/?token=launch-secret') { res.writeHead(303, { 'set-cookie': 'a_browser=version1; Path=/', location: './' }); res.end(); return; }
    if (req.headers.cookie !== 'a_browser=version1') { res.writeHead(401); res.end(); return; }
    if (req.method === 'POST') state.writes += 1;
    req.resume(); req.once('end', () => res.end('remote-page'));
  });
  target.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const store = memoryStore();
  const binding = { id: 'A', instanceId: 'A', name: '电脑A', deviceId: 'B', credential: 'credential-secret', deviceKey: 'key-secret', keyId: 'public-key-id',
    routes: [{ url: 'http://127.0.0.1:5000', channel: 'lan' }, { url: 'https://relay.invalid/path', channel: 'relay' }], createdAt: 1 };
  const transport = {
    parseInvitation: (value) => JSON.parse(value),
    async pairComputer() { return structuredClone(binding); },
    async probeRemote(_binding, _route, options) { state.probes += 1; if (state.failure) throw state.failure; if (state.connectionInfo) await options.onConnectionInfo(state.connectionInfo); return 5; },
    async openRemoteStream(_binding, route) {
      state.dials += 1; state.dialRoutes.push(route);
      if (state.failure) throw state.failure;
      const stream = net.connect({ host: '127.0.0.1', port: target.address().port });
      await once(stream, 'connect');
      stream.renew = async (expiresAt) => { state.renewals.push(expiresAt); return expiresAt; };
      return { stream, host: { port: target.address().port, token: 'launch-secret' } };
    },
  };
  const controller = createRemoteController({ store, transport, name: '本机', tunnels: { routesFor: async () => [], close: async (id) => state.closes.push(id) }, onBindingsChanged: options.onBindingsChanged });
  t.after(async () => { await controller.close(); for (const socket of sockets) socket.destroy(); target.close(); });
  await controller.add('invite');
  return { controller, store, state, binding };
}

async function browser(controller) {
  const opened = await controller.open('A');
  const response = await new Promise((resolve, reject) => {
    http.get(opened.url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' } }, (res) => {
      res.resume(); resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] });
    }).on('error', reject);
  });
  assert.equal(response.status, 303);
  return { ...opened, base: new URL(opened.url).origin, cookie: response.cookie.split(';')[0] };
}

test('安全列表只返回允许字段和无秘密线路，模式合并不覆盖隧道密钥', async (t) => {
  const f = await fixture(t);
  f.store.rows.get('A').tunnelKeys = { secret: 'concurrent-key' };
  const mode = await f.controller.setMode('A', 'relay');
  assert.equal(mode.mode, 'relay');
  assert.equal(f.store.rows.get('A').tunnelKeys.secret, 'concurrent-key');
  await assert.rejects(() => f.controller.setMode('A', 'unknown'));
  const list = await f.controller.list();
  const encoded = JSON.stringify(list);
  assert.equal(encoded.includes('credential-secret'), false);
  assert.equal(encoded.includes('key-secret'), false);
  assert.equal(encoded.includes('concurrent-key'), false);
  assert.equal(list[0].expiresAt, null);
  assert.equal(list[0].state, 'idle');
  assert.equal(list[0].attached, false);
});

test('到期不能renew，重新open得到新租期和可用浏览器并保留模式', { concurrency: false }, async (t) => {
  const f = await fixture(t);
  await f.controller.setMode('A', 'relay');
  const first = await browser(f.controller);
  assert.equal((await fetch(first.base, { headers: { cookie: first.cookie } })).status, 200);
  const realNow = Date.now;
  try {
    Date.now = () => first.expiresAt + 1;
    assert.equal((await f.controller.list())[0].state, 'expired');
    await assert.rejects(() => f.controller.renew('A'), { code: 'REMOTE_EXPIRED' });
    const second = await browser(f.controller);
    assert.notEqual(second.base, first.base);
    assert.ok(second.expiresAt > first.expiresAt);
    const response = await fetch(second.base, { headers: { cookie: second.cookie } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'remote-page');
    assert.equal((await f.controller.list())[0].mode, 'relay');
  } finally { Date.now = realNow; }
});

test('续期只允许有效本地访问，停止后旧入口失效且长期绑定保留', async (t) => {
  const f = await fixture(t);
  const page = await browser(f.controller);
  const before = await fetch(page.base, { headers: { cookie: page.cookie } });
  assert.equal(before.status, 200);
  const renewed = await f.controller.renew('A');
  assert.ok(renewed.expiresAt >= page.expiresAt);
  assert.ok(renewed.expiresAt <= Date.now() + LEASE_MS);
  await f.controller.stop('A');
  const row = (await f.controller.list())[0];
  assert.equal(row.state, 'idle'); assert.equal(row.expiresAt, null);
  assert.ok(f.store.rows.has('A'));
  await assert.rejects(() => f.controller.renew('A'), { code: 'REMOTE_EXPIRED' });
  await f.controller.remove('A');
  assert.deepEqual(await f.controller.list(), []);
});

test('桌面进程退出即视为窗口关闭，列表回到未打开', async (t) => {
  const f = await fixture(t);
  await browser(f.controller);
  const opened = (await f.controller.list())[0];
  assert.equal(opened.attached, true);
  const child = new EventEmitter();
  child.exitCode = null;
  f.controller.watchWindow('A', child);
  child.emit('exit', 0, null);
  const closed = (await f.controller.list())[0];
  assert.equal(closed.attached, false);
  assert.equal(closed.state, 'idle');
});

test('认证后的基础线路更新持久保存且不覆盖模式或隧道密钥', async (t) => {
  const f = await fixture(t);
  f.store.rows.get('A').tunnelKeys = { secret: 'persisted-helper-key' };
  f.state.connectionInfo = { routes: [{ url: 'http://192.168.9.2:5000', channel: 'lan' }, { url: 'https://relay.invalid/path', channel: 'relay' }] };
  await f.controller.probe('A');
  assert.deepEqual(f.store.rows.get('A').routes, f.state.connectionInfo.routes);
  assert.equal(f.store.rows.get('A').tunnelKeys.secret, 'persisted-helper-key');
  await f.controller.setMode('A', 'lan');
  const page = await browser(f.controller);
  const response = await fetch(page.base, { headers: { cookie: page.cookie } });
  assert.equal(response.status, 200);
  assert.equal(f.state.dialRoutes[0].url, 'http://192.168.9.2:5000');
  assert.equal((await f.controller.list())[0].mode, 'lan');
});

test('认证过的吊销错误主动关闭本地访问，列表不暴露原始错误', async (t) => {
  const f = await fixture(t);
  const page = await browser(f.controller);
  await fetch(page.base, { headers: { cookie: page.cookie } });
  f.state.failure = Object.assign(new Error('credential-secret at https://user:secret@example/?token=secret'), { code: 'REMOTE_REVOKED' });
  const row = await f.controller.probe('A');
  assert.equal(row.state, 'revoked');
  assert.equal(JSON.stringify(row).includes('credential-secret'), false);
  const denied = await fetch(page.base, { headers: { cookie: page.cookie } }).catch(() => null);
  assert.ok(!denied || denied.status >= 400);
});

test('逐线路诊断直接返回每条候选的探测结果，不改设备状态', async (t) => {
  const f = await fixture(t);
  const rows = await f.controller.diagnose('A');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.ok === true && row.latencyMs === 5 && row.errorCode === null));
  assert.deepEqual(rows.map((row) => row.channel), ['lan', 'relay']);
  assert.equal((await f.controller.list())[0].state, 'idle', '诊断不改变设备状态');
});

test('绑定增删后触发 onBindingsChanged，让局域网监听随远程电脑开关联动', async (t) => {
  let calls = 0;
  const f = await fixture(t, { onBindingsChanged: () => { calls += 1; } });
  assert.equal(calls, 1, 'fixture 的首次 add 已触发一次');
  await f.controller.add('invite');
  assert.equal(calls, 2, '再次 add 也要联动');
  await f.controller.remove('A');
  assert.equal(calls, 3, 'remove 也要联动');
});

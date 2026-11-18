'use strict';
// 管理动作只接受精确同源的本机请求，来访电脑清单与撤销响应不得包含密钥。
// 桌面壳入口带专属标记，普通浏览器入口保持原样。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRemoteRoutes } = require('../lib/remote/routes.cjs');
async function invoke(routes, suffix, patch = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method: suffix ? 'POST' : 'GET', url: '/api/relay/remote-computers' + suffix,
    socket: { remoteAddress: '127.0.0.1' }, headers: {
      host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234',
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    } }, patch);
  req.setEncoding = () => {};
  const res = { status: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(raw) { this.body = JSON.parse(raw); } };
  const work = routes.handler(suffix)(req, res);
  queueMicrotask(() => { req.emit('data', JSON.stringify(patch.body || {})); req.emit('end'); });
  await work;
  return res;
}
function setup() {
  const calls = [];
  const launches = [];
  const records = [{ deviceId: 'B', name: '出门电脑', createdAt: 1, remoteWeb: true, hash: 'hidden', deviceKey: 'private' },
    { deviceId: 'phone', name: '手机', createdAt: 1 }];
  // 挡位校验的真实判据在 router.setMode：这里照它实现（只有对方报来的通道可选），
  // 这样 `/mode` 的用例钉的是那条存在性校验，而不是假体缺方法抛错兜成 400。
  const selectable = ['auto', 'lan', 'ipv6', 'relay', 'tunnel', 'p2p'];
  const controller = { list: async () => [], open: async id => { calls.push(id); return { url: 'http://127.0.0.1:4321/', expiresAt: 5000 }; },
    diagnose: async id => { calls.push('diagnose:' + id); return [{ channel: 'lan', url: 'http://192.168.1.2:18787', ok: true, latencyMs: 5, errorCode: null }]; },
    setMode: async (id, mode) => { calls.push('mode:' + id + ':' + mode); if (!selectable.includes(mode)) throw Object.assign(new Error('这条线路当前不可用'), { code: 'bad-mode' }); },
    watchWindow: () => {} };
  const host = { mintInvite: async () => ({ invite: 'invite', expiresAt: 1000 }), revoke: id => calls.push('closed:' + id) };
  const credentials = { listRemoteComputers: () => records.filter(row => row.remoteWeb).map(row => ({ deviceId: row.deviceId, name: row.name, platform: '', lastSeenAt: 0, createdAt: row.createdAt })), revokeDevice: (instance, id) => { calls.push(instance + ':' + id); return 1; } };
  return { routes: createRemoteRoutes({ controller, host, credentials, instanceId: 'A', now: () => 100, launch: args => launches.push(args) }), calls, launches };
}
test('同源本机可查看来访电脑，结果不包含手机或凭据，能按设备撤销', async () => {
  const { routes, calls } = setup();
  const response = await invoke(routes, '');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.authorizedComputers, [{ deviceId: 'B', name: '出门电脑', platform: '', lastSeenAt: 0, createdAt: 1 }]);
  const revoked = await invoke(routes, '/revoke', { body: { deviceId: 'B' } });
  assert.equal(revoked.body.revoked, 1);
  assert.deepEqual(calls, ['A:B', 'closed:B']);
});
test('其他localhost端口的远端页面、域名重绑定、转发标记和外部来源一律拒绝', async () => {
  const { routes, calls } = setup();
  for (const patch of [
    { headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:5678', 'content-type': 'application/json' } },
    { headers: { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json' } },
    { headers: { host: '127.0.0.1:1234', 'x-dsh-via': 'tunnel', 'content-type': 'application/json' } },
    { socket: { remoteAddress: '192.168.1.3' } },
  ]) assert.equal((await invoke(routes, '/open', { ...patch, body: { id: 'A' } })).status, 403);
  assert.deepEqual(calls, []);
});
test('桌面壳入口带专属标记，普通浏览器入口不变，回包仍是不带标记的原地址', async () => {
  const { routes, launches } = setup();
  const shell = await invoke(routes, '/open-shell', { body: { id: 'A' } });
  assert.equal(shell.status, 200);
  assert.equal(shell.body.url, 'http://127.0.0.1:4321/');
  assert.equal(shell.body.shellOpened, true);
  assert.equal(launches.length, 1);
  const opened = new URL(launches[0].url);
  assert.equal(opened.origin, 'http://127.0.0.1:4321');
  assert.equal(opened.searchParams.get('shell'), '1');
  const browser = await invoke(routes, '/open', { body: { id: 'A' } });
  assert.equal(browser.status, 200);
  assert.equal(browser.body.url, 'http://127.0.0.1:4321/');
  assert.equal(launches.length, 1);
});

test('桌面壳进程起手就退出时回 shellOpened:false，让前端退回浏览器', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  setTimeout(() => { child.exitCode = 1; child.emit('exit', 1); }, 5);
  const controller = { list: async () => [], open: async () => ({ url: 'http://127.0.0.1:4321/', expiresAt: 5000 }), diagnose: async () => [], watchWindow: () => { throw new Error('不该记窗口'); } };
  const host = { mintInvite: async () => ({}), revoke: () => {} };
  const credentials = { listRemoteComputers: () => [], revokeDevice: () => 1 };
  const routes = createRemoteRoutes({ controller, host, credentials, instanceId: 'A', now: () => 100, launch: () => child });
  const response = await invoke(routes, '/open-shell', { body: { id: 'A' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.shellOpened, false);
});

test('GET不能触发续期，表单不能触发打开，错误不反射凭据', async () => {
  const { routes } = setup();
  assert.equal((await invoke(routes, '/renew', { method: 'GET' })).status, 405);
  assert.equal((await invoke(routes, '/open', { headers: { host: '127.0.0.1:1234', 'content-type': 'text/plain' } })).status, 415);
  const failed = await invoke(routes, '/open', { body: { id: '../secret-token' } });
  assert.equal(failed.status, 400);
  assert.doesNotMatch(JSON.stringify(failed.body), /secret-token/);
});

test('线路检测只接受POST且返回逐线路结果，id校验与其它路由一致', async () => {
  const { routes, calls } = setup();
  const res = await invoke(routes, '/diagnose', { body: { id: 'A' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.routes[0].channel, 'lan');
  assert.deepEqual(calls, ['diagnose:A']);
  assert.equal((await invoke(routes, '/diagnose', { method: 'GET' })).status, 405);
  assert.equal((await invoke(routes, '/diagnose', { body: { id: '../secret-token' } })).status, 400);
});

test('挡位存在性由控制器校验：只有对方确实报来的通道可选，其余给具体提示', async () => {
  const { routes, calls } = setup();
  const bad = await invoke(routes, '/mode', { body: { id: 'A', mode: 'direct' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error.code, 'bad-mode');
  assert.equal(bad.body.error.message, '线路挡位不正确，请重新选择');
  const good = await invoke(routes, '/mode', { body: { id: 'A', mode: 'lan' } });
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  assert.deepEqual(calls, ['mode:A:direct', 'mode:A:lan']);
});

test('协议版本不兼容单独返回 REMOTE_VERSION 文案', async () => {
  const controller = { list: async () => [], diagnose: async () => { throw Object.assign(new Error('Remote'), { code: 'REMOTE_VERSION' }); } };
  const routes = createRemoteRoutes({ controller, host: { mintInvite: async () => ({}), revoke() {} },
    credentials: { listRemoteComputers: () => [], revokeDevice() {} }, instanceId: 'A' });
  const res = await invoke(routes, '/diagnose', { body: { id: 'A' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'REMOTE_VERSION');
  assert.equal(res.body.error.message, '对方插件版本不兼容，请升级到支持远程电脑的版本');
});

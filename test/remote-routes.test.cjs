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
  const controller = { list: async () => [], open: async id => { calls.push(id); return { url: 'http://127.0.0.1:4321/', expiresAt: 5000 }; },
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
  assert.equal(launches.length, 1);
  const opened = new URL(launches[0].url);
  assert.equal(opened.origin, 'http://127.0.0.1:4321');
  assert.equal(opened.searchParams.get('shell'), '1');
  const browser = await invoke(routes, '/open', { body: { id: 'A' } });
  assert.equal(browser.status, 200);
  assert.equal(browser.body.url, 'http://127.0.0.1:4321/');
  assert.equal(launches.length, 1);
});

test('GET不能触发续期，表单不能触发打开，错误不反射凭据', async () => {
  const { routes } = setup();
  assert.equal((await invoke(routes, '/renew', { method: 'GET' })).status, 405);
  assert.equal((await invoke(routes, '/open', { headers: { host: '127.0.0.1:1234', 'content-type': 'text/plain' } })).status, 415);
  const failed = await invoke(routes, '/open', { body: { id: '../secret-token' } });
  assert.equal(failed.status, 400);
  assert.doesNotMatch(JSON.stringify(failed.body), /secret-token/);
});

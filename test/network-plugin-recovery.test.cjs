// 主动重连串行重建隧道，手机先回受理，稳定旧mux也遵守当前查看权限。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const workerSource = fs.readFileSync(path.join(__dirname, '../lib/sidecar-facade-worker.cjs'), 'utf8');
function reconnectRoute(source = workerSource, starts = []) {
  const start = source.indexOf("    if (req.method === 'POST' && req.url === '/reconnect') {");
  assert.notEqual(start, -1);
  const end = source.indexOf("    if (req.method === 'POST' && req.url === '/tunnel/send')", start);
  const route = source.slice(start, end);
  const api = new Function('starts', `
    let configuring = Promise.resolve();
    let state = 'connected';
    const startTunnel = () => { starts.push('start'); state = 'connecting'; };
    const status = () => ({ tunnel: { state } });
    const send = (res, code, body) => Object.assign(res, { code, body });
    return { handle: async (req, res) => { ${route} }, block: promise => { configuring = promise; } };
  `)(starts);
  return api;
}
async function assertReconnectOrder(source = workerSource) {
  const starts = [];
  const route = reconnectRoute(source, starts);
  let release;
  route.block(new Promise(resolve => { release = resolve; }));
  const res = {};
  const pending = route.handle({ method: 'POST', url: '/reconnect' }, res);
  await Promise.resolve();
  assert.deepEqual(starts, [], '重连不能越过正在下发的配置');
  release(); await pending;
  assert.deepEqual(starts, ['start']);
  assert.equal(res.body.tunnel.state, 'connecting', '不能把受理响应伪造成已连接');
}
test('worker主动重连等待配置串行链且返回真实connecting状态', () => assertReconnectOrder());
test('变异：主动重连退回空操作会被真实路由行为拒绝', async () => {
  const marker = 'configuring.then(() => { startTunnel(); return status() })';
  assert.ok(workerSource.includes(marker));
  await assert.rejects(assertReconnectOrder(workerSource.replace(marker, 'configuring.then(() => status())')), assert.AssertionError);
});
test('worker startTunnel仍通过真实stopTunnel取消旧连接与退避', () => {
  const stop = workerSource.slice(workerSource.indexOf('function stopTunnel() {'), workerSource.indexOf('function startNetworkMonitor()'));
  const start = workerSource.slice(workerSource.indexOf('function startTunnel() {'), workerSource.indexOf('function relayRoutePlan()'));
  const calls = [];
  const run = new Function('calls', `
    let tunnelGeneration = 1, connectedRelayUrl = 'old', tunnelState = 'connected', tunnelError = null, relayMirror = true, tunnelRoute = {};
    let tunnel = { stop() { calls.push('stop'); } };
    const reconnect = { cancel() { calls.push('cancel'); } };
    const relayRace = { cancel() { calls.push('cancel-race'); } };
    const config = { enabled: true, upstreamPort: 1 };
    const publishState = () => {};
    const relayRoutePlan = () => ['https://relay.invalid'];
    const refreshRelayLatency = async () => {};
    const raceTunnels = () => calls.push('race');
    ${stop}
    ${start}
    startTunnel(); return { tunnelRoute, connectedRelayUrl, tunnelState };
  `);
  const state = run(calls);
  assert.deepEqual(calls, ['cancel', 'cancel-race', 'stop', 'race']);
  assert.deepEqual(state, { tunnelRoute: null, connectedRelayUrl: null, tunnelState: 'connecting' });
});
test('手机重连入口先回已受理再调独立动作，缺接线回503', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/mobile/relay-control.js'), 'utf8');
  const match = source.match(/async function handleRelayReconnect\(_ctx, _req, res\) \{[\s\S]*?\n  \}/);
  assert.ok(match);
  const queued = [], calls = [];
  const handler = new Function('afterResponse', 'sendJson', 'unavailable', 'wired', 'reconnectTunnel', `${match[0]}; return handleRelayReconnect;`)(
    fn => queued.push(fn), (res, code, body) => Object.assign(res, { code, body }), res => { res.code = 503; }, true,
    () => { calls.push('reconnect'); throw new Error('sync reject'); },
  );
  const response = {};
  await handler(null, {}, response);
  assert.equal(response.code, 200); assert.deepEqual(response.body, { ok: true, started: true });
  assert.deepEqual(calls, []);
  await queued[0](); assert.deepEqual(calls, ['reconnect']);
  const missing = new Function('afterResponse', 'sendJson', 'unavailable', 'wired', 'reconnectTunnel', `${match[0]}; return handleRelayReconnect;`)(
    () => {}, () => {}, res => { res.code = 503; }, true, null,
  );
  const denied = {}; await missing(null, {}, denied); assert.equal(denied.code, 503);
});
function assertMuxView(createAuthorizer) {
  const authorize = createAuthorizer(req => ({ ok: true, record: req.record }));
  assert.equal(authorize({ record: { permissions: [] } }), false);
  assert.equal(authorize({ record: { permissions: ['view'] } }), true);
  assert.equal(authorize({ record: {} }), true);
}
test('当前装配authorizer使仍存活的旧mux同样拒绝空权限', () => {
  const file = path.join(__dirname, '../lib/mobile/mux.js');
  const { createMuxAuthorizer } = require(file);
  assertMuxView(createMuxAuthorizer);
  const impl = fs.readFileSync(path.join(__dirname, '../lib/impl.js'), 'utf8');
  assert.ok(impl.includes('const muxAuthorize = createMuxAuthorizer(authOutcome)'));
  assert.ok(impl.includes('muxHost.setProviders({ authorize: muxAuthorize })'));
  const source = fs.readFileSync(file, 'utf8');
  const marker = "if (!hasPermission(outcome.record, resolvePermission('/api/mobile/v1/mux', 'GET'))) return false;";
  assert.ok(source.includes(marker));
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source.replace(marker, ''))(createRequire(file), loaded, loaded.exports);
  assert.throws(() => assertMuxView(loaded.exports.createMuxAuthorizer), assert.AssertionError);
});
function assertRotatedPreviewPermission(permissionApi) {
  const { createPreviewService } = require('../lib/relay/preview.js');
  const currentRecord = { deviceId: 'phone', instanceId: 'current', permissions: [] };
  const credentials = { lookup(_token, instance) { return instance === 'current' ? currentRecord : null; } };
  const service = createPreviewService({ authorized(req) { req.__dshRecord = credentials.lookup('token', 'current'); return true; },
    protectedPorts: () => new Set(), permission: permissionApi.createUpgradePermission({ credentials,
      instanceId: 'previous', presentedCredential: () => 'token' }) });
  const writes = [];
  const socket = new EventEmitter();
  socket.write = value => { writes.push(String(value)); };
  socket.end = value => { if (value) writes.push(String(value)); };
  socket.destroy = () => {};
  try {
    service.handleUpgrade({ method: 'GET', url: '/api/mobile/v1/preview?port=12345', headers: {} }, socket, Buffer.alloc(0));
    assert.match(writes[0], /403 Forbidden/, '换号后预览仍按当前空权限记录拒绝');
  } finally { service.close(); }
}
test('换号后预览不把旧实例查空误判为legacy全权，变异必须拒绝', () => {
  const file = path.join(__dirname, '../lib/mobile/permissions.js');
  assertRotatedPreviewPermission(require(file));
  const source = fs.readFileSync(file, 'utf8');
  const marker = "if (req && req.__dshRecord && typeof req.__dshRecord === 'object') return req.__dshRecord;";
  assert.ok(source.includes(marker));
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source.replace(marker, ''))(createRequire(file), loaded, loaded.exports);
  assert.throws(() => assertRotatedPreviewPermission(loaded.exports), assert.AssertionError);
});

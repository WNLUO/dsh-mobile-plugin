// 驱动真实移动/控制路由吊销升级连接，验证回执、实例隔离与准确关闭计数。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revoke-upgrade-'));
process.env.DSH_HOME = home;
process.env.DEVICE_CREDENTIALS_FILE = path.join(home, 'credentials.json');
const store = require('../lib/shared/credentials-entry').credentialsEntry();
const core = require('../lib/relay/core');
const { createMuxService, REVOKE_DRAIN_TIMEOUT_MS } = require('../lib/mobile/mux');
const { createPreviewService } = require('../lib/relay/preview');
const { registerMobileRoutes } = require('../lib/routes/mobile-api');
const { registerControlPlaneRoutes } = require('../lib/routes/control-plane');
const routing = require('../lib/http/routing');
const { sendJson, readJsonBody } = require('../lib/shared/http-util');
const registry = require('../lib/mobile/stream-registry');

const waitFor = async (predicate, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待吊销连接超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function fixture(upstreamAgent) {
  registry.reset();
  const instanceId = `revoke-${Math.random().toString(36).slice(2)}`;
  const otherId = `${instanceId}-other`;
  const state = { ...core.defaultState(), instanceId, enabled: true };
  const first = store.issue(instanceId, { deviceId: 'same-phone' }, '');
  const second = store.issue(instanceId, { deviceId: 'another-phone' }, '');
  const other = store.issue(otherId, { deviceId: 'same-phone' }, '');
  const tokens = new Map([[first.credential, instanceId], [second.credential, instanceId], [other.credential, otherId]]);
  const auth = (req) => {
    const token = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '')?.[1];
    if (token === 'legacy') return { ok: true };
    const scope = tokens.get(token);
    const record = scope ? store.lookup(token, scope) : null;
    return record && !record.revokedAt ? { ok: true, record } : { ok: false };
  };
  const routes = new Map();
  const upgrades = new Map();
  const upstream = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://x').pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(req, res)).catch((error) => { if (!res.writableEnded) sendJson(res, 500, { error: error.message }); });
  });
  const port = await listen(upstream);
  const mux = createMuxService({ upstream: { port, agent: upstreamAgent }, authorize: (req) => {
    const result = auth(req); req.__dshRecord = result.record; return Boolean(result.ok && result.record);
  } });
  const preview = createPreviewService({ authorized: (req) => {
    const result = auth(req); req.__dshRecord = result.record; req.__dshInstanceId = instanceId; return result.ok;
  }, protectedPorts: () => new Set(), ownWebPort: () => port });
  const closedCounts = [];
  const drop = (deviceId, res) => {
    const closed = registry.drop(deviceId, instanceId) + preview.dropDevice(deviceId, instanceId) + mux.dropDevice(deviceId, instanceId, res);
    closedCounts.push(closed);
    return closed;
  };
  const dropAll = (res) => {
    const closed = registry.dropAll(instanceId) + preview.dropAll(instanceId) + mux.dropAll(instanceId, res);
    closedCounts.push(closed);
    return closed;
  };
  const relayControl = { state, settings: {}, credentials: store, syncSidecar: async () => {}, status: () => ({}),
    getSidecar: () => ({ request: async () => ({ revoked: 0 }) }), dropDeviceStreams: drop, dropAllDeviceStreams: dropAll };
  registerMobileRoutes({
    registerRoute: (route) => routes.set(route.path, route.handler), registerUpgradeRoute: (route) => upgrades.set(route.path, route.handler),
    guarded: routing.createGuarded({}, auth), state, credentials: store, hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({}), safeLanCandidates: () => [], safeIpv6Candidates: () => [], lanPortInUse: () => 0,
    core, pairingApproval: null, preview, mux, relayControl, dropDeviceStreams: drop, dropAllDeviceStreams: dropAll,
  });
  registerControlPlaneRoutes({
    registerRoute: (route) => routes.set(route.path, route.handler), localOnly: routing.localOnly, trustedLocalUi: routing.trustedLocalUi,
    readJson: async (req) => (await readJsonBody(req)) || {}, sendJson, state, credentials: store, settings: {}, status: () => ({}),
    syncSidecar: async () => {}, getSidecar: () => ({ request: async () => ({ revoked: 0 }) }),
    lanPortInUse: () => 0, dropDeviceStreams: drop, dropAllDeviceStreams: dropAll,
  });
  const muxSockets = new Map();
  upstream.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname.endsWith('/mux')) muxSockets.set(req.headers.authorization, socket);
    upgrades.get(pathname)?.(req, socket, head);
  });
  const clients = [];
  const open = async (kind, credential) => {
    const suffix = kind === 'mux' ? '/mux' : `/preview?port=${port}&host=127.0.0.1`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mobile/v1${suffix}`, { headers: { authorization: `Bearer ${credential}` } });
    clients.push(ws);
    const frames = [];
    if (kind === 'mux') ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const socket = muxSockets.get(`Bearer ${credential}`);
    return { ws, frames, socket: () => socket };
  };
  const request = async (url, body = {}, credential) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const fakeSse = () => {
    const stream = new EventEmitter();
    stream.end = () => { stream.writableEnded = true; };
    stream.destroy = () => { stream.destroyed = true; stream.emit('close'); };
    stream.once('close', registry.track('same-phone', stream, instanceId));
    return stream;
  };
  return { instanceId, otherId, first, second, other, state, mux, preview, closedCounts, open, request, fakeSse, routes,
    close: async () => {
      for (const client of clients) client.terminate();
      preview.close(); mux.dropAll(); registry.reset();
      upstream.closeAllConnections?.(); await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

test('自助解绑经真实mux收到完整回执，随后关闭同设备preview/mux且不伤另一实例', async () => {
  const f = await fixture();
  const phone = await f.open('mux', f.first.credential);
  const preview = await f.open('preview', f.first.credential);
  const other = await f.open('mux', f.other.credential);
  const sse = f.fakeSse();
  try {
    phone.ws.send(JSON.stringify({ t: 'req', id: 1, method: 'POST', path: '/api/mobile/v1/device-credential/revoke' }));
    phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 1 }));
    await waitFor(() => phone.frames.some((frame) => frame.t === 'end' && frame.id === 1));
    const body = JSON.parse(phone.frames.filter((frame) => frame.t === 'chunk').map((frame) => frame.text).join(''));
    assert.equal(body.revoked, true);
    assert.ok(phone.frames.some(frame => frame.t === 'end' && frame.id === 1), '解绑回执须先于承载mux关闭');
    await waitFor(() => phone.ws.readyState === WebSocket.CLOSED && preview.ws.readyState === WebSocket.CLOSED);
    assert.equal(sse.destroyed, true);
    assert.equal(f.closedCounts[0], 3, 'SSE、preview、mux各计一次');
    assert.equal(other.ws.readyState, WebSocket.OPEN);
    assert.equal(store.lookup(f.other.credential, f.otherId).revokedAt, undefined);
  } finally { await f.close(); }
});

for (const url of ['/api/relay/revoke-all', '/api/mobile/v1/relay/revoke-all']) {
  test(`${url}真实路由回执后关闭本实例全部升级连接，覆盖无记录legacy预览`, async () => {
    const f = await fixture();
    const mux = await f.open('mux', f.first.credential);
    const preview = await f.open('preview', f.second.credential);
    const legacy = await f.open('preview', 'legacy');
    const other = await f.open('mux', f.other.credential);
    const sse = f.fakeSse();
    try {
      const body = await f.request(url, { confirm: true }, f.first.credential);
      assert.equal(body.ok, true);
      await waitFor(() => [mux, preview, legacy].every((client) => client.ws.readyState === WebSocket.CLOSED));
      assert.equal(sse.destroyed, true);
      assert.equal(f.closedCounts.reduce((sum, count) => sum + count, 0), 4);
      assert.equal(other.ws.readyState, WebSocket.OPEN);
      assert.ok(store.lookup(f.first.credential, f.instanceId).revokedAt);
      assert.equal(store.lookup(f.other.credential, f.otherId).revokedAt, undefined);
    } finally { await f.close(); }
  });
}

test('单设备管理路由返回数字closed且不重复计算mux', async () => {
  const f = await fixture();
  const mux = await f.open('mux', f.first.credential);
  const preview = await f.open('preview', f.first.credential);
  f.fakeSse();
  try {
    const body = await f.request('/api/mobile/v1/paired-devices/revoke', { deviceId: 'same-phone' }, f.second.credential);
    assert.equal(body.closed, 3);
    assert.equal(typeof body.closed, 'number');
    await waitFor(() => mux.ws.readyState === WebSocket.CLOSED && preview.ws.readyState === WebSocket.CLOSED);
    const again = await f.request('/api/relay/devices/revoke', { deviceId: 'same-phone' });
    assert.equal(again.closed, 0);
  } finally { await f.close(); }
});


test('单台管理接口指定自己时，真实mux先收到closed回执再断开', async () => {
  const f = await fixture();
  const phone = await f.open('mux', f.first.credential);
  const preview = await f.open('preview', f.first.credential);
  try {
    phone.ws.send(JSON.stringify({ t: 'req', id: 2, method: 'POST', path: '/api/mobile/v1/paired-devices/revoke', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'same-phone' }) }));
    phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 2 }));
    await waitFor(() => phone.frames.some((frame) => frame.t === 'end' && frame.id === 2));
    const body = JSON.parse(phone.frames.filter((frame) => frame.t === 'chunk' && frame.id === 2).map((frame) => frame.text).join(''));
    assert.equal(body.closed, 2, 'closed是本次唯一选中并排定关闭的在途连接数');
    assert.ok(phone.frames.some(frame => frame.t === 'end' && frame.id === 2));
    await waitFor(() => phone.ws.readyState === WebSocket.CLOSED && preview.ws.readyState === WebSocket.CLOSED);
  } finally { await f.close(); }
});

test('SSE按实例隔离，相同设备号不误伤另一实例，defer只计一次', () => {
  registry.reset();
  const stream = () => ({ end() { this.writableEnded = true; }, destroy() { this.destroyed = true; } });
  const first = stream();
  const second = stream();
  registry.track('phone', first, 'first'); registry.track('phone', second, 'second');
  const actions = [];
  assert.equal(registry.drop('phone', 'first', action => actions.push(action)), 1);
  assert.equal(first.destroyed, undefined, '延后关闭不能在回执前动连接');
  assert.equal(registry.drop('phone', 'first'), 0, '已选中连接不可被重复计数');
  actions.forEach(action => action());
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, undefined);
  assert.equal(registry.dropAll('first'), 0);
  assert.equal(registry.dropAll('second'), 1);
  registry.reset();
});


function writeGate(socket) {
  const originalWrite = socket._write;
  const originalWritev = socket._writev;
  const pending = [];
  let opened = false;
  socket._write = function (...args) { if (opened) return originalWrite.apply(this, args); pending.push(() => originalWrite.apply(this, args)); };
  if (originalWritev) socket._writev = function (...args) { if (opened) return originalWritev.apply(this, args); pending.push(() => originalWritev.apply(this, args)); };
  return () => { opened = true; for (const write of pending.splice(0)) write(); };
}

for (const separateMux of [false, true]) {
  test(`keepalive复用已结束响应的socket后${separateMux ? '另一mux指定自己吊销' : '同mux自助解绑'}完整回执`, async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const f = await fixture(agent);
    const phone = await f.open('mux', f.first.credential);
    const stale = separateMux ? await f.open('mux', f.first.credential) : phone;
    const preview = await f.open('preview', f.first.credential);
    const other = await f.open('mux', f.other.credential);
    const sse = f.fakeSse();
    const releaseStale = writeGate(stale.socket());
    const releasePhone = separateMux ? writeGate(phone.socket()) : releaseStale;
    let finiteSocket;
    let reusedSocket;
    let finiteRequestEnded = false;
    let finiteFinished = false;
    let upstreamFreed = false;
    let queuedStarted = false;
    const onFree = (socket) => {
      if (finiteSocket && socket.localPort === finiteSocket.remotePort && socket.remotePort === finiteSocket.localPort) upstreamFreed = true;
    };
    agent.on('free', onFree);
    f.routes.set('/api/mobile/v1/finite', (req, res) => {
      finiteSocket = req.socket;
      req.on('end', () => { finiteRequestEnded = true; });
      req.resume();
      res.on('finish', () => { finiteFinished = true; });
      res.end('finite');
    });
    f.routes.set('/api/mobile/v1/queued', (_req, res) => { queuedStarted = true; res.end('unexpected'); });
    const revokePath = separateMux ? '/api/mobile/v1/paired-devices/revoke' : '/api/mobile/v1/device-credential/revoke';
    const revoke = f.routes.get(revokePath);
    f.routes.set(revokePath, (req, res) => { reusedSocket = req.socket; return revoke(req, res); });
    try {
      stale.ws.send(JSON.stringify({ t: 'req', id: 20, path: '/api/mobile/v1/finite' }));
      stale.ws.send(JSON.stringify({ t: 'bodyEnd', id: 20 }));
      await waitFor(() => finiteRequestEnded && finiteFinished && upstreamFreed && stale.socket().writableLength > 0);
      assert.equal(stale.frames.some(frame => frame.id === 20), false, '旧响应已在上游结束，外发end回调仍被写门阻住');
      phone.ws.send(JSON.stringify({ t: 'req', id: 21, method: 'POST', path: revokePath, headers: { 'content-type': 'application/json' } }));
      phone.ws.send(JSON.stringify({ t: 'req', id: 22, path: '/api/mobile/v1/queued' }));
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 22 }));
      await waitFor(() => Object.values(agent.requests).some(requests => requests.some(req => req.path === '/api/mobile/v1/queued')));
      phone.ws.send(JSON.stringify({ t: 'body', id: 21, text: JSON.stringify(separateMux ? { deviceId: 'same-phone' } : {}) }));
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 21 }));
      await waitFor(() => f.closedCounts.length > 0);
      assert.strictEqual(reusedSocket, finiteSocket, 'maxSockets=1必须真实复用同一个上游socket');
      assert.ok(store.lookup(f.first.credential, f.instanceId).revokedAt, '写门未放开时凭据立即失效');
      await waitFor(() => preview.ws.readyState === WebSocket.CLOSED && sse.destroyed && (!separateMux || stale.ws.readyState === WebSocket.CLOSED));
      assert.equal(phone.ws.readyState, WebSocket.OPEN, '真正吊销回执的mux须等待外发排空');
      assert.equal(queuedStarted, false, '同设备其余排队流在进入上游前取消');
      assert.equal(other.ws.readyState, WebSocket.OPEN);
      releasePhone();
      await waitFor(() => phone.ws.readyState === WebSocket.CLOSED);
      const receipt = phone.frames.filter(frame => frame.id === 21);
      assert.equal(receipt[0].t, 'resp');
      assert.equal(receipt[0].status, 200);
      assert.ok(receipt.some(frame => frame.t === 'chunk'));
      assert.equal(receipt.at(-1).t, 'end');
      assert.equal(receipt.some(frame => frame.t === 'err'), false);
      const body = JSON.parse(receipt.filter(frame => frame.t === 'chunk').map(frame => frame.text).join(''));
      if (separateMux) assert.equal(body.closed, 4);
      else assert.equal(body.revoked, true);
      if (!separateMux) assert.equal(phone.frames.filter(frame => frame.id === 20 && frame.t === 'chunk').map(frame => frame.text).join(''), 'finite');
      assert.equal(queuedStarted, false);
      other.ws.send(JSON.stringify({ t: 'req', id: 23, path: '/api/mobile/v1/finite' }));
      other.ws.send(JSON.stringify({ t: 'bodyEnd', id: 23 }));
      await waitFor(() => other.frames.some(frame => frame.id === 23 && frame.t === 'end'));
      assert.equal(other.frames.find(frame => frame.id === 23 && frame.t === 'resp').status, 200);
      assert.equal(other.ws.readyState, WebSocket.OPEN);
      assert.equal(store.lookup(f.other.credential, f.otherId).revokedAt, undefined);
    } finally {
      releaseStale(); releasePhone(); agent.off('free', onFree); agent.destroy(); await f.close();
    }
  });
}

for (const releaseGate of [true, false]) {
  test(`mux积压超过4MiB后自吊销：${releaseGate ? '写门放开收到完整回执再关' : '永不放开在5秒内回收'}`, async () => {
    const f = await fixture();
    let floodCancelled = false;
    f.routes.set('/api/mobile/v1/flood', (_req, res) => {
      res.writeHead(200);
      res.on('close', () => { floodCancelled = true; });
      res.write('x'.repeat(6 * 1024 * 1024));
    });
    const phone = await f.open('mux', f.first.credential);
    const sibling = await f.open('preview', f.first.credential);
    const other = await f.open('mux', f.other.credential);
    const release = writeGate(phone.socket());
    try {
      phone.ws.send(JSON.stringify({ t: 'req', id: 10, path: '/api/mobile/v1/flood' }));
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 10 }));
      await waitFor(() => phone.socket().writableLength > 4 * 1024 * 1024);
      phone.ws.send(JSON.stringify({ t: 'req', id: 11, method: 'POST', path: '/api/mobile/v1/device-credential/revoke' }));
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 11 }));
      await waitFor(() => f.closedCounts.length > 0);
      assert.ok(store.lookup(f.first.credential, f.instanceId).revokedAt, '凭据及时失效，回执承载连接有界排空');
      await waitFor(() => sibling.ws.readyState === WebSocket.CLOSED && floodCancelled);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(phone.ws.readyState, WebSocket.OPEN, '本地finish和固定延迟不能抢先terminate积压中的回执');
      assert.equal(other.ws.readyState, WebSocket.OPEN);
      if (releaseGate) {
        release();
        await waitFor(() => phone.ws.readyState === WebSocket.CLOSED);
        const receipt = phone.frames.filter(frame => frame.id === 11);
        assert.equal(receipt[0].t, 'resp');
        assert.equal(receipt.at(-1).t, 'end');
        const body = JSON.parse(receipt.filter(frame => frame.t === 'chunk').map(frame => frame.text).join(''));
        assert.equal(body.revoked, true);
      } else {
        await waitFor(() => phone.ws.readyState === WebSocket.CLOSED, REVOKE_DRAIN_TIMEOUT_MS + 1000);
      }
      assert.equal(other.ws.readyState, WebSocket.OPEN);
    } finally { release(); await f.close(); }
  });
}

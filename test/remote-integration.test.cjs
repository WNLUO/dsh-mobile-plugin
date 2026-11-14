'use strict';
// 真正串起A凭据、LAN代理、端到端加密、本地B浏览器以及现有Rust中转。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-integration-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(home, 'credentials.json');
const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const { createRemoteHost, PAIR_PATH, TUNNEL_PATH } = require('../lib/remote/host.cjs');
const transport = require('../lib/remote/transport.cjs');
const { createRemoteController } = require('../lib/remote/controller.cjs');
const { createLanProxy } = require('../lib/relay/lan-proxy.js');
const { createTunnelForwarder } = require('../lib/relay/tunnel-forwarder.cjs');
const { RelayTunnel } = require('../lib/relay/tunnel.js');
const { remoteRelayRequest } = require('../lib/http/routing.js');
const { createRemoteRoutes } = require('../lib/remote/routes.cjs');

async function fixture() {
  const sockets = new Set();
  let host;
  let writes = 0;
  let exchanges = 0;
  const target = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    if (url.pathname === PAIR_PATH) return host.handlePair(req, res);
    if (url.pathname.startsWith('/api/relay/')) { res.writeHead(remoteRelayRequest(req) ? 403 : 200); return res.end('control'); }
    if (url.pathname === '/' && url.searchParams.get('token') === 'launch-secret') {
      exchanges++; res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-v1=owner-private; Path=/; HttpOnly; SameSite=Strict' }); return res.end();
    }
    if (!String(req.headers.cookie || '').includes('dsh-auth-v1=owner-private')) { res.writeHead(401); return res.end('auth'); }
    if (url.pathname === '/write') {
      writes++; const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => res.end(Buffer.concat(chunks))); return;
    }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>A电脑</title><p>remote-page</p>');
  });
  target.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  target.on('upgrade', (req, socket, head) => {
    if (req.url === TUNNEL_PATH) return host.handleUpgrade(req, socket, head);
    if (!String(req.headers.cookie || '').includes('dsh-auth-v1=owner-private')) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); ws.on('message', (data, binary) => ws.send(data, { binary })); });
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const forwarder = createTunnelForwarder({ upstreamPort: () => target.address().port });
  await forwarder.start();
  const lan = createLanProxy({ lanPort: 0, instanceId: 'integrationA', lanSecret: 'secret', pairingCode: '123456', upstreamPort: target.address().port });
  await lan.start();
  const lanPort = lan.port();
  let routes = [{ url: `http://127.0.0.1:${lanPort}`, channel: 'lan' }];
  host = createRemoteHost({ state: { instanceId: 'integrationA', name: '家里的A' }, credentials,
    routesOf: () => routes, getUpstreamPort: () => forwarder.port(), getWebPort: () => target.address().port,
    getLaunchToken: () => 'launch-secret' });
  const rows = new Map();
  const store = { list: async () => [...rows.values()], get: async id => rows.get(id),
    put: async value => { const id = value.id || value.instanceId; rows.set(id, { ...rows.get(id), ...value, id }); },
    delete: async id => rows.delete(id), update: async (id, fn) => rows.set(id, { ...rows.get(id), ...await fn(rows.get(id)) }) };
  const controller = createRemoteController({ store, transport, name: '出门的B' });
  return { host, controller, rows, target, get writes() { return writes; }, get exchanges() { return exchanges; },
    setRoutes(value) { routes = value; },
    async close() { await controller.close(); host.close(); forwarder.close(); lan.stop(); for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); },
  };
}
async function browserOpen(controller, id) {
  const opened = await controller.open(id);
  const response = await new Promise((resolve, reject) => {
    http.get(opened.url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } }, res => {
      res.resume(); resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] });
    }).on('error', reject);
  });
  assert.equal(response.status, 303);
  const cookie = response.cookie.split(';')[0];
  return { base: new URL(opened.url).origin, cookie };
}

test('A复制邀请→B经LAN绑定→浏览器访问、上传、WS；密钥不进浏览器，控制面不回流', async t => {
  const f = await fixture(); t.after(() => f.close());
  const invited = await f.host.mintInvite();
  const device = await f.controller.add(invited.invite);
  const binding = f.rows.get(device.id);
  const browser = await browserOpen(f.controller, device.id);
  const response = await fetch(browser.base + '/', { headers: { cookie: browser.cookie } });
  assert.equal(response.status, 200); assert.match(await response.text(), /remote-page/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.ok(f.exchanges > 0);
  const body = Buffer.alloc(512 * 1024, 97);
  const posted = await fetch(browser.base + '/write', { method: 'POST', headers: { cookie: browser.cookie, origin: browser.base }, body });
  assert.equal((await posted.arrayBuffer()).byteLength, body.length); assert.equal(f.writes, 1);
  const ws = new WebSocket(browser.base.replace('http:', 'ws:') + '/echo', { headers: { cookie: browser.cookie, origin: browser.base } });
  ws.on('error', () => {}); await once(ws, 'open');
  const answer = once(ws, 'message'); ws.send('live-text'); const [message, binary] = await answer;
  assert.equal(message.toString(), 'live-text'); assert.equal(binary, false); ws.terminate();
  assert.equal((await fetch(browser.base + '/api/relay/config', { method: 'POST', headers: { cookie: browser.cookie, origin: browser.base }, body: '{}' })).status, 403);
  assert.doesNotMatch(JSON.stringify(await f.controller.list()), new RegExp(binding.credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const management = createRemoteRoutes({ controller: f.controller, host: f.host, credentials, instanceId: 'integrationA' });
  assert.ok(management.authorizedComputers().some(row => row.deviceId === binding.deviceId));
  const revokeRequest = new (require('node:stream').PassThrough)();
  Object.assign(revokeRequest, { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:8000', origin: 'http://127.0.0.1:8000', 'content-type': 'application/json' } });
  const revokeResult = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const revoking = management.handler('/revoke')(revokeRequest, revokeResult);
  revokeRequest.end(JSON.stringify({ deviceId: binding.deviceId })); await revoking;
  assert.equal(revokeResult.status, 200); assert.equal(revokeResult.body.revoked, 1);
  assert.deepEqual(management.authorizedComputers(), []);
  const denied = await fetch(browser.base + '/', { headers: { cookie: browser.cookie } }).catch(() => null);
  assert.ok(!denied || denied.status >= 400);
});

const relayBinary = path.resolve(__dirname, '../../server/dsh-mobile-server/server/relay/rust/target/debug/dsh-relay');
test('已有Rust中转不改协议即可承载新电脑配对与加密网页', { skip: !fs.existsSync(relayBinary), timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const child = spawn(relayBinary, [], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PLATFORM_ENABLED: '0', MIRROR_CACHE: '0', BLOB_STORE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 2000);
    try { await stopped; } finally { clearTimeout(timer); }
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error('Rust中转启动失败: ' + logs);
    ready = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const relayRoute = { url: `http://127.0.0.1:${port}`, channel: 'relay' };
  f.setRoutes([relayRoute]);
  const tunnel = new RelayTunnel({ relayUrl: `ws://127.0.0.1:${port}/tunnel`, instanceId: 'integrationA', upstream: `http://127.0.0.1:${f.target.address().port}` });
  t.after(() => tunnel.stop()); await tunnel.start();
  const row = await f.controller.add((await f.host.mintInvite()).invite);
  const browser = await browserOpen(f.controller, row.id);
  const response = await fetch(browser.base + '/', { headers: { cookie: browser.cookie } });
  assert.equal(response.status, 200); assert.match(await response.text(), /remote-page/);
});

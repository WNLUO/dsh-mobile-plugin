// 本地远程网页网关的真实 HTTP、流式上传、SSE 与 WebSocket 边界。
// 壳会话的专属标记只留在本机，页面脚本按会话分发，不进转发请求。
// 2026-11-24：本机端口跨打开稳定、静态资源按上游缓存头缓存都由这里钉住。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { Duplex } = require('node:stream');
const { WebSocket, WebSocketServer } = require('ws');
const { createLocalGateway, LEASE_MS, OPEN_MS } = require('../lib/remote/local.cjs');
const { preferredPortOf } = require('../lib/remote/local-port.cjs');

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function fixture(t) {
  const state = { requests: [], auth: 0, failedPosts: 0, uploadChunks: 0, renewals: [], dials: 0 };
  const token = 'remote-launch-secret';
  const cookie = 'dsh_browser=version1-secret';
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, method: req.method, headers: req.headers });
    const url = new URL(req.url, 'http://host');
    if (url.pathname === '/connect' && url.searchParams.get('token') === token) {
      res.writeHead(302, { 'set-cookie': 'dsh_browser=version2-api-peer; Path=/', location: '/api/remote.mux' }); res.end(); return;
    }
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      state.auth += 1;
      res.writeHead(303, { 'set-cookie': `${cookie}; Path=/; HttpOnly`, location: './' }); res.end(); return;
    }
    if (req.headers.cookie !== cookie) { res.writeHead(401); res.end('browser cookie version1 required'); return; }
    if (url.pathname === '/upload') {
      let bytes = 0;
      req.on('data', (part) => { bytes += part.length; state.uploadChunks += 1; });
      req.on('end', () => { res.writeHead(200); res.end(String(bytes)); }); return;
    }
    if (url.pathname === '/fail') {
      state.failedPosts += 1;
      req.on('data', () => {});
      req.on('end', () => req.socket.destroy()); return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders(); res.write('data: ready\n\n'); return;
    }
    if (url.pathname === '/html') {
      const body = '<!doctype html><html><head><title>remote</title></head><body>remote body</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.write(body.slice(0, 25)); res.end(body.slice(25)); return;
    }
    if (url.pathname === '/assets/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' });
      res.end('console.log(1)'); return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(303, { location: `http://127.0.0.1:${server.address().port}/?token=${token}` }); res.end(); return;
    }
    res.writeHead(url.pathname.startsWith('/__remote') ? 404 : 200, { 'set-cookie': `${cookie}; Path=/`, 'x-dsh-device-credential': 'hidden' });
    res.end(url.pathname === '/' ? 'remote webpage' : 'ok');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    state.requests.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.headers.cookie !== cookie) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(data)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const ws of wss.clients) ws.terminate(); for (const socket of sockets) socket.destroy(); server.close(); });
  async function connect() {
    state.dials += 1;
    const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    const stream = new Duplex({
      read() { socket.resume(); },
      write(chunk, encoding, callback) { socket.write(chunk, encoding, callback); },
      final(callback) { socket.end(callback); },
      destroy(error, callback) { socket.destroy(); callback(error); },
    });
    socket.on('data', (part) => { if (!stream.push(part)) socket.pause(); });
    socket.on('end', () => stream.push(null));
    socket.on('error', (error) => stream.destroy(error));
    socket.on('close', () => stream.destroy());
    stream.renew = async (expiresAt) => { state.renewals.push(expiresAt); return expiresAt; };
    return { stream, host: { port: server.address().port, token } };
  }
  async function gateway(options = {}) {
    const local = createLocalGateway({ connect, ...options });
    t.after(() => local.close());
    const opened = await local.start();
    const origin = new URL(opened.url).origin;
    const bootstrap = await request(opened.url, { headers: {
      'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', referer: 'http://127.0.0.1:12345/',
    } });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.location, '/');
    return { local, opened, origin, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
  }
  return { state, server, connect, gateway, token, cookie };
}

function headers(gateway, extra = {}) {
  return { cookie: gateway.cookie, origin: gateway.origin, 'sec-fetch-site': 'same-origin', ...extra };
}

/** 顶层文档导航的请求头：网关据此才出过渡页。 */
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml' };

test('一次性入口清地址，v1浏览器认证和全部本机凭据隔离', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  assert.equal((await request(g.opened.url)).status, 403);
  const response = await request(`${g.origin}/`, { headers: headers(g, {
    cookie: `${g.cookie}; dsh_owner=B-owner-secret; dsh_lan=B-mobile-secret`,
    authorization: 'Bearer B-secret', 'x-dsh-device-credential': 'B-secret', 'x-dsh-via': 'local', 'x-forwarded-host': 'evil',
  }) });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'remote webpage');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-dsh-device-credential'], undefined);
  assert.equal(f.state.auth, 1);
  assert.equal(f.state.requests.some((entry) => entry.url.startsWith('/connect')), false);
  const forwarded = f.state.requests.findLast((entry) => entry.url === '/');
  assert.equal(forwarded.headers.cookie, f.cookie);
  assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(forwarded.headers['x-dsh-device-credential'], undefined);
  assert.equal(forwarded.headers['x-dsh-via'], undefined);
  assert.equal(forwarded.headers['x-forwarded-host'], undefined);
  assert.equal(forwarded.headers.host, `127.0.0.1:${f.server.address().port}`);
  assert.equal(forwarded.headers.origin, `http://127.0.0.1:${f.server.address().port}`);
  const redirect = await request(`${g.origin}/redirect`, { headers: headers(g) });
  assert.equal(redirect.headers.location, `${g.origin}/`);
  assert.equal(JSON.stringify(redirect).includes(f.token), false);
});

test('精确Host、Origin与Fetch Metadata拒绝跨站，设备cookie不能串用', async (t) => {
  const f = await fixture(t);
  const a = await f.gateway();
  const b = await f.gateway();
  assert.notEqual(a.cookie.split('=')[0], b.cookie.split('=')[0]);
  const requests = [
    headers(a, { host: `attacker.local:${new URL(a.origin).port}` }),
    headers(a, { origin: 'https://attacker.invalid' }),
    headers(a, { origin: b.origin }),
    headers(a, { 'sec-fetch-site': 'cross-site' }),
  ];
  for (const value of requests) assert.equal((await request(`${a.origin}/`, { headers: value })).status, 403);
  assert.equal((await request(`${b.origin}/`, { headers: headers(b, { cookie: a.cookie }) })).status, 401);
  assert.equal(f.state.dials, 0);
  const allCookies = `${a.cookie}; ${b.cookie}; dsh_owner=shared-cookie`;
  assert.equal((await request(`${b.origin}/`, { headers: headers(b, { cookie: allCookies }) })).status, 200);
  assert.equal(f.state.requests.findLast((entry) => entry.url === '/').headers.cookie, f.cookie);
});

test('上传保持分块，POST失败只发一次，网页没有本地续期接口', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const upload = new Promise((resolve, reject) => {
    const req = http.request(`${g.origin}/upload`, { method: 'POST', headers: headers(g), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (part) => chunks.push(part));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(128 * 1024, 1));
    setImmediate(() => { req.write(Buffer.alloc(128 * 1024, 2)); req.end(); });
  });
  assert.equal(await upload, String(256 * 1024));
  assert.ok(f.state.uploadChunks > 1);
  const failed = await request(`${g.origin}/fail`, { method: 'POST', headers: headers(g), body: 'mutate once' });
  assert.equal(failed.status, 502);
  assert.equal(f.state.failedPosts, 1);
  const before = g.local.expiresAt();
  assert.equal((await request(`${g.origin}/__remote/renew`, { method: 'POST', headers: headers(g) })).status, 404);
  assert.equal(g.local.expiresAt(), before);
});

test('WebSocket握手和字节双向透传，关闭立即断开', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const ws = new WebSocket(`${g.origin.replace('http:', 'ws:')}/socket`, { headers: headers(g) });
  ws.on('error', () => {});
  await once(ws, 'open');
  ws.send('remote-message');
  const [message] = await once(ws, 'message');
  assert.equal(String(message), 'remote-message');
  const forwarded = f.state.requests.findLast((entry) => entry.url === '/socket');
  assert.equal(forwarded.headers.cookie, f.cookie);
  assert.equal(forwarded.headers.origin, `http://127.0.0.1:${f.server.address().port}`);
  const closed = once(ws, 'close');
  g.local.close(); await closed;
});

test('手动续期等待活跃流确认，不重开SSE；到期主动关闭且不能复活', async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  const g = await f.gateway({ expiresAt: clock + 1000, now: () => clock });
  const req = http.get(`${g.origin}/events`, { headers: headers(g), agent: false });
  req.on('error', () => {});
  const [res] = await once(req, 'response');
  res.on('error', () => {});
  const [data] = await once(res, 'data');
  assert.equal(String(data), 'data: ready\n\n');
  const dials = f.state.dials;
  clock += 500;
  const renewed = await g.local.renew(clock + LEASE_MS);
  assert.equal(renewed.expiresAt, clock + LEASE_MS);
  assert.ok(f.state.renewals.includes(renewed.expiresAt));
  clock += 1000;
  assert.equal(g.local.checkExpiry(), false);
  assert.equal(res.destroyed, false);
  assert.equal(f.state.dials, dials);
  const closed = new Promise((resolve) => res.once('close', resolve));
  clock = renewed.expiresAt;
  assert.equal(g.local.checkExpiry(), true);
  await closed;
  await assert.rejects(() => g.local.renew(clock + LEASE_MS), { code: 'REMOTE_EXPIRED' });
});

test('临期且窗口还在用才自动续期，闲置时不延长', async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  const g = await f.gateway({ expiresAt: clock + LEASE_MS, now: () => clock });
  clock = g.local.expiresAt() - 60_000;
  const before = g.local.expiresAt();
  assert.equal(await g.local.autoRenew(clock), false);
  assert.equal(g.local.expiresAt(), before);
  const ws = new WebSocket(`${g.origin.replace('http:', 'ws:')}/socket`, { headers: headers(g) });
  ws.on('error', () => {});
  await once(ws, 'open');
  assert.equal(await g.local.autoRenew(clock), true);
  assert.ok(g.local.expiresAt() > before);
  ws.terminate();
});

test('attached 反映桌面窗口是否连着：刚有请求算连着，断开超过宽限即置否', async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  const g = await f.gateway({ now: () => clock });
  assert.equal(g.local.attached(), true);
  clock += 60_000;
  assert.equal(g.local.attached(), false);
  const ws = new WebSocket(`${g.origin.replace('http:', 'ws:')}/socket`, { headers: headers(g) });
  ws.on('error', () => {});
  await once(ws, 'open');
  assert.equal(g.local.attached(), true);
  ws.terminate();
});

test('网变只断已有流，保留入口会话和期限供新WS重连', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const first = new WebSocket(`${g.origin.replace('http:', 'ws:')}/socket`, { headers: headers(g) });
  first.on('error', () => {}); await once(first, 'open');
  const expiresAt = g.local.expiresAt();
  const closed = once(first, 'close');
  g.local.disconnect(); await closed;
  assert.equal(g.local.expiresAt(), expiresAt);
  const second = new WebSocket(`${g.origin.replace('http:', 'ws:')}/socket`, { headers: headers(g) });
  second.on('error', () => {}); await once(second, 'open');
  const reply = once(second, 'message'); second.send('after-network');
  assert.equal(String((await reply)[0]), 'after-network'); second.terminate();
});

test('主文档流式注入只读租期脚本，续期状态实时且不增加远程请求', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const html = await request(`${g.origin}/html`, { headers: headers(g, { accept: 'text/html', 'sec-fetch-dest': 'document' }) });
  assert.equal(html.headers['content-length'], undefined);
  assert.equal(html.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(html.body, /<head><script src="\/__dsh_remote_notice.js" defer><\/script><title>/);
  assert.equal(f.state.requests.findLast((entry) => entry.url === '/html').headers['accept-encoding'], 'identity');
  const dials = f.state.dials;
  const status = await request(`${g.origin}/__dsh_remote_status`, { headers: headers(g) });
  assert.equal(JSON.parse(status.body).expiresAt, g.local.expiresAt());
  assert.equal(status.headers['cache-control'], 'no-store');
  const script = await request(`${g.origin}/__dsh_remote_notice.js`, { headers: headers(g) });
  assert.match(script.body, /__dsh_remote_status/);
  assert.equal(script.body.includes(f.token), false);
  assert.equal((await request(`${g.origin}/__dsh_remote_status`)).status, 401);
  assert.equal((await request(`${g.origin}/__dsh_remote_status`, { method: 'POST', headers: headers(g) })).status, 405);
  assert.equal(f.state.dials, dials);
});

test('打开凭据一分钟失效', async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  const local = createLocalGateway({ connect: f.connect, now: () => clock });
  t.after(() => local.close());
  const opened = await local.start();
  clock += OPEN_MS;
  assert.equal((await request(opened.url)).status, 403);
  assert.equal(f.state.dials, 0);
});

test('同一页面多个顺序请求复用同一条加密流，不重复握手', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const first = await request(`${g.origin}/first`, { headers: headers(g) });
  assert.equal(first.status, 200);
  const dials = f.state.dials;
  assert.equal(dials, 1, '首个请求只握手一次');
  assert.equal(f.state.auth, 1);
  for (let i = 0; i < 4; i += 1) {
    const response = await request(`${g.origin}/page-${i}`, { headers: headers(g) });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
  }
  assert.equal(f.state.dials, dials, '顺序请求应复用同一加密流，不再逐个握手');
  assert.equal(f.state.auth, 1, '同一会话只认证一次');
});

test('只有桌面壳会话拿到 Mac 排版脚本，壳标记与本机凭据都不外送', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway({ platform: 'darwin' });
  const plain = await request(`${g.origin}/__dsh_remote_notice.js`, { headers: headers(g) });
  assert.equal(plain.status, 200);
  assert.match(plain.body, /__dsh_remote_status/);
  assert.doesNotMatch(plain.body, /data-tauri-drag-region|data-dshm-shell|dataset\.platform/);

  const link = g.local.openLink();
  const shellUrl = new URL(link.url);
  shellUrl.searchParams.set('shell', '1');
  const boot = await request(shellUrl.href, { headers: {
    'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  } });
  assert.equal(boot.status, 303);
  const cookies = boot.headers['set-cookie'];
  assert.equal(cookies.length, 2);
  const sessionCookie = cookies[0].split(';')[0];
  const shellCookie = cookies[1].split(';')[0];
  assert.equal(sessionCookie, g.cookie);

  const script = await request(`${g.origin}/__dsh_remote_notice.js`, {
    headers: headers(g, { cookie: `${sessionCookie}; ${shellCookie}` }),
  });
  assert.match(script.body, /data-tauri-drag-region/);
  assert.match(script.body, /body\.dataset\.platform = 'darwin'/);
  assert.match(script.body, /data-dshm-shell/);
  // 快捷键桥只在 dataset 对象上挂自有属性，让 JS 读到精确平台；不写真实 HTML 属性，
  // 官方 CSS 的 [data-platform] 选择器一概不命中，排版保持网页版。
  assert.doesNotMatch(script.body, /documentElement\.setAttribute\(['"]data-platform|root\.setAttribute\(['"]data-platform/);
  assert.equal(script.body.includes(f.token), false);

  const page = await request(`${g.origin}/`, {
    headers: headers(g, { cookie: `${sessionCookie}; ${shellCookie}` }),
  });
  assert.equal(page.status, 200);
  assert.equal(f.state.requests.findLast((entry) => entry.url === '/').headers.cookie, f.cookie);
});

test('顶层文档先给过渡页，隧道建好后才跳真实页面，内部标记不外送', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const loading = await request(`${g.origin}/`, { headers: headers(g, NAV) });
  assert.equal(loading.status, 200);
  assert.match(loading.headers['content-type'], /text\/html/);
  assert.match(loading.body, /__dsh_remote_ready/);
  assert.match(loading.body, /正在连接远程电脑|Connecting to the remote computer/);
  assert.equal(f.state.dials, 0, '过渡页本身不触发握手');

  const ready = await request(`${g.origin}/__dsh_remote_ready`, { headers: headers(g) });
  assert.equal(ready.status, 200);
  assert.equal(JSON.parse(ready.body).ok, true);
  assert.equal(f.state.dials, 1, '就绪探测建立首条加密流');

  const page = await request(`${g.origin}/?__dsh_ready=1`, { headers: headers(g, NAV) });
  assert.equal(page.status, 200);
  assert.equal(page.body, 'remote webpage');
  assert.equal(f.state.requests.findLast((entry) => entry.url === '/').url, '/', '__dsh_ready 不转给远端');
  assert.equal(f.state.dials, 1, '复用已建好的流，不重复握手');

  const again = await request(`${g.origin}/`, { headers: headers(g, NAV) });
  assert.equal(again.status, 200);
  assert.equal(again.body, 'remote webpage', '已就绪后直接透传，不再给过渡页');
});

test('就绪探测失败如实回错误码，只读且需要本机入口会话', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway({ connect: async () => { throw Object.assign(new Error('no route'), { code: 'REMOTE_CONNECT' }); } });
  const ready = await request(`${g.origin}/__dsh_remote_ready`, { headers: headers(g) });
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.body), { ok: false, code: 'REMOTE_CONNECT' });
  assert.equal((await request(`${g.origin}/__dsh_remote_ready`, { method: 'POST', headers: headers(g) })).status, 405);
  assert.equal((await request(`${g.origin}/__dsh_remote_ready`)).status, 401);
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('同一绑定每次打开从同一端口起，被占才顺延，空出来后回到原号', async (t) => {
  const key = 'remote-computer-A';
  const derived = preferredPortOf(key);
  assert.equal(preferredPortOf(key), derived);
  assert.ok(derived >= 49152 && derived <= 65535);
  assert.notEqual(preferredPortOf('remote-computer-B'), derived);

  const f = await fixture(t);
  const base = await freePort();
  const first = await f.gateway({ preferredPort: base });
  assert.equal(new URL(first.origin).port, String(base));
  const second = await f.gateway({ preferredPort: base });
  assert.notEqual(new URL(second.origin).port, String(base));
  first.local.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const third = await f.gateway({ preferredPort: base });
  assert.equal(new URL(third.origin).port, String(base));
});

test('静态资源按上游缓存头缓存，注入提示的文档和只读入口不缓存', async (t) => {
  const f = await fixture(t);
  const g = await f.gateway();
  const ready = await request(`${g.origin}/__dsh_remote_ready`, { headers: headers(g) });
  assert.equal(JSON.parse(ready.body).ok, true);

  const asset = await request(`${g.origin}/assets/app.js`, { headers: headers(g, { 'sec-fetch-dest': 'script' }) });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

  const doc = await request(`${g.origin}/html`, { headers: headers(g, NAV) });
  assert.equal(doc.status, 200);
  assert.match(doc.body, /__dsh_remote_notice\.js/);
  assert.equal(doc.headers['cache-control'], 'no-store');
  assert.equal(doc.headers.etag, undefined);

  const status = await request(`${g.origin}/__dsh_remote_status`, { headers: headers(g) });
  assert.equal(status.headers['cache-control'], 'no-store');
});

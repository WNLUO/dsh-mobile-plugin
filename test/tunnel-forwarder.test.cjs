'use strict';

/**
 * 隧道落点代理：局域网关着时，隧道流量必须带着转发标记进宿主。
 *
 * 现场（2026-11-09 审计）：局域网关闭时，直连隧道（tailcat）与点对点隧道（p2p）都把连接
 * 裸转宿主 web 端口 —— 纯 TCP 透传，请求上不带任何转发标记。控制面 `localOnly` 的判据
 * 全落在转发标记与 Host 上、不校验来源 IP（见 `lib/shared/via-header.js` 文件头），于是
 * 一台已配对的手机经隧道打 `/api/relay/revoke-all`、`/api/relay/config`、
 * `/api/relay/update/apply`，会被当成「本机设置页」照单执行。
 *
 * 这条守卫真起一个落点代理和一个假宿主，把路由真的喂给 `routing.localOnly`：控制面回 403，
 * 移动 API 那条（不挂 localOnly）照常 200。变异证明：把落点代理换成裸转 web 端口、
 * 或让它不打标记，第一条立刻红成 200（handler 被调用）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const routing = require('../lib/http/routing.js');
const { createTunnelForwarder } = require('../lib/relay/tunnel-forwarder.cjs');
const { mountP2P } = require('../lib/p2p/wiring.cjs');

/** 假宿主：控制面那条挂真的 `localOnly`，移动 API 那条不挂（只认 token，测试里直接放行）。 */
function startHost() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, via: req.headers['x-dsh-via'], host: req.headers.host });
    if (req.url === '/api/relay/revoke-all') {
      return routing.localOnly('POST', (_req, _res) => {
        _res.writeHead(200, { 'content-type': 'application/json' });
        _res.end(JSON.stringify({ ok: true, reached: 'control-plane' }));
      })(req, res);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reached: 'mobile' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function request(port, { method = 'GET', path, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

test('局域网关着：经隧道转发进来的控制面请求一律 403，移动 API 照常', async () => {
  const host = await startHost();
  const forwarder = createTunnelForwarder({ upstreamPort: () => host.port, log: () => {} });
  const port = await forwarder.start();
  try {
    // 控制面：不让任何转发标记的情况下打 revoke-all —— 手机经隧道就是这么打的。
    const control = await request(port, {
      method: 'POST',
      path: '/api/relay/revoke-all',
      headers: { host: '127.0.0.1:12345', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(control.status, 403, '控制面必须被挡：不挡就是一台已配对的手机能吊销全部授权');
    assert.equal(JSON.parse(control.body).error.code, 'local_only');
    assert.ok(!host.seen.some((hit) => hit.url === '/api/relay/revoke-all' && hit.via === undefined),
      '控制面请求到达时头上必须已经带着转发标记');

    // 移动 API：只认 token，落点代理原样放过。
    const mobile = await request(port, {
      method: 'GET',
      path: '/api/mobile/v1/status',
      headers: { host: '127.0.0.1:12345', authorization: 'Bearer demo' },
    });
    assert.equal(mobile.status, 200, '移动 API 一条都不该受影响');
    assert.equal(JSON.parse(mobile.body).reached, 'mobile');
    const hit = host.seen.find((entry) => entry.url === '/api/mobile/v1/status');
    assert.equal(hit.via, 'tunnel', '到宿主的请求必须带落点代理的转发标记');
  } finally {
    forwarder.close();
    await new Promise((done) => host.server.close(done));
  }
});

test('挂载层：局域网关着时 p2p 的落点就是打标记的代理（控制面照样 403）', async () => {
  // 直接驱动真实门面：`door.targetPort()` 报出的端口就是隧道里那些连接要去的地方。
  const host = await startHost();
  const door = mountP2P({
    mount: (_label, fn) => fn(),
    warn: () => {},
    state: {},
    saveState: () => {},
    localPort: () => 18787,
    lanEnabled: () => false,
    lanPort: () => 18787,
    webPort: () => host.port,
    ctx: { effect: (fn) => fn() },
    name: 'test',
    resolveBinary: () => null,
  });
  try {
    // 落点代理 `listen(0)` 是异步的，等一拍拿到端口。
    await new Promise((done) => setTimeout(done, 50));
    const port = door.targetPort();
    assert.ok(port > 0 && port !== host.port, '落点必须是代理端口，不能是宿主 web 端口');
    const control = await request(port, {
      method: 'POST',
      path: '/api/relay/revoke-all',
      headers: { host: '127.0.0.1:12345', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(control.status, 403, '经隧道转进来的控制面请求必须被挡');
    assert.equal(JSON.parse(control.body).error.code, 'local_only');
  } finally {
    await new Promise((done) => host.server.close(done));
  }
});

test('手机自己塞的转发标记会被落点代理覆盖，不能用来伪装本机', async () => {
  const host = await startHost();
  const forwarder = createTunnelForwarder({ upstreamPort: () => host.port, log: () => {} });
  const port = await forwarder.start();
  try {
    // 空值是最便宜的绕过尝试：只写不删的话，`proxiedRequest` 见到空串当「没有这个头」。
    const control = await request(port, {
      method: 'POST',
      path: '/api/relay/revoke-all',
      headers: { host: '127.0.0.1:12345', 'x-dsh-via': '   ', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(control.status, 403, '客户端自带的转发标记必须被删掉，再写代理自己的');
  } finally {
    forwarder.close();
    await new Promise((done) => host.server.close(done));
  }
});

test('升级请求（预览）原样穿过落点代理，并带上转发标记', async () => {
  // 假宿主：只接升级，回 101 后再回显一行字节，用来确认双向都通。
  const upgradeSeen = [];
  const host = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const hostSockets = new Set();
  host.on('connection', (socket) => { hostSockets.add(socket); socket.on('close', () => hostSockets.delete(socket)); });
  host.on('upgrade', (req, socket) => {
    upgradeSeen.push({ url: req.url, via: req.headers['x-dsh-via'], connection: req.headers.connection, upgrade: req.headers.upgrade });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const hostPort = await new Promise((resolve) => host.listen(0, '127.0.0.1', () => resolve(host.address().port)));
  const forwarder = createTunnelForwarder({ upstreamPort: () => hostPort, log: () => {} });
  const port = await forwarder.start();
  try {
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          'GET /api/mobile/v1/preview?port=3001 HTTP/1.1\r\n'
          + 'Host: 127.0.0.1:12345\r\n'
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        );
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('101 Switching Protocols')) {
          socket.write('PING');
        }
        if (buffer.includes('PING')) { socket.destroy(); resolve(buffer); }
      });
      socket.on('error', reject);
    });
    assert.ok(received.includes('101 Switching Protocols'), '升级必须真的握上（否则内置浏览器永远白屏）');
    assert.equal(upgradeSeen.length, 1);
    assert.equal(upgradeSeen[0].via, 'tunnel', '升级请求也要带转发标记');
    assert.equal(String(upgradeSeen[0].upgrade).toLowerCase(), 'websocket', '升级相关头必须原样带过去');
  } finally {
    forwarder.close();
    for (const socket of hostSockets) socket.destroy();
    await new Promise((done) => host.close(done));
  }
});

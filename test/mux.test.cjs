// 验证多路移动请求、可信连接头、路径边界与设备吊销。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');
const { createMuxService } = require('../lib/mobile/mux.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// PLUG-09 明确只允许移动 API，假体沿用同一前缀，非移动路径单独验证拒绝。
/** 上游移动 API 假体：/echo 回显方法+路径+请求体；/stream 分两块回 SSE 文本。 */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/mobile/v1/echo')) {
      const chunks = [];
      req.on('data', (b) => chunks.push(b));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers }));
      });
      return;
    }
    if (req.url.startsWith('/api/mobile/v1/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      // 故意把一个多字节字符劈在两块之间，验证宿主用 StringDecoder 不会切坏。
      const bytes = Buffer.from('data: 中文\n\n', 'utf8');
      const cut = bytes.indexOf(Buffer.from('文', 'utf8')) + 1;
      res.write(bytes.subarray(0, cut));
      setTimeout(() => { res.write(bytes.subarray(cut)); res.end(); }, 10);
      return;
    }
    res.writeHead(404); res.end('no');
  });
  const port = await listen(server);
  return { server, port };
}

async function startMux(upstreamPort, authorize) {
  const svc = createMuxService({ upstream: { host: '127.0.0.1', port: upstreamPort }, authorize });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => svc.handleUpgrade(req, socket, head));
  const port = await listen(server);
  return { port, svc, close: () => new Promise((r) => { server.close(() => r()); }) };
}

async function connect(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mobile/v1/mux`, { headers });
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch { return; }
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = (pred, timeoutMs = 2000) => new Promise((resolve, reject) => {
    const hit = frames.find(pred);
    if (hit) { resolve(hit); return; }
    const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
    waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
  });
  const textOf = (id) => frames.filter((f) => f.t === 'chunk' && f.id === id).map((f) => f.text).join('');
  return { ws, frames, waitFor, textOf };
}

test('mux: GET 请求 → resp/chunk/end 回显', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/api/mobile/v1/echo?a=1', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 1 }));
    const resp = await waitFor((f) => f.t === 'resp' && f.id === 1);
    assert.strictEqual(resp.status, 200);
    await waitFor((f) => f.t === 'end' && f.id === 1);
    const body = JSON.parse(textOf(1));
    assert.strictEqual(body.method, 'GET');
    assert.strictEqual(body.url, '/api/mobile/v1/echo?a=1');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: POST 请求体分片转发', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 7, method: 'POST', path: '/api/mobile/v1/echo', headers: { 'content-type': 'text/plain' } }));
    ws.send(JSON.stringify({ t: 'body', id: 7, text: 'hello ' }));
    ws.send(JSON.stringify({ t: 'body', id: 7, text: 'world' }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 7 }));
    await waitFor((f) => f.t === 'end' && f.id === 7);
    assert.strictEqual(JSON.parse(textOf(7)).body, 'hello world');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: 响应体跨块的多字节字符不被切坏', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 9, method: 'GET', path: '/api/mobile/v1/stream', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 9 }));
    await waitFor((f) => f.t === 'end' && f.id === 9);
    assert.strictEqual(textOf(9), 'data: one\n\ndata: 中文\n\n');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: ping → pong', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'ping' }));
    await waitFor((f) => f.t === 'pong');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: 同一 id 重复 → err', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 3, method: 'GET', path: '/api/mobile/v1/stream', headers: {} }));
    ws.send(JSON.stringify({ t: 'req', id: 3, method: 'GET', path: '/api/mobile/v1/stream', headers: {} }));
    await waitFor((f) => f.t === 'err' && f.id === 3);
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: 未鉴权 → 连接被拒', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => false);
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mux.port}/api/mobile/v1/mux`);
      ws.once('open', () => reject(new Error('should not open')));
      ws.once('error', () => resolve());
    });
  } finally {
    await mux.close(); up.server.close();
  }
});

test('mux: 两条逻辑流并行互不串台', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 10, method: 'GET', path: '/api/mobile/v1/echo?x=10', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 10 }));
    ws.send(JSON.stringify({ t: 'req', id: 11, method: 'GET', path: '/api/mobile/v1/echo?x=11', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 11 }));
    await waitFor((f) => f.t === 'end' && f.id === 10);
    await waitFor((f) => f.t === 'end' && f.id === 11);
    assert.strictEqual(JSON.parse(textOf(10)).url, '/api/mobile/v1/echo?x=10');
    assert.strictEqual(JSON.parse(textOf(11)).url, '/api/mobile/v1/echo?x=11');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});


test('mux: 控制面、绝对URL、路径穿越与空路径都不转发；合法query仍可用', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, frames, waitFor } = await connect(mux.port);
  try {
    const forbidden = ['/api/relay/config', '/', 'http://localhost/api/mobile/v1/status', '/api/mobile/v1/../relay/config', '/api/mobile/v1/%2e%2e/relay/config', '/api/mobile/v1/status#fragment', ''];
    for (const [index, path] of forbidden.entries()) {
      const id = 100 + index;
      ws.send(JSON.stringify({ t: 'req', id, method: 'POST', path }));
      await waitFor((f) => f.t === 'err' && f.id === id);
      assert.ok(!frames.some((f) => f.t === 'resp' && f.id === id));
    }
    ws.send(JSON.stringify({ t: 'req', id: 120, path: '/api/mobile/v1/echo?query=a%2Fb', method: 'GET' }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 120 }));
    await waitFor((f) => f.t === 'end' && f.id === 120);
  } finally { ws.close(); await mux.close(); up.server.close(); }
});

test('mux: 逻辑帧不能覆盖握手身份、设备元信息与via', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port, { authorization: 'Bearer trusted', 'x-dsh-device-model': 'trusted-model' });
  try {
    ws.send(JSON.stringify({ t: 'req', id: 130, path: '/api/mobile/v1/echo', headers: {
      Authorization: 'Bearer forged', 'X-Dsh-Via': '', 'x-dsh-via': 'lan',
      'X-Dsh-Device-Credential': 'other-device', 'x-dsh-device-model': 'forged-model',
    } }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 130 }));
    await waitFor((f) => f.t === 'end' && f.id === 130);
    const { headers } = JSON.parse(textOf(130));
    assert.equal(headers['x-dsh-via'], 'mux');
    assert.equal(headers.authorization, 'Bearer trusted');
    assert.equal(headers['x-dsh-device-credential'], undefined);
    assert.equal(headers['x-dsh-device-model'], 'trusted-model');
  } finally { ws.close(); await mux.close(); up.server.close(); }
});

test('mux: 吊销只关闭对应已鉴权设备，关闭后注销连接', async () => {
  const registry = require('../lib/mobile/stream-registry.js');
  registry.reset();
  const up = await startUpstream();
  const mux = await startMux(up.port, (req) => { req.__dshRecord = { deviceId: req.headers['x-dsh-device'] }; return true; });
  const first = await connect(mux.port, { 'x-dsh-device': 'revoked' });
  const second = await connect(mux.port, { 'x-dsh-device': 'kept' });
  try {
    assert.equal(registry.size(), 0, 'mux由稳定service单独计数，不能与SSE重复登记');
    const closed = new Promise((resolve) => first.ws.once('close', resolve));
    registry.reset(); // 稳定外壳与当前代可能各有一份登记模块，service仍必须能吊销旧连接。
    assert.equal(mux.svc.dropDevice('revoked'), 1);
    await closed;
    second.ws.send(JSON.stringify({ t: 'ping' }));
    await second.waitFor((f) => f.t === 'pong');
    assert.equal(mux.svc.dropDevice('revoked'), 0);
    assert.equal(mux.svc.dropDevice('kept'), 1);
  } finally {
    first.ws.terminate(); second.ws.terminate();
    await mux.close(); up.server.close(); registry.reset();
  }
});


for (const [bodyInRequest, method] of [[true, 'POST'], [false, 'POST'], [true, 'GET'], [false, 'GET']]) {
  test(`mux ${method} HTTP分帧：恶意CL=0不能把${bodyInRequest ? 'frame.body' : '后续body帧'}变成第二个控制面请求`, async () => {
    const { localOnly } = require('../lib/http/routing');
    const seen = [];
    let controlCalls = 0;
    const upstream = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === '/api/relay/config') {
        return localOnly('POST', (_req, response) => { controlCalls += 1; response.end('unsafe'); })(req, res);
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
        res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), via: req.headers['x-dsh-via'], length: req.headers['content-length'] || null }));
      });
    });
    const port = await listen(upstream);
    const mux = await startMux(port, () => true);
    const phone = await connect(mux.port);
    const injected = 'POST /api/relay/config HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n';
    try {
      phone.ws.send(JSON.stringify({ t: 'req', id: 200, method, path: '/api/mobile/v1/echo', headers: { 'Content-Length': '0' }, ...(bodyInRequest ? { body: injected } : {}) }));
      if (!bodyInRequest) {
        phone.ws.send(JSON.stringify({ t: 'body', id: 200, text: injected.slice(0, 17) }));
        phone.ws.send(JSON.stringify({ t: 'body', id: 200, text: injected.slice(17) }));
      }
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 200 }));
      phone.ws.send(JSON.stringify({ t: 'req', id: 201, method: 'POST', path: '/api/mobile/v1/echo', headers: { 'content-length': '999' }, body: 'normal-body' }));
      phone.ws.send(JSON.stringify({ t: 'bodyEnd', id: 201 }));
      await phone.waitFor((frame) => frame.t === 'end' && frame.id === 200);
      await phone.waitFor((frame) => frame.t === 'end' && frame.id === 201);
      const first = JSON.parse(phone.textOf(200));
      assert.equal(first.body, injected, '看似HTTP请求的正文仍必须只是本条mobile请求正文');
      assert.equal(first.via, 'mux');
      assert.equal(first.length, null, '客户端Content-Length不能控制上游分帧');
      assert.equal(JSON.parse(phone.textOf(201)).body, 'normal-body');
      assert.equal(controlCalls, 0);
      assert.deepEqual(seen, ['/api/mobile/v1/echo', '/api/mobile/v1/echo']);
    } finally {
      phone.ws.terminate(); await mux.close();
      upstream.closeAllConnections?.(); await new Promise((resolve) => upstream.close(resolve));
    }
  });
}

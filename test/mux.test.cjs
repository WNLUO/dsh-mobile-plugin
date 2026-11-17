'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');
const { createMuxService } = require('../lib/mobile/mux.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** 上游移动 API 假体：/echo 回显方法+路径+请求体；/stream 分两块回 SSE 文本。 */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/echo')) {
      const chunks = [];
      req.on('data', (b) => chunks.push(b));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (req.url.startsWith('/stream')) {
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
  return { port, close: () => new Promise((r) => { server.close(() => r()); }) };
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mobile/v1/mux`);
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
    ws.send(JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/echo?a=1', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 1 }));
    const resp = await waitFor((f) => f.t === 'resp' && f.id === 1);
    assert.strictEqual(resp.status, 200);
    await waitFor((f) => f.t === 'end' && f.id === 1);
    const body = JSON.parse(textOf(1));
    assert.strictEqual(body.method, 'GET');
    assert.strictEqual(body.url, '/echo?a=1');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

test('mux: POST 请求体分片转发', async () => {
  const up = await startUpstream();
  const mux = await startMux(up.port, () => true);
  const { ws, waitFor, textOf } = await connect(mux.port);
  try {
    ws.send(JSON.stringify({ t: 'req', id: 7, method: 'POST', path: '/echo', headers: { 'content-type': 'text/plain' } }));
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
    ws.send(JSON.stringify({ t: 'req', id: 9, method: 'GET', path: '/stream', headers: {} }));
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
    ws.send(JSON.stringify({ t: 'req', id: 3, method: 'GET', path: '/stream', headers: {} }));
    ws.send(JSON.stringify({ t: 'req', id: 3, method: 'GET', path: '/stream', headers: {} }));
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
    ws.send(JSON.stringify({ t: 'req', id: 10, method: 'GET', path: '/echo?x=10', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 10 }));
    ws.send(JSON.stringify({ t: 'req', id: 11, method: 'GET', path: '/echo?x=11', headers: {} }));
    ws.send(JSON.stringify({ t: 'bodyEnd', id: 11 }));
    await waitFor((f) => f.t === 'end' && f.id === 10);
    await waitFor((f) => f.t === 'end' && f.id === 11);
    assert.strictEqual(JSON.parse(textOf(10)).url, '/echo?x=10');
    assert.strictEqual(JSON.parse(textOf(11)).url, '/echo?x=11');
  } finally {
    ws.close(); await mux.close(); up.server.close();
  }
});

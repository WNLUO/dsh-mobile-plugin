// 验证网页版管道逐请求标记、keepalive、WS升级余留字节与关闭清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { WebSocket } = require('ws');
const { createPreviewService } = require('../lib/relay/preview');
const { OUTPUT_DRAIN_TIMEOUT_MS } = require('../lib/relay/preview-webapp.cjs');
const { localOnly } = require('../lib/http/routing');
const registry = require('../lib/mobile/stream-registry');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const until = async (predicate, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待管道响应超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function fixture(handler) {
  const seen = [];
  const sockets = new Set();
  const host = http.createServer((req, res) => {
    seen.push(req.headers['x-dsh-via']);
    if (handler) return handler(req, res);
    return localOnly('POST', (_req, response) => { response.writeHead(200); response.end('unsafe'); })(req, res);
  });
  host.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const hostPort = await listen(host);
  const service = createPreviewService({
    authorized: (req) => {
      req.__dshRecord = { instanceId: 'preview-instance', deviceId: 'preview-device' };
      return true;
    },
    protectedPorts: () => new Set([hostPort]), ownWebPort: () => hostPort,
  });
  const gateway = http.createServer();
  let pipeSocket;
  gateway.on('upgrade', (req, socket, head) => { pipeSocket = socket; service.handleUpgrade(req, socket, head); });
  const gatewayPort = await listen(gateway);
  const open = async ({ collect = true } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/mobile/v1/preview?mode=webapp&host=127.0.0.1&port=${hostPort}`);
    const data = [];
    if (collect) ws.on('message', (chunk) => data.push(Buffer.from(chunk)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, data, text: () => Buffer.concat(data).toString('latin1') };
  };
  const close = async () => {
    service.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((resolve) => gateway.close(resolve)), new Promise((resolve) => host.close(resolve))]);
  };
  return { host, hostPort, service, seen, sockets, open, close, pipeSocket: () => pipeSocket };
}

test('webapp每次keepalive请求都覆盖via，网页版请求按本机界面放行控制面', async () => {
  const f = await fixture();
  const phone = await f.open();
  try {
    const request = 'POST /api/relay/config HTTP/1.1\r\nHost: localhost\r\nX-Dsh-Via: \r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n';
    phone.ws.send(request);
    await until(() => f.seen.length === 1 && phone.text().includes('200 OK'));
    // 客户端自带的 lan 标记会被管道覆盖成 preview-webapp：手机上打开的整份网页版仍能进控制面。
    phone.ws.send(request.replace('X-Dsh-Via: ', 'x-dsh-via: lan'));
    await until(() => f.seen.length === 2 && (phone.text().match(/200 OK/g) || []).length === 2);
    assert.deepEqual(f.seen, ['preview-webapp', 'preview-webapp']);
  } finally { phone.ws.terminate(); await f.close(); }
});

test('webapp逐请求保留HTTP正文与流式响应字节', async () => {
  const f = await fixture((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('first:'); res.end(Buffer.concat(chunks)); });
  });
  const phone = await f.open();
  try {
    phone.ws.send('POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 6\r\n\r\nabc123');
    await until(() => phone.text().includes('abc123'));
    assert.ok(phone.text().includes('first:'));
    assert.equal(f.seen[0], 'preview-webapp');
  } finally { phone.ws.terminate(); await f.close(); }
});

test('webapp升级覆盖via，双向保留握手之后同包head及后续字节', async () => {
  const f = await fixture();
  let received = '';
  let via;
  f.host.on('upgrade', (req, socket, head) => {
    via = req.headers['x-dsh-via'];
    received += head.toString('latin1');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nserver-head');
    if (head.length) socket.write(head);
    socket.on('data', (chunk) => { received += chunk.toString('latin1'); socket.write(chunk); });
  });
  const phone = await f.open();
  try {
    phone.ws.send('GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\nX-Dsh-Via: \r\n\r\nclient-head');
    await until(() => phone.text().includes('client-head') && phone.text().includes('server-head'));
    assert.equal(via, 'preview-webapp');
    phone.ws.send('after-upgrade');
    await until(() => phone.text().includes('after-upgrade'));
    assert.equal(received, 'client-headafter-upgrade');
  } finally { phone.ws.terminate(); await f.close(); }
});

test('吊销和客户端断开都立即拆除webapp上游，计数只减一次', async () => {
  const f = await fixture((_req, res) => { res.writeHead(200); res.write('open'); });
  let phone = await f.open();
  try {
    phone.ws.send('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await until(() => f.sockets.size === 1);
    const closed = new Promise((resolve) => phone.ws.once('close', resolve));
    assert.equal(f.service.dropDevice('preview-device', 'preview-instance'), 1);
    await closed;
    await until(() => f.sockets.size === 0 && f.service.stats().activeStreams === 0);
    phone = await f.open();
    phone.ws.send('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await until(() => f.sockets.size === 1);
    phone.ws.terminate();
    await until(() => f.sockets.size === 0 && f.service.stats().activeStreams === 0);
    assert.equal(registry.size(), 0);
  } finally { phone.ws.terminate(); await f.close(); }
});

test('上游异常断开不会留下webapp连接', async () => {
  const f = await fixture((req) => req.socket.destroy());
  const phone = await f.open();
  try {
    phone.ws.send('GET /fail HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await until(() => phone.text().includes('502') || phone.ws.readyState === WebSocket.CLOSED);
    await until(() => phone.ws.readyState === WebSocket.CLOSED && f.service.stats().activeStreams === 0);
  } finally { await f.close(); }
});


test('webapp大流遇到慢读端会按背压暂停，恢复后交付完再自释放', async () => {
  const total = 64 * 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024, 'x');
  let sent = 0;
  let blocked = false;
  let finished = false;
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-length': String(total), connection: 'close' });
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!res.write(chunk)) { blocked = true; res.once('drain', pump); return; }
      }
      finished = true;
      res.end();
    };
    pump();
  });
  const phone = await f.open({ collect: false });
  let received = 0;
  phone.ws.on('message', (data) => { received += data.length; });
  try {
    phone.ws.pause();
    phone.ws.send('GET /large HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await until(() => blocked);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(finished, false, '手机暂停读取时不能把64MiB全部灌入宿主写队列');
    assert.ok(sent < total);
    phone.ws.resume();
    await until(() => phone.ws.readyState === WebSocket.CLOSED && f.service.stats().activeStreams === 0);
    assert.ok(received >= total, '恢复读取后正文必须完整交付');
  } finally { phone.ws.terminate(); await f.close(); }
});


for (const method of ['GET', 'HEAD']) {
  test(`webapp chunked ${method}正文跨WS分片仍只有一个带via请求`, async () => {
    let actions = 0;
    const requests = [];
    let body;
    const f = await fixture((req, res) => {
      requests.push({ url: req.url, via: req.headers['x-dsh-via'] });
      if (req.url === '/api/relay/config') return localOnly('POST', (_req, response) => { actions += 1; response.end('unsafe'); })(req, res);
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => { body = Buffer.concat(chunks).toString(); res.writeHead(200, { 'content-length': '0' }); res.end(); });
    });
    const phone = await f.open();
    const injected = 'POST /api/relay/config HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n';
    const raw = `${method} /body HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(injected).toString(16)}\r\n${injected}\r\n0\r\n\r\n`;
    try {
      for (let offset = 0; offset < raw.length; offset += 13) phone.ws.send(raw.slice(offset, offset + 13));
      await until(() => body !== undefined && phone.text().includes('200 OK'));
      assert.equal(body, injected);
      assert.deepEqual(requests, [{ url: '/body', via: 'preview-webapp' }]);
      assert.equal(actions, 0);
    } finally { phone.ws.terminate(); await f.close(); }
  });
}

function writeGate(socket) {
  const originalWrite = socket._write;
  const originalWritev = socket._writev;
  const pending = [];
  let opened = false;
  socket._write = function (...args) { if (opened) return originalWrite.apply(this, args); pending.push(() => originalWrite.apply(this, args)); };
  if (originalWritev) socket._writev = function (...args) { if (opened) return originalWritev.apply(this, args); pending.push(() => originalWritev.apply(this, args)); };
  return () => { opened = true; for (const write of pending.splice(0)) write(); };
}

for (const releaseGate of [true, false]) {
  test(`webapp升级正常EOF的尾部${releaseGate ? '排空后完整关闭' : '写死后有界回收'}`, async () => {
    const f = await fixture();
    let clientBytes = '';
    f.host.on('upgrade', (_req, socket, head) => {
      clientBytes += head.toString();
      socket.on('data', (chunk) => { clientBytes += chunk.toString(); });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nserver-head');
      socket.end('last-business-frame-and-close');
    });
    const phone = await f.open();
    const release = writeGate(f.pipeSocket());
    try {
      phone.ws.send('GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nclient-head');
      await until(() => f.pipeSocket().writableLength > 0);
      await new Promise((resolve) => setTimeout(resolve, 160));
      assert.equal(phone.ws.readyState, WebSocket.OPEN, '正常EOF不能抢在已排队尾部之前销毁外层WS');
      if (releaseGate) {
        release();
        await until(() => phone.ws.readyState === WebSocket.CLOSED);
        assert.ok(phone.text().includes('server-head'));
        assert.ok(phone.text().endsWith('last-business-frame-and-close'));
        assert.equal(clientBytes, 'client-head');
      } else {
        await until(() => phone.ws.readyState === WebSocket.CLOSED, OUTPUT_DRAIN_TIMEOUT_MS + 1500);
      }
      await until(() => f.service.stats().activeStreams === 0);
    } finally { release(); phone.ws.terminate(); await f.close(); }
  });
}

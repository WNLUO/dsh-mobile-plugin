// 验证 mux 半开回收、响应头期限与吊销回执的定时边界。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

const FILE = require.resolve('../lib/mobile/mux.js');

function clock() {
  let now = 0;
  const tasks = new Map();
  const add = (fn, delay, every = 0) => {
    const timer = { fn, at: now + delay, every, unref() {} };
    tasks.set(timer, timer);
    return timer;
  };
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => add(fn, delay), clearTimeout: (timer) => tasks.delete(timer),
    setInterval: (fn, delay) => add(fn, delay, delay), clearInterval: (timer) => tasks.delete(timer),
    performance: { now: () => now },
    pending: () => tasks.size,
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks.values()].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every;
        else tasks.delete(next);
        next.fn();
      }
      now = end;
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fixture(t, handler = (_req, res) => { res.writeHead(200); res.flushHeaders(); }, mutate = (source) => source) {
  const timers = clock();
  const requests = [];
  const arrivals = [];
  const arrivalWaiters = [];
  const serverSockets = [];
  const socketById = new Map();
  let connectionId = 0;
  const clients = [];
  const tcpSockets = new Set();
  const anchored = createRequire(FILE);
  class CapturedServer extends WebSocketServer {
    handleUpgrade(req, socket, head, done) {
      super.handleUpgrade(req, socket, head, (ws) => {
        serverSockets.push(ws); socketById.set(req.headers['x-fixture-id'], ws); done(ws);
      });
    }
  }
  const loaded = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(FILE, 'utf8')), {
    module: loaded, exports: loaded.exports, Buffer, ...timers,
    require: (name) => name === 'ws' ? { WebSocketServer: CapturedServer } : name === 'node:http' ? {
      request(...args) { const req = http.request(...args); requests.push(req); return req; },
    } : name === 'node:perf_hooks' ? { performance: timers.performance } : anchored(name),
  });
  const upstream = http.createServer((req, res) => {
    arrivals.push({ req, res });
    handler(req, res);
    for (const resolve of arrivalWaiters.splice(0)) resolve();
  });
  const upstreamPort = await listen(upstream);
  const svc = loaded.exports.createMuxService({
    upstream: { host: '127.0.0.1', port: upstreamPort },
    authorize(req) { req.__dshRecord = { deviceId: 'phone', instanceId: 'instance' }; return true; },
  });
  const server = http.createServer();
  for (const host of [upstream, server]) host.on('connection', (socket) => {
    tcpSockets.add(socket); socket.once('close', () => tcpSockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => svc.handleUpgrade(req, socket, head));
  const port = await listen(server);
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of serverSockets) ws.terminate();
    for (const socket of tcpSockets) socket.destroy();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  });
  async function connect() {
    const id = String(++connectionId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mobile/v1/mux`, { autoPong: false, headers: { 'x-fixture-id': id } });
    clients.push(ws);
    const frames = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()); frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].matches(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
      }
    });
    await once(ws, 'open');
    return {
      ws, frames, serverWs: socketById.get(id),
      send: (frame) => ws.send(JSON.stringify(frame)),
      frame: (matches) => {
        const found = frames.find(matches);
        return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ matches, resolve }));
      },
    };
  }
  const arrival = async (index = 0) => {
    while (!arrivals[index]) await new Promise((resolve) => arrivalWaiters.push(resolve));
    return arrivals[index];
  };
  return { timers, requests, svc, connect, arrival, port, ...loaded.exports };
}

async function beat(f, client) {
  const ping = once(client.ws, 'ping');
  f.timers.tick(15_000);
  await ping;
  const pong = once(client.serverWs, 'pong');
  client.ws.pong();
  await pong;
}

function assertHeaderDeadline(f) {
  f.timers.tick(29_999);
  assert.equal(f.requests[0].destroyed, false, '响应头期限前不能销毁请求');
  f.timers.tick(1);
  assert.equal(f.requests[0].destroyed, true, '无响应头时，期限必须独立于 socket 活动到达');
}

function assertHalfOpenReclaimed(f, client) {
  f.timers.tick(45_000);
  assert.notEqual(client.serverWs.readyState, WebSocket.OPEN, '45 秒没有协议 pong 必须回收半开连接');
}

test('mux：半开连接释放全部槽位与上游，重复 close/error 不会重复归还', { timeout: 15_000 }, async (t) => {
  let response;
  const f = await fixture(t, (_req, res) => { response = res; res.writeHead(200); res.flushHeaders(); });
  const old = await Promise.all(Array.from({ length: f.MAX_CONNECTIONS }, () => f.connect()));
  old[0].send({ t: 'req', id: 1, path: '/api/mobile/v1/events' });
  old[0].send({ t: 'bodyEnd', id: 1 });
  await old[0].frame((frame) => frame.t === 'resp');
  const upstreamClosed = once(response, 'close');
  const closed = old.map((client) => once(client.ws, 'close'));
  assertHalfOpenReclaimed(f, old[0]);
  await Promise.all([...closed, upstreamClosed]);
  assert.equal(f.timers.pending(), 0, '回收必须清掉心跳与各流定时器');
  assert.equal(f.requests[0].destroyed, true);
  assert.equal(old[0].frames.some((frame) => frame.t === 'err'), false, '连接回收不能伪装成业务失败');
  old[0].serverWs.emit('close');
  old[0].serverWs.emit('error', new Error('late error'));
  const fresh = await Promise.all(Array.from({ length: f.MAX_CONNECTIONS }, () => f.connect()));
  assert.equal(fresh.length, f.MAX_CONNECTIONS, '半开回收后必须重新接满原容量');
  const extra = new WebSocket(`ws://127.0.0.1:${f.port}/api/mobile/v1/mux`);
  extra.on('error', () => {});
  const refused = once(extra, 'unexpected-response');
  const [, res] = await refused;
  assert.equal(res.statusCode, 503, '重复清理不能把计数减成负数、放大容量');
  res.resume();
  extra.terminate();
});

test('mux：闲置但持续回应协议 pong 的连接保持可用', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  for (let i = 0; i < 5; i += 1) await beat(f, client);
  assert.equal(client.serverWs.readyState, WebSocket.OPEN);
  client.send({ t: 'ping' });
  await client.frame((frame) => frame.t === 'pong');
});

test('mux：持续上传字节不能续长响应头期限', { timeout: 10_000 }, async (t) => {
  let upstreamRequest;
  let received;
  const firstData = new Promise((resolve) => { received = resolve; });
  const f = await fixture(t, (req) => { upstreamRequest = req; req.once('data', received); });
  const client = await f.connect();
  client.send({ t: 'req', id: 8, method: 'POST', path: '/api/mobile/v1/send' });
  client.send({ t: 'body', id: 8, text: 'one' });
  await firstData;
  f.timers.tick(15_000);
  const nextData = once(upstreamRequest, 'data');
  client.send({ t: 'body', id: 8, text: 'two' });
  await nextData;
  f.timers.tick(14_999);
  assert.equal(f.requests[0].destroyed, false);
  f.timers.tick(1);
  assert.equal(f.requests[0].destroyed, true);
  const error = await client.frame((frame) => frame.t === 'err' && frame.id === 8);
  assert.equal(error.message, 'upstream header timeout');
});

test('mux：响应头到达立即撤销期限，正文静默超过 30 秒仍能正常结束', { timeout: 10_000 }, async (t) => {
  let response;
  const f = await fixture(t, (_req, res) => { response = res; res.writeHead(200); res.flushHeaders(); });
  const client = await f.connect();
  client.send({ t: 'req', id: 9, path: '/api/mobile/v1/events' });
  client.send({ t: 'bodyEnd', id: 9 });
  await client.frame((frame) => frame.t === 'resp');
  assert.equal(f.timers.pending(), 1, '收到响应头后只保留连接心跳');
  for (let i = 0; i < 4; i += 1) await beat(f, client);
  assert.equal(response.destroyed, false);
  assert.equal(client.frames.some((frame) => frame.t === 'err'), false);
  response.end('done');
  await client.frame((frame) => frame.t === 'end' && frame.id === 9);
  assert.equal(client.frames.filter((frame) => frame.t === 'chunk').map((frame) => frame.text).join(''), 'done');
});

test('mux：cancel 与上游错误清理头期限，同 id 新流不受旧计时影响', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  client.send({ t: 'req', id: 10, path: '/api/mobile/v1/events' });
  client.send({ t: 'cancel', id: 10 });
  client.send({ t: 'ping' });
  await client.frame((frame) => frame.t === 'pong');
  assert.equal(f.timers.pending(), 1);
  f.timers.tick(20_000);
  const pong = once(client.ws, 'message');
  client.send({ t: 'req', id: 10, path: '/api/mobile/v1/events' });
  client.send({ t: 'ping' });
  await pong;
  f.timers.tick(10_000);
  assert.equal(f.requests[1].destroyed, false, '旧流的 30 秒不能销毁新流');
  f.requests[1].emit('error', new Error('upstream gone'));
  await client.frame((frame) => frame.t === 'err' && frame.id === 10);
  assert.equal(f.timers.pending(), 1, '上游错误后只留下心跳');
});

for (const revokeAt of [29_000, 44_000]) {
  test(`mux：撤销在 ${revokeAt}ms 仍保留完整 5 秒回执窗口`, { timeout: 10_000 }, async (t) => {
    let response;
    const f = await fixture(t, (_req, res) => {
      response = res;
      if (revokeAt > 30_000) { res.writeHead(200); res.flushHeaders(); }
    });
    const client = await f.connect();
    client.send({ t: 'req', id: 11, path: '/api/mobile/v1/revoke' });
    client.send({ t: 'bodyEnd', id: 11 });
    await f.arrival();
    if (revokeAt > 30_000) await client.frame((frame) => frame.t === 'resp');
    f.timers.tick(revokeAt);
    const drained = once(client.ws, 'close');
    assert.equal(f.svc.dropDevice('phone', 'instance', response), 1);
    f.timers.tick(4_999);
    assert.equal(client.serverWs.readyState, WebSocket.OPEN, '头期限和心跳均不得提前截断撤销回执');
    f.timers.tick(1);
    await drained;
    await response.__dshMuxDrained;
    assert.equal(f.timers.pending(), 0);
  });
}

test('变异：删除半开期限或头期限，原定时断言必须失败', { timeout: 10_000 }, async (t) => {
  const halfOpen = await fixture(t, undefined, (source) => {
    const marker = 'performance.now() - lastPong >= PONG_TIMEOUT_MS';
    assert.ok(source.includes(marker));
    return source.replace(marker, 'false');
  });
  const stale = await halfOpen.connect();
  assert.throws(() => assertHalfOpenReclaimed(halfOpen, stale), { code: 'ERR_ASSERTION' });
  const header = await fixture(t, () => {}, (source) => {
    const marker = '}, UPSTREAM_HEADER_TIMEOUT_MS);';
    assert.ok(source.includes(marker));
    return source.replace(marker, '}, UPSTREAM_HEADER_TIMEOUT_MS + 1);');
  });
  const client = await header.connect();
  client.send({ t: 'req', id: 12, path: '/api/mobile/v1/events' });
  client.send({ t: 'ping' });
  await client.frame((frame) => frame.t === 'pong');
  assert.throws(() => assertHeaderDeadline(header), { code: 'ERR_ASSERTION' });
});

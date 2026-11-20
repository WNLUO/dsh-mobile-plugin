// 验证 LAN/IPv6 代理透传手机协议心跳，半开 mux 与上游流一起回收。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

const MUX = require.resolve('../lib/mobile/mux.js');
const LAN = require.resolve('../lib/relay/lan-proxy.js');

function clock() {
  let now = 0;
  const tasks = new Map();
  const add = (fn, delay, every = 0) => {
    const timer = { fn, at: now + delay, every, unref() {} };
    tasks.set(timer, timer);
    return timer;
  };
  return {
    performance: { now: () => now },
    setTimeout: (fn, delay) => add(fn, delay), clearTimeout: (timer) => tasks.delete(timer),
    setInterval: (fn, delay) => add(fn, delay, delay), clearInterval: (timer) => tasks.delete(timer),
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

function load(file, context, overrides = {}, mutate = (source) => source) {
  const anchored = createRequire(file);
  const loaded = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), {
    module: loaded, exports: loaded.exports, Buffer, URL, process,
    setTimeout, clearTimeout, setInterval, clearInterval, ...context,
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : anchored(name),
  });
  return loaded.exports;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fixture(t, host = '127.0.0.1', mutate = (source) => source) {
  const timers = clock();
  const phones = [];
  const muxSockets = new Map();
  const proxyPhones = new Map();
  const proxyUpstreams = new Map();
  const responses = new Map();
  const tcpSockets = new Set();
  const records = new Map();
  let nextId = 0;
  const captureServer = (map) => class extends WebSocketServer {
    handleUpgrade(req, socket, head, done) {
      super.handleUpgrade(req, socket, head, (ws) => { map.set(req.headers['x-fixture-id'], ws); done(ws); });
    }
  };
  class ProxySocket extends WebSocket {
    constructor(url, options) { super(url, options); proxyUpstreams.set(options.headers['x-fixture-id'], this); }
  }
  const { createMuxService, MAX_CONNECTIONS } = load(MUX, timers, {
    ws: { WebSocketServer: captureServer(muxSockets) },
    'node:perf_hooks': { performance: timers.performance },
  });
  const upstream = http.createServer((req, res) => {
    responses.set(req.headers['x-fixture-id'], res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const upstreamPort = await listen(upstream);
  const svc = createMuxService({
    upstream: { host: '127.0.0.1', port: upstreamPort },
    authorize(req) {
      const record = records.get(req.headers['x-dsh-device-credential']);
      if (!record) return false;
      req.__dshRecord = record;
      return true;
    },
  });
  const muxServer = http.createServer();
  muxServer.on('upgrade', (req, socket, head) => svc.handleUpgrade(req, socket, head));
  const muxPort = await listen(muxServer);
  for (const server of [upstream, muxServer]) server.on('connection', (socket) => {
    tcpSockets.add(socket); socket.once('close', () => tcpSockets.delete(socket));
  });
  const { createLanProxy } = load(LAN, {}, {
    ws: { WebSocket: ProxySocket, WebSocketServer: captureServer(proxyPhones) },
    '../shared/credentials-entry.js': { credentialsEntry: () => ({
      lookup: (value, instanceId) => instanceId === 'instance' ? records.get(value) || null : null,
      renew() {},
    }) },
  }, mutate);
  const proxy = createLanProxy({
    lanPort: 0, ipv4Enabled: host !== '::1', instanceId: 'instance',
    lanSecret: 'a'.repeat(64), upstreamPort: muxPort,
  });
  t.after(async () => {
    for (const phone of phones) phone.terminate();
    for (const ws of proxyUpstreams.values()) ws.terminate();
    for (const ws of muxSockets.values()) ws.terminate();
    await proxy.stop();
    for (const socket of tcpSockets) socket.destroy();
    await Promise.all([new Promise((resolve) => muxServer.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  });
  try { await proxy.start(); } catch (error) {
    if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('本机没有 IPv6 环回'); return null; }
    throw error;
  }
  const targetHost = host.includes(':') ? `[${host}]` : host;
  const url = `ws://${targetHost}:${proxy.port()}/api/mobile/v1/mux`;
  async function connect(deviceId = 'lost') {
    const id = String(++nextId);
    const credential = `fixture-${id}`;
    records.set(credential, { deviceId, instanceId: 'instance', credential });
    const phone = new WebSocket(url, { autoPong: false, headers: { 'x-fixture-id': id, 'x-dsh-device-credential': credential } });
    phones.push(phone);
    const frames = [];
    const waiters = [];
    phone.on('error', () => {});
    phone.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()); frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].matches(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
      }
    });
    await once(phone, 'open');
    return {
      id, credential, phone, frames, mux: muxSockets.get(id), inner: proxyUpstreams.get(id), outer: proxyPhones.get(id),
      send: (frame) => phone.send(JSON.stringify(frame)),
      frame(matches) {
        const found = frames.find(matches);
        return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ matches, resolve }));
      },
      async stream() {
        this.send({ t: 'req', id: 1, path: '/api/mobile/v1/events', headers: { 'x-fixture-id': id } });
        this.send({ t: 'bodyEnd', id: 1 });
        await this.frame((frame) => frame.t === 'resp');
        return responses.get(id);
      },
    };
  }
  return { timers, svc, proxy, url, connect, MAX_CONNECTIONS };
}

function assertReclaimed(client) {
  assert.notEqual(client.mux.readyState, WebSocket.OPEN, '手机不回 pong 必须回收');
}

async function beat(f, clients, reply = clients) {
  const pings = clients.map((client) => once(client.phone, 'ping'));
  f.timers.tick(15_000);
  await Promise.all(pings);
  const pongs = reply.map((client) => once(client.mux, 'pong'));
  for (const client of reply) client.phone.pong();
  await Promise.all(pongs);
}

for (const host of ['127.0.0.1', '::1']) {
  test(`mux经${host}代理：手机半开回收WS/SSE并归还容量，正常设备保持连接`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, host);
    if (!f) return;
    const lost = await Promise.all(Array.from({ length: f.MAX_CONNECTIONS - 1 }, () => f.connect()));
    const healthy = await f.connect('healthy');
    const lostResponse = await lost[0].stream();
    const healthyResponse = await healthy.stream();
    let localPongs = 0;
    lost[0].mux.on('pong', () => { localPongs += 1; });
    await beat(f, [...lost, healthy], [healthy]);
    await beat(f, [...lost, healthy], [healthy]);
    assert.equal(localPongs, 0, '本机代理不能替不回应的手机自动 pong');
    const lostClosed = lost.flatMap((client) => [once(client.phone, 'close'), once(client.mux, 'close'), once(client.inner, 'close')]);
    const responseClosed = once(lostResponse, 'close');
    const healthyPing = once(healthy.phone, 'ping');
    f.timers.tick(15_000);
    for (const client of lost) assertReclaimed(client);
    await Promise.all([...lostClosed, responseClosed, healthyPing]);
    const healthyPong = once(healthy.mux, 'pong'); healthy.phone.pong(); await healthyPong;
    assert.equal(lostResponse.destroyed, true);
    assert.equal(healthyResponse.destroyed, false, '同一代理下其他设备的 SSE 不应被误收');
    assert.equal(healthy.phone.readyState, WebSocket.OPEN);
    assert.equal(lost[0].frames.some((frame) => frame.t === 'err'), false);
    assert.equal(f.timers.pending(), 1, '半开连接及其请求计时必须全部清掉');
    for (const client of lost) {
      assert.equal(client.inner.listenerCount('ping'), 0);
      assert.equal(client.outer.listenerCount('pong'), 0);
    }
    lost[0].inner.emit('close', 1006); lost[0].inner.emit('error', new Error('late'));
    const recovered = await Promise.all(Array.from({ length: f.MAX_CONNECTIONS - 1 }, () => f.connect()));
    assert.equal(recovered.length + 1, f.MAX_CONNECTIONS, '半开槽位须全部归还');
    const extra = new WebSocket(f.url, { headers: { 'x-dsh-device-credential': healthy.credential } });
    extra.on('error', () => {});
    const [, refused] = await once(extra, 'unexpected-response');
    assert.equal(refused.statusCode, 503, '重复清理不得把可用容量放大');
    refused.resume(); extra.terminate();
  });
}

test('LAN mux：真实手机 pong 可持续保活，正常关闭清理协议监听', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.connect('healthy');
  const response = await client.stream();
  for (let i = 0; i < 5; i += 1) await beat(f, [client]);
  assert.equal(client.phone.readyState, WebSocket.OPEN);
  const closed = Promise.all([once(client.phone, 'close'), once(client.mux, 'close'), once(response, 'close')]);
  client.phone.close();
  await closed;
  assert.equal(client.inner.listenerCount('ping'), 0);
  assert.equal(client.outer.listenerCount('pong'), 0);
  assert.equal(f.timers.pending(), 0);
});

test('LAN mux：吊销回执在心跳期限前进入5秒窗口，代理不提前关断', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const response = await client.stream();
  f.timers.tick(44_000);
  assert.equal(f.svc.dropDevice('lost', 'instance', response), 1);
  f.timers.tick(4_999);
  assert.equal(client.phone.readyState, WebSocket.OPEN);
  response.end('revoked');
  await client.frame((frame) => frame.t === 'end');
  await response.__dshMuxDrained;
  assert.equal(client.frames.filter((frame) => frame.t === 'chunk').map((frame) => frame.text).join(''), 'revoked');
});

test('变异：恢复本机自动pong会掩盖手机失联，同一回收断言必须失败', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, '127.0.0.1', (source) => {
    const marker = '...(mux ? { autoPong: false } : {}),';
    assert.ok(source.includes(marker));
    return source.replace(marker, '');
  });
  const client = await f.connect();
  for (let i = 0; i < 3; i += 1) {
    const localPong = once(client.mux, 'pong');
    await beat(f, [client], []);
    await localPong;
  }
  assert.throws(() => assertReclaimed(client), { code: 'ERR_ASSERTION' });
});

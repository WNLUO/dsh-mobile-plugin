// 验证总控握手、协议心跳、退避代次与停止清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter, once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');

const FILE = require.resolve('../lib/relay/control.js');
const HK = Buffer.alloc(32, 7).toString('base64url');

function clock() {
  let now = 0;
  const tasks = new Map();
  const add = (fn, delay, every = 0) => {
    const timer = { fn, at: now + delay, delay, every, unref() {} };
    tasks.set(timer, timer);
    return timer;
  };
  return {
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now },
    setTimeout: (fn, delay) => add(fn, delay), clearTimeout: (timer) => tasks.delete(timer),
    setInterval: (fn, delay) => add(fn, delay, delay), clearInterval: (timer) => tasks.delete(timer),
    pending: () => [...tasks.values()],
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

function fixture(t, { Socket, url = 'https://control.example/findme/', mutate = (source) => source } = {}) {
  const timers = clock();
  const sockets = [];
  const logs = [];
  class FakeSocket extends EventEmitter {
    constructor(target) {
      super(); this.url = target; this.readyState = 0; this.sent = []; this.pings = 0; this.terminated = 0;
      sockets.push(this);
    }
    addEventListener(name, listener) { this.on(name, listener); }
    send(text) { this.sent.push(JSON.parse(text)); }
    ping() { this.pings += 1; }
    terminate() { this.terminated += 1; this.readyState = 3; this.emit('close'); }
    open() { this.readyState = 1; this.emit('open'); }
    message(data) { this.emit('message', { data: JSON.stringify(data) }); }
  }
  const anchored = createRequire(FILE);
  const loaded = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(FILE, 'utf8')), {
    module: loaded, exports: loaded.exports, Buffer, ...timers,
    process: { env: { DSH_CONTROL_URL: url } },
    require: (name) => name === 'ws' ? Socket || FakeSocket : name === 'node:perf_hooks' ? { performance: timers.performance } : anchored(name),
  });
  const state = { enabled: true, instanceId: 'liveness', controlToken: 'private-control-token' };
  let addresses = [{ kind: 'relay', url: 'https://actual.example' }];
  let relay = 'https://actual.example';
  const client = loaded.exports.createControlClient({
    state, getHistoryKey: () => HK, getAddresses: () => addresses,
    getRelayConnected: () => Boolean(relay), getConnectedRelay: () => relay,
    log: (...args) => logs.push(args),
  });
  t.after(() => client.stop());
  return {
    timers, sockets, logs, client, state,
    setAddresses(value) { addresses = value; }, setRelay(value) { relay = value; },
    open() { const ws = sockets.at(-1); ws.open(); return ws; },
    plain: (frame) => openHistoryBlob(HK, 'control', 'liveness', frame.payload),
  };
}

function assertHandshakeDeadline(f) {
  const ws = f.sockets[0];
  f.timers.tick(9_999);
  assert.equal(ws.terminated, 0);
  f.timers.tick(1);
  assert.equal(ws.terminated, 1, '10 秒未 open 必须主动回收并进入退避');
}

function assertHalfOpenDeadline(f, ws) {
  f.timers.tick(45_000);
  assert.equal(ws.terminated, 1, '45 秒没有协议 pong 必须回收');
  assert.equal(f.client.snapshot().connected, false);
}

test('总控：握手超时逐次退避，重复 start/sync 与旧 socket 事件不抢拨', (t) => {
  const f = fixture(t);
  f.client.start();
  const first = f.sockets[0];
  const initialToken = f.state.controlToken;
  assertHandshakeDeadline(f);
  first.open(); first.message({ type: 'registered', token: 'late-token' }); first.emit('close');
  f.client.start(); f.client.sync();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.client.snapshot().connected, false);
  assert.equal(f.state.controlToken, initialToken, '旧代 token 回执不能污染当前状态');
  f.timers.tick(999); assert.equal(f.sockets.length, 1);
  f.timers.tick(1); assert.equal(f.sockets.length, 2);
  f.timers.tick(10_000);
  assert.equal(f.sockets[1].terminated, 1);
  f.timers.tick(1_999); assert.equal(f.sockets.length, 2);
  f.timers.tick(1); assert.equal(f.sockets.length, 3, '第二次失败必须退避 2 秒');
});

test('总控：open 取消握手期限，协议 pong 维持空闲连接，失联后半开回收', (t) => {
  const f = fixture(t);
  f.client.start();
  const staleHandshake = f.timers.pending().find((timer) => timer.delay === 10_000);
  const ws = f.open();
  staleHandshake.fn();
  assert.equal(ws.terminated, 0, '已取消的握手回调不得关闭 open 连接');
  for (let i = 0; i < 5; i += 1) {
    f.timers.tick(15_000);
    assert.equal(ws.terminated, 0);
    ws.emit('pong');
  }
  assert.equal(ws.pings, 5);
  assert.deepEqual(ws.sent.map((frame) => frame.type), ['register'], '心跳只能使用 WS 协议帧');
  assertHalfOpenDeadline(f, ws);
  f.timers.tick(999); assert.equal(f.sockets.length, 1);
  f.timers.tick(1); assert.equal(f.sockets.length, 2);
  ws.emit('pong'); ws.emit('error', new Error('late')); ws.emit('close');
  assert.equal(f.sockets[1].terminated, 0, '旧代事件不得关闭新一代');
});

test('总控：只有 registered 才清零退避，error/close 幂等且日志不泄露令牌', (t) => {
  const f = fixture(t);
  f.client.start();
  let ws = f.open();
  ws.message({ type: 'error', message: `unauthorized ${f.state.controlToken}` });
  ws.emit('error', new Error(`failed ${f.state.controlToken}`)); ws.emit('close');
  f.timers.tick(1_000);
  ws = f.open();
  ws.message({ type: 'error', message: 'unauthorized' });
  f.timers.tick(1_999); assert.equal(f.sockets.length, 2, 'open 不能重置退避');
  f.timers.tick(1); ws = f.open();
  ws.message({ type: 'registered' });
  ws.emit('error', new Error('offline')); ws.emit('close');
  f.timers.tick(999); assert.equal(f.sockets.length, 3);
  f.timers.tick(1); assert.equal(f.sockets.length, 4, '注册成功后回到首次 1 秒退避');
  assert.equal(JSON.stringify(f.logs).includes(f.state.controlToken), false);
});

test('总控：stop 清理拨号、心跳、上报及重拨；旧回调不能干扰重启', (t) => {
  const f = fixture(t);
  f.client.start();
  const first = f.sockets[0];
  const staleHandshake = f.timers.pending().find((timer) => timer.delay === 10_000);
  f.client.stop(); f.client.stop();
  assert.equal(first.terminated, 1);
  assert.equal(f.timers.pending().length, 0);
  staleHandshake.fn(); first.open(); first.message({ type: 'registered' });
  f.timers.tick(120_000);
  assert.equal(f.sockets.length, 1);
  f.client.start();
  const ws = f.open();
  const staleHeartbeat = f.timers.pending().find((timer) => timer.delay === 15_000);
  ws.emit('close');
  const staleReconnect = f.timers.pending().find((timer) => timer.delay === 1_000);
  f.client.stop(); f.client.start();
  const current = f.open();
  staleHeartbeat.fn(); staleReconnect.fn(); ws.emit('error', new Error('old'));
  assert.equal(current.terminated, 0);
  assert.equal(f.sockets.length, 3);
  f.client.stop();
  assert.equal(f.timers.pending().length, 0);
});

test('总控：open 重读真实地址，非空变空清 meta，目的地 getter 只读且无令牌', (t) => {
  const f = fixture(t);
  f.client.start();
  f.setAddresses([{ kind: 'relay', url: 'https://new-route.example' }]);
  f.setRelay('https://new-route.example');
  const ws = f.open();
  assert.equal(f.plain(ws.sent[0]).addresses[0].url, 'https://new-route.example');
  assert.equal(f.plain(ws.sent[0]).meta.connectedRelay, 'https://new-route.example');
  f.setAddresses([]); f.setRelay(''); f.client.sync();
  const cleared = f.plain(ws.sent[1]);
  assert.deepEqual(cleared.addresses, []);
  assert.equal(cleared.meta.connectedRelay, '');
  assert.equal(cleared.meta.relayConnected, false);
  assert.equal(f.client.targetUrl, 'https://control.example/findme');
  assert.equal(f.client.snapshot().url, f.client.targetUrl);
  assert.equal(f.client.targetUrl.includes(f.state.controlToken), false);
  assert.equal(Object.getOwnPropertyDescriptor(f.client, 'targetUrl').set, undefined);
  assert.throws(() => { f.client.targetUrl = 'https://other.example'; }, TypeError);
  assert.ok(ws.url.includes(`token=${f.state.controlToken}`), '敏感令牌只用于既有握手认证');
});

test('总控：真实 WS 协议 pong 保活，停止回应后按心跳期限重拨', { timeout: 10_000 }, async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
  await once(server, 'listening');
  const accepted = [];
  const messages = [];
  const dialed = [];
  let answerPings = true;
  class CapturedSocket extends WebSocket {
    constructor(...args) { super(...args); dialed.push(this); }
  }
  server.on('connection', (ws) => {
    accepted.push(ws);
    ws.on('ping', (data) => { if (answerPings) ws.pong(data); });
    ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); });
  });
  const f = fixture(t, { Socket: CapturedSocket, url: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => {
    f.client.stop();
    for (const ws of accepted) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const connection = once(server, 'connection');
  f.client.start();
  await Promise.all([once(dialed[0], 'open'), connection]);
  for (let i = 0; i < 4; i += 1) {
    const pong = once(dialed[0], 'pong');
    f.timers.tick(15_000);
    await pong;
  }
  assert.equal(f.client.snapshot().connected, true);
  answerPings = false;
  const closed = once(dialed[0], 'close');
  f.timers.tick(45_000);
  await closed;
  assert.equal(f.client.snapshot().connected, false);
  assert.equal(messages.some((frame) => frame.type === 'ping'), false);
  const reconnected = once(server, 'connection');
  f.timers.tick(1_000);
  await Promise.all([once(dialed[1], 'open'), reconnected]);
  assert.equal(f.client.snapshot().connected, true);
});

test('变异：移除握手或半开回收时，同一条期限断言必须失败', (t) => {
  const handshake = fixture(t, { mutate(source) {
    const marker = '}, HANDSHAKE_TIMEOUT_MS);'; assert.ok(source.includes(marker));
    return source.replace(marker, '}, HANDSHAKE_TIMEOUT_MS + 1);');
  } });
  handshake.client.start();
  assert.throws(() => assertHandshakeDeadline(handshake), { code: 'ERR_ASSERTION' });
  const heartbeat = fixture(t, { mutate(source) {
    const marker = 'performance.now() - lastPong >= PONG_TIMEOUT_MS'; assert.ok(source.includes(marker));
    return source.replace(marker, 'false');
  } });
  heartbeat.client.start();
  const ws = heartbeat.open();
  assert.throws(() => assertHalfOpenDeadline(heartbeat, ws), { code: 'ERR_ASSERTION' });
});

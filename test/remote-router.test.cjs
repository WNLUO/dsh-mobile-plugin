// 自动线路使用真实身份探测，独立记账且冷隧道不阻塞业务。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createRemoteRouter } = require('../lib/remote/router.cjs');
const { createNetworkMonitor, interfacesOf } = require('../lib/remote/network.cjs');
const { safeRoutes } = require('../lib/remote/local-headers.cjs');

const routes = [
  { url: 'http://lan.invalid', channel: 'lan' },
  { url: 'https://relay.invalid', channel: 'relay' },
  { url: 'http://[::1]:5000', channel: 'ipv6' },
];
const result = () => ({ stream: new PassThrough(), host: { port: 5000, token: 'secret' } });
const error = (code = 'REMOTE_CONNECT') => Object.assign(new Error(code), { code });

test('候选拒绝带userinfo/query/hash的线路，不将秘密地址变形成另一条路', () => {
  assert.deepEqual(safeRoutes([
    ...routes, { url: 'https://user:password@host', channel: 'relay' }, { url: 'https://host/?ticket=secret', channel: 'relay' },
    { url: 'https://host/#secret', channel: 'relay' }, { url: 'ws://host', channel: 'relay' },
  ]), routes);
});

test('当前可用路优先，后台慢隧道不阻塞首次或并发静态资源', async () => {
  let finish;
  let reads = 0;
  let dials = 0;
  const tunnels = { routesFor: () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); } };
  const router = createRemoteRouter({ binding: { routes }, tunnels, transport: {
    async openRemoteStream() { dials += 1; return result(); }, async probeRemote() { return 20; },
  } });
  const connections = await Promise.all([router.open(), router.open(), router.open()]);
  assert.equal(dials, 3); assert.equal(reads, 1);
  finish([]); for (const connection of connections) connection.stream.destroy(); router.close();
});

test('实测排序和滞回逐设备隔离，每轮最多当前加3个轮转挑战者、并发2', async () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ url: `https://route${index}.invalid`, channel: 'relay' }));
  const measured = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport = {
    async probeRemote(binding, route) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(setImmediate); inFlight -= 1;
      measured.push(route.url);
      return binding.id === 'a' ? 200 - many.findIndex((value) => value.url === route.url) * 10 : 10;
    },
    async openRemoteStream() { return result(); },
  };
  const a = createRemoteRouter({ binding: { id: 'a', routes: many }, transport });
  const b = createRemoteRouter({ binding: { id: 'b', routes: many }, transport });
  await a.probe();
  assert.equal(measured.length, 3);
  const first = [...measured];
  measured.length = 0;
  await a.probe();
  assert.ok(measured.length <= 4);
  assert.ok(measured.some((value) => !first.includes(value)));
  assert.ok(maxInFlight <= 2);
  assert.equal(b.snapshot().latencyMs, null);
  await b.probe();
  assert.equal(b.snapshot().latencyMs, 10);
  a.close(); b.close();
});

test('错误身份线路被排除，换网取消旧探测并清事实，当前租期不被修改', async () => {
  let staleResolve;
  let hanging = true;
  const dials = [];
  let refreshes = 0;
  let aborted = false;
  const router = createRemoteRouter({ binding: { routes }, tunnels: { routesFor: async () => [], refresh: async () => { refreshes += 1; return []; } }, transport: {
    async probeRemote(_binding, route, { signal }) {
      if (hanging) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return new Promise((resolve) => { staleResolve = resolve; });
      }
      if (route.channel === 'lan') throw error('REMOTE_AUTH');
      return route.channel === 'relay' ? 20 : 80;
    },
    async openRemoteStream(_binding, route, options) { dials.push({ route, options }); return result(); },
  } });
  const old = router.probe();
  await new Promise(setImmediate);
  hanging = false;
  await router.networkChanged();
  assert.equal(aborted, true); assert.equal(refreshes, 1);
  await old;
  staleResolve(1);
  const lease = Date.now() + 5000;
  const stream = await router.open({ expiresAt: lease });
  assert.equal(dials[0].route.channel, 'relay');
  assert.equal(dials[0].options.expiresAt, lease);
  stream.stream.destroy(); router.close();
});

test('首线路握手失败可换路，交付stream后不重投业务字节，晚到结果回收', async () => {
  const calls = [];
  const router = createRemoteRouter({ binding: { routes }, transport: {
    async probeRemote() { return 5; },
    async openRemoteStream(_binding, route) { calls.push(route); if (calls.length === 1) throw error(); return result(); },
  } });
  const connected = await router.open();
  assert.equal(calls.length, 2);
  router.failure(error());
  assert.equal(calls.length, 2);
  connected.stream.destroy(); router.close();
  let resolve;
  const late = result();
  const closing = createRemoteRouter({ binding: { routes: routes.slice(0, 1) }, transport: {
    openRemoteStream: () => new Promise((done) => { resolve = done; }), probeRemote: async () => 5,
  } });
  const pending = closing.open().catch((value) => value);
  await new Promise(setImmediate); closing.close();
  assert.equal((await pending).code, 'REMOTE_CONNECT');
  resolve(late); await new Promise(setImmediate);
  assert.equal(late.stream.destroyed, true);
});

test('网卡集合变更先清线路事实，唤醒和租期检查不等待慢心跳', async () => {
  let clock = 1000;
  let entries = { en0: [{ family: 'IPv4', address: '192.168.1.2', netmask: '255.255.255.0', internal: false }] };
  const events = [];
  const monitor = createNetworkMonitor({ now: () => clock, interfaces: () => entries,
    onChange: ({ reason }) => { events.push(reason); return new Promise(() => {}); },
    onTick: () => { events.push('deadline'); },
  });
  entries = { en0: [{ family: 'IPv4', address: '192.168.2.2', netmask: '255.255.255.0', internal: false }] };
  await monitor.poll();
  assert.deepEqual(events, ['network', 'deadline']);
  clock += 60000;
  await monitor.poll();
  assert.deepEqual(events, ['network', 'deadline', 'wake', 'deadline']);
  assert.deepEqual(interfacesOf(() => ({ ...entries, lo0: [{ internal: true }] })), interfacesOf(() => entries));
  monitor.close();
});

test('强制局域网不预热或刷新公网隧道，回自动档恢复候选发现', async () => {
  let warmed = 0;
  let refreshed = 0;
  const used = [];
  const router = createRemoteRouter({ binding: { routes, mode: 'lan' }, tunnels: {
    async routesFor() { warmed += 1; return []; },
    async refresh() { refreshed += 1; return []; },
  }, transport: {
    async openRemoteStream(_binding, route) { used.push(route.channel); return result(); },
    async probeRemote(_binding, route) { used.push(route.channel); return 5; },
  } });
  await router.refresh(); await router.probe(); await router.networkChanged();
  const connected = await router.open(); connected.stream.destroy();
  assert.equal(warmed, 0); assert.equal(refreshed, 0);
  assert.ok(used.every((channel) => channel === 'lan'));
  router.setMode('auto'); await router.refresh();
  assert.equal(warmed, 1); router.close();
});

test('认证后的最新地址持久回调，拒绝秘密线路且无新地址保留旧线路', async () => {
  const fresh = [{ url: 'http://192.168.2.2:5000', channel: 'lan' }, routes[1]];
  const saved = [];
  const binding = { routes };
  const router = createRemoteRouter({ binding, onRoutes: async (value) => saved.push(value), transport: {
    async probeRemote(_binding, _route, options) { await options.onConnectionInfo({ routes: fresh }); return 10; },
    async openRemoteStream() { return result(); },
  } });
  await router.probe();
  assert.deepEqual(saved[0], fresh);
  assert.deepEqual(binding.routes, fresh);
  assert.deepEqual(router.snapshot().routes, fresh);
  const connected = await router.open();
  assert.deepEqual(router.snapshot().routes, fresh);
  connected.stream.destroy(); router.close();
});

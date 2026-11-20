// 自动线路按scope区分探测身份与真实业务，常态拨钟且保留隧道失效清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createRemoteRouter } = require('../lib/remote/router.cjs');
const { createNetworkMonitor, interfacesOf } = require('../lib/remote/network.cjs');
const { safeRoutes } = require('../lib/remote/local-headers.cjs');

function tracedRouter(binding, transport) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const file = require.resolve('../lib/remote/router.cjs');
  const requireReal = createRequire(file);
  const { createRoutePolicy } = requireReal('../shared/route-order.cjs');
  const trace = [];
  let policy;
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: loaded, exports: loaded.exports, AbortController, URL, setTimeout, clearTimeout,
    require: name => name === '../shared/route-order.cjs' ? {
      createRoutePolicy() {
        policy = createRoutePolicy();
        return new Proxy(policy, { get(target, name) {
          if (typeof target[name] !== 'function') return target[name];
          return (...args) => { trace.push({ name, args }); return target[name](...args); };
        } });
      },
    } : requireReal(name),
  });
  return { router: loaded.exports.createRemoteRouter({ binding, transport }), trace, policy: () => policy };
}

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

// T01不再把模糊REMOTE_AUTH当作外来实例；失败仍参与退避，身份只由已认证的应答解除排除。
test('认证失败线路退避，换网取消旧探测并清事实，当前租期不被修改', async () => {
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

test('逐线路诊断：并发探活所有安全候选，单条失败隔离且不改已选线路与状态', async () => {
  const candidates = [
    { url: 'http://lan.invalid', channel: 'lan' },
    { url: 'https://relay.invalid', channel: 'relay' },
    { url: 'http://[::1]:5000', channel: 'ipv6' },
  ];
  let inFlight = 0;
  let maxInFlight = 0;
  const router = createRemoteRouter({ binding: { routes: candidates, mode: 'lan' }, transport: {
    async probeRemote(_binding, route) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(setImmediate); inFlight -= 1;
      if (route.channel === 'lan') throw Object.assign(new Error('denied'), { code: 'REMOTE_AUTH' });
      return route.channel === 'relay' ? 20 : 80;
    },
    async openRemoteStream() { return result(); },
  } });
  const before = router.snapshot();
  const rows = await router.diagnose();
  const byChannel = Object.fromEntries(rows.map((row) => [row.channel, row]));
  assert.deepEqual(byChannel.lan, { channel: 'lan', url: 'http://lan.invalid', ok: false, latencyMs: null, errorCode: 'REMOTE_AUTH' });
  assert.equal(byChannel.relay.ok, true); assert.equal(byChannel.relay.latencyMs, 20); assert.equal(byChannel.relay.errorCode, null);
  assert.equal(byChannel.ipv6.ok, true); assert.equal(byChannel.ipv6.latencyMs, 80);
  assert.equal(maxInFlight, 3, '三条候选应并发探测');
  assert.deepEqual(router.snapshot(), before, '诊断不能改动已选线路或线路状态');
  router.close();
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

test('真实消费者每个常态轮只advance一次，诊断和业务不拨钟，所有调用显式传同scope', async () => {
  for (const binding of [
    { instanceId: 'expected-instance', id: 'binding-id', routes: routes.slice(0, 1) },
    { id: 'binding-id', routes: routes.slice(0, 1) },
    { routes: routes.slice(0, 1) },
  ]) {
    const h = tracedRouter(binding, { probeRemote: async () => 20, openRemoteStream: async () => result() });
    const scope = binding.instanceId || binding.id || '';
    await Promise.all([h.router.probe(), h.router.probe()]);
    const rounds = () => h.trace.filter(row => row.name === 'advanceRouteEvidenceRound');
    assert.equal(rounds().length, 1, '合并的同轮probe只推进一次');
    assert.deepEqual(rounds()[0].args, [1, 1, scope]);
    await h.router.diagnose(); await h.router.diagnose();
    const connected = await h.router.open();
    assert.equal(rounds().length, 1, '诊断密采与真实open不拨轮次');
    assert.equal(h.trace.filter(row => row.name === 'noteRouteProven').length, 1);
    await h.router.probe();
    assert.equal(rounds().length, 2);
    for (const { name, args } of h.trace) {
      const scopeAt = name === 'noteRouteLatency' || name === 'orderRouteCandidates' ? 3
        : name === 'advanceRouteEvidenceRound' ? 2 : name === 'forgetRouteFacts' ? 0 : 1;
      assert.equal(args[scopeAt], scope, `${name}必须显式传设备scope`);
    }
    connected.stream.destroy(); h.router.close();
  }
});

test('认证probe只Verified不清业务失败，真实open成功才Proven清账', async () => {
  const scope = 'expected-instance';
  const h = tracedRouter({ instanceId: scope, routes: routes.slice(0, 1) }, {
    probeRemote: async () => 100, openRemoteStream: async () => result(),
  });
  await h.router.probe();
  assert.equal(h.trace.filter(row => row.name === 'noteRouteVerified').length, 1);
  assert.equal(h.trace.filter(row => row.name === 'noteRouteProven').length, 0, '认证探测不冒充真实业务成功');
  h.router.failure(error());
  assert.equal(h.policy().routeCostOf(routes[0].url, scope), 150);
  await h.router.probe();
  assert.equal(h.policy().routeCostOf(routes[0].url, scope), 150, '健康重采不能洗掉真实失败');
  const connected = await h.router.open();
  assert.equal(h.policy().routeCostOf(routes[0].url, scope), 100);
  assert.equal(h.trace.filter(row => row.name === 'noteRouteProven').length, 1);
  connected.stream.destroy(); h.router.close();
});

test('模糊REMOTE_AUTH不永久标foreign，后续同地址通过绑定身份仍可恢复', async () => {
  let rejected = true;
  const h = tracedRouter({ instanceId: 'instance', routes: routes.slice(0, 1) }, {
    async probeRemote() { if (rejected) throw error('REMOTE_AUTH'); return 30; },
    openRemoteStream: async () => result(),
  });
  await assert.rejects(h.router.probe(), value => value.code === 'REMOTE_AUTH');
  assert.equal(h.trace.filter(row => row.name === 'noteRouteForeign').length, 0);
  rejected = false;
  await h.router.probe();
  assert.equal(h.router.snapshot().latencyMs, 30);
  assert.equal(h.trace.filter(row => row.name === 'noteRouteVerified').length, 1);
  h.router.close();
});

test('首连赛跑的认证探测不记Proven，迟到旧代结果不写新代账', async () => {
  const pending = [];
  const h = tracedRouter({ instanceId: 'instance', routes: routes.slice(0, 2) }, {
    probeRemote: async (_binding, route) => new Promise(resolve => pending.push({ route, resolve })),
    openRemoteStream: async () => result(),
  });
  const opening = h.router.open();
  await new Promise(setImmediate);
  pending[0].resolve(20);
  const connected = await opening;
  assert.equal(h.trace.filter(row => row.name === 'noteRouteVerified').length, 1);
  assert.equal(h.trace.filter(row => row.name === 'noteRouteProven').length, 1, '唯一真实open才算业务成功');
  h.router.close();
  const writes = h.trace.filter(row => ['noteRouteLatency', 'noteRouteVerified', 'noteRouteProven', 'noteRouteFailure'].includes(row.name)).length;
  pending[1].resolve(1);
  await new Promise(setImmediate);
  assert.equal(h.trace.filter(row => ['noteRouteLatency', 'noteRouteVerified', 'noteRouteProven', 'noteRouteFailure'].includes(row.name)).length, writes);
  assert.equal(h.trace.filter(row => row.name === 'advanceRouteEvidenceRound').length, 0, '首连赛跑不拨常态轮次');
  connected.stream.destroy(); h.router.close();
});


test('助手失效不取消基础线路在飞请求，并撤销旧隧道候选', async () => {
  const base = { url: 'https://relay.invalid', channel: 'relay' };
  const tunnel = { url: 'http://127.0.0.1:41001', channel: 'tunnel' };
  let finish; let signal;
  const router = createRemoteRouter({ binding: { routes: [base], mode: 'relay' },
    tunnels: { routesFor: async () => [tunnel] }, transport: {
      probeRemote: async () => 5,
      openRemoteStream(_binding, _route, options) {
        signal = options.signal;
        return new Promise(resolve => { finish = () => resolve(result()); });
      },
    } });
  const pending = router.open();
  await new Promise(setImmediate);
  router.invalidateTunnels();
  assert.equal(signal.aborted, false);
  finish(); const opened = await pending;
  assert.equal(opened.route.channel, 'relay');
  opened.stream.destroy(); router.close();
});

test('助手失效取消旧隧道连接，真实代理证据不会被最后一个泛错盖掉', async () => {
  const base = { url: 'https://relay.invalid', channel: 'relay' };
  const tunnel = { url: 'http://127.0.0.1:41001', channel: 'tunnel' };
  let signal;
  const router = createRemoteRouter({ binding: { routes: [base], mode: 'tunnel' },
    tunnels: { routesFor: async () => [tunnel] }, transport: {
      probeRemote: async () => 5,
      openRemoteStream(_binding, _route, options) { signal = options.signal; return new Promise(() => {}); },
    } });
  await router.refresh();
  const opening = router.open(); await new Promise(setImmediate);
  router.invalidateTunnels();
  assert.equal(signal.aborted, true);
  await assert.rejects(opening, { code: 'REMOTE_HELPER_RESTARTING' });
  assert.ok(router.snapshot().routes.every(route => route.channel !== 'tunnel'));
  router.close();
  const failing = createRemoteRouter({ binding: { routes: [base, routes[0]] }, transport: {
    async probeRemote(_binding, route) { throw error(route.channel === 'relay' ? 'REMOTE_PROXY' : 'REMOTE_CONNECT'); },
  } });
  await assert.rejects(failing.open(), { code: 'REMOTE_PROXY' });
  failing.close();
});

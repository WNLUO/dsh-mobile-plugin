// 第一批远程电脑修复的回归断言：网卡集合两步变化只采纳一次、丢网只断连不探活、
// 换网后按通道各取一条候选（中转必进）、并发探测先成功者直接用于打开、固定挡位缺路按自动兜底、
// 多窗口最后一个退出才算关窗、壳进程异步失败按没打开处理、入口票未消费时重复签不换新。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNetworkMonitor } = require('../lib/remote/network.cjs');
const { createRemoteRouter } = require('../lib/remote/router.cjs');
const { spawnFailed, launchShell } = require('../lib/remote/shell.cjs');
const { createRemoteRoutes } = require('../lib/remote/routes.cjs');
const { createLocalGateway, OPEN_MS } = require('../lib/remote/local.cjs');

const result = () => ({ stream: new PassThrough(), host: { port: 5000, token: 'secret' } });
const error = (code = 'REMOTE_CONNECT') => Object.assign(new Error(code), { code });

function ifaces(...rows) {
  const out = {};
  for (const [name, address] of rows) {
    out[name] = [{ family: 'IPv4', address, netmask: '255.255.255.0', internal: false }];
  }
  return out;
}

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async list() { return [...rows.values()]; },
    async get(id) { return rows.get(id); },
    async put(binding) { rows.set(binding.id, structuredClone(binding)); return binding; },
    async delete(id) { rows.delete(id); },
    async update(id, fn) { const next = { ...rows.get(id), ...await fn(rows.get(id)) }; rows.set(id, next); return next; },
  };
}

/**
 * 控制器测试把网络监视、路由器工厂与本机网关换成假体：网络监视只留 onChange 供直接触发，
 * 路由器记录 networkChanged / probe 调用，网关记录 disconnect。其余依赖照真实现走。
 */
function injectControllerDeps(t) {
  const paths = {
    network: require.resolve('../lib/remote/network.cjs'),
    router: require.resolve('../lib/remote/router.cjs'),
    local: require.resolve('../lib/remote/local.cjs'),
    controller: require.resolve('../lib/remote/controller.cjs'),
  };
  const saved = {};
  for (const key of Object.keys(paths)) saved[key] = require.cache[paths[key]];
  const state = {
    network: null,
    routers: [],
    gateways: [],
    routerCalls: [],
    routerOpen: null,
    routerSnapshot: () => ({ route: null, routes: [], latencyMs: null }),
  };
  require.cache[paths.network] = { id: paths.network, filename: paths.network, loaded: true, exports: {
    createNetworkMonitor: (options) => { state.network = options; return { poll: async () => {}, close() {} }; },
  } };
  require.cache[paths.router] = { id: paths.router, filename: paths.router, loaded: true, exports: {
    createRemoteRouter: () => {
      const router = {
        open: state.routerOpen || (async () => { throw new Error('未配置 router.open'); }),
        probe: async () => { state.routerCalls.push({ router, method: 'probe' }); },
        networkChanged: async () => { state.routerCalls.push({ router, method: 'networkChanged' }); },
        snapshot: () => state.routerSnapshot(),
        refresh: async () => [],
        diagnose: async () => [],
        close() {},
        setMode() {},
        failure() {},
      };
      state.routers.push(router);
      return router;
    },
  } };
  require.cache[paths.local] = { id: paths.local, filename: paths.local, loaded: true, exports: {
    LEASE_MS: 60000,
    createLocalGateway: (options) => {
      const gateway = {
        options,
        disconnectCount: 0,
        start: async () => ({ url: 'http://127.0.0.1:1234/__dsh_remote_open?ticket=x', expiresAt: Date.now() + 60000 }),
        openLink: () => ({ url: 'http://127.0.0.1:1234/__dsh_remote_open?ticket=x', expiresAt: Date.now() + 60000 }),
        renew: async (value) => ({ expiresAt: value }),
        attached: () => true,
        disconnect() { gateway.disconnectCount += 1; },
        close() {},
        checkExpiry() {},
        expiresAt: () => Date.now() + 60000,
      };
      state.gateways.push(gateway);
      return gateway;
    },
  } };
  delete require.cache[paths.controller];
  t.after(() => {
    for (const key of Object.keys(paths)) {
      if (saved[key]) require.cache[paths[key]] = saved[key]; else delete require.cache[paths[key]];
    }
  });
  return { createRemoteController: require('../lib/remote/controller.cjs').createRemoteController, state };
}

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

async function invokeOpenShell(routes) {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST',
    url: '/api/relay/remote-computers/open-shell',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234',
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    },
  });
  req.setEncoding = () => {};
  const res = {
    status: 0, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(raw) { this.body = JSON.parse(raw); },
  };
  const work = routes.handler('/open-shell')(req, res);
  queueMicrotask(() => { req.emit('data', JSON.stringify({ id: 'A' })); req.emit('end'); });
  await work;
  return res;
}

function shellRoutes(launch, watchCalls) {
  const controller = {
    list: async () => [],
    open: async () => ({ url: 'http://127.0.0.1:4321/', expiresAt: 5000 }),
    watchWindow: () => { watchCalls.count += 1; },
  };
  const host = { mintInvite: async () => ({}), revoke() {} };
  const credentials = { listRemoteComputers: () => [], revokeDevice: () => 1 };
  return createRemoteRoutes({ controller, host, credentials, instanceId: 'A', now: () => 100, launch });
}

// ——— network.cjs ———

test('网卡集合两步变化只采纳一次：窗口内再变重置计时、合并成最终那份', async (t) => {
  let entries = ifaces(['en0', '192.168.1.2']);
  const events = [];
  const monitor = createNetworkMonitor({
    now: () => 1000,
    interfaces: () => entries,
    settleMs: 40,
    onChange: (change) => { events.push(change); },
    onTick: () => {},
  });
  t.after(() => monitor.close());
  entries = ifaces(['en0', '192.168.1.3']);
  const polling = monitor.poll();
  setTimeout(() => { entries = ifaces(['en0', '192.168.1.4']); }, 5);
  await polling;
  assert.deepEqual(events, [{ reason: 'network', lost: false }], '两步变化只产生一次采纳');
  await monitor.poll();
  assert.equal(events.length, 1, '采纳的是最终那份，再轮询不会把中间态当成新换网');
});

test('网卡集合窗口内变回原样不算换网：不采纳也不误报丢网', async (t) => {
  let entries = ifaces(['en0', '192.168.1.2']);
  const events = [];
  const monitor = createNetworkMonitor({
    now: () => 1000,
    interfaces: () => entries,
    settleMs: 40,
    onChange: (change) => { events.push(change); },
    onTick: () => {},
  });
  t.after(() => monitor.close());
  entries = ifaces(['en0', '192.168.1.3']);
  const polling = monitor.poll();
  setTimeout(() => { entries = ifaces(['en0', '192.168.1.2']); }, 5);
  await polling;
  assert.deepEqual(events, [], '变回原样一次都不采纳');
});

test('从有外网卡到全空给 lost:true', async (t) => {
  let entries = ifaces(['en0', '192.168.1.2']);
  const events = [];
  const monitor = createNetworkMonitor({
    now: () => 1000,
    interfaces: () => entries,
    settleMs: 10,
    onChange: (change) => { events.push(change); },
    onTick: () => {},
  });
  t.after(() => monitor.close());
  entries = {};
  await monitor.poll();
  assert.deepEqual(events, [{ reason: 'network', lost: true }]);
});

test('唤醒只报 reason:wake 且 loss:false，不进换网去抖', async (t) => {
  let clock = 1000;
  const entries = ifaces(['en0', '192.168.1.2']);
  const events = [];
  const monitor = createNetworkMonitor({
    now: () => clock,
    interfaces: () => entries,
    intervalMs: 100,
    settleMs: 5000,
    onChange: (change) => { events.push(change); },
    onTick: () => {},
  });
  t.after(() => monitor.close());
  clock += 100 * 3 + 1;
  const started = Date.now();
  await monitor.poll();
  assert.ok(Date.now() - started < 1000, '唤醒不被 5 秒的去抖窗口挡住');
  assert.deepEqual(events, [{ reason: 'wake', lost: false }]);
});

// ——— router.cjs ———

test('换网后没有当前线路：候选按通道各取一条，中转必进探测队列', async () => {
  const probed = [];
  const routes = [
    { url: 'http://lan1.invalid', channel: 'lan' },
    { url: 'http://lan2.invalid', channel: 'lan' },
    { url: 'http://[::1]:5000', channel: 'ipv6' },
    { url: 'https://relay.invalid', channel: 'relay' },
  ];
  const router = createRemoteRouter({ binding: { id: 'A', routes }, transport: {
    async probeRemote(_binding, route) { probed.push(route.url); return 5; },
    async openRemoteStream() { return result(); },
  } });
  await router.probe();
  assert.ok(probed.includes('https://relay.invalid'), '中转必须进队列');
  assert.ok(probed.includes('http://lan1.invalid'));
  assert.equal(probed.length, 3, '只看三条候选，按通道各取一条');
  router.close();
});

test('单轮没探全不抛错也不判整台离线：返回 snapshot 留证据', async () => {
  const routes = Array.from({ length: 5 }, (_, index) => ({ url: `http://lan${index}.invalid`, channel: 'lan' }));
  let probed = 0;
  const router = createRemoteRouter({ binding: { id: 'A', routes }, transport: {
    async probeRemote() { probed += 1; throw error(); },
    async openRemoteStream() { return result(); },
  } });
  const snapshot = await router.probe();
  assert.equal(probed, 3, '这一轮只探三条，还有候选没试');
  assert.ok(snapshot && typeof snapshot === 'object', '没探全也要返回 snapshot');
  assert.equal(snapshot.route, null, '不把整台电脑判成离线');
  assert.equal(snapshot.routes.length, 5);
  router.close();
});

test('固定挡位那条路不存在时按自动兜底，不抛没有可用的远程线路', async () => {
  const relay = { url: 'https://relay.invalid', channel: 'relay' };
  const dialed = [];
  const router = createRemoteRouter({ binding: { id: 'A', mode: 'lan', routes: [relay] }, transport: {
    async probeRemote() { return 5; },
    async openRemoteStream(_binding, route) { dialed.push(route.url); return result(); },
  } });
  const connection = await router.open();
  assert.deepEqual(dialed, [relay.url], '兜底用现存的中转线路');
  assert.equal(connection.route.channel, 'relay', 'open 返回值带实际选中的 route');
  connection.stream.destroy();
  router.close();
});

test('换网后 open 对候选并发各发一发，先成功者直接用于打开', async () => {
  const lan = { url: 'http://lan.invalid', channel: 'lan' };
  const relay = { url: 'https://relay.invalid', channel: 'relay' };
  const probed = [];
  const dialed = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const router = createRemoteRouter({ binding: { id: 'A', routes: [lan, relay] }, transport: {
    async probeRemote(_binding, route) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      probed.push(route.url);
      if (route.channel === 'relay') { inFlight -= 1; return 5; }
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      inFlight -= 1;
      return 50;
    },
    async openRemoteStream(_binding, route) { dialed.push(route.url); return result(); },
  } });
  const connection = await router.open();
  assert.deepEqual(probed, [lan.url, relay.url], '两条候选各探一发');
  assert.equal(maxInFlight, 2, '候选并发探测');
  assert.deepEqual(dialed, [relay.url], '先成功的那条直接拿去打开');
  assert.equal(connection.route.url, relay.url);
  connection.stream.destroy();
  router.close();
});

test('open 成功返回值带 route 字段', async () => {
  const route = { url: 'http://lan.invalid', channel: 'lan' };
  const router = createRemoteRouter({ binding: { id: 'A', routes: [route] }, transport: {
    async probeRemote() { return 5; },
    async openRemoteStream() { return result(); },
  } });
  const connection = await router.open();
  assert.deepEqual(connection.route, route);
  assert.ok(connection.stream);
  connection.stream.destroy();
  router.close();
});

// ——— controller.cjs ———

test('多窗口：第一个退出仍 attached，最后一个退出才回到未打开', async (t) => {
  const { createRemoteController } = injectControllerDeps(t);
  const transport = { pairComputer: async () => ({ id: 'A', instanceId: 'A', name: '电脑A', routes: [] }) };
  const controller = createRemoteController({ store: memoryStore(), transport, name: '本机' });
  t.after(() => controller.close());
  await controller.add('invite');
  const first = new EventEmitter(); first.exitCode = null;
  const second = new EventEmitter(); second.exitCode = null;
  controller.watchWindow('A', first);
  controller.watchWindow('A', second);
  first.emit('exit', 0, null);
  assert.equal((await controller.list())[0].attached, true, '还有窗口在就仍算打开');
  second.emit('exit', 0, null);
  assert.equal((await controller.list())[0].attached, false, '最后一个退出才回到未打开');
  const third = new EventEmitter(); third.exitCode = null;
  controller.watchWindow('A', third);
  assert.equal((await controller.list())[0].attached, true, '重新拉起窗口后又算打开');
});

test('换网 lost:true 只断开已打开设备的连接，不改状态也不探活', async (t) => {
  const { createRemoteController, state } = injectControllerDeps(t);
  let n = 0;
  const transport = { pairComputer: async () => { n += 1; const id = n === 1 ? 'A' : 'B'; return { id, instanceId: id, name: `电脑${id}`, routes: [] }; } };
  const controller = createRemoteController({ store: memoryStore(), transport, name: '本机' });
  t.after(() => controller.close());
  await controller.add('invite');
  await controller.add('invite');
  await controller.open('A');
  await new Promise(setImmediate);
  assert.equal(state.gateways.length, 1, '只有打开过的 A 有网关');
  const gatewayA = state.gateways[0];
  const before = (await controller.list()).map((row) => row.state);
  const callsBefore = state.routerCalls.length;
  await state.network.onChange({ reason: 'network', lost: true });
  assert.equal(gatewayA.disconnectCount, 1, '只断开已打开设备的连接');
  assert.equal(state.routerCalls.length, callsBefore, '丢网不重选线路也不探活');
  assert.deepEqual((await controller.list()).map((row) => row.state), before, '丢网不改状态');
});

test('换网非 lost 让所有绑定（含没打开过的）都重选线路', async (t) => {
  const { createRemoteController, state } = injectControllerDeps(t);
  let n = 0;
  const transport = { pairComputer: async () => { n += 1; const id = n === 1 ? 'A' : 'B'; return { id, instanceId: id, name: `电脑${id}`, routes: [] }; } };
  const controller = createRemoteController({ store: memoryStore(), transport, name: '本机' });
  t.after(() => controller.close());
  await controller.add('invite');
  await controller.add('invite');
  await controller.open('A');
  await state.network.onChange({ reason: 'network', lost: false });
  const changed = state.routerCalls.filter((call) => call.method === 'networkChanged');
  assert.equal(changed.length, 2, '打开过和没打开过的绑定都走 networkChanged');
  assert.equal(state.gateways[0].disconnectCount, 1, '已打开设备先断开旧连接');
});

test('connect 回调把实际在用线路记下来，行展示优先用它', async (t) => {
  const { createRemoteController, state } = injectControllerDeps(t);
  const lan = { url: 'http://lan.invalid', channel: 'lan' };
  const relay = { url: 'https://relay.invalid', channel: 'relay' };
  state.routerOpen = async () => ({ stream: new PassThrough(), host: { port: 1, token: 'x' }, route: relay });
  state.routerSnapshot = () => ({ route: lan, routes: [lan], latencyMs: 5 });
  const transport = { pairComputer: async () => ({ id: 'A', instanceId: 'A', name: '电脑A', routes: [lan, relay] }) };
  const controller = createRemoteController({ store: memoryStore(), transport, name: '本机' });
  t.after(() => controller.close());
  await controller.add('invite');
  await controller.open('A');
  await state.gateways[0].options.connect();
  const row = (await controller.list())[0];
  assert.equal(row.url, relay.url, '行展示用实际在用的线路，而不是探测选中的那条');
  assert.equal(row.channel, 'relay');
});

// ——— shell.cjs / routes.cjs ———

const LOCAL_URL = 'http://127.0.0.1:49152/?ticket=once';
const BINARY = '/fake/dsh-mobile-shell';

test('spawn 没有 pid 时 spawnFailed 为真', () => {
  const child = { on() {}, unref() {} };
  launchShell({ url: LOCAL_URL }, { resolve: () => BINARY, spawn: () => child });
  assert.equal(spawnFailed(child), true);
});

test('spawn 收到 error 事件时 spawnFailed 为真', () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  launchShell({ url: LOCAL_URL }, { resolve: () => BINARY, spawn: () => child });
  child.emit('error', new Error('ENOENT'));
  assert.equal(spawnFailed(child), true);
});

test('有 pid 且没有 error 时 spawnFailed 为假', () => {
  assert.equal(spawnFailed({ pid: 4242, on() {}, unref() {} }), false);
});

test('壳没有 pid 时按没打开处理，回 shellOpened:false 且不记窗口', async () => {
  const watchCalls = { count: 0 };
  const launch = () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    child.unref = () => {};
    return child;
  };
  const routes = shellRoutes(launch, watchCalls);
  const res = await invokeOpenShell(routes);
  assert.equal(res.status, 200);
  assert.equal(res.body.shellOpened, false);
  assert.equal(watchCalls.count, 0, '没起来的壳不该记成窗口');
});

test('壳收到 error 事件时按没打开处理，回 shellOpened:false 且不记窗口', async () => {
  const watchCalls = { count: 0 };
  const launch = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.unref = () => {};
    setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
    return child;
  };
  const routes = shellRoutes(launch, watchCalls);
  const res = await invokeOpenShell(routes);
  assert.equal(res.status, 200);
  assert.equal(res.body.shellOpened, false);
  assert.equal(watchCalls.count, 0);
});

// ——— local.cjs ———

test('openLink 保留未消费的 ticket，消费或过期后才换新', async (t) => {
  let clock = 1000;
  const local = createLocalGateway({
    connect: async () => ({ stream: new PassThrough(), host: { port: 1, token: 'x' } }),
    now: () => clock,
  });
  t.after(() => local.close());
  await local.start();
  const first = local.openLink();
  const second = local.openLink();
  assert.equal(first.url, second.url, '未消费时连签两次拿到同一个 ticket');
  const url = new URL(first.url);
  const consumed = await request(first.url, { headers: {
    host: url.host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  } });
  assert.equal(consumed.status, 303, '入口票被消费');
  const third = local.openLink();
  assert.notEqual(third.url, first.url, '旧票消费后才换新');
  clock += OPEN_MS;
  const fourth = local.openLink();
  assert.notEqual(fourth.url, third.url, '旧票过期后才换新');
});

'use strict';

/**
 * 「一组中转地址」：假中转设施验收 + 宿主侧择路的真行为。
 *
 * 两截。前半是设施本身（多条实例能同时起、顺序就是优先级、挂了之后探测得出来、三条地址
 * 落盘再读回来还是那三条）；后半是**第二轮择路**（契约 `docs/relay-multi-address.md` 的
 * 「择路·宿主侧」）——按 `relayUrls` 顺序试、第一条注册成功的当主用、全不通报 error 且不
 * 退化成「假装连着」、以及最要紧的一条：写回队首之后隧道**不许**被自己拆掉重建。
 *
 * 数据目录先改到临时目录再 require 实现：`lib/relay/core.js` 在模块求值时就定死了
 * `relay.json` 的路径，不隔离会把开发机真实的实例号 / 密钥覆盖掉（与 relay-control.test.cjs
 * 同一个理由）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-multi-address-'));
process.env.DSH_HOME = DSH_HOME;

const { startFakeRelay } = require('./fake-relay.cjs');
const core = require('../lib/relay/core.js');
const { createStatusView } = require('../lib/relay/status.js');
const { verifyRelayRegistration, probeInstanceId } = require('../lib/relay/verify.js');

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 起三条假中转；调用方负责在 finally 里关掉。 */
async function startThree() {
  const relays = [];
  try {
    for (let i = 0; i < 3; i += 1) relays.push(await startFakeRelay());
  } catch (error) {
    await Promise.all(relays.map((relay) => relay.close()));
    throw error;
  }
  return relays;
}

async function closeAll(relays) {
  await Promise.all(relays.map((relay) => relay.close()));
}

test('三条假中转能同时起、端口互不相同、各自的 /healthz 都回 200', async () => {
  const relays = await startThree();
  try {
    assert.equal(relays.length, 3);
    assert.equal(new Set(relays.map((relay) => relay.port)).size, 3, '端口 0 自动分配，三条实例不许撞同一个端口');
    for (const relay of relays) {
      const response = await fetch(`${relay.url}/healthz`);
      assert.equal(response.status, 200, `${relay.url} 的健康检查应回 200`);
      assert.equal(await response.text(), 'ok');
    }
  } finally {
    await closeAll(relays);
  }
});

test('三条都健康：按列表顺序选中第一条 —— 注册真的只落在第一条上', async () => {
  const relays = await startThree();
  try {
    const relayUrls = relays.map((relay) => relay.url);
    // 这一轮的插件仍然只用 `relayUrl`，而契约规定 `relayUrls[0] === relayUrl`；
    // 所以「选中第一条」在这里就是「用列表的第一条去连」。
    const primary = relayUrls[0];
    const result = await verifyRelayRegistration({
      relayUrl: primary,
      instanceId: probeInstanceId('multi1'),
      upstreamPort: 19387,
      name: 'Mac',
    });
    assert.deepEqual(result, { ok: true }, '第一条是健康的，试连应该成功');
    assert.equal(relays[0].connections.length, 1, '连接必须落在第一条上');
    assert.equal(relays[0].connections[0].registrations.length, 1, '注册帧要真的发出去');
    assert.equal(relays[1].connections.length, 0, '没轮到的地址不该收到任何连接');
    assert.equal(relays[2].connections.length, 0);
  } finally {
    await closeAll(relays);
  }
});

test('判为挂了之后：健康检查不再是 200，新连接被拒 —— 假中转能模拟「这条没了」', async () => {
  const relay = await startFakeRelay();
  try {
    relay.fail();
    assert.equal(relay.healthy, false);
    const response = await fetch(`${relay.url}/healthz`);
    assert.equal(response.status, 503, '挂了之后健康检查必须不是 2xx，否则择路永远发现不了它');

    await assert.rejects(
      () => verifyRelayRegistration({
        relayUrl: relay.url,
        instanceId: probeInstanceId('multi1'),
        upstreamPort: 19387,
      }),
      '挂了的地址连接必须失败，不能连上了再悄悄断',
    );

    relay.recover();
    assert.equal(relay.healthy, true);
    assert.equal((await fetch(`${relay.url}/healthz`)).status, 200, '恢复后端口不变、还是同一条地址');
  } finally {
    await closeAll([relay]);
  }
});

test('判为挂了：已经在连的隧道会被踢掉，不是等下一次握手才发现', async () => {
  const relay = await startFakeRelay();
  try {
    await verifyRelayRegistration({
      relayUrl: relay.url,
      instanceId: probeInstanceId('multi1'),
      upstreamPort: 19387,
    });
    assert.equal(relay.connections.length, 1);
    await wait(150);
    relay.fail();
    await wait(150);
    assert.equal(relay.connections[0].closed, true, 'fail() 要把在连的隧道断开');
  } finally {
    await closeAll([relay]);
  }
});

test('三条地址写进配置、重启后读盘仍是三条且顺序不变', () => {
  const state = core.loadState();
  const relayUrls = ['http://127.0.0.1:19001', 'http://127.0.0.1:19002', 'http://127.0.0.1:19003'];
  // 契约：`relayUrls[0]` 恒等于 `relayUrl`，写列表时主用地址跟着变成第一条。
  state.relayUrl = relayUrls[0];
  state.relayUrls = relayUrls.slice();
  core.saveState(state);

  // 模拟重启：不缓存内存状态，重新从盘上读。
  const reloaded = core.loadState();
  assert.deepEqual(reloaded.relayUrls, relayUrls, '三条地址与顺序都要原样读回来，不许被截成一条');
  assert.equal(reloaded.relayUrl, relayUrls[0], '主用地址必须还是列表的第一条');

  const onDisk = JSON.parse(fs.readFileSync(core.STATE_FILE, 'utf8'));
  assert.deepEqual(onDisk.relayUrls, relayUrls, '落盘的那份也要是三条');
});

// ── 第二轮：宿主侧择路 ─────────────────────────────────────────────────────
//
// 用真的旁路（fork `lib/sidecar-facade-worker.cjs`）+ 真的假中转跑端到端：断言的是外部
// 可观测的后果（注册落在哪条上、/status 报什么、连接数有没有多一次），不是源码文本。

const { randomBytes } = require('node:crypto');
const http = require('node:http');
const { SidecarFacade } = require('../lib/sidecar-facade.cjs');

/** 假父进程：择路这条路上 worker 只有配对审批会回调它，本用例不触发配对。 */
async function startParent() {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** 起一个跑真 worker 的旁路，返回 facade 与一份随时读的 /status。 */
async function startFacade(parent) {
  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') });
  await facade.start();
  return facade;
}

async function waitForStatus(facade, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await facade.request('/status');
      if (predicate(last)) return last;
    } catch { /* worker 正在重连时请求会失败，继续等 */ }
    await wait(100);
  }
  throw new Error(`${message}（最后一次 /status：${JSON.stringify(last)}）`);
}

/** 一条能过 worker 校验的最小配置（字段全在 allowed 白名单里）。 */
function workerConfig(relayUrls, overrides = {}) {
  return {
    enabled: true,
    relayUrl: relayUrls[0],
    relayUrls: relayUrls.slice(),
    instanceId: 'multi-route',
    pairingCode: '123456',
    name: 'Multi',
    upstreamPort: 19387,
    lanPort: 18787,
    lanEnabled: false,
    lanSecret: randomBytes(32).toString('hex'),
    ...overrides,
  };
}

test('换到下一条：第一条判死、第二条注册成功，主用就是第二条', async () => {
  const relays = await startThree();
  const parent = await startParent();
  const facade = await startFacade(parent);
  try {
    relays[0].fail();
    const relayUrls = relays.map((relay) => relay.url);
    await facade.configure(workerConfig(relayUrls));

    const status = await waitForStatus(facade, (s) => s?.tunnel?.state === 'connected', 12_000, '前两条里必有一条能连上，隧道应变成 connected');
    assert.equal(status.tunnel.error, null, '连上之后不许再挂着上一轮的错');

    // 注册必须真的落在第二条上：第一条的握手在 upgrade 阶段就被拒了（它已经 fail()）。
    assert.equal(relays[1].connections.length, 1, '连接要落在第二条假中转上');
    assert.equal(relays[1].connections[0].registrations.length, 1, '注册帧要真的发出去');
    assert.equal(relays[2].connections.length, 0, '第二条既然通了，第三条就不该被碰到');

    // 择路的账：这次连的是列表里第 1 条（从 0 数）、试了 2 条、一共 3 条。
    const route = status.tunnel.route;
    assert.ok(route, '/status 要能看出「用的第几条、试过几条」');
    assert.equal(route.url, relayUrls[1]);
    assert.equal(route.index, 1, 'index 是这次连上的是列表里第几条');
    assert.equal(route.tried, 2, '第一条试失败、第二条成功 → 试过 2 条');
    assert.equal(route.total, 3);

    // 写回的形状：中选那条提到队首，其余相对顺序不动（契约「择路」第 2 条）。
    assert.equal(route.adopted, true, '中选的不在队首 → 要写回');
    assert.deepEqual(route.urls, [relayUrls[1], relayUrls[0], relayUrls[2]], '只换队首，其余相对顺序不动');

    // 旁路自己那份配置也已经是写回之后的顺序：宿主拿它落盘，两边必须一字不差，
    // 否则那次配置下发会判成「变了」并重建隧道。
    assert.equal(status.relayUrl, relayUrls[1], '主用地址跟着变成中选那条');
    assert.deepEqual(status.relayUrls, route.urls);
  } finally {
    await facade.stop();
    await new Promise((resolve) => parent.close(resolve));
    await closeAll(relays);
  }
});

test('写回队首之后不许重建隧道：同一份列表再下发一次仍然是同一条连接', async () => {
  const relays = await startThree();
  const parent = await startParent();
  const facade = await startFacade(parent);
  try {
    relays[0].fail();
    const relayUrls = relays.map((relay) => relay.url);
    await facade.configure(workerConfig(relayUrls));
    const status = await waitForStatus(facade, (s) => s?.tunnel?.state === 'connected', 12_000, '应连上第二条');
    assert.equal(relays[1].connections.length, 1);
    const registeredAt = relays[1].connections[0].closed;

    // 宿主按 relayRoute.urls 落盘之后会下发同一份配置（`buildConfig` 就是从 state 拼的）。
    // 这条路径必须幂等：签名没变 → 不重建 → 那条隧道一条连接都不许多开。
    await facade.configure(workerConfig(status.relayUrls));
    await wait(300);
    const after = await facade.request('/status');
    assert.equal(after.tunnel.state, 'connected', '写回之后隧道不许断');
    assert.equal(relays[1].connections.length, 1, '写回不能触发重建：多了第二条连接就是刚连上的隧道被自己拆了');
    assert.equal(relays[1].connections[0].closed, registeredAt, '原来那条隧道实例还活着（没被 close）');

    // 顺序真的变了（比如人把别的地址挪到前面）才该重建，这是同一条判据的另一面。
    await facade.configure(workerConfig([relayUrls[2], relayUrls[1], relayUrls[0]]));
    const moved = await waitForStatus(facade, (s) => s?.relayUrl === relayUrls[2], 12_000, '换了优先级顺序应重新择路到新的首项');
    assert.equal(moved.relayUrl, relayUrls[2], '顺序变了就是一次新的择路');
    assert.equal(relays[2].connections.length, 1, '新首项应被真的用上');
  } finally {
    await facade.stop();
    await new Promise((resolve) => parent.close(resolve));
    await closeAll(relays);
  }
});

test('全部不通：状态是 error，不退化成「假装连着」，并报出试过的最后一条', async () => {
  const relays = await startThree();
  const parent = await startParent();
  const facade = await startFacade(parent);
  try {
    for (const relay of relays) relay.fail();
    await facade.configure(workerConfig(relays.map((relay) => relay.url)));

    const status = await waitForStatus(facade, (s) => s?.tunnel?.state === 'error', 15_000, '三条都不通时状态必须是 error');
    assert.notEqual(status.tunnel.state, 'connected', '一条都没连上时绝不能报 connected');
    assert.ok(String(status.tunnel.error || '').length > 0, 'error 态必须带一句原因');
    // 三条都试过：每条都在 upgrade 阶段被拒，连接数都是 0（握手没成），所以用请求路径判断
    // 「三条都被敲过」——这是「全都不通之后从头再来」也算数的那份账。
    for (const relay of relays) {
      assert.ok(
        relay.requests.some((entry) => String(entry).includes('/tunnel')),
        `${relay.url} 应被真的试过，不能悄悄跳过`,
      );
    }
  } finally {
    await facade.stop();
    await new Promise((resolve) => parent.close(resolve));
    await closeAll(relays);
  }
});

test('全部都不通之后：下一次重连从列表第一条重新开始，不记「上次卡在第几条」', async () => {
  const relays = await startThree();
  const parent = await startParent();
  const facade = await startFacade(parent);
  try {
    for (const relay of relays) relay.fail();
    const relayUrls = relays.map((relay) => relay.url);
    await facade.configure(workerConfig(relayUrls));
    const dead = await waitForStatus(facade, (s) => s?.tunnel?.state === 'error', 15_000, '三条都不通时状态必须是 error');
    assert.equal(dead.tunnel.state, 'error', '不许记成「还在连」');
    assert.equal(dead.relayUrl, relayUrls[0], '全挂的时候配置里的主用一个字都不动（没有谁中选，就没有写回）');

    // 只把**第一条**救活，然后等退避重连（5s + 抖动 2s）。
    relays[0].recover();
    const back = await waitForStatus(
      facade,
      (s) => s?.tunnel?.state === 'connected',
      15_000,
      '第一条恢复之后，退避重连必须从列表第一条重新试',
    );
    assert.equal(back.relayUrl, relayUrls[0], '重连从第一条开始，连上的是第一条');
    assert.equal(relays[0].connections.length, 1, '注册要真的落在第一条上');
    assert.equal(back.tunnel.route.index, 0, 'index 归零：没有记住上一轮卡在第几条');
    assert.equal(back.tunnel.route.adopted, false, '中选那条本来就在队首 → 不需要写回');
  } finally {
    await facade.stop();
    await new Promise((resolve) => parent.close(resolve));
    await closeAll(relays);
  }
});

test('宿主侧：worker 报来的 route 一路走到写回订阅者（状态帧与轮询两条来源都算）', async () => {
  // 这条钉的是接线，不是规则：`applyTunnelState` 收到 `tunnel.route` 之后必须叫上订阅者，
  // 否则旁路报得再准，`relay.json` 也不会动，下一次重启又从死掉的那条开始试。
  const FACADE = require.resolve('../lib/sidecar-facade.cjs');
  const LIFECYCLE = require.resolve('../lib/sidecar-lifecycle.cjs');
  const savedFacade = require.cache[FACADE];
  const routes = { next: null };
  let facadeOptions = null;
  class FakeFacade {
    constructor(options) { facadeOptions = options }
    async start() {}
    async stop() {}
    async configure() { return { tunnel: { state: 'off', error: null }, lan: { state: 'off', error: null } } }
    async request() { return { tunnel: { state: 'connected', error: null, route: routes.next }, lan: { state: 'off', error: null } } }
  }
  try {
    require.cache[FACADE] = { id: FACADE, filename: FACADE, loaded: true, exports: { SidecarFacade: FakeFacade } };
    delete require.cache[LIFECYCLE];
    const { createSidecarLifecycle } = require(LIFECYCLE);
    const lifecycle = createSidecarLifecycle({
      ctx: { webServer: { port: 19387 } },
      lanPortInUse: () => 18787,
      resolveLanPort: async () => 18787,
      buildConfig: async () => ({}),
    });
    const seen = [];
    lifecycle.onRouteAdopted((route) => seen.push(route.url));
    assert.equal(typeof facadeOptions.onState, 'function', 'facade 必须把 worker 的状态帧转给宿主');

    // ① 即时上报：worker 的 publishState() 走到这里。
    facadeOptions.onState({
      type: 'state',
      tunnel: { state: 'connected', error: null, route: { url: 'https://b.example', index: 1, tried: 2, total: 2, urls: ['https://b.example', 'https://a.example'], adopted: true } },
    });
    assert.deepEqual(seen, ['https://b.example'], '状态帧里的 route 必须叫上写回订阅者');

    // 同一个地址再报一次：订阅者会被再叫一次，但**去重只在写盘那一处做一次**
    // （`createRouteAdopter` 比对内存里那份顺序），否则同一个判断就有两份实现。
    facadeOptions.onState({
      type: 'state',
      tunnel: { state: 'connected', error: null, route: { url: 'https://b.example', index: 1, tried: 2, total: 2, urls: ['https://b.example', 'https://a.example'], adopted: true } },
    });
    assert.deepEqual(seen, ['https://b.example', 'https://b.example'], '重复报到照样交给订阅者，去重由写盘那一处负责（下面那条用例钉着）');

    // ② 权威兜底：即时上报丢了的时候，10s 轮询看到的 route 也要能触发写回。
    routes.next = { url: 'https://c.example', index: 1, tried: 2, total: 2, urls: ['https://c.example', 'https://a.example'], adopted: true };
    const timers = [];
    const realSetInterval = global.setInterval;
    global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    try {
      lifecycle.start();
      await wait(10);
      const poll = timers.find((timer) => timer.ms === 10000);
      assert.ok(poll, '健康轮询定时器必须存在');
      await poll.fn();
    } finally {
      global.setInterval = realSetInterval;
    }
    assert.deepEqual(seen, ['https://b.example', 'https://b.example', 'https://c.example'], '轮询那条来源也要触发写回');

    // `adopted:false`（中选那条本来就在队首）不该叫订阅者。
    facadeOptions.onState({ type: 'state', tunnel: { state: 'connected', error: null, route: { url: 'https://c.example', index: 0, tried: 1, total: 2, urls: ['https://c.example', 'https://b.example'], adopted: false } } });
    assert.deepEqual(seen, ['https://b.example', 'https://b.example', 'https://c.example'], '队首本来就没换，不许写盘');
  } finally {
    if (savedFacade) require.cache[FACADE] = savedFacade; else delete require.cache[FACADE];
    delete require.cache[LIFECYCLE];
  }
});

test('写回由宿主主进程做：notify 必须是 false，且与内存一致时不写盘', async () => {
  const { createRouteAdopter } = require('../lib/sidecar-lifecycle.cjs');
  const writes = [];
  const state = { enabled: true, relayUrl: 'https://a.example', relayUrls: ['https://a.example', 'https://b.example'] };
  const adopt = createRouteAdopter({
    state,
    settings: { update: async (patch, options) => { writes.push({ patch, options }); } },
    warn: () => { throw new Error('不该有写回失败的告警'); },
  });

  // adopted:false —— 中选那条本来就在队首：不落盘（多余的磁盘写）。
  adopt({ url: 'https://a.example', index: 0, tried: 1, total: 2, urls: ['https://a.example', 'https://b.example'], adopted: false });
  await wait(10);
  assert.equal(writes.length, 0, '队首没换就不写盘');

  // adopted:true —— 写回，且必须带 notify:false：走通知那条会把刚连上的隧道拆了重建。
  adopt({ url: 'https://b.example', index: 1, tried: 2, total: 2, urls: ['https://b.example', 'https://a.example'], adopted: true });
  await wait(10);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].patch, { relayUrls: ['https://b.example', 'https://a.example'] });
  assert.equal(writes[0].options?.notify, false, 'notify:false 是硬要求（写回不许触发一次重配）');

  // 同一份 route 重复报到（状态帧 + 10s 轮询都会送）不许反复写盘。
  adopt({ url: 'https://b.example', index: 1, tried: 2, total: 2, urls: ['https://b.example', 'https://a.example'], adopted: true });
  await wait(10);
  assert.equal(writes.length, 1, '与内存里那份一致时不再写盘');

  // 写回失败只记一行，不许把异常抛回状态通道。
  const failed = createRouteAdopter({
    state,
    settings: { update: async () => { throw new Error('disk full'); } },
    warn: () => {},
  });
  assert.doesNotThrow(() => failed({ url: 'https://c.example', index: 1, tried: 2, total: 2, urls: ['https://c.example'], adopted: true }));
});

/**
 * 心跳视图：`/status` 与手机 30 秒轮询的是同一个函数，装配照
 * `test/relay-address-list.test.cjs` 里那套收敛（那些取值器都是 `apply()` 闭包里会被重新
 * 赋值的 let，测试里给固定值即可）。
 */
function statusView(state) {
  return createStatusView({
    state,
    webServerPort: 3080,
    getSidecarSnapshot: () => ({}),
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    getSidecarState: () => 'healthy',
    getSidecarRestarts: () => 0,
    getSidecarRestartedAt: () => 0,
    getSidecarRestartError: () => null,
    getMirrorPush: () => ({ pushedAt: 0, ok: null, error: null }),
  })();
}

test('心跳 /status 的 relayRoute：没试过是 null，试过就报第几条与试过的条数', () => {
  const route = { url: 'https://b.example', index: 1, tried: 2, total: 2, urls: ['https://b.example', 'https://a.example'], adopted: true };
  const withRoute = createStatusView({
    state: { enabled: true, relayUrl: 'https://b.example', relayUrls: route.urls },
    webServerPort: 3080,
    getSidecarSnapshot: () => ({ tunnel: { state: 'connected', error: null, route } }),
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    getSidecarState: () => 'healthy',
    getSidecarRestarts: () => 0,
    getSidecarRestartedAt: () => 0,
    getSidecarRestartError: () => null,
    getMirrorPush: () => ({ pushedAt: 0, ok: null, error: null }),
  })();
  assert.deepEqual(withRoute.relayRoute, route, '手机与面板要能看出用的第几条、试过几条');
  // 没试过（隧道没起来 / 老宿主不报这一格）时是 null，不许编一份出来。
  assert.equal(statusView({ enabled: true, relayUrl: 'https://a.example' }).relayRoute, null);
});

test('心跳 /status 的 relayUrls 与 relayUrl 一致', () => {
  const relayUrls = ['https://a.example', 'https://b.example', 'https://c.example'];
  const listed = statusView({ enabled: true, relayUrl: relayUrls[0], relayUrls: relayUrls.slice() });
  assert.ok(Array.isArray(listed.relayUrls), '手机拿到的一格必须是数组，不是字符串');
  assert.deepEqual(listed.relayUrls, relayUrls, '整组地址按原序报出去，不许被截成一条');
  assert.equal(listed.relayUrls[0], listed.relayUrl, '`relayUrls[0] === relayUrl` 在任何出口都成立');

  // 老宿主（state 里没有这一格）也不能报 undefined：手机读到它得能退化成单条。
  const legacy = statusView({ enabled: true, relayUrl: 'https://a.example' });
  assert.deepEqual(legacy.relayUrls, [legacy.relayUrl], '没有列表时按「只有主用这一条」报');

  // 没配中转：两格都空，不留上一轮的残留值。
  const none = statusView({ enabled: false, relayUrl: '', relayUrls: [] });
  assert.equal(none.relayUrl, '');
  assert.deepEqual(none.relayUrls, [], '空列表时两格一起空');
});

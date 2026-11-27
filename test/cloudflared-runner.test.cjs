// Cloudflare 快速隧道 runner：banner 地址解析、起停状态、崩溃退避重连与用户开关标记回归。
// 钉住进程消失的清理契约：exit 单独到也清状态撤地址重连，exit+close 幂等，spawn error 后能重新起进程。
'use strict';

/**
 * cloudflared 运行器：不真起进程、不联网。
 *
 * 注入假 spawn / 假 ensure，输出假 banner，钉住「从 stderr 装饰文本里取到 trycloudflare 地址」、
 * 「崩溃只在用户仍开启时有限重连」、「用户 stop 后不复活且清地址」这些契约。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCloudflaredRunner, extractTunnelUrl } = require('../lib/cloudflared/runner.cjs');

const BANNER = '2026-11-22T10:00:00Z INF |  https://brave-lamp-trycloudflare.trycloudflare.com  |';
const REGISTERED = '2026-11-22T10:00:02Z INF Registered tunnel connection connIndex=0 connection=abc event=1 ip=198.41.200.13 location=hkg12 protocol=quic';
const DROPPED = '2026-11-22T10:05:00Z ERR Connection terminated error="failed to dial to edge with quic: timeout"';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-runner-'));
}

function fakeChild() {
  const handlers = {};
  const stream = () => {
    const streamHandlers = {};
    return {
      setEncoding() {},
      on(event, cb) { streamHandlers[event] = cb; },
      emit(event, ...args) { if (streamHandlers[event]) streamHandlers[event](...args); },
    };
  };
  return {
    pid: 4242,
    stdout: stream(),
    stderr: stream(),
    kill() { return true; },
    on(event, cb) { handlers[event] = cb; },
    emit(event, ...args) { if (handlers[event]) handlers[event](...args); },
  };
}

function retryClock() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimerImpl(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimerImpl(key) { timers.delete(key); },
    async tick() {
      const entry = timers.entries().next().value;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1].fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function harness({ port = 49906, clock = {}, onAddress, onAddressGone, ensure } = {}) {
  const children = [];
  const spawns = [];
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => port,
    ensureBin: ensure || (async () => ({ ok: true, path: '/fake/cloudflared' })),
    spawnImpl: (binary, args) => { spawns.push({ binary, args }); const child = fakeChild(); children.push(child); return child; },
    onAddress,
    onAddressGone,
    ...clock,
  });
  return { runner, children, spawns };
}

test('端口未就绪时不启动，status 报 waitingForPort', async () => {
  let port = 0;
  let spawns = 0;
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => port,
    ensureBin: async () => { throw new Error('不该取二进制'); },
    spawnImpl: () => { spawns += 1; return fakeChild(); },
  });
  const st = await runner.start();
  assert.equal(st.waitingForPort, true);
  assert.equal(st.running, false);
  assert.equal(st.url, '');
  port = 80;
  await runner.syncLocalPort();
  assert.equal(runner.status().waitingForPort, true, '越界端口同样不启动');
  assert.equal(spawns, 0);
});

test('start 起进程、从 stderr banner 解析地址、spawn 参数正确', async () => {
  const published = [];
  const { runner, children, spawns } = harness({ onAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); } });
  const st = await runner.start();
  assert.equal(st.running, false, '进程起来不等于隧道通，边缘还没连上不能说运行中');
  assert.equal(st.starting, true);
  assert.equal(st.pid, 4242);
  assert.equal(st.url, '');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['tunnel', '--url', 'http://127.0.0.1:49906', '--no-autoupdate']);
  children[0].stderr.emit('data', `${BANNER}\n`);
  assert.equal(runner.status().url, 'https://brave-lamp-trycloudflare.trycloudflare.com');
  assert.deepEqual(published, [], '只有 banner 地址、还没连上边缘：这条地址先不交出去');
  children[0].stderr.emit('data', `${REGISTERED}\n`);
  assert.equal(runner.status().running, true, '连上边缘才算运行中');
  assert.equal(runner.status().starting, false);
  assert.deepEqual(published, ['https://brave-lamp-trycloudflare.trycloudflare.com'], '连上之后才上报地址');
});

test('协议族策略 ipv4-only 时 spawn 带 --edge-ip-version 4；auto 不带', async () => {
  for (const [policy, expectEdge] of [['ipv4-only', true], ['auto', false]]) {
    const spawns = [];
    const runner = createCloudflaredRunner({
      root: tempDir(), portOf: () => 49906,
      ensureBin: async () => ({ ok: true, path: '/fake/cloudflared' }),
      spawnImpl: (binary, args) => { spawns.push(args); return fakeChild(); },
      ipVersionPolicy: () => policy,
    });
    await runner.start();
    const expected = ['tunnel', '--url', 'http://127.0.0.1:49906', '--no-autoupdate'];
    if (expectEdge) expected.push('--edge-ip-version', '4');
    assert.deepEqual(spawns[0], expected, `${policy} 的 spawn 参数不对`);
  }
});

test('同一 URL 只回调一次', async () => {
  const published = [];
  const child = fakeChild();
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => 49906,
    ensureBin: async () => ({ ok: true, path: '/fake/cloudflared' }),
    spawnImpl: () => child,
    onAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); },
  });
  await runner.start();
  child.stderr.emit('data', `${BANNER}\n`);
  child.stderr.emit('data', `${REGISTERED}\n`);
  child.stderr.emit('data', `${BANNER}\n`);
  child.stdout.emit('data', `${BANNER}\n`);
  assert.equal(published.length, 1, '相同地址重复出现不重复回调');
  assert.equal(runner.status().url, 'https://brave-lamp-trycloudflare.trycloudflare.com');
});

test('setAddressListener 在已知地址时补发当前地址', async () => {
  const child = fakeChild();
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => 49906,
    ensureBin: async () => ({ ok: true, path: '/fake/cloudflared' }),
    spawnImpl: () => child,
  });
  await runner.start();
  child.stderr.emit('data', `${BANNER}\n`);
  child.stderr.emit('data', `${REGISTERED}\n`);
  const got = [];
  runner.setAddressListener(async (value, isCurrent) => { if (isCurrent()) got.push(value); });
  assert.deepEqual(got, ['https://brave-lamp-trycloudflare.trycloudflare.com']);
});

test('崩溃按退避重连（用户仍开启），封顶后转固定间隔继续重试', async () => {
  const clock = retryClock();
  const { runner, children } = harness({ port: 18787, clock });
  await runner.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    children.at(-1).emit('close', 1, null);
    assert.equal(runner.status().retrying, true);
    assert.equal([...clock.timers.values()][0].ms, delay);
    await clock.tick();
    assert.equal(runner.status().starting, true, '重连起的是一新进程，连上边缘之前不算运行中');
  }
  // 需求变更（2026-11-28）：封顶后不再永久停，转 60 秒固定档无限重试（带 ±20% 抖动）。
  children.at(-1).emit('close', 1, null);
  assert.equal(clock.timers.size, 1, '退避用尽后转固定长间隔继续重试，不能永久停');
  const steadyMs = [...clock.timers.values()][0].ms;
  assert.ok(steadyMs >= 48_000 && steadyMs <= 72_000, `固定档应在 60s±20% 内，实际 ${steadyMs}`);
  await clock.tick();
  assert.equal(runner.status().starting, true, '固定档到点必须重新拉起');
  children.at(-1).emit('close', 1, null);
  assert.equal(clock.timers.size, 1, '再次异常仍要排下一次重试，不能放弃');
  assert.equal(children.length, 7);
  await runner.stop();
  assert.equal(runner.shouldAutoStart(), false);
  assert.equal(runner.status().error, '');
  assert.equal(runner.status().retrying, false);
});

test('只来 exit 不来 close：清状态、撤地址、按退避重连', async () => {
  const clock = retryClock();
  const published = [];
  const gone = [];
  const { runner, children } = harness({
    port: 18787,
    clock,
    onAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); },
    onAddressGone: () => gone.push(1),
  });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n${REGISTERED}\n`);
  assert.equal(runner.status().running, true);
  assert.deepEqual(published, ['https://brave-lamp-trycloudflare.trycloudflare.com']);

  // stdio 管道被第三方占住时 close 永远不来，只有 exit 到。
  children[0].emit('exit', 1, null);
  const st = runner.status();
  assert.equal(st.running, false, '进程没了就不能再报运行中');
  assert.equal(st.pid, null);
  assert.equal(st.url, '');
  assert.match(st.error, /cloudflared 已退出/);
  assert.deepEqual(gone, [1], '进程没了要撤回上报过的地址，别让总控继续发死链');
  assert.equal(st.retrying, true, '按退避排一次重连');
  assert.equal([...clock.timers.values()][0].ms, 1000);

  await clock.tick();
  assert.equal(children.length, 2, '退避到点后起的是新进程');
  await runner.stop();
});

test('exit 与 close 都到：清理只做一次，close 补最终退出原因', async () => {
  const clock = retryClock();
  const gone = [];
  const { runner, children } = harness({ port: 18787, clock, onAddressGone: () => gone.push(1) });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n${REGISTERED}\n`);
  children[0].emit('exit', 1, null);
  children[0].emit('close', 7, null);

  assert.deepEqual(gone, [1], '退出+关闭只撤一次地址');
  assert.equal(clock.timers.size, 1, '只排一次重连，不因两个事件重复退避');
  assert.match(runner.status().error, /code=7/, 'close 到得晚，用它补最终退出原因');

  await clock.tick();
  assert.equal(children.length, 2, '一次 tick 只起一个新进程');
  assert.equal(clock.timers.size, 0);
  await runner.stop();
});

test('spawn error 后清掉僵住的 child，再 start 能起新进程', async () => {
  const clock = retryClock();
  const gone = [];
  const { runner, children } = harness({ port: 18787, clock, onAddressGone: () => gone.push(1) });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n${REGISTERED}\n`);

  children[0].emit('error', Object.assign(new Error('系统拒绝运行'), { code: 'UNKNOWN' }));
  assert.equal(runner.status().pid, null, 'error 后必须清掉 child，否则 launch 的 if(child) return 永久卡死');
  assert.equal(runner.status().url, '');
  assert.deepEqual(gone, [1], 'error 也要撤回上报过的地址');
  assert.equal(runner.status().retrying, true, 'error 同样进退避重连');

  const st = await runner.start();
  assert.equal(children.length, 2, '再次 start 真的起了新进程');
  assert.equal(st.pid, 4242);
  await runner.stop();
});

test('崩溃时用户显式关掉（写了 disabled 标记）则不重连', async () => {
  const clock = retryClock();
  const { runner, children } = harness({ port: 18787, clock });
  await runner.start();
  fs.writeFileSync(runner._paths.disabled, '1');
  children[0].emit('close', 1, null);
  assert.equal(runner.status().retrying, false, '用户关掉就不该自动重连');
  assert.equal(clock.timers.size, 0);
  assert.match(runner.status().error, /cloudflared 已退出/);
});

test('stop 后清地址、写关闭标记、不复活', async () => {
  const clock = retryClock();
  const gone = [];
  const { runner, children } = harness({ port: 18787, clock, onAddressGone: () => gone.push(1) });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n`);
  children[0].stderr.emit('data', `${REGISTERED}\n`);
  assert.equal(runner.status().url, 'https://brave-lamp-trycloudflare.trycloudflare.com');
  const stopped = await runner.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.url, '');
  assert.deepEqual(gone, [1], '停用要把上报过的地址撤回，总控不能再拿它发给手机');
  assert.equal(runner.shouldAutoStart(), false);
  children[0].emit('close', 1, null);
  assert.equal(runner.status().retrying, false, '用户 stop 后崩溃不能复活');
  assert.equal(clock.timers.size, 0);
  assert.equal(children.length, 1);
});

test('dispose 杀进程、清地址、解绑监听，不动关闭标记', async () => {
  const clock = retryClock();
  const child = fakeChild();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const got = [];
  const gone = [];
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => 49906,
    ensureBin: async () => ({ ok: true, path: '/fake/cloudflared' }),
    spawnImpl: () => child,
    onAddress: async (value, isCurrent) => { if (isCurrent()) got.push(value); },
    onAddressGone: () => gone.push(1),
    ...clock,
  });
  await runner.start();
  child.stderr.emit('data', `${BANNER}\n`);
  child.stderr.emit('data', `${REGISTERED}\n`);
  const st = runner.dispose();
  assert.equal(st.running, false);
  assert.equal(st.url, '');
  assert.equal(kills, 1);
  assert.deepEqual(gone, [1], '卸载时那条地址同样要撤回');
  assert.equal(runner.shouldAutoStart(), true, 'dispose 写不写关闭标记都不影响：没关掉，下次宿主启动照旧自动起');
  child.stderr.emit('data', `${BANNER}\n`);
  assert.equal(runner.status().url, '', '解绑后旧输出不再写地址');
  assert.equal(clock.timers.size, 0);
});

test('shouldAutoStart：默认开，显式关掉才不自动起', async () => {
  const { runner } = harness({});
  assert.equal(runner.shouldAutoStart(), true, '没写过关闭标记按默认开');
  assert.equal(runner.status().enabled, true);
  await runner.start();
  assert.equal(runner.shouldAutoStart(), true);
  await runner.stop();
  assert.equal(runner.shouldAutoStart(), false, '用户显式关掉后重启不再自动起');
  assert.equal(runner.status().enabled, false);
  fs.rmSync(runner._paths.disabled, { force: true });
  assert.equal(runner.shouldAutoStart(), true, '关掉标记没了（例如用户从面板重开）又恢复默认开');
});

test('拿不到二进制：起不来但如实报原因，不抛', async () => {
  const { runner, children } = harness({ ensure: async () => ({ ok: false, message: '下载失败' }) });
  const st = await runner.start();
  assert.equal(st.running, false);
  assert.match(st.error, /下载失败/);
  assert.equal(children.length, 0);
  assert.equal(runner.shouldAutoStart(), true, '默认开：没写关闭标记，拿不到二进制也留着稍后重试');
});

test('extractTunnelUrl 只认 trycloudflare 地址，剥掉装饰符与尾斜杠', () => {
  assert.equal(extractTunnelUrl(`${BANNER}\n`), 'https://brave-lamp-trycloudflare.trycloudflare.com');
  assert.equal(extractTunnelUrl('  https://a-b.trycloudflare.com/  \n'), 'https://a-b.trycloudflare.com');
  assert.equal(extractTunnelUrl('https://example.com'), '');
  assert.equal(extractTunnelUrl('nothing here'), '');
});

test('全新机器：available 反映平台能否跑 cloudflared，与二进制是否已下载分开', () => {
  // 面板拿 available 决定开关能不能点。若它只表示「二进制已下载」，全新机器上恒为 false，
  // 开关就永远点不动、下不了首次。所以这里钉住：available = 平台支持（或已有二进制）。
  const { platformId } = require('../lib/cloudflared/provision.cjs');
  const expected = Boolean(platformId());
  const { runner } = harness();
  const st = runner.status();
  assert.equal(st.running, false);
  assert.equal(st.available, expected);
});

test('起进程后迟迟拿不到地址：状态报「连不上 Cloudflare」，不崩、不假装运行中', async () => {
  let fireConnect = null;
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => 49906,
    ensureBin: async () => ({ path: '/fake/cloudflared' }),
    spawnImpl: () => fakeChild(),
    connectTimeoutMs: 1000,
    connectTimerImpl: (fn) => { fireConnect = fn; return 111; },
    clearConnectTimerImpl: () => {},
  });
  const st0 = await runner.start();
  assert.equal(st0.starting, true, '进程起了、边缘没连上：停在「正在启动」，不报运行中');
  assert.equal(st0.running, false);
  assert.equal(typeof fireConnect, 'function');
  fireConnect();
  const st = runner.status();
  assert.equal(st.running, false, '进程还在（会自己重试），但不冒充已连上');
  assert.match(st.error, /Cloudflare/, '要把「连不上 Cloudflare」这个真实原因写进状态');
});

test('地址监听同步抛错或异步 reject 都不会反噬进程', async () => {
  for (const onAddress of [() => { throw new Error('boom'); }, async () => { throw new Error('boom'); }]) {
    const { runner, children } = harness({ onAddress });
    await runner.start();
    assert.equal(children.length, 1);
    assert.doesNotThrow(() => children[0].stderr.emit('data', `${BANNER}\n${REGISTERED}\n`), '监听抛错不许从流回调里冒出来把宿主带崩');
    await new Promise((r) => setImmediate(r));
  }
});

test('只有地址、一直没连上边缘：不交地址，超时把真实原因写进状态', async () => {
  let fireConnect = null;
  const published = [];
  const gone = [];
  const { runner, children } = harness({
    port: 18787,
    onAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); },
    onAddressGone: () => gone.push(1),
    clock: {
      connectTimerImpl: (fn) => { fireConnect = fn; return 111; },
      clearConnectTimerImpl: () => { fireConnect = null; },
    },
  });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n`);
  children[0].stderr.emit('data', '2026-11-22T10:00:05Z ERR Failed to dial a quic connection error="timeout: no recent network activity"\n');
  assert.deepEqual(published, [], '还没连上边缘，不能把这条地址写进总控');
  assert.equal(typeof fireConnect, 'function');
  fireConnect();
  const st = runner.status();
  assert.equal(st.running, false);
  assert.match(st.error, /7844/, '要指出最常见的拦截原因');
  assert.match(st.error, /Failed to dial a quic/, '要把 cloudflared 的原话带出来');
  assert.deepEqual(gone, [], '本来就没上报过地址，没有要撤的');
});

test('连上后掉线：先回到未连通，重连超时才撤回地址', async () => {
  let fireConnect = null;
  const published = [];
  const gone = [];
  const { runner, children } = harness({
    port: 18787,
    onAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); },
    onAddressGone: () => gone.push(1),
    clock: {
      connectTimerImpl: (fn) => { fireConnect = fn; return 111; },
      clearConnectTimerImpl: () => { fireConnect = null; },
    },
  });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n${REGISTERED}\n`);
  assert.deepEqual(published, ['https://brave-lamp-trycloudflare.trycloudflare.com']);
  children[0].stderr.emit('data', `${DROPPED}\n`);
  assert.equal(runner.status().running, false, '掉线就不能再报运行中');
  assert.deepEqual(gone, [], '先给它自己重连的余地（同一地址，地址没变）');
  assert.equal(typeof fireConnect, 'function', '掉线后要重新计时');
  fireConnect();
  assert.deepEqual(gone, [1], '重连超时才把地址撤回');
  assert.match(runner.status().error, /7844/);
});

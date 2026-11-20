// FRP 真实端口等待与运行跟随、JSON 配置、有限重试及主动停止取消回归。
'use strict';

// 2026-11-19：补一条断言——启动同步抛 UNKNOWN 时要翻译成能照着排查的提示，而不是原始 errno。

/**
 * frpc 运行器：本地端口对齐、起停、状态、失败与自动重启判定。
 *
 * 注入假 spawn / 假 ensure，不真起进程、不联网。要钉的是「配置里的 localPort 被改成实际端口」
 * 与「起停状态如实反映」，不是去验 frpc 本身。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const { createFrpcRunner, alignLocalPort, withAdminPort } = require('../lib/frpc/runner.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-runner-'));
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

const CONFIG = ['serverAddr = "1.2.3.4"', 'serverPort = 8000', '[[proxies]]', 'type = "tcp"', 'localIP = "127.0.0.1"', 'localPort = 18787'].join('\n');

function runnerFactory(mutate = (source) => source) {
  const file = require.resolve('../lib/frpc/runner.cjs');
  const module = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), {
    module, exports: module.exports, require: createRequire(file), process, Buffer, performance,
    setTimeout, clearTimeout, AbortController,
  });
  return module.exports.createFrpcRunner;
}

async function portFollowContract(create = createFrpcRunner) {
  let port = 0;
  const children = [];
  let kills = 0, writes = 0;
  const runner = create({ root: tempDir(), portOf: () => port,
    fsImpl: { ...fs, writeFileSync(...args) { writes += 1; return fs.writeFileSync(...args); } },
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => { const child = fakeChild(); child.kill = () => { kills += 1; }; children.push(child); return child; },
  });
  const file = runner.saveConfig(CONFIG);
  try {
    await runner.start();
    assert.equal(children.length, 0, '没有真实监听端口时不能按旧配置启动');
    assert.equal(runner.status().waitingForPort, true);
    port = 23456;
    await Promise.all([runner.syncLocalPort(), runner.syncLocalPort()]);
    assert.equal(children.length, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /localPort = 23456/);
    assert.equal(runner.status().localPort, 23456);
    const stableWrites = writes;
    for (let poll = 0; poll < 6; poll += 1) await runner.syncLocalPort();
    assert.equal(children.length, 1, '相同端口不重复启动');
    assert.equal(writes, stableWrites, '健康轮询重复同步不重写配置');
    port = 0;
    await runner.syncLocalPort();
    assert.equal(kills, 0, '监听重配期间的暂空不拆现有穿透');
    port = 34567;
    await Promise.all([runner.syncLocalPort(), runner.syncLocalPort()]);
    assert.equal(children.length, 2);
    assert.equal(kills, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /localPort = 34567/);
    children[0].emit('close', 0, null);
    assert.equal(runner.status().running, true, '旧进程迟到退出不污染新代');
    await runner.stop();
    port = 45678;
    await runner.syncLocalPort();
    assert.equal(children.length, 2, '主动停止后监听更新不能重新启动');
    assert.equal(runner.status().waitingForPort, false);
  } finally { await runner.clear(); }
}

test('等到真实端口再启动，运行中换号只重建一次，主动停止不复活', () => portFollowContract());

test('变异：跳过端口等待或忽略运行端口变化时，恢复契约必须失败', async () => {
  await assert.rejects(portFollowContract(runnerFactory((source) => source.replaceAll("if (waitingForPort) { error = ''; return; }", ''))), assert.AssertionError);
  await assert.rejects(portFollowContract(runnerFactory((source) => source.replace('if (port === requestedLocalPort && !waitingForPort) return status();', 'if (child) return status();'))), assert.AssertionError);
});

test('获取二进制期间端口变化或停止，只能启动最新仍有效的入口', async () => {
  let port = 18787;
  const releases = [], launched = [];
  const runner = createFrpcRunner({ root: tempDir(), portOf: () => port,
    ensure: () => new Promise((resolve) => releases.push(resolve)),
    spawnImpl: (_binary, args) => { launched.push(fs.readFileSync(args[1], 'utf8')); return fakeChild(); },
  });
  runner.saveConfig(CONFIG);
  const first = runner.start();
  port = 23456;
  const changed = runner.syncLocalPort();
  releases[0]({ ok: true, path: '/fake/frpc' });
  await first;
  assert.equal(launched.length, 0, '迟到的旧启动不能占用入口');
  releases[1]({ ok: true, path: '/fake/frpc' });
  await changed;
  assert.equal(launched.length, 1);
  assert.match(launched[0], /localPort = 23456/);
  await runner.clear();
});

test('alignLocalPort 只改 localPort，不动 localIP', () => {
  const out = alignLocalPort(CONFIG, 49906);
  assert.match(out, /localPort = 49906/);
  assert.match(out, /localIP = "127\.0\.0\.1"/);
  assert.match(out, /serverPort = 8000/, 'serverPort 不该被改');
  // 下划线写法也认
  assert.equal(alignLocalPort('local_port = 22', 6000), 'local_port = 6000');
});

test('保存配置时把 localPort 对齐到当前实际端口，并记启用', () => {
  const root = tempDir();
  const runner = createFrpcRunner({ root, portOf: () => 49906 });
  runner.saveConfig(CONFIG);
  const saved = fs.readFileSync(path.join(root, 'frpc.toml'), 'utf8');
  assert.match(saved, /localPort = 49906/, '写盘时就要把 localPort 改成实际端口');
  assert.equal(runner.shouldAutoStart(), true);
});

test('start 起进程、status 报运行中；进程退出后报已退出', async () => {
  const root = tempDir();
  const child = fakeChild();
  const runner = createFrpcRunner({
    root,
    portOf: () => 49906,
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => child,
  });
  runner.saveConfig(CONFIG);
  const started = await runner.start();
  assert.equal(started.running, true);
  assert.equal(started.pid, 4242);
  child.emit('close', 1, null);
  const after = runner.status();
  assert.equal(after.running, false);
  assert.match(after.error, /退出/);
});

test('退出原因取自 stdout：只收 stderr 或太早拼文案都会让这条变红', async () => {
  const root = tempDir();
  const child = fakeChild();
  const runner = createFrpcRunner({
    root,
    portOf: () => 49906,
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => child,
  });
  runner.saveConfig(CONFIG);
  await runner.start();
  // 若还监听 exit 并当场拼文案，这一发就会清掉进程、且收不到随后的输出。
  child.emit('exit', 1, null);
  assert.equal(runner.status().running, true, '退出出口已改为 close，exit 不该生效');
  // frpc 的致命原因（这里模拟 token 不匹配）写在 stdout，stderr 是空的。
  child.stdout.emit('data', '2026-11-17 10:00:00 [E] token in login does not match\n');
  child.emit('close', 1, null);
  const after = runner.status();
  assert.equal(after.running, false);
  assert.match(after.error, /token in login does not match/, 'stdout 上的原因必须带进文案');
});

test('stop 关掉进程、清启用标记', async () => {
  const root = tempDir();
  const runner = createFrpcRunner({ root, portOf: () => 49906, ensure: async () => ({ ok: true, path: '/fake/frpc' }), spawnImpl: () => fakeChild() });
  runner.saveConfig(CONFIG);
  await runner.start();
  assert.equal(runner.status().running, true);
  const stopped = await runner.clear();
  assert.equal(stopped.running, false);
  assert.equal(runner.shouldAutoStart(), false);
});

test('拿不到可执行文件：起不来但如实报原因，不抛', async () => {
  const root = tempDir();
  const runner = createFrpcRunner({ root, portOf: () => 49906, ensure: async () => ({ ok: false, message: '下载失败' }), spawnImpl: () => fakeChild() });
  runner.saveConfig(CONFIG);
  const st = await runner.start();
  assert.equal(st.running, false);
  assert.match(st.error, /下载失败/);
});

test('没有配置就启动：报「还没有导入」', async () => {
  const root = tempDir();
  const runner = createFrpcRunner({ root, portOf: () => 49906, ensure: async () => ({ ok: true, path: '/x' }), spawnImpl: () => fakeChild() });
  const st = await runner.start();
  assert.equal(st.running, false);
  assert.match(st.error, /配置/);
});

test('spawn 同步抛 UNKNOWN：换成能照着排查的话，不把原始 errno 甩给用户', async () => {
  const root = tempDir();
  const err = new Error('spawn UNKNOWN');
  err.code = 'UNKNOWN';
  const runner = createFrpcRunner({
    root,
    portOf: () => 49906,
    ensure: async () => ({ ok: true, path: 'C:\\Users\\x\\.dsh\\frpc\\frpc.exe' }),
    spawnImpl: () => { throw err; },
  });
  runner.saveConfig(CONFIG);
  const st = await runner.start();
  assert.equal(st.running, false);
  assert.match(st.error, /安全软件/, '要点明多半是安全软件拦截');
  assert.match(st.error, /信任名单|放行|匹配/, '要给出接下来能做的动作');
  assert.doesNotMatch(st.error, /^启动 frpc 失败：spawn UNKNOWN$/, '不该只剩原始报错');
});

test('withAdminPort 在 [[proxies]] 前补本机管理接口，已有就不动', () => {
  const out = withAdminPort(CONFIG, 17401);
  assert.match(out, /webServer\.port = 17401/);
  assert.ok(out.indexOf('webServer.port') < out.indexOf('[[proxies]]'), 'webServer 必须在 [[proxies]] 之前当顶层写');
  const existing = withAdminPort('webServer.port = 9000\n[[proxies]]\ntype = "tcp"', 17401);
  assert.match(existing, /9000/, '用户自己配了 webServer 就别覆盖');
});

test('discoverRemoteAddress 从管理接口读出服务端分配的公网地址', async () => {
  const root = tempDir();
  const child = fakeChild();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tcp: [{ name: 'x', status: 'running', remote_addr: '103.40.14.14:51543' }] }) });
  const runner = createFrpcRunner({ root, portOf: () => 49906, ensure: async () => ({ ok: true, path: '/x' }), spawnImpl: () => child, fetchImpl });
  runner.saveConfig(CONFIG);
  await runner.start();
  const addr = await runner.discoverRemoteAddress(2000);
  assert.equal(addr, '103.40.14.14:51543');
  assert.equal(runner.status().remoteAddress, '103.40.14.14:51543');
});

function retryClock() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimeoutImpl(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeoutImpl(key) { timers.delete(key); },
    async tick() {
      const entry = timers.entries().next().value;
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1].fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('异常退出按退避有限重启，主动停用取消待重试且清错误', async () => {
  const clock = retryClock();
  const children = [];
  const runner = createFrpcRunner({ root: tempDir(), portOf: () => 18787, ...clock,
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
  });
  runner.saveConfig(CONFIG);
  await runner.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    children.at(-1).emit('close', 1, null);
    assert.equal(runner.status().retrying, true);
    assert.equal([...clock.timers.values()][0].ms, delay);
    await clock.tick();
    assert.equal(runner.status().running, true);
  }
  children.at(-1).emit('close', 1, null);
  assert.equal(clock.timers.size, 0, '重试必须封顶');
  assert.equal(children.length, 6);
  await runner.clear();
  assert.equal(runner.shouldAutoStart(), false);
  assert.equal(runner.status().error, '');
  assert.equal(runner.status().retrying, false);
});

test('等待重试时 clear/dispose 均取消，clear 后宿主不再自动启动', async () => {
  for (const action of ['clear', 'dispose']) {
    const clock = retryClock();
    const child = fakeChild();
    const runner = createFrpcRunner({ root: tempDir(), portOf: () => 18787, ...clock,
      ensure: async () => ({ ok: true, path: '/fake/frpc' }), spawnImpl: () => child });
    runner.saveConfig(CONFIG);
    await runner.start();
    child.emit('close', 1, null);
    assert.equal(clock.timers.size, 1);
    await runner[action]();
    assert.equal(clock.timers.size, 0);
    assert.equal(runner.status().running, false);
    if (action === 'clear') assert.equal(runner.shouldAutoStart(), false);
  }
});

test('二进制仍在获取时停止，稍后完成也不能重新拉起；并发 start 只起一份', async () => {
  let release;
  let spawns = 0;
  const runner = createFrpcRunner({ root: tempDir(), portOf: () => 18787,
    ensure: () => new Promise((resolve) => { release = resolve; }),
    spawnImpl: () => { spawns += 1; return fakeChild(); },
  });
  runner.saveConfig(CONFIG);
  const first = runner.start();
  const second = runner.start();
  await runner.clear();
  release({ ok: true, path: '/fake/frpc' });
  await Promise.all([first, second]);
  assert.equal(spawns, 0);
  assert.equal(runner.status().running, false);
  assert.equal(runner.status().starting, false);
});

test('INI 不落运行配置和启用标记，JSON 保持格式、端口对齐及管理接口', async () => {
  const root = tempDir();
  const calls = [];
  const runner = createFrpcRunner({ root, portOf: () => 49906,
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: (_bin, args) => { calls.push(args); return fakeChild(); },
  });
  assert.throws(() => runner.saveConfig('[common]\nserver_addr = example.com\n[ssh]\nlocal_port = 22'), /INI.*TOML.*JSON/);
  assert.equal(runner.shouldAutoStart(), false);
  const file = runner.saveConfig(JSON.stringify({ serverAddr: 'example.com', proxies: [{ type: 'tcp', localPort: 22 }] }));
  assert.match(file, /frpc\.json$/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.proxies[0].localPort, 49906);
  assert.deepEqual(saved.webServer, { addr: '127.0.0.1', port: 17401 });
  await runner.start();
  assert.equal(calls[0][1], file);
  await runner.clear();
});

for (const [kind, config] of [
  ['TOML 点键', 'webServer.port = 9000\n' + CONFIG],
  ['TOML 管理表', 'serverAddr = "example.com"\n[webServer]\naddr = "127.0.0.1"\nport = 9000\n[[proxies]]\nlocalPort = 22'],
  ['JSON', JSON.stringify({ serverAddr: 'example.com', webServer: { addr: '127.0.0.1', port: 9000 }, proxies: [{ localPort: 22 }] })],
]) {
  test(`${kind} 已有管理端口9000用于真实发现，不覆盖用户配置`, async () => {
    const urls = [];
    const runner = createFrpcRunner({ root: tempDir(), portOf: () => 18787, ensure: async () => ({ ok: true, path: '/fake/frpc' }),
      spawnImpl: () => fakeChild(), fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => ({ tcp: [{ remote_addr: 'example.com:6000' }] }) }; },
    });
    const file = runner.saveConfig(config);
    await runner.start();
    assert.equal(await runner.discoverRemoteAddress(), 'example.com:6000');
    assert.deepEqual(urls, ['http://127.0.0.1:9000/api/status']);
    assert.match(fs.readFileSync(file, 'utf8'), /9000/);
    await runner.clear();
  });
}

test('每代异常重启重新发现动态地址并同步，停止后迟到的发现不得回写', async () => {
  const clock = retryClock();
  const children = [], published = [], responses = [];
  let address = 'example.com:6000';
  const runner = createFrpcRunner({ root: tempDir(), portOf: () => 18787, ...clock,
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
    fetchImpl: async () => new Promise((resolve) => responses.push(() => resolve({ ok: true, json: async () => ({ tcp: [{ remote_addr: address }] }) }))),
    onRemoteAddress: async (value, isCurrent) => { if (isCurrent()) published.push(value); },
  });
  runner.saveConfig(CONFIG);
  await runner.start(); responses.shift()(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ['example.com:6000']);
  children[0].emit('close', 1, null);
  address = 'example.com:7000';
  await clock.tick(); responses.shift()(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ['example.com:6000', 'example.com:7000']);
  assert.equal(runner.status().remoteAddress, 'example.com:7000');
  children[1].emit('close', 1, null);
  await clock.tick();
  await runner.clear();
  address = 'example.com:8000'; responses.shift()(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ['example.com:6000', 'example.com:7000']);
  assert.equal(runner.status().remoteAddress, '');
});

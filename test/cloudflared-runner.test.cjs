// Cloudflare 快速隧道 runner：banner 地址解析、起停状态、崩溃退避重连与用户开关标记回归。
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

function harness({ port = 49906, clock = {}, onAddress, ensure } = {}) {
  const children = [];
  const spawns = [];
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => port,
    ensureBin: ensure || (async () => ({ ok: true, path: '/fake/cloudflared' })),
    spawnImpl: (binary, args) => { spawns.push({ binary, args }); const child = fakeChild(); children.push(child); return child; },
    onAddress,
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
  assert.equal(st.running, true);
  assert.equal(st.pid, 4242);
  assert.equal(st.url, '');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['tunnel', '--url', 'http://127.0.0.1:49906', '--no-autoupdate']);
  children[0].stderr.emit('data', `${BANNER}\n`);
  assert.equal(runner.status().url, 'https://brave-lamp-trycloudflare.trycloudflare.com');
  assert.deepEqual(published, ['https://brave-lamp-trycloudflare.trycloudflare.com']);
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
  const got = [];
  runner.setAddressListener(async (value, isCurrent) => { if (isCurrent()) got.push(value); });
  assert.deepEqual(got, ['https://brave-lamp-trycloudflare.trycloudflare.com']);
});

test('崩溃按退避有限重连（用户仍开启），封顶后不再重试', async () => {
  const clock = retryClock();
  const { runner, children } = harness({ port: 18787, clock });
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
  await runner.stop();
  assert.equal(runner.shouldAutoStart(), false);
  assert.equal(runner.status().error, '');
  assert.equal(runner.status().retrying, false);
});

test('崩溃时 enabled 标记缺失则不重连', async () => {
  const clock = retryClock();
  const { runner, children } = harness({ port: 18787, clock });
  await runner.start();
  fs.rmSync(runner._paths.enabled, { force: true });
  children[0].emit('close', 1, null);
  assert.equal(runner.status().retrying, false, '没有用户开启标记就不该自动重连');
  assert.equal(clock.timers.size, 0);
  assert.match(runner.status().error, /cloudflared 已退出/);
});

test('stop 后清地址、删标记、不复活', async () => {
  const clock = retryClock();
  const { runner, children } = harness({ port: 18787, clock });
  await runner.start();
  children[0].stderr.emit('data', `${BANNER}\n`);
  assert.equal(runner.status().url, 'https://brave-lamp-trycloudflare.trycloudflare.com');
  const stopped = await runner.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.url, '');
  assert.equal(runner.shouldAutoStart(), false);
  children[0].emit('close', 1, null);
  assert.equal(runner.status().retrying, false, '用户 stop 后崩溃不能复活');
  assert.equal(clock.timers.size, 0);
  assert.equal(children.length, 1);
});

test('dispose 杀进程、清地址、解绑监听，但保留 enabled', async () => {
  const clock = retryClock();
  const child = fakeChild();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const got = [];
  const runner = createCloudflaredRunner({
    root: tempDir(),
    portOf: () => 49906,
    ensureBin: async () => ({ ok: true, path: '/fake/cloudflared' }),
    spawnImpl: () => child,
    onAddress: async (value, isCurrent) => { if (isCurrent()) got.push(value); },
    ...clock,
  });
  await runner.start();
  child.stderr.emit('data', `${BANNER}\n`);
  const st = runner.dispose();
  assert.equal(st.running, false);
  assert.equal(st.url, '');
  assert.equal(kills, 1);
  assert.equal(runner.shouldAutoStart(), true, 'dispose 不删 enabled，下次宿主启动还能自动起');
  child.stderr.emit('data', `${BANNER}\n`);
  assert.equal(runner.status().url, '', '解绑后旧输出不再写地址');
  assert.equal(clock.timers.size, 0);
});

test('shouldAutoStart 由 enabled 标记驱动', async () => {
  const { runner } = harness({});
  assert.equal(runner.shouldAutoStart(), false);
  await runner.start();
  assert.equal(runner.shouldAutoStart(), true);
  await runner.stop();
  assert.equal(runner.shouldAutoStart(), false);
});

test('拿不到二进制：起不来但如实报原因，不抛', async () => {
  const { runner, children } = harness({ ensure: async () => ({ ok: false, message: '下载失败' }) });
  const st = await runner.start();
  assert.equal(st.running, false);
  assert.match(st.error, /下载失败/);
  assert.equal(children.length, 0);
  assert.equal(runner.shouldAutoStart(), true, '用户已开启，标记要留着以便稍后重试');
});

test('extractTunnelUrl 只认 trycloudflare 地址，剥掉装饰符与尾斜杠', () => {
  assert.equal(extractTunnelUrl(`${BANNER}\n`), 'https://brave-lamp-trycloudflare.trycloudflare.com');
  assert.equal(extractTunnelUrl('  https://a-b.trycloudflare.com/  \n'), 'https://a-b.trycloudflare.com');
  assert.equal(extractTunnelUrl('https://example.com'), '');
  assert.equal(extractTunnelUrl('nothing here'), '');
});

// 桌面助手只在明确不支持时停用，探测超时和意外退出均有界退避恢复。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { createRemoteTunnelHelper, resolveRemoteBinary } = require('../lib/remote/tunnel-helper.cjs');

function fakeProcess(handler) {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.stdout = new PassThrough();
  proc.commands = [];
  proc.killed = false;
  let buffer = '';
  proc.reply = value => proc.stdout.write(`${JSON.stringify(value)}\n`);
  proc.exit = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } };
  proc.kill = () => { proc.killed = true; proc.exit(); };
  proc.stdin = new Writable({ write(chunk, encoding, done) {
    buffer += String(chunk);
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const command = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      proc.commands.push(command);
      if (command.command === 'remoteCapabilities') queueMicrotask(() => handler?.capabilities
        ? handler.capabilities(proc, command) : proc.reply({ event: 'remoteResult', requestId: command.requestId, ok: true, result: { version: 1, tailcat: true, p2p: true } }));
      else if (command.command) handler?.command?.(proc, command);
    }
    done();
  } });
  proc.stdin.on('finish', proc.exit);
  return proc;
}

const reply = (proc, command, result) => proc.reply({ event: 'remoteResult', requestId: command.requestId, ok: true, result });

test('桌面助手按显式覆盖、包内产物、源码构建、平台包顺序选择', () => {
  const root = path.resolve('remote-helper-fixture');
  const packageRoot = path.join(root, 'dsh-mobile-plugin');
  const marker = path.join(root, 'tailcat-host', 'runtime-version.json');
  const binary = path.join(root, 'build', 'tailcat-runtime', 'darwin-arm64', 'dsh-tailcat-host');
  const bundled = path.join(packageRoot, 'native', 'darwin-arm64', 'dsh-tailcat-host');
  const existing = new Set([marker, binary, bundled, '/explicit-helper']);
  const options = { root, packageRoot, env: {}, platformId: 'darwin-arm64', exists: file => existing.has(file), fallback: () => 'platform-helper' };
  assert.equal(resolveRemoteBinary(options), bundled);
  assert.equal(resolveRemoteBinary({ ...options, env: { DSHM_REMOTE_TUNNEL_HELPER: '/explicit-helper' } }), '/explicit-helper');
  existing.delete(marker);
  assert.equal(resolveRemoteBinary(options), bundled, 'profile安装不依赖源码标志');
  existing.delete(bundled);
  assert.equal(resolveRemoteBinary(options), 'platform-helper', '发布目录不能误用外部构建目录');
  existing.add(marker);
  assert.equal(resolveRemoteBinary(options), binary);
  existing.delete(marker);
  assert.equal(resolveRemoteBinary({ ...options, env: { DSHM_REMOTE_TUNNEL_HELPER: '/missing-helper' } }), 'platform-helper');
});

test('Windows ARM64 上按 dsh-tailcat-host.exe 找包内助手', () => {
  const root = path.resolve('remote-helper-fixture');
  const packageRoot = path.join(root, 'dsh-mobile-plugin');
  const expected = path.join(packageRoot, 'native', 'win32-arm64', 'dsh-tailcat-host.exe');
  const got = resolveRemoteBinary({
    root, packageRoot, env: {}, platformId: 'win32-arm64',
    exists: file => file === expected, fallback: () => 'platform-helper',
  });
  assert.equal(got, expected, 'Win ARM64 的助手文件名要带 .exe');
});

test('并发调用按 requestId 关联，私钥错误不回显', async () => {
  const waiting = [];
  const proc = fakeProcess({ command(proc, command) {
    waiting.push(command);
    if (waiting.length === 2) {
      reply(proc, waiting[1], { name: 'second' });
      reply(proc, waiting[0], { name: 'first' });
    }
  } });
  const helper = createRemoteTunnelHelper({ resolve: () => 'helper', spawn: () => proc });
  const [first, second] = await Promise.all([
    helper.request('remoteP2PPath', { deviceId: 'a' }), helper.request('remoteP2PPath', { deviceId: 'b' }),
  ]);
  assert.equal(first.name, 'first'); assert.equal(second.name, 'second');
  const bad = helper.request('remoteTailcatKey', { deviceId: 'a', privateKey: 'top-secret' });
  await new Promise(resolve => setImmediate(resolve));
  const command = proc.commands.at(-1);
  proc.reply({ event: 'remoteResult', requestId: command.requestId, ok: false, code: 'bad top-secret' });
  await assert.rejects(bad, error => error.message === 'remote-helper-request');
  await helper.close();
});

test('旧助手明确拒绝时禁用新增能力，后续调用不重复拉起', async () => {
  const proc = fakeProcess({ capabilities(proc) { proc.reply({ event: 'error', code: 'invalid-command' }); } });
  let launches = 0;
  const helper = createRemoteTunnelHelper({ resolve: () => 'old-helper', spawn: () => { launches++; return proc; } });
  await assert.rejects(helper.request('remoteP2PKeys', { deviceId: 'a' }), /remote-helper-unsupported/);
  await assert.rejects(helper.request('remoteP2PKeys', { deviceId: 'a' }), /remote-helper-unsupported/);
  assert.equal(launches, 1);
  assert.equal(helper.status().available, false);
  assert.equal(proc.killed, true);
  await helper.close();
});

// 能力探测无响应可能只是本机启动迟缓；只有明确旧协议拒绝才永久停用。
test('能力探测超时退避重拉，恢复后后续设备可使用', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const helper = createRemoteTunnelHelper({ resolve: () => 'helper', capabilityTimeoutMs: 20, spawn: () => {
    const proc = fakeProcess(children.length === 0 ? { capabilities() {} } : {
      command(proc, command) { reply(proc, command, { public: 'recovered' }); },
    });
    children.push(proc); return proc;
  } });
  try {
    const pending = assert.rejects(helper.request('remoteP2PKeys', { deviceId: 'a' }), /remote-helper-capability-timeout/);
    await new Promise(setImmediate);
    t.mock.timers.tick(20); await pending;
    assert.equal(helper.status().available, true);
    assert.equal(helper.status().restarting, true);
    assert.equal(children[0].killed, true);
    await assert.rejects(helper.request('remoteP2PKeys', { deviceId: 'b' }), /remote-helper-restarting/);
    t.mock.timers.tick(999); assert.equal(children.length, 1);
    t.mock.timers.tick(1); await new Promise(setImmediate);
    assert.equal(children.length, 2);
    assert.equal((await helper.request('remoteP2PKeys', { deviceId: 'b' })).public, 'recovered');
  } finally { await helper.close(); }
});

test('变异：能力超时改回永久不支持会被可恢复状态拒绝', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = path.join(__dirname, '../lib/remote/tunnel-helper.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const marker = "command === 'remoteCapabilities' ? 'remote-helper-capability-timeout'";
  assert.ok(source.includes(marker));
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source.replace(marker, "command === 'remoteCapabilities' ? 'remote-helper-unsupported'"))(createRequire(file), loaded, loaded.exports);
  const helper = loaded.exports.createRemoteTunnelHelper({ resolve: () => 'helper', spawn: () => fakeProcess({ capabilities() {} }), capabilityTimeoutMs: 20 });
  try {
    const rejected = helper.request('remoteP2PKeys', { deviceId: 'phone' }).catch(error => error);
    await new Promise(setImmediate); t.mock.timers.tick(20); await rejected;
    assert.throws(() => assert.equal(helper.status().available, true), assert.AssertionError);
  } finally { await helper.close(); }
});

test('单设备请求超时排队清理该设备，关闭拒绝未完成请求', async () => {
  const proc = fakeProcess();
  const helper = createRemoteTunnelHelper({ resolve: () => 'helper', spawn: () => proc, timeoutMs: 20 });
  await assert.rejects(helper.request('remoteP2PStart', { deviceId: 'a' }), /remote-helper-timeout/);
  assert.equal(proc.commands.at(-1).command, 'remoteClose');
  assert.equal(proc.commands.at(-1).deviceId, 'a');
  assert.equal(proc.killed, false, '不能因 a 超时杀掉所有电脑的助手');
  const pending = helper.request('remoteP2PPath', { deviceId: 'b' });
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, /remote-helper-closed/);
  await helper.close(); await rejected;
});


test('意外退出退避重拉且通知新代次，关闭后取消重拉', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = []; const states = [];
  const helper = createRemoteTunnelHelper({ resolve: () => 'helper', spawn: () => {
    const proc = fakeProcess({ command(proc, command) { reply(proc, command, { path: 'direct' }); } });
    children.push(proc); return proc;
  } });
  helper.onChange(state => states.push(state));
  await helper.request('remoteP2PPath', { deviceId: 'a' });
  children[0].exit();
  assert.equal(helper.status().running, false);
  assert.equal(helper.status().restarting, true);
  await assert.rejects(helper.request('remoteP2PPath', { deviceId: 'a' }), /remote-helper-restarting/);
  t.mock.timers.tick(999); assert.equal(children.length, 1);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.equal(children.length, 2);
  assert.ok(states.some(state => state.ready && state.generation === 2));
  children[1].exit(); await helper.close();
  t.mock.timers.tick(30000); assert.equal(children.length, 2);
});

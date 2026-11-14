'use strict';
// 远程电脑桌面端启动出口：平台识别、可执行文件定位与固定启动参数。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORM_IDS, SHELL_UNAVAILABLE, platformId, binaryPath, resolveShell, buildArgs, launchShell } = require('../lib/remote/shell.cjs');

const LOCAL_URL = 'http://127.0.0.1:49152/?ticket=once';
const BINARY = '/fake/dsh-mobile-shell';

/** 只记录调用，不起真进程；子进程句柄也给齐，unref 那条路能走完。 */
function fakeSpawn(calls) {
  return (binary, args, options) => {
    calls.push({ binary, args, options });
    return { on() {}, unref() {} };
  };
}

test('platformId 只认五个分发平台，其余平台一律不认', () => {
  assert.deepEqual(PLATFORM_IDS, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
  for (const [platform, arch, expected] of [
    ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'x64', 'linux-x64'], ['linux', 'arm64', 'linux-arm64'], ['win32', 'x64', 'win32-x64'],
  ]) assert.equal(platformId(platform, arch), expected);
  for (const [platform, arch] of [['freebsd', 'x64'], ['win32', 'arm64'], ['darwin', 'ia32'], ['linux', 'ppc64']]) {
    assert.equal(platformId(platform, arch), undefined);
  }
});

test('平台包内可执行文件按统一契约分三种形态', () => {
  assert.equal(binaryPath('win32-x64'), 'dsh-mobile-shell.exe');
  assert.equal(binaryPath('linux-x64'), 'dsh-mobile-shell');
  assert.equal(binaryPath('linux-arm64'), 'dsh-mobile-shell');
  assert.equal(binaryPath('darwin-arm64'), 'dsh-mobile-shell.app/Contents/MacOS/dsh-mobile-shell');
  assert.equal(binaryPath('darwin-x64'), 'dsh-mobile-shell.app/Contents/MacOS/dsh-mobile-shell');
});

test('resolveShell 找不到平台包时返回 null，不抛错', () => {
  assert.equal(resolveShell({ platform: 'freebsd', arch: 'x64', exists: () => false }), null);
  assert.equal(resolveShell({ platform: 'darwin', arch: 'arm64', exists: () => false,
    paths: ['/not-installed'], env: {}, devRoot: '/not-built' }), null);
});

test('插件自带的 native/desktop-shell 能找到可执行文件', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = binaryPath('darwin-arm64');
  const binary = path.join(root, 'darwin-arm64', relative);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'stub');
  assert.equal(resolveShell({ platform: 'darwin', arch: 'arm64', env: {}, nativeRoot: root }), binary);
});

test('buildArgs 固定两项，设备名缺省为空串', () => {
  assert.deepEqual(buildArgs({ url: LOCAL_URL }), [`--remote-url=${LOCAL_URL}`, '--device-name=']);
  assert.deepEqual(buildArgs({ url: LOCAL_URL, deviceName: '出门电脑' }),
    [`--remote-url=${LOCAL_URL}`, '--device-name=出门电脑']);
});

test('launchShell 只把两个固定参数交给可执行文件，不经 shell', () => {
  const calls = [];
  launchShell({ url: LOCAL_URL, deviceName: '出门电脑' }, { resolve: () => BINARY, spawn: fakeSpawn(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, BINARY);
  assert.deepEqual(calls[0].args, [`--remote-url=${LOCAL_URL}`, '--device-name=出门电脑']);
  assert.equal(calls[0].args.length, 2);
  assert.ok(!calls[0].options.shell);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
});

test('平台包不可用或进程起不来时报 SHELL_UNAVAILABLE，不启动别的进程', () => {
  const calls = [];
  assert.throws(() => launchShell({ url: LOCAL_URL }, { resolve: () => null, spawn: fakeSpawn(calls) }),
    error => error.code === SHELL_UNAVAILABLE);
  assert.throws(() => launchShell({ url: LOCAL_URL }, {
    resolve: () => BINARY, spawn: () => { throw new Error('ENOENT'); },
  }), error => error.code === SHELL_UNAVAILABLE);
  assert.equal(calls.length, 0);
});

test('地址不是本机一次性入口时不启动进程', () => {
  const calls = [];
  for (const url of ['https://outside.example/', 'http://localhost:49152/', 'http://127.0.0.1/',
    'http://user:pass@127.0.0.1:49152/', 'javascript:alert(1)', undefined, '']) {
    assert.throws(() => launchShell({ url }, { resolve: () => BINARY, spawn: fakeSpawn(calls) }));
  }
  assert.equal(calls.length, 0);
});

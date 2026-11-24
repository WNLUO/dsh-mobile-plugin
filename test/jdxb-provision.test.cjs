// 节点小宝设备端的安装：自己下载、装成系统服务、拉起；授权取消与下载坏了都要说真话。
'use strict';

/**
 * 这一步的价值是「用户不用碰命令行」。守卫要钉的也正是这点：
 *   ① 装的是官方地址、写的是 launchd 自己的 Label；
 *   ② 安装动作必须走系统授权（`with administrator privileges`），不能悄悄以 root 跑；
 *   ③ 用户取消 / 下到网页 / 装完没起来，三种失败各自如实回报，不报成功。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROVISION = path.join(__dirname, '..', 'lib', 'jdxb', 'provision.cjs');
const provision = require(PROVISION);

/** 一个最小的 Mach-O 头，够 `looksLikeMachO` 认出来。官方给的是小端 64 位，测试也照这个来。 */
function macho() {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(0xcffaedfe, 0);
  return buffer;
}

function fakeRun(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    return result;
  };
  return { calls, run };
}

test('平台表：mac / Windows x64 / Linux 两种架构都有安装入口，别的平台如实说不支持', () => {
  assert.equal(provision.platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(provision.platformKey('darwin', 'x64'), 'darwin-x64');
  assert.equal(provision.platformKey('win32', 'x64'), 'win32-x64');
  assert.equal(provision.platformKey('linux', 'x64'), 'linux-x64');
  assert.equal(provision.platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(provision.platformKey('win32', 'ia32'), '');
  assert.equal(provision.platformKey('darwin', 'ia32'), '');
  const result = provision.install({ platform: 'win32', arch: 'ia32' });
  return result.then((r) => {
    assert.equal(r.ok, false);
    assert.match(r.error, /只接了/);
  });
});

test('下载地址：macOS 是官方二进制，Windows / Linux 是官方一键安装脚本', () => {
  assert.equal(provision.downloadUrl('darwin-arm64').endsWith('/NodeBabyLinkService.darwin.arm64.4.3.5'), true);
  assert.equal(provision.downloadUrl('darwin-x64').endsWith('/NodeBabyLinkService.darwin.amd64.4.3.5'), true);
  assert.equal(provision.downloadUrl('win32-x64'), 'https://iepose.com/install.ps1');
  assert.equal(provision.downloadUrl('linux-x64'), 'https://iepose.com/install.sh');
  assert.equal(provision.downloadUrl('linux-arm64'), 'https://iepose.com/install.sh');
});

test('装成功：走系统授权、写的是它自己的 Label，装完等管理口应答', async () => {
  const { calls, run } = fakeRun();
  const probed = [];
  const result = await provision.install({
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => macho() }),
    run,
    probePort: async (port) => { probed.push(port); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  const osa = calls.find((call) => call.file === 'osascript');
  assert.ok(osa, '必须经 osascript 走系统授权');
  assert.match(osa.args.join(' '), /with administrator privileges/, '不能绕过系统授权');
  assert.equal(probed[0], 2080, '装完等它的本地管理口');
});

test('用户取消授权：不报成功，也不把「取消」说成「装坏了」', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' });
  const result = await provision.install({
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => macho() }),
    run,
    probePort: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
});

test('下到的不是可执行文件：当场拒装，别把网页存成系统服务', async () => {
  const { calls, run } = fakeRun();
  const result = await provision.install({
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>blocked</html>') }),
    run,
    probePort: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /可执行文件/);
  assert.equal(calls.some((call) => call.file === 'osascript'), false, '没验过就不该去提权');
});

test('装好了但管理口没起来：如实报「没起来」，不假装可用', async () => {
  const { run } = fakeRun();
  const result = await provision.install({
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => macho() }),
    run,
    probePort: async () => ({ ok: false }),
    waitMs: 1,
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.installed, true);
  assert.equal(result.started, false);
  assert.match(result.error, /没起来/);
});

test('Windows：跑官方 PowerShell 脚本并经 UAC 提权，装完问它的虚拟回环', async () => {
  const { calls, run } = fakeRun();
  const probed = [];
  const result = await provision.install({
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://iepose.com/install.ps1');
      return { ok: true, arrayBuffer: async () => Buffer.from('$ErrorActionPreference = "Stop"\nWrite-Output "install"\n') };
    },
    probeStatus: async () => ({ installed: false }),
    run,
    probePort: async (port, opts) => { probed.push({ port, host: opts.host }); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  const ps = calls.find((call) => call.file === 'powershell.exe');
  assert.ok(ps, '必须经 PowerShell 提权，不能悄悄跑脚本');
  assert.match(ps.args.join(' '), /-Verb RunAs/, '必须弹 UAC');
  assert.match(ps.args.join(' '), /-File/, '跑的是下载下来的官方脚本');
  assert.equal(probed[0].host, '127.66.36.18');
  assert.equal(probed[0].port, 2080);
});

test('Linux：跑官方安装脚本并经 pkexec 弹授权，装完问 9118', async () => {
  const { calls, run } = fakeRun();
  const probed = [];
  const result = await provision.install({
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://iepose.com/install.sh');
      return { ok: true, arrayBuffer: async () => Buffer.from('#!/bin/bash\necho install\n') };
    },
    probeStatus: async () => ({ installed: false }),
    run,
    probePort: async (port, opts) => { probed.push({ port, host: opts.host }); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  const pk = calls.find((call) => call.file === 'pkexec');
  assert.ok(pk, '必须经 pkexec 弹系统授权框');
  assert.equal(pk.args[0], 'bash');
  assert.equal(probed[0].port, 9118);
});

test('已经装了就不重复跑官方脚本（它会进卸载 / 升级菜单）', async () => {
  const { calls, run } = fakeRun();
  const result = await provision.install({
    platform: 'win32',
    arch: 'x64',
    probeStatus: async () => ({ installed: true }),
    fetchImpl: async () => { throw new Error('不该下载'); },
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0);
});

test('Windows 取消 UAC：不报成功，也不说成装坏了', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: 'canceled by the user' });
  const result = await provision.install({
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('Write-Output "install"') }),
    probeStatus: async () => ({ installed: false }),
    run,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /取消/);
});

test('安装脚本被门户换成网页：当场拒装，不去提权', async () => {
  const { calls, run } = fakeRun();
  const result = await provision.install({
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<!doctype html><html>blocked</html>') }),
    probeStatus: async () => ({ installed: false }),
    run,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /安装脚本/);
  assert.equal(calls.some((call) => call.file === 'pkexec'), false);
});
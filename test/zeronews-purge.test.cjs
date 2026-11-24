// 2026-11-24：需求变了——彻底清理不再提示用户开终端，macOS 改走系统授权框跑 reset，
// 因此这里相应改断言：钉住「必须走 osascript + with administrator privileges」、取消单独报、留缓存。
// ZeroNews 彻底清理：reset 失败必须留住缓存二进制供手动重试，成功才删。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { purgeZeroNews, runElevatedReset, RESET_TIMEOUT_MS } = require('../lib/zeronews/purge.cjs');

const ROOT = '/tmp/dsh-zeronews-purge-test';
const CACHED = path.join(ROOT, 'zeronews');
const SYSTEM_BIN = '/Applications/zeronews/zeronews';

function harness({ resetOk = true, located = true, rmThrows = false, resetStderr = 'need administrator privileges', platform = 'darwin' } = {}) {
  const commands = [];
  const removed = [];
  return {
    commands,
    removed,
    options: {
      root: ROOT,
      platform: { platform },
      fsImpl: {
        rmSync(target, opts) {
          if (rmThrows) throw new Error('permission denied');
          removed.push([target, opts]);
        },
      },
      locate: async () => (located ? { ok: true, path: SYSTEM_BIN, source: 'system' } : { ok: false, path: '', code: 'not-installed' }),
      run: async (bin, args, opts) => {
        commands.push([bin, args, opts]);
        return resetOk
          ? { code: 0, stdout: 'reset ok', stderr: '' }
          : { code: 1, stdout: '', stderr: resetStderr };
      },
    },
  };
}

test('macOS 上 reset 走系统授权框，成功才删插件缓存的客户端', async () => {
  const h = harness();
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.reset.attempted, true);
  assert.equal(result.reset.ok, true);
  assert.equal(h.commands[0][0], 'osascript', '经 osascript 走系统授权，不让用户开终端');
  assert.match(h.commands[0][1][1], /with administrator privileges/, '不能绕过系统授权');
  assert.equal(h.commands[0][2].timeoutMs, RESET_TIMEOUT_MS);
  assert.deepEqual(h.removed, [[CACHED, { force: true }]], '只删缓存那份，系统安装的不碰');
  assert.equal(result.cacheRemoved, true);
  assert.equal(result.error, '');
});

test('提权脚本内容是定位到的客户端 + reset，跑完删掉临时脚本', async () => {
  let scriptText = '';
  let scriptPath = '';
  const run = async (bin, args) => {
    assert.equal(bin, 'osascript');
    const matched = /do shell script "sh (.+)" with administrator privileges/.exec(args[1]);
    assert.ok(matched, 'osascript 里是 sh 一段脚本');
    scriptPath = matched[1];
    scriptText = fs.readFileSync(scriptPath, 'utf8');
    return { code: 0, stdout: '', stderr: '' };
  };
  await runElevatedReset(SYSTEM_BIN, { run });
  assert.ok(scriptText.includes(`'${SYSTEM_BIN}' reset`), '脚本里是单引号包住的客户端路径 + reset');
  assert.equal(fs.existsSync(scriptPath), false, '临时脚本跑完即删');
});

test('reset 失败：如实报错、留住缓存二进制，提示重新点按钮而非开终端', async () => {
  const h = harness({ resetOk: false });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reset.ok, false);
  assert.match(result.error, /administrator privileges/);
  assert.match(result.error, /重新点/);
  assert.doesNotMatch(result.error, /终端/);
  assert.deepEqual(h.removed, [], 'reset 没成功就绝不能删掉最后一份二进制');
});

test('用户取消系统授权：报「没通过授权」而不是报「reset 失败」，留住缓存', async () => {
  const h = harness({ resetOk: false, resetStderr: 'execution error: User canceled. (-128)' });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.match(result.reset.error, /没有通过系统授权/);
  assert.match(result.error, /授权没通过/);
  assert.deepEqual(h.removed, []);
});

test('Windows：走 UAC 提权，不经 osascript', async () => {
  const h = harness({ platform: 'win32' });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true, 'UAC 成功就算重置成功');
  assert.equal(h.commands[0][0], 'powershell.exe', '经 PowerShell 弹 UAC');
  const script = h.commands[0][1].join(' ');
  assert.match(script, /-Verb RunAs/, '必须走 UAC 提权，不能绕过');
  assert.match(script, /'reset'/, '跑的是官方 reset');
  assert.equal(h.commands.some((c) => c[0] === 'osascript'), false, 'Windows 不用 macOS 的授权框');
});

test('Windows 用户拒绝 UAC：报「没通过授权」，留住缓存', async () => {
  const h = harness({ platform: 'win32', resetOk: false, resetStderr: 'The operation was canceled by the user' });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /授权没通过/);
  assert.deepEqual(h.removed, []);
});

test('Linux：走 pkexec 弹 polkit 授权框，路径作独立参数不经 shell', async () => {
  const h = harness({ platform: 'linux' });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true);
  assert.equal(h.commands[0][0], 'pkexec', '经 pkexec 弹授权框');
  assert.deepEqual(h.commands[0][1], [SYSTEM_BIN, 'reset'], '路径单独作参数，免 shell 注入');
  assert.equal(h.commands.some((c) => c[0] === 'osascript'), false, 'Linux 不用 macOS 的授权框');
});

test('Linux 用户拒绝 polkit 授权：报「没通过授权」，留住缓存', async () => {
  const h = harness({ platform: 'linux', resetOk: false, resetStderr: 'Not authorized: dismissed' });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /授权没通过/);
  assert.deepEqual(h.removed, []);
});

test('本机没装客户端：跳过 reset，仍清掉缓存残留', async () => {
  const h = harness({ located: false });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.reset.attempted, false);
  assert.deepEqual(h.commands, [], '没二进制就不跑命令');
  assert.deepEqual(h.removed, [[CACHED, { force: true }]]);
});

test('缓存删不掉：如实报，不让界面说已经清理干净', async () => {
  const h = harness({ rmThrows: true });
  const result = await purgeZeroNews(h.options);
  assert.equal(result.ok, false);
  assert.equal(result.reset.ok, true, '身份已经重置成功');
  assert.match(result.error, /permission denied/);
  assert.equal(result.cacheRemoved, false);
});

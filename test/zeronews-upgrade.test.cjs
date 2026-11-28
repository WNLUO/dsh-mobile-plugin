// 2026-11-28：客户端换代守卫：新版预热、验版本、空档切换、起不来换回旧版。
// ZeroNews 客户端换代：下载 / 校验 / 原子换 / 回滚 / 断点收尾，用注入假体走完整条分支。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseVersion, compareVersions, pathsOf, createClientUpdater,
} = require('../lib/zeronews/upgrade.cjs');
const { mountZeroNews } = require('../lib/zeronews/wiring.cjs');

/** 临时目录里放一份「旧版客户端」，所有换代动作都在它旁边发生。 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-upgrade-'));
  const binary = path.join(dir, 'zeronews');
  fs.writeFileSync(binary, 'old-binary', { mode: 0o755 });
  return { dir, binary };
}

/** 假下载：把内容写到目标路径，模拟官方下载地址回来一份新文件。 */
function fakeDownload(body = 'new-binary') {
  const calls = [];
  const download = async (dest) => {
    calls.push(dest);
    fs.writeFileSync(dest, body, { mode: 0o755 });
    return { ok: true, path: dest };
  };
  return { download, calls };
}

/** 假 `--version`：按可执行文件路径回版本号，模拟「旧版 4.1.0、新版 4.1.1」。 */
function fakeRun(versions) {
  return async (binary) => {
    const body = (() => { try { return fs.readFileSync(binary, 'utf8'); } catch { return ''; } })();
    const version = versions[body];
    if (!version) return { code: 1, stdout: '', stderr: 'boom' };
    return { code: 0, stdout: `zeronews version zeronews ${version}`, stderr: '' };
  };
}

test('版本号解析与比较：只比三段数字，读不出的当 0', () => {
  assert.equal(parseVersion('zeronews version zeronews 4.1.1'), '4.1.1');
  assert.equal(parseVersion('v4.10.2\n'), '4.10.2');
  assert.equal(parseVersion('no version here'), '');
  assert.equal(compareVersions('4.1.1', '4.1.0'), 1);
  assert.equal(compareVersions('4.1.0', '4.1.1'), -1);
  assert.equal(compareVersions('4.1.1', '4.1.1'), 0);
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1, '按数字比，不按字符串比');
  assert.equal(compareVersions('', '4.1.1'), -1);
});

test('预热：新版下到 .next 并通过版本校验，旧版原样还在', async () => {
  const { binary } = sandbox();
  const { next } = pathsOf(binary);
  const { download, calls } = fakeDownload();
  const updater = createClientUpdater({ desiredVersion: '4.1.1', download, run: fakeRun({ 'old-binary': '4.1.0', 'new-binary': '4.1.1' }) });
  const staged = await updater.stage(binary);
  assert.equal(staged.ok, true);
  assert.equal(staged.version, '4.1.1');
  assert.deepEqual(calls, [next], '新版只能写到 .next，别碰正在跑的那份');
  assert.equal(fs.readFileSync(binary, 'utf8'), 'old-binary', '预热阶段旧版一个字节都不动');
  assert.equal(await updater.stagedVersion(binary), '4.1.1');
});

test('官方地址回来的还是同一版：不切，把 .next 删掉', async () => {
  const { binary } = sandbox();
  const { download } = fakeDownload();
  const updater = createClientUpdater({ desiredVersion: '4.1.1', download, run: fakeRun({ 'old-binary': '4.1.1', 'new-binary': '4.1.1' }) });
  const staged = await updater.stage(binary);
  assert.equal(staged.ok, false);
  assert.equal(staged.error, 'not-newer');
  assert.equal(fs.existsSync(pathsOf(binary).next), false);
});

test('新版跑不起来（验不出版本）：不当成功，删掉 .next', async () => {
  const { binary } = sandbox();
  const { download } = fakeDownload('broken-binary');
  const updater = createClientUpdater({ desiredVersion: '4.1.1', download, run: fakeRun({ 'old-binary': '4.1.0' }) });
  const staged = await updater.stage(binary);
  assert.equal(staged.ok, false);
  assert.match(staged.error, /运行不起来/);
  assert.equal(fs.existsSync(pathsOf(binary).next), false);
});

test('切换是两次 rename：旧版退到 .prev，新版顶上；回滚能换回来', async () => {
  const { binary } = sandbox();
  const { next, prev } = pathsOf(binary);
  fs.writeFileSync(next, 'new-binary', { mode: 0o755 });
  const updater = createClientUpdater({ desiredVersion: '4.1.1', run: fakeRun({}) });
  const applied = updater.apply(binary);
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'new-binary');
  assert.equal(fs.readFileSync(prev, 'utf8'), 'old-binary', '旧版留着，回滚靠它');
  assert.equal(fs.existsSync(next), false);

  const back = updater.rollback(binary);
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'old-binary');
  assert.equal(fs.existsSync(prev), false);
});

test('切换断在两个 rename 中间：下次启动把旧版挪回原位', async () => {
  const { binary } = sandbox();
  const { prev } = pathsOf(binary);
  // 现场：旧版已经改名、新版还没顶上，可执行文件位置空着。
  fs.renameSync(binary, prev);
  const updater = createClientUpdater({ desiredVersion: '4.1.1', run: fakeRun({}) });
  assert.equal(updater.recover(binary), 'restored');
  assert.equal(fs.readFileSync(binary, 'utf8'), 'old-binary');
  assert.equal(fs.existsSync(prev), false);
});

test('没有可执行文件就不去下载：别在盘上留一个来路不明的文件', async () => {
  const { binary } = sandbox();
  fs.rmSync(binary);
  const { download, calls } = fakeDownload();
  const updater = createClientUpdater({ desiredVersion: '4.1.1', download, run: fakeRun({}) });
  const staged = await updater.stage(binary);
  assert.equal(staged.ok, false);
  assert.deepEqual(calls, []);
});

/** 换代在接线层的那一拍：假跑器 + 假换代器，只看「什么时候换、换失败怎么办」。 */
function upgradeHarness({ connections, secondStart }) {
  const events = [];
  let phase = 'connected';
  let starts = 0;
  const runner = {
    start: async () => {
      starts += 1;
      phase = starts === 1 ? 'connected' : secondStart;
      return { phase, url: phase === 'connected' ? 'https://old.example.com' : '', binary: '/fake/zeronews' };
    },
    stop: () => { events.push('stop'); phase = 'off'; return { phase: 'off' }; },
    status: () => ({ phase, url: phase === 'connected' ? 'https://old.example.com' : '', binary: '/fake/zeronews' }),
    checkAlive: async () => ({ phase, url: phase === 'connected' ? 'https://old.example.com' : '' }),
  };
  const updater = {
    desiredVersion: '4.1.1',
    recover: () => '',
    versionOf: async () => '4.1.0',
    stagedVersion: async () => '4.1.1',
    stage: async () => { events.push('stage'); return { ok: true, version: '4.1.1' }; },
    shutdown: async () => { events.push('shutdown'); },
    apply: () => { events.push('apply'); return { ok: true }; },
    rollback: () => { events.push('rollback'); return { ok: true }; },
    cleanup: () => { events.push('cleanup'); },
  };
  let cleanupFn = null;
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({ zeroNewsEnabled: true, zeroNewsUrl: 'https://old.example.com' }),
    control: {},
    warn: () => {},
    ctx: { effect: (fn) => { cleanupFn = fn(); return () => {}; } },
    name: 'test',
    portOf: () => 18787,
    retryBaseMs: 5,
    healthCheckMs: 5,
    runnerFactory: () => runner,
    ensure: async () => ({ ok: true, path: '/fake/zeronews' }),
    updaterFactory: () => updater,
    activeMuxConnections: () => connections,
  });
  return { facade, events, cleanup: () => cleanupFn && cleanupFn() };
}

const ticks = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test('有手机连着就不换客户端：等下一拍空档', async (t) => {
  const env = upgradeHarness({ connections: 1, secondStart: 'connected' });
  t.after(env.cleanup);
  await ticks();
  assert.equal(env.events.includes('apply'), false, '有人在用的时候绝不能断线换版本');
  assert.equal(env.events.includes('shutdown'), false);
});

test('没人连着就换上去：停旧版、换文件、新版连上后删旧版', async (t) => {
  const env = upgradeHarness({ connections: 0, secondStart: 'connected' });
  t.after(env.cleanup);
  await ticks();
  assert.ok(env.events.includes('shutdown'), '先让旧客户端自己退出');
  assert.ok(env.events.includes('apply'), '再动盘换文件');
  assert.ok(env.events.includes('cleanup'), '新版连上了才删旧版');
  assert.equal(env.events.includes('rollback'), false);
});

test('新版本起不来：换回旧版再起，不让用户停在「升级后没线路」', async (t) => {
  const env = upgradeHarness({ connections: 0, secondStart: 'error' });
  t.after(env.cleanup);
  await ticks();
  assert.ok(env.events.includes('apply'));
  assert.ok(env.events.includes('rollback'), '新版连不上必须回滚');
  assert.equal(env.events.includes('cleanup'), false, '没连上就别删旧版');
  await ticks();
  assert.equal(env.events.filter((e) => e === 'apply').length, 1, '同一版起不来就不要再拿它反复折腾');
});

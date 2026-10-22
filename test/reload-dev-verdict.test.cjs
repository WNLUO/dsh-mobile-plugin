'use strict';

/**
 * 守卫：开发机同步脚本的收尾判据（`scripts/lib/reload-verdict.mjs`）。
 *
 * 起因：脚本原来只要宿主答了 200 就打一个 ✔。两种「热重载了但没生效」都过得了那道判据 ——
 * 装载失败时外壳已经把上一代回滚装回去了（接口照样答得出来），盘上那份也可能被别处的重装
 * 换回冻结的 tgz 快照。人看到的是「明明热重载了，过一阵又是旧版本」，而脚本全程没红。
 *
 * 这里钉住三条：跑着的必须等于盘上、盘上整包同步后必须等于仓库、装载记了错误就算失败；
 * 外加「开跑前那几行」能把「被重装打回」说出来。
 *
 * 运行：node --test test/reload-dev-verdict.test.cjs
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE = path.join(__dirname, '..', 'scripts', 'lib', 'reload-verdict.mjs');

let verdictModule = null;
/** 模块是 ESM；这里 import 它不会跑同步脚本（脚本本体在另一个文件里）。 */
async function load() {
  if (!verdictModule) verdictModule = await import(pathToFileURL(MODULE).href);
  return verdictModule;
}

test('三项都对上：这一轮算成功', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({ repoVersion: '0.1.97', diskVersion: '0.1.97', runningVersion: '0.1.97', lastError: null });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
});

test('跑着的还是上一代：不算成功，并且说清要重启', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({ repoVersion: '0.1.97', diskVersion: '0.1.97', runningVersion: '0.1.93', lastError: null });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /重启/);
  // 变异证明：把这条判据删掉，上面那条断言在本用例里立刻变红。
  assert.match(verdict.failures.join('\n'), /0\.1\.93/);
});

test('宿主记了装载错误（外壳已回滚）：不算成功，哪怕版本号看着对', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({
    repoVersion: '0.1.97',
    diskVersion: '0.1.97',
    runningVersion: '0.1.97',
    lastError: '装载 0.1.97 失败：Cannot find module ../mobile/channels.js',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /回滚/);
});

test('整包同步之后盘上仍落后仓库：不算成功', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({ repoVersion: '0.1.97', diskVersion: '0.1.93', runningVersion: '0.1.93', lastError: null });
  assert.equal(verdict.ok, false);
  const text = verdict.failures.join('\n');
  assert.match(text, /0\.1\.93/);
  assert.match(text, /0\.1\.97/);
});

test('--only 只推几个文件时，盘上与仓库不同不算失败', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({
    repoVersion: '0.1.97',
    diskVersion: '0.1.97',
    runningVersion: '0.1.97',
    lastError: null,
    partial: true,
  });
  assert.equal(verdict.ok, true);

  // 但「跑着的 ≠ 盘上的」这条不因为 --only 而放宽。
  const drifted = verifyReload({ repoVersion: '0.1.97', diskVersion: '0.1.96', runningVersion: '0.1.93', lastError: null, partial: true });
  assert.equal(drifted.ok, false);
});

test('宿主没报版本 / 盘上没有版本号：都不许当成功', async () => {
  const { verifyReload } = await load();
  const noRunning = verifyReload({ repoVersion: '0.1.97', diskVersion: '0.1.97', runningVersion: null, lastError: null });
  assert.equal(noRunning.ok, false);
  const noDisk = verifyReload({ repoVersion: '0.1.97', diskVersion: null, runningVersion: '0.1.97', lastError: null });
  assert.equal(noDisk.ok, false);
});

test('整包装上去了，但 profile 的声明还指着旧的一份：不算成功（重启就退回旧版）', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({
    repoVersion: '0.1.97',
    diskVersion: '0.1.97',
    runningVersion: '0.1.97',
    lastError: null,
    declaredSpec: 'file:dsh-mobile-plugin-0.1.93.tgz',
    expectedSpec: 'file:dsh-mobile-plugin-dev-1792710000000.tgz',
  });
  assert.equal(verdict.ok, false);
  const text = verdict.failures.join('\n');
  // 变异证明：删掉这条判据，本用例立刻变红（那时会 ok 且 failures 为空）。
  assert.match(text, /重启会退回旧的一份/);

  const aligned = verifyReload({
    repoVersion: '0.1.97',
    diskVersion: '0.1.97',
    runningVersion: '0.1.97',
    lastError: null,
    declaredSpec: 'file:dsh-mobile-plugin-dev-1792710000000.tgz',
    expectedSpec: 'file:dsh-mobile-plugin-dev-1792710000000.tgz',
  });
  assert.equal(aligned.ok, true, '声明指对了就过');
});

test('--only 那条快路不落安装声明：不拿这条判据卡它', async () => {
  const { verifyReload } = await load();
  const verdict = verifyReload({
    repoVersion: '0.1.97',
    diskVersion: '0.1.93',
    runningVersion: '0.1.93',
    lastError: null,
    partial: true,
    declaredSpec: 'file:dsh-mobile-plugin-0.1.93.tgz',
    expectedSpec: null,
  });
  assert.equal(verdict.ok, true);
});

test('开跑前那几行：盘上还是声明的冻结安装包时，直接说成「被重装打回过」', async () => {
  const { describeDrift } = await load();

  const reverted = describeDrift({ repoVersion: '0.1.97', diskVersion: '0.1.93', installVersion: '0.1.93' });
  assert.match(reverted[0], /仓库版本：0\.1\.97/);
  assert.match(reverted[0], /盘上版本：0\.1\.93/);
  assert.match(reverted.join('\n'), /重装/);

  const normal = describeDrift({ repoVersion: '0.1.97', diskVersion: '0.1.97', installVersion: '0.1.93' });
  assert.equal(normal.length, 1, '盘上与仓库一致时不该再解释一遍为什么是旧的');

  // 声明的安装包读不到（npm / link 装法）也要照实说「这次会装成仓库这一份」，不许静默。
  const npmInstalled = describeDrift({ repoVersion: '0.1.97', diskVersion: '0.1.94', installVersion: null });
  assert.match(npmInstalled.join('\n'), /装成仓库这一份/);
});

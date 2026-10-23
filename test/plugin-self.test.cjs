'use strict';

/**
 * 「这台插件自己」的版本现场投影 + 自动更新开关。
 *
 * 钉的是三件从代码上看不出来、错了会在手机上显示错误结论的事：
 *
 *  1. **`lastApply` 不许带 `check` 与 `command`**：前者是注册表原始响应、后者是本机装法
 *     命令行，都不是 App 该显示的东西（后端路由背了同样的规矩）。
 *  2. **`rolledBack` 只认外壳给的那个字段**：手机端不自己推「是不是退了」——判据写在会真
 *     去医院的那一头，两边各写一套只会出现两套口径。
 *  3. **没有外壳时如实报 `supported: false`**：无头部署 / 源码挂载的机器装了也没法立刻
 *     生效，界面要据此说清，而不是给一颗按下去必然失败的按钮。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { snapshot, applyView, handlePluginAuto } = require('../lib/mobile/plugin-self.js');

function fakeRes() {
  const res = {
    status: 0,
    body: null,
    writeHead(status) { res.status = status; },
    end(chunk) { res.body = JSON.parse(String(chunk)); },
  };
  return res;
}

function reqWith(body) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = 'POST';
  return stream;
}

/** 假 ctx：只回答一个服务。 */
function ctxWith(runtime) {
  return { get: (key) => (key === 'dshMobilePluginRuntime' ? runtime : null) };
}

test('没有外壳：如实报不支持，不许假装能更新', () => {
  const value = snapshot({ get: () => null });
  assert.equal(value.supported, false);
  assert.equal(value.runningVersion, null);
  assert.equal(value.lastApply, null);
  assert.equal(value.autoUpdate, false);
});

test('有外壳：版本、来源、回退结果都投影出来', () => {
  const runtime = {
    apply: async () => {},
    status: () => ({
      version: '1.2.3',
      installedVersion: '1.2.4',
      source: 'npm',
      appliedAt: '2026-10-24T00:00:00.000Z',
      shellChanged: false,
      autoUpdate: true,
      autoIntervalMs: 600000,
      lastApply: {
        installed: true,
        skipped: false,
        state: 'rolled-back',
        beforeVersion: '1.2.3',
        installedVersion: '1.2.4',
        swapped: false,
        retryable: false,
        rolledBack: true,
        runningAfterRollback: '1.2.3',
        failure: { code: 'self_check_failed', message: '新版没通过自检' },
        // 下面这两格**必须**被丢掉：注册表原文与本机装法命令行。
        check: { latestVersion: '1.2.4', raw: 'RAW REGISTRY BODY' },
        command: 'pnpm add dsh-mobile-plugin@1.2.4',
      },
    }),
  };
  const value = snapshot(ctxWith(runtime));
  assert.equal(value.supported, true);
  assert.equal(value.runningVersion, '1.2.3');
  assert.equal(value.installedVersion, '1.2.4');
  assert.equal(value.source, 'npm');
  assert.equal(value.autoUpdate, true);
  assert.equal(value.lastApply.rolledBack, true);
  assert.equal(value.lastApply.runningAfterRollback, '1.2.3');
  assert.equal(value.lastApply.state, 'rolled-back');
  assert.equal(Object.prototype.hasOwnProperty.call(value.lastApply, 'check'), false, 'lastApply 不许带注册表原文');
  assert.equal(Object.prototype.hasOwnProperty.call(value.lastApply, 'command'), false, 'lastApply 不许带装法命令行');
});

test('状态里的未知 state 收敛成 null，不原样透传', () => {
  assert.equal(applyView({ state: 'weird-value' }).state, null);
  assert.equal(applyView({ state: 'succeeded' }).state, 'succeeded');
});

test('自动更新开关：没有外壳时回 409，不假装打开了', async () => {
  const res = fakeRes();
  await handlePluginAuto({ get: () => null }, reqWith({ enabled: true }), res);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'plugin_auto_unavailable');
});

test('自动更新开关：只收布尔，写成功回新的现场', async () => {
  let stored = false;
  const runtime = {
    apply: async () => {},
    setAutoUpdate: (enabled) => { stored = enabled; return enabled; },
    status: () => ({ version: '1.0.0', autoUpdate: stored }),
  };
  const ctx = ctxWith(runtime);

  const bad = fakeRes();
  await handlePluginAuto(ctx, reqWith({ enabled: 'yes' }), bad);
  assert.equal(bad.status, 400);

  const ok = fakeRes();
  await handlePluginAuto(ctx, reqWith({ enabled: true }), ok);
  assert.equal(ok.status, 200);
  assert.equal(stored, true);
  assert.equal(ok.body.plugin.autoUpdate, true);
});

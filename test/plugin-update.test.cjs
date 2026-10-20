'use strict';

/**
 * 手机端「插件更新」三条路由（`lib/mobile/plugin-update.js`）的契约。
 *
 * 这一块的形状跟别的移动端接口不一样，所以必须钉住：
 *
 *  1. **apply 只回「已开始」**：装完会把整代实现换掉，旧代码手里的响应发不出去。所以
 *     结果只能靠轮询 status 读，apply 里不许等安装、也不许把结果写进响应；
 *  2. **状态里给身份不给时间差**：前端判「这一轮跑完了」比的是 `appliedAt` 变没变、
 *     `runningVersion` 变没变 —— 手机与电脑的钟不一定对得上；
 *  3. **来源判据不放开**：force 只跳过「有对话在跑」与发布晾置期，跳不过「这台是本地
 *     目录 / 本机 tgz 装的」；界面据此不给按钮，服务端也不能假装能装；
 *  4. **没有换代外壳时 apply 是 409**，不是 200 —— 盘上换了版本、跑着的还是旧的，等于白装。
 *
 * 驱动的是真 handler + 真 sendJson（假 res 只收状态码与响应体），`checkForUpdate` 走真
 * 实现，只把 fetch 换成假的注册表响应。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-update-'));
process.env.DSH_HOME = home;
process.env.DSHM_NPM_REGISTRY = 'https://registry.test';

const {
  handlePluginUpdateStatus,
  handlePluginUpdateCheck,
  handlePluginUpdateApply,
} = require('../lib/mobile/plugin-update.js');

/**
 * apply 的「上一次还在跑」是**模块级**状态（`applyingSince`）：真实运行时它随这一代实现
 * 一起被换代丢弃，但在同一个测试进程里会一直挂着。所以要测「干净的第一次」就得换一份模块
 * 实例；想测「第二次被拒」时就让两次共用同一份 —— 这两种情形各自需要一个新实例。
 */
function freshApply() {
  const file = require.resolve('../lib/mobile/plugin-update.js');
  delete require.cache[file];
  return require(file).handlePluginUpdateApply;
}

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); },
  };
}

/**
 * 假请求：`body` 走 readJsonBody，所以得给一个能读的流。
 *
 * 挂上 `end` 监听之后才把 body 吐出去（下一拍），否则 readJsonBody 那个 promise 永远不结算
 * —— 第一版就是这样把测试挂死的。
 */
function fakeReq(body = null) {
  const text = body === null ? '' : JSON.stringify(body);
  const listeners = {};
  const emit = (event, arg) => { for (const fn of listeners[event] || []) fn(arg); };
  return {
    headers: {},
    method: 'POST',
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
      if (event === 'end') {
        setTimeout(() => {
          if (text) emit('data', Buffer.from(text));
          emit('end');
        }, 0);
      }
      return this;
    },
    resume() { return this; },
  };
}

/** 一份能装新版的最小外壳服务。`apply` 默认只记账、不改状态。 */
function runtimeOf(overrides = {}) {
  const state = {
    version: '0.2.100',
    installedVersion: '0.2.100',
    appliedAt: null,
    lastApply: null,
    shellChanged: false,
    profileNodeModules: path.join(home, 'profiles', 'desktop', 'node_modules'),
    marketResult: null,
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    status: () => ({ ...state }),
    apply: async (options) => { calls.push(options || {}); return { installed: true, swapped: true }; },
  };
}

function ctxWith(runtime) {
  return { get: (key) => (key === 'dshMobilePluginRuntime' ? runtime : null) };
}

/** 让假注册表回一个给定版本。 */
function stubRegistry(version) {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/dsh-mobile-plugin\/latest$/, '应该问 latest 而不是整份文档');
    return { ok: true, status: 200, json: async () => ({ version }) };
  };
}

test('没有外壳时 status 如实报「不支持」，且不抛', async () => {
  const res = fakeRes();
  await handlePluginUpdateStatus(ctxWith(null), {}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status.supported, false);
  assert.equal(res.body.status.shellChanged, false);
});

test('status 把 lastApply 收成前端要的那几格，注册表原始响应不外泄', async () => {
  const runtime = runtimeOf({
    appliedAt: '2026-10-21T00:00:00.000Z',
    lastApply: {
      installed: true,
      swapped: true,
      state: 'succeeded',
      beforeVersion: '0.2.99',
      installedVersion: '0.2.100',
      restartRequired: false,
      refreshRequired: false,
      failure: null,
      check: { installedVersion: '0.2.99', latestVersion: '0.2.100', updateAvailable: true, source: 'npm' },
      command: 'pnpm add dsh-mobile-plugin@0.2.100',
    },
  });
  const res = fakeRes();
  await handlePluginUpdateStatus(ctxWith(runtime), {}, res);
  const status = res.body.status;
  assert.equal(status.runningVersion, '0.2.100');
  assert.equal(status.installedVersion, '0.2.100');
  assert.equal(status.appliedAt, '2026-10-21T00:00:00.000Z');
  assert.equal(status.lastApply.installed, true);
  assert.equal(status.lastApply.swapped, true);
  assert.equal(status.lastApply.check, undefined, 'check 里那一坨不该搬给手机');
  assert.equal(status.lastApply.command, undefined, '装法命令是本机运维细节，不外泄');
});

test('check 走真实现：有新版就 updateAvailable，并把 status 一起带回去', async () => {
  const runtime = runtimeOf();
  stubRegistry('0.2.101');
  const res = fakeRes();
  await handlePluginUpdateCheck(ctxWith(runtime), {}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.update.latestVersion, '0.2.101');
  assert.equal(res.body.update.updateAvailable, true);
  assert.equal(res.body.status.runningVersion, '0.2.100');
});

test('check：线上不比盘上新时报「没有新版」（回滚 / 本地构建跑在前面都不许降级）', async () => {
  stubRegistry('0.2.99');
  const res = fakeRes();
  await handlePluginUpdateCheck(ctxWith(runtimeOf()), {}, res);
  assert.equal(res.body.update.updateAvailable, false);
});

test('check：注册表挂了回 500 + 稳定 code，status 仍然带回去', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  const res = fakeRes();
  await handlePluginUpdateCheck(ctxWith(runtimeOf()), {}, res);
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'plugin_update_check_failed');
  assert.equal(res.body.status.runningVersion, '0.2.100');
});

test('apply 只回「已开始」，不等安装、也不把结果写进响应', async () => {
  const runtime = runtimeOf();
  const res = fakeRes();
  await freshApply()(ctxWith(runtime), fakeReq(), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.started, true);
  assert.equal(res.body.force, false);
  assert.equal(res.body.before.runningVersion, '0.2.100');
  // 响应发出去了还没开装（defer 到下一拍），这正是它不给结果的原因。
  assert.equal(runtime.calls.length, 0, 'apply 不该在响应之前就跑起来');
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.equal(runtime.calls.length, 1, '响应之后必须真去装');
});

test('apply 传 force：手机点的是「我现在就要更新」', async () => {
  const runtime = runtimeOf();
  const res = fakeRes();
  await freshApply()(ctxWith(runtime), fakeReq({ force: true }), res);
  assert.equal(res.body.force, true);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.equal(runtime.calls[0].force, true);
});

test('没有换代外壳时 apply 回 409（装完也没法就地生效）', async () => {
  const res = fakeRes();
  await freshApply()(ctxWith(null), fakeReq(), res);
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'plugin_update_unavailable');
});

test('装着的时候再点一次回 409：不许并发跑两次包管理器', async () => {
  const apply = freshApply();
  const runtime = runtimeOf();
  const first = fakeRes();
  await apply(ctxWith(runtime), fakeReq(), first);
  const second = fakeRes();
  await apply(ctxWith(runtime), fakeReq(), second);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'plugin_update_busy');
});

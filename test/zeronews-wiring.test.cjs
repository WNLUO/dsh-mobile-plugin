// ZeroNews 接线层：插件自动更新 / 就地重载把客户端弄断后要能自愈，别卡死在错误上。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mountZeroNews } = require('../lib/zeronews/wiring.cjs');

/** 拼一份最小装配，effect 立即建立并给出清理函数；runnerFactory 换成假体。 */
function mountWith(runner, overrides = {}) {
  const updates = [];
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async (patch) => { updates.push(patch); } },
    getState: () => overrides.state || { zeroNewsEnabled: true },
    control: {},
    warn: () => {},
    ctx,
    name: 'test',
    portOf: () => 18787,
    retryBaseMs: 5,
    runnerFactory: () => runner,
    ensure: async () => ({ ok: true, path: '/x' }),
  });
  return { updates, cleanup: () => cleanup && cleanup() };
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('启动失败会按退避自动重试，连上后把地址写回状态', async () => {
  let calls = 0;
  const starts = [];
  const runner = {
    start: async () => {
      starts.push(1);
      calls += 1;
      return calls < 2 ? { phase: 'error', error: 'boom', url: '', running: true } : { phase: 'connected', url: 'https://ok.example.com', running: true };
    },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  const env = mountWith(runner);
  await tick();
  assert.ok(starts.length >= 2, '一次失败后会自动再试并连上');
  assert.ok(env.updates.some((p) => p.zeroNewsUrl === 'https://ok.example.com'), '连上后写回隧道地址');
  env.cleanup();
});

test('第一次接入：装好客户端并打开登录页；身份落盘后状态直接算已接好', async () => {
  const opened = [];
  const updates = [];
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  const runner = {
    start: async () => ({ phase: 'off' }),
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off', configured: false }),
  };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async (patch) => { updates.push(patch); } },
    getState: () => ({ zeroNewsBound: true }),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-prepare',
    portOf: () => 18787,
    runnerFactory: () => runner,
    ensure: async () => ({ ok: true, path: '/x', source: 'downloaded' }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.downloaded, true);
  assert.equal(result.opened, true);
  assert.deepEqual(opened, ['https://user.zeronews.cc/setup'], '打开的是控制台的快速开始页');
  assert.equal(facade.status().configured, true, '落盘标记要并进状态，面板据此收起粘贴框');
  cleanup();
});

test('浏览器没打开时如实说没打开，不假装成功', async () => {
  const ctx = { effect: (fn) => { fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({}),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-prepare-fail',
    portOf: () => 18787,
    runnerFactory: () => ({ start: async () => ({ phase: 'off' }), stop: () => ({ phase: 'off' }), status: () => ({ phase: 'off' }) }),
    ensure: async () => ({ ok: true, path: '/x', source: 'cache' }),
    openUrl: async () => false,
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.equal(result.url, 'https://user.zeronews.cc/setup');
});

test('客户端意外退出回调会触发自愈重连', async () => {
  let onExit = null;
  let calls = 0;
  const runner = {
    start: async () => { calls += 1; return { phase: 'connected', url: 'https://ok.example.com', running: true }; },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({ zeroNewsEnabled: true }),
    control: {}, warn: () => {}, ctx, name: 'test', portOf: () => 18787, retryBaseMs: 5,
    runnerFactory: (options) => { onExit = options.onUnexpectedExit; return runner; },
    ensure: async () => ({ ok: true, path: '/x' }),
  });
  await tick();
  const before = calls;
  assert.equal(typeof onExit, 'function', '接线层要把 onUnexpectedExit 交给运行器');
  onExit();
  await tick();
  assert.ok(calls > before, '客户端意外退出后应再起一次连接');
  cleanup && cleanup();
});

test('显式断开后不再自动重连', async () => {
  let calls = 0;
  const runner = {
    start: async () => { calls += 1; return { phase: 'error', error: 'boom', running: true }; },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  const facade = mountWith(runner);
  await tick();
  facade.cleanup(); // 触发一次清理，等价于断开 / 卸载
  const afterCleanup = calls;
  await tick();
  assert.equal(calls, afterCleanup, '清理/断开后不应再有新的重试');
});

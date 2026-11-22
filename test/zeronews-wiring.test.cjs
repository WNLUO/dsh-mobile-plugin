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

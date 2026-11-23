// ZeroNews 接线层：插件自动更新 / 就地重载把客户端弄断后要能自愈，别卡死在错误上。
// 打开登录页走真实等待路径的用例要钉住：命令退出就得返回，报错就如实说没打开。
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

test('第一次接入：装好客户端后跑 login 并打开确认链接（不再要 token）；身份落盘后算已接好', async () => {
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
    loginFlow: async () => ({ already: false, url: 'https://verify.zeronews.cc/abc', error: '' }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.downloaded, true);
  assert.equal(result.opened, true);
  assert.equal(result.loginPending, true);
  assert.deepEqual(opened, ['https://verify.zeronews.cc/abc'], '打开的是 login 给出的确认链接');
  assert.equal(facade.status().configured, true, '落盘标记要并进状态，面板据此收起引导');
  cleanup();
});

test('已登录机器：login 直接回 already，准备阶段不开浏览器就能往下走', async () => {
  const opened = [];
  const ctx = { effect: (fn) => { fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({}),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-prepare-already',
    portOf: () => 18787,
    runnerFactory: () => ({ start: async () => ({ phase: 'off' }), stop: () => ({ phase: 'off' }), status: () => ({ phase: 'off' }) }),
    ensure: async () => ({ ok: true, path: '/x', source: 'cache' }),
    loginFlow: async () => ({ already: true, url: '', error: '' }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(result.opened, false);
  assert.deepEqual(opened, [], '已经登录就不该再开确认页');
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
    loginFlow: async () => ({ already: false, url: 'https://verify.zeronews.cc/abc', error: '' }),
    openUrl: async () => false,
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.equal(result.url, 'https://verify.zeronews.cc/abc');
});

test('浏览器正常打开后 prepare 会返回，面板不会卡在准备中', { timeout: 1000 }, async () => {
  const commands = [];
  const ctx = { effect: (fn) => { fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({}),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-open-success',
    portOf: () => 18787,
    runnerFactory: () => ({ start: async () => ({ phase: 'off' }), stop: () => ({ phase: 'off' }), status: () => ({ phase: 'off' }) }),
    ensure: async () => ({ ok: true, path: '/x', source: 'cache' }),
    loginFlow: async () => ({ already: false, url: 'https://verify.zeronews.cc/abc', error: '' }),
    execFile: (_command, args, _options, callback) => {
      commands.push(args);
      setImmediate(() => callback(null, '', ''));
      return { on: () => {} };
    },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.opened, true);
  assert.equal(commands.length, 1, '只打开一次确认页');
});

test('打开命令报错时如实说没打开', { timeout: 1000 }, async () => {
  const ctx = { effect: (fn) => { fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({}),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-open-error',
    portOf: () => 18787,
    runnerFactory: () => ({ start: async () => ({ phase: 'off' }), stop: () => ({ phase: 'off' }), status: () => ({ phase: 'off' }) }),
    ensure: async () => ({ ok: true, path: '/x', source: 'cache' }),
    loginFlow: async () => ({ already: false, url: 'https://verify.zeronews.cc/abc', error: '' }),
    execFile: (_command, _args, _options, callback) => {
      setImmediate(() => callback(new Error('打不开浏览器')));
      return { on: () => {} };
    },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.equal(result.url, 'https://verify.zeronews.cc/abc');
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

// ── 登录兑换：login 必须留在后台轮询设备码，不能 NO_TTY 秒退、也不能拿到地址就杀 ──

const { EventEmitter } = require('node:events');

/** 假 spawn：可指定打印一行输出、是否输出 already、以及是否打印后仍存活（轮询）。 */
function fakeLoginSpawn(records, { line = '', already = false, retain = true } = {}) {
  return (_bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    records.push({ args, opts, child });
    setImmediate(() => {
      if (already) { child.stdout.emit('data', 'already logged in\n'); child.emit('exit', 0); return; }
      if (line) child.stdout.emit('data', `${line}\n`);
      if (!retain) child.emit('exit', 0);
    });
    return child;
  };
}

function mountLogin(overrides = {}) {
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async () => {} },
    getState: () => ({}),
    control: {},
    warn: () => {},
    ctx,
    name: 'test-login',
    portOf: () => 18787,
    runnerFactory: () => ({ start: async () => ({ phase: 'off' }), stop: () => ({ phase: 'off' }), status: () => ({ phase: 'off', configured: false }) }),
    ensure: async () => ({ ok: true, path: '/x', source: 'cache' }),
    ...overrides,
  });
  return { facade, cleanup: () => cleanup && cleanup() };
}

test('首次登录：拿到确认地址就打开，但 login 进程留着继续轮询、且不设 NO_TTY', async () => {
  const records = [];
  const opened = [];
  const { facade, cleanup } = mountLogin({
    spawnImpl: fakeLoginSpawn(records, { line: 'https://user.zeronews.cc/cli/login?code=abc&client=DSH-mobile' }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.loginPending, true);
  assert.deepEqual(opened, ['https://user.zeronews.cc/cli/login?code=abc&client=DSH-mobile'], '打开的是 login 给出的确认链接');
  assert.equal(records.length, 1, '发起了一次 login');
  assert.equal(records[0].opts.env.NO_TTY, undefined, '不设 NO_TTY：设了它 login 会打完地址就退，不做兑换');
  assert.equal(records[0].child.killed, false, '拿到地址后不能杀 login，它要留着轮询兑换');
  cleanup();
  assert.equal(records[0].child.killed, true, '停止/卸载时把仍在轮询的 login 收掉');
});

test('已登录：login 回 already，准备阶段不开浏览器', async () => {
  const records = [];
  const opened = [];
  const { facade, cleanup } = mountLogin({
    spawnImpl: fakeLoginSpawn(records, { already: true }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(result.opened, false);
  assert.deepEqual(opened, [], '已经登录就不该再开确认页');
  cleanup();
});

test('重开登录页：先收掉上一次还没确认的 login 进程，免得两边各持一个设备码', async () => {
  const records = [];
  const { facade, cleanup } = mountLogin({
    spawnImpl: fakeLoginSpawn(records, { line: 'https://user.zeronews.cc/cli/login?code=abc' }),
    openUrl: async () => true,
  });
  await facade.prepare();
  await facade.prepare();
  assert.equal(records.length, 2, '第二次准备又发起一次 login');
  assert.equal(records[0].child.killed, true, '旧的还没确认的 login 要被收掉');
  assert.equal(records[1].child.killed, false, '新的留着轮询');
  cleanup();
});

// 2026-11-27：连上后落盘零讯客户端身份，复用前交给 runner 比对；错配不认已连接。
// 2026-11-27：外部把隧道重建到新端口后第一次 connect 就该成功，真实失配仍按旧/当前标注。
// 2026-11-26：运行中才点连接也要挂体检，客户端静默退出后能自愈重连。
// 2026-11-26：体检发现落点端口失效要清掉旧地址并通知兜底重新判定，不自动重连。
// 2026-11-25：端口失配要清掉状态里的旧地址，别让它进配对码。
// 2026-11-25：连上后定时体检发现客户端没了，要自动安排重连。
// ZeroNews 接线层：插件自动更新 / 就地重载把客户端弄断后要能自愈，别卡死在错误上。
// 打开登录页走真实等待路径的用例要钉住：命令退出就得返回，报错就如实说没打开。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { mountZeroNews, AGENT_INVITE_URL } = require('../lib/zeronews/wiring.cjs');
const { createZeroNewsRunner } = require('../lib/zeronews/runner.cjs');
const { pairingPayload } = require('../lib/relay/pairing-payload.cjs');

/** 拼一份最小装配，effect 立即建立并给出清理函数；runnerFactory 换成假体。 */
function mountWith(runner, overrides = {}) {
  const updates = [];
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async (patch) => { updates.push(patch); } },
    getState: () => overrides.state || { zeroNewsEnabled: true },
    control: {},
    warn: () => {},
    ctx,
    name: 'test',
    portOf: () => 18787,
    retryBaseMs: 5,
    runnerFactory: overrides.runnerFactory || (() => runner),
    ensure: async () => ({ ok: true, path: '/x' }),
    purgeLocal: overrides.purgeLocal,
    ...(overrides.healthCheckMs ? { healthCheckMs: overrides.healthCheckMs } : {}),
  });
  return { facade, updates, cleanup: () => cleanup && cleanup() };
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('彻底清理：停进程、跑 reset、三格状态一次清掉（与断开分开）', async () => {
  const calls = [];
  const runner = {
    start: async () => ({ phase: 'off' }),
    stop: () => { calls.push('stop'); return { phase: 'off' }; },
    status: () => ({ phase: 'off' }),
  };
  const env = mountWith(runner, {
    state: { zeroNewsEnabled: false },
    purgeLocal: async () => {
      calls.push('purge');
      return { ok: true, reset: { attempted: true, ok: true, error: '' }, cacheRemoved: true, error: '' };
    },
  });
  const result = await env.facade.purge();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['stop', 'purge'], '先停进程再清本机客户端');
  assert.ok(
    env.updates.some((p) => p.zeroNewsUrl === '' && p.zeroNewsEnabled === false && p.zeroNewsBound === false
      && p.zeroNewsClientId === '' && p.zeroNewsNode === ''),
    '地址、开关、已绑定标记、客户端身份一次清掉',
  );
  env.cleanup();
});

test('彻底清理：reset 失败也清插件状态，但把失败如实带回去', async () => {
  const runner = {
    start: async () => ({ phase: 'off' }),
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  const env = mountWith(runner, {
    state: { zeroNewsEnabled: false },
    purgeLocal: async () => ({ ok: false, reset: { attempted: true, ok: false, error: 'need admin' }, cacheRemoved: false, error: 'need admin' }),
  });
  const result = await env.facade.purge();
  assert.equal(result.ok, false);
  assert.match(result.error, /need admin/);
  assert.ok(env.updates.some((p) => p.zeroNewsBound === false), '失败也不让界面继续说已绑定');
  env.cleanup();
});

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
  assert.deepEqual(opened, [AGENT_INVITE_URL, 'https://verify.zeronews.cc/abc'], '先开邀请链接埋归属，再开 login 给出的确认链接');
  assert.equal(facade.status().configured, true, '落盘标记要并进状态，面板据此收起引导');
  cleanup();
});

test('代理商归属：邀请链接带 agent 且走主登录页（埋 cookie），不是 CLI 确认页', () => {
  assert.match(AGENT_INVITE_URL, /^https:\/\/user\.zeronews\.cc\/login\?agent=\w+$/, '邀请链接落在主登录页并带 agent 参数');
  assert.doesNotMatch(AGENT_INVITE_URL, /\/cli\/login/, '不能拿 CLI 确认页当邀请链接：那页不读 agent，埋不下 cookie');
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
  assert.equal(commands.length, 2, '先开邀请链接埋归属，再开确认页，各一次');
  assert.deepEqual(commands[0], [AGENT_INVITE_URL], '第一个开的是代理商邀请链接');
  assert.deepEqual(commands[1], ['https://verify.zeronews.cc/abc'], '第二个开的是确认链接');
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

test('连上后定时体检发现客户端没了：自动安排重连', async () => {
  let checks = 0;
  let onExit = null;
  let starts = 0;
  let phase = 'connected';
  const runner = {
    start: async () => { starts += 1; return { phase: 'connected', url: 'https://ok.example.com', running: true }; },
    stop: () => { phase = 'off'; return { phase: 'off' }; },
    status: () => ({ phase, running: phase === 'connected' }),
    checkAlive: async () => {
      checks += 1;
      if (checks === 1) { phase = 'error'; onExit && onExit(); }
      return { phase };
    },
  };
  const env = mountWith(runner, { healthCheckMs: 5,
    runnerFactory: (options) => { onExit = options.onUnexpectedExit; return runner; } });
  await tick(80);
  assert.ok(checks >= 1, '连着的时候要定时体检客户端还在不在');
  assert.ok(starts >= 2, '体检发现客户端没了要自动重连，不能卡在旧状态上');
  env.cleanup();
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

test('首次登录：按官方 NO_TTY 语义拿到确认地址就打开，登录完成交给状态轮询', async () => {
  const records = [];
  const opened = [];
  const { facade, cleanup } = mountLogin({
    spawnImpl: fakeLoginSpawn(records, { line: 'https://user.zeronews.cc/cli/login?code=abc&client=DSH-mobile' }),
    openUrl: async (url) => { opened.push(url); return true; },
  });
  const result = await facade.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.loginPending, true);
  assert.deepEqual(opened, [AGENT_INVITE_URL, 'https://user.zeronews.cc/cli/login?code=abc&client=DSH-mobile'], '先开邀请链接埋归属，再开 login 给出的确认链接');
  assert.equal(records.length, 1, '发起了一次 login');
  assert.equal(records[0].opts.env.NO_TTY, '1', '按官方规程带 NO_TTY：CLI 只打印确认地址，浏览器由我们打开');
  assert.equal(records[0].child.killed, false, '拿到地址后先不杀，交给面板轮询状态确认登录');
  cleanup();
  assert.equal(records[0].child.killed, true, '停止/卸载时把 login 进程收掉');
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

test('配额满这类确定性错误不自动重试（retryable=false），别无限空转', async () => {
  let calls = 0;
  const runner = {
    start: async () => { calls += 1; return { phase: 'error', error: '免费套餐只一台设备', retryable: false, running: true }; },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  const env = mountWith(runner);
  await tick(200);
  assert.equal(calls, 1, '确定性错误只尝试一次，不再退避重连');
  env.cleanup();
});

test('login 直接撞上客户端数量上限：prepare 把原文翻成可操作提示', async () => {
  const { facade, cleanup } = mountLogin({
    loginFlow: async () => ({ already: false, url: '', error: 'auth client failed: client count limit reached for this plan' }),
    openUrl: async () => true,
  });
  const result = await facade.prepare();
  assert.equal(result.ok, false);
  assert.match(result.error, /名额|控制台|恢复客户端/, '要说明免费套餐一台的名额怎么释放');
  assert.doesNotMatch(result.error, /client count limit/, '不要把英文原文直接甩给用户');
  cleanup();
});

test('端口失配：清掉状态里的旧地址，配对码整串都不带失效线路', async () => {
  const writes = [];
  let starts = 0;
  const state = { zeroNewsEnabled: true, zeroNewsUrl: 'https://stale.example.com' };
  const runner = {
    start: async () => {
      starts += 1;
      return {
        phase: 'error',
        error: '旧隧道指向旧端口，请删除后重试（旧端口 18787，当前本机端口 19797）',
        errorReason: 'port-mismatch',
        retryable: false,
      };
    },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off' }),
  };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: {
      update: async (patch, options) => {
        writes.push({ patch, options });
        Object.assign(state, patch);
      },
    },
    getState: () => state,
    control: {},
    warn: () => {},
    // 不让 mount 那条 effect 自动起连接：这里手动调 start，时序可控。
    ctx: { effect: () => () => {} },
    name: 'test-port-mismatch',
    portOf: () => 19797,
    retryBaseMs: 5,
    runnerFactory: () => runner,
    ensure: async () => ({ ok: true, path: '/x' }),
  });

  await facade.start();
  assert.equal(state.zeroNewsUrl, '', '失配后状态里的旧域名要清掉');
  assert.ok(
    writes.some((w) => w.patch.zeroNewsUrl === '' && w.options && w.options.notify === false),
    '清旧地址只落盘、不通知重配，免得和自动重连的 mount effect 互相触发',
  );
  assert.equal(starts, 1, '确定性错误不安排自动重试');

  const { payload, text } = pairingPayload({
    ...state,
    name: 'host',
    instanceId: 'i',
    pairingCode: '123456',
    pairingTicket: 'x'.repeat(43),
    relayUrl: '',
    lanEnabled: false,
  }, 19797);
  assert.equal(payload.routes, undefined, 'routes 不再带失效的服务商线路');
  assert.ok(!payload.lanUrls.includes('https://stale.example.com'), 'lanUrls 不带失效域名');
  assert.ok(!text.includes('stale.example.com'), '整串二维码原文里都没有那条失效域名');

  // 变异证明：接线层必须按 reason 认出失配，并用 notify:false 只落盘。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'wiring.cjs'), 'utf8');
  assert.match(source, /result\.errorReason === 'port-mismatch'/, '要按 reason 认出端口失配');
  assert.match(source, /zeroNewsUrl: '' \}, \{ notify: false \}/, '清地址要 notify:false，避免通知循环');
});

test('落点端口：已有隧道时沿用它自己的端口，不当成「指向旧端口」', () => {
  let received = null;
  const runner = {
    start: async () => ({ phase: 'off' }),
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'connected', url: 'https://x.example', tunnelLocalPort: 41081 }),
  };
  const env = mountWith(runner, { runnerFactory: (opts) => { received = opts; return runner; } });
  assert.ok(received, 'runner 工厂拿到端口取值器');
  assert.equal(received.portOf(), 41081, '隧道已经在 41081 上，就必须继续用它');
  env.cleanup();
});

test('落点端口：还没有隧道时用判据给的首选值', () => {
  let received = null;
  const runner = {
    start: async () => ({ phase: 'off' }),
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'off', tunnelLocalPort: 0 }),
  };
  const env = mountWith(runner, { runnerFactory: (opts) => { received = opts; return runner; } });
  assert.equal(received.portOf(), 18787, '没有隧道才按首选值建');
  env.cleanup();
});

test('体检判定落点端口失效：清旧地址、通知兜底重判，不自动重连', async () => {
  const writes = [];
  let staleNotifications = 0;
  let starts = 0;
  const state = { zeroNewsEnabled: true, zeroNewsUrl: 'https://stale.example.com' };
  const runner = {
    start: async () => { starts += 1; return { phase: 'connected', url: 'https://stale.example.com' }; },
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'connected', url: 'https://stale.example.com' }),
    // 运行器体检已经探过落点、判了失效；接线层只按 reason 收尾。
    checkAlive: async () => ({
      phase: 'error',
      error: '旧隧道指向的本机端口 18787 没有服务监听，请在控制台删除旧隧道后重新接入',
      errorReason: 'port-dead',
      retryable: false,
    }),
  };
  let cleanup = null;
  const ctx = { effect: (fn) => { cleanup = fn(); return () => {}; } };
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: {
      update: async (patch, options) => { writes.push({ patch, options }); Object.assign(state, patch); },
    },
    getState: () => state,
    control: {},
    warn: () => {},
    ctx,
    name: 'test-port-dead',
    portOf: () => 52831,
    healthCheckMs: 5,
    retryBaseMs: 5,
    runnerFactory: () => runner,
    ensure: async () => ({ ok: true, path: '/x' }),
    onRouteStale: () => { staleNotifications += 1; },
  });
  assert.equal(typeof facade.start, 'function');
  await tick(80);
  assert.equal(state.zeroNewsUrl, '', '失效地址要清掉，才不会被 hasOtherRoute 算作可用线路');
  assert.ok(
    writes.some((w) => w.patch.zeroNewsUrl === '' && w.options && w.options.notify === false),
    '沿用 notify:false：只落盘改内存，不走 watch 触发 configured 重连',
  );
  assert.equal(staleNotifications, 1, 'notify:false 不触发 watch，得显式通知兜底重新判定');
  assert.equal(starts, 1, '只挂载时连过一次，失效后不自动重连、不重建云端隧道');
  if (cleanup) cleanup();

  // 变异证明：按 reason 认出落点失效、只落盘清地址、显式通知兜底，缺一不可。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'wiring.cjs'), 'utf8');
  assert.match(source, /errorReason === 'port-dead'/, '体检结果要按 port-dead 认出落点失效');
  assert.match(source, /zeroNewsUrl: '' \}, \{ notify: false \}/, '清地址要 notify:false');
  assert.match(source, /onRouteStale\(\)/, '清地址后要显式通知兜底');
});

test('装配层：落点失效通知接到 Cloudflare 兜底重新判定', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  assert.ok(source.includes('onRouteStale: () => cloudflare?.reconcile?.()'), '清掉失效地址后要让兜底重新判定顶上');
});

test('运行中才点连接：连上后体检挂上，客户端静默退出能自愈重连', async () => {
  const state = { zeroNewsEnabled: false, zeroNewsUrl: '' };
  let checks = 0;
  let starts = 0;
  let onExit = null;
  let phase = 'off';
  const runner = {
    start: async () => { starts += 1; phase = 'connected'; return { phase, url: 'https://ok.example.com' }; },
    stop: () => { phase = 'off'; return { phase }; },
    status: () => ({ phase }),
    checkAlive: async () => {
      checks += 1;
      if (checks === 1) { phase = 'error'; if (onExit) onExit('客户端意外退出'); }
      return { phase, errorReason: '' };
    },
  };
  let cleanup = null;
  const facade = mountZeroNews({
    mount: (_name, run) => run(),
    settings: { update: async (patch) => { Object.assign(state, patch); } },
    getState: () => state,
    control: {}, warn: () => {},
    ctx: { effect: (fn) => { cleanup = fn(); return () => {}; } },
    name: 'test-late-connect',
    portOf: () => 18787,
    healthCheckMs: 5,
    retryBaseMs: 5,
    runnerFactory: (options) => { onExit = options.onUnexpectedExit; return runner; },
    ensure: async () => ({ ok: true, path: '/x' }),
  });
  assert.equal(checks, 0, '还没连过时不体检');
  assert.equal((await facade.start()).phase, 'connected');
  await tick(80);
  assert.ok(checks >= 1, '运行中才点连接，连上后也要开始体检');
  assert.ok(starts >= 2, '体检发现客户端没了要自动重连，别卡在假连接上');
  if (cleanup) cleanup();

  // 变异证明：连上后必须补挂体检，少了这一句守卫就该红。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'wiring.cjs'), 'utf8');
  assert.match(source, /retryMs = retryBaseMs; startHealth\(\)/, '连接成功后要把体检定时器挂上');
});

/**
 * 真 runner 经接线层挂载：portOf() 走 wiring 的 tunnelPort()（先缓存、再首选值），落点端口可随时改。
 * CLI / HTTP / spawn / sleep 全用假体，形状抄 zeronews-runner.test.cjs 的 tunnelHarness。
 */
function mountRealRunner({ preferredPort, localPort: initialLocalPort }) {
  const state = { zeroNewsEnabled: true, zeroNewsUrl: '' };
  const writes = [];
  const cmds = [];
  let localPort = initialLocalPort;
  const fetchImpl = async (url) => {
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    if (key === '/healthz') return { ok: true, json: async () => ({ ok: true }) };
    if (key === '/api/v1/endpoints') return { ok: true, json: async () => ({ data: { items: [
      { type: 'HTTPS', domain: 'https://new.example.com', status: 'active', local_port: localPort },
    ] } }) };
    return { ok: false };
  };
  const runImpl = async (_bin, args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'status') return { code: 0, stdout: '{"login":true}', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const facade = mountZeroNews({
    mount: (_name, run) => { run(); return () => {}; },
    settings: { update: async (patch, options) => { writes.push({ patch, options }); Object.assign(state, patch); } },
    getState: () => state,
    control: {}, warn: () => {},
    ctx: { effect: () => () => {} }, // 不让挂载 effect 自动起连接，手动 start 控时序
    name: 'test-real-runner',
    portOf: () => preferredPort,
    runnerFactory: (opts) => createZeroNewsRunner({ ...opts, fetchImpl, runImpl,
      spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() }),
    ensure: async () => ({ ok: true, path: '/x' }),
  });
  return { facade, state, writes, cmds, setLocalPort: (p) => { localPort = p; } };
}

test('外部把隧道改成新端口：第一次 connect 就认下，不报失配也不清域名', async () => {
  const env = mountRealRunner({ preferredPort: 18787, localPort: 18787 });
  const first = await env.facade.start();
  assert.equal(first.phase, 'connected', '老隧道照旧连得上');
  assert.equal(first.tunnelLocalPort, 18787, '记住老隧道落点');

  // 用户删旧隧道、把新隧道建到 59542；endpoints 立刻报新落点，首选值和缓存都还是旧的。
  env.setLocalPort(59542);
  const second = await env.facade.start();
  assert.equal(second.phase, 'connected', '第一次 connect 就该认下新端口，不用等第二次');
  assert.equal(second.errorReason, '', '不再报端口失配');
  assert.equal(second.url, 'https://new.example.com');
  assert.equal(second.tunnelLocalPort, 59542, '缓存换成新端口，下一轮继续沿用');
  assert.ok(!env.writes.some((w) => w.patch.zeroNewsUrl === ''), '不把新隧道域名当失效清掉');
  assert.ok(!env.cmds.some((c) => c.startsWith('add ')), '不自动重建云端隧道');

  // 变异证明：拿掉按 endpoints 新端口刷新比对值那行，第一次 connect 就会失配转红。
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zeronews', 'runner.cjs'), 'utf8');
  assert.match(source, /if \(fromCache.*\) current = found\.localPort/, '缓存落点被外部改动时要用 endpoints 端口比对');
});

test('真实失配：云端隧道仍指旧端口时按旧/当前标注，不删不建', async () => {
  // 插件首选端口已是 28787，云端那条旧隧道还停在 18787，用户没动过它。
  const env = mountRealRunner({ preferredPort: 28787, localPort: 18787 });
  env.state.zeroNewsUrl = 'https://stale.example.com';
  const s = await env.facade.start();
  assert.equal(s.phase, 'error');
  assert.equal(s.errorReason, 'port-mismatch');
  assert.match(s.error, /旧端口 18787/, '旧隧道落点标成旧端口');
  assert.match(s.error, /当前本机端口 28787/, '插件当前端口标成当前端口');
  assert.ok(!env.cmds.some((c) => c.startsWith('add ')), '失配不自动建新隧道');
  assert.ok(!env.cmds.some((c) => /^(delete|remove)\b/.test(c)), '失配不自动删云端隧道');
  assert.ok(env.writes.some((w) => w.patch.zeroNewsUrl === '' && w.options && w.options.notify === false), '失配只清本机旧地址');
});

test('连上后把客户端身份落盘，复用本机客户端前交给 runner 比对', async () => {
  const state = { zeroNewsEnabled: true, zeroNewsClientId: '', zeroNewsNode: '' };
  const updates = [];
  let runnerOpts = null;
  const runner = {
    start: async () => ({ phase: 'connected', url: 'https://ok.example.com', running: true,
      clientId: 'cid-own', node: 'zns.example:7000' }),
    stop: () => ({ phase: 'off' }),
    status: () => ({ phase: 'connected', url: 'https://ok.example.com', running: true,
      clientId: 'cid-own', node: 'zns.example:7000' }),
  };
  const facade = mountZeroNews({
    mount: (_name, run) => { run(); return () => {}; },
    settings: { update: async (patch) => { updates.push(patch); Object.assign(state, patch); } },
    getState: () => state,
    control: {}, warn: () => {},
    ctx: { effect: () => () => {} },
    name: 'test-identity',
    portOf: () => 18787,
    runnerFactory: (opts) => { runnerOpts = opts; return runner; },
    ensure: async () => ({ ok: true, path: '/x' }),
  });
  const result = await facade.start();
  assert.equal(result.clientId, 'cid-own');
  assert.ok(updates.some((p) => p.zeroNewsClientId === 'cid-own' && p.zeroNewsNode === 'zns.example:7000'),
    '连上后把 identity 落盘，重载后才知道哪个客户端是自己的');
  assert.deepEqual(runnerOpts.identityOf(), { clientId: 'cid-own', node: 'zns.example:7000' },
    'runner 复用前读到的期望身份就是落盘那份');
});

test('真 runner 经接线层：另一个身份占端口时不写回地址、不认已连接', async () => {
  const state = { zeroNewsEnabled: true, zeroNewsUrl: '', zeroNewsClientId: 'cid-own', zeroNewsNode: 'zns.example:7000' };
  const writes = [];
  const cmds = [];
  const runImpl = async (_bin, args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({
      login: true, running: true, client_id: 'cid-other', cloud_server_addr: 'zns.other:7000',
    }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const facade = mountZeroNews({
    mount: (_name, run) => { run(); return () => {}; },
    settings: { update: async (patch, options) => { writes.push({ patch, options }); Object.assign(state, patch); } },
    getState: () => state,
    control: {}, warn: () => {},
    ctx: { effect: () => () => {} },
    name: 'test-identity-mismatch',
    portOf: () => 18787,
    runnerFactory: (opts) => createZeroNewsRunner({ ...opts, runImpl,
      fetchImpl: async () => ({ ok: false }),
      spawnImpl: () => ({ on() {}, unref() {} }), sleepImpl: () => Promise.resolve() }),
    ensure: async () => ({ ok: true, path: '/x' }),
    retryBaseMs: 100000,
  });
  const result = await facade.start();
  assert.equal(result.phase, 'error');
  assert.equal(result.running, false, '不能把别人的客户端报成已连接');
  assert.match(result.error, /另一个身份.*让开端口/, '报错说清是另一个身份占位、让用户让开端口');
  assert.ok(!writes.some((w) => w.patch.zeroNewsUrl), '不把别人的隧道地址写回状态');
  assert.ok(!writes.some((w) => w.patch.zeroNewsClientId === 'cid-other'), '不把别人的身份落盘');
  assert.ok(!cmds.some((c) => c.startsWith('add ')), '不删不建云端隧道');
});

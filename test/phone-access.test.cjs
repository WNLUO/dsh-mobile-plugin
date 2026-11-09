'use strict';

/**
 * 按 App 三档授权的守卫：直接加载真的 `access.js` / `confirm.js`，再把 `installPhoneTools` 真跑起来，
 * 用假服务 / 假审批去驱动。覆盖：
 *   1. 三档真值表 + 默认 ask；
 *   2. 旧两档存档迁移成 v2（blocked→block；shareAllowed→block 且保留）；
 *   3. 禁止档不下发动作（service.call 一次都不发；删掉 block 短路 → 红）；
 *   4. payment / delete 在任何档都 needsConfirmation 真、send / submit 假；allow 也不能免掉付款确认；
 *   5. ask 每轮每 App 只问一次，换轮重问；
 *   6. phone_steps 入口 app.open 到 block 包，整批不下发；
 *   7. 批里 ref-only 的付款 tap 用最近一屏元素文字判出来并停在之前。
 *
 * 运行：node --test test/phone-access.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 绑定账与 App 授权都落在 $DSH_HOME 下，路径在调用时解析 —— 先把 HOME 指到临时目录再 require。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-access-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const binding = require('../lib/mobile/phone/binding.js');
const registry = require('../lib/mobile/stream-registry.js');
const access = require('../lib/mobile/phone/access.js');
const confirm = require('../lib/mobile/phone/confirm.js');
const { installPhoneTools } = require('../lib/mobile/phone/tools.js');

const DEVICE = 'dev-access';
const SESSION = 'sess-access';

function resetAccess() {
  fs.rmSync(access.storePath(), { force: true });
}

/** 每条用例从「这条会话绑着这台手机、那台手机开着流」开始（审批卡能不能被看见的判据）。 */
function freshBinding(session = SESSION) {
  fs.rmSync(binding.stateFile(), { force: true });
  binding.resetForTest();
  registry.reset();
  binding.setBinding(session, DEVICE);
  registry.track(DEVICE, { end() {}, destroy() {} });
}

test.after(() => registry.reset());

function fakeCtx({ approval = null, agents = null } = {}) {
  const registered = new Map();
  return {
    registered,
    approval,
    agents,
    on() { return () => {}; },
    get(name) {
      if (name === 'approval') return approval;
      if (name === 'agents') return agents;
      return null;
    },
    inject(names, callback) {
      assert.deepEqual(names, ['tools']);
      callback({ tools: { register: (tool) => registered.set(tool.name, tool) } });
    },
  };
}

function mountTools(ctxOpts = {}) {
  const ctx = fakeCtx(ctxOpts);
  const service = ctxOpts.service || null;
  installPhoneTools(ctx, {
    getService: () => service,
    listDevices: () => [],
    describeDevice: (id) => id,
  });
  return ctx;
}

function fakeService(handlers = {}) {
  const calls = [];
  return {
    calls,
    isOnline: () => true,
    hasCapability: () => true,
    async call(_deviceId, _sessionId, action, args) {
      calls.push({ action, args });
      const handler = handlers[action];
      if (typeof handler === 'function') return { data: await handler(args) };
      if (handler === undefined) return { data: { packageName: 'com.example.app', elements: [] } };
      const error = new Error(handler.message || '手机那边没能完成这一步');
      error.code = handler.code || 'failed';
      throw error;
    },
  };
}

const callOf = (session = SESSION, callId = 'call-1') => ({ agent: { id: session }, signal: undefined, callId });

/* ── access.js：三档真值表 + 默认 ask ─────────────────────────────────── */

test('三档真值表 + 未列出的包默认 ask + rows 形状 + unknown-mode', () => {
  resetAccess();
  assert.equal(access.modeFor(access.readState(), 'com.a.b'), 'ask', '没写过的包默认 ask');
  access.update('com.a.b', { mode: 'allow' });
  access.update('com.a.c', { mode: 'ask' });
  access.update('com.a.d', { mode: 'block' });
  const state = access.readState();
  assert.equal(access.modeFor(state, 'com.a.b'), 'allow');
  assert.equal(access.modeFor(state, 'com.a.c'), 'ask');
  assert.equal(access.modeFor(state, 'com.a.d'), 'block');
  assert.deepEqual(
    access.rows().find((r) => r.packageName === 'com.a.d'),
    { packageName: 'com.a.d', mode: 'block', shareAllowed: false },
  );
  const bad = access.update('com.a.e', { mode: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown-mode');
  assert.deepEqual(bad.modes, ['allow', 'ask', 'block']);
});

test('旧两档存档迁移：blocked→block；shareAllowed→block 且保留；下次 update 落 v2', () => {
  fs.mkdirSync(path.dirname(access.storePath()), { recursive: true });
  fs.writeFileSync(access.storePath(), JSON.stringify({
    blocked: ['com.old.block'],
    shareAllowed: ['com.old.share'],
  }), 'utf8');
  const state = access.readState();
  assert.equal(access.modeFor(state, 'com.old.block'), 'block');
  assert.equal(access.modeFor(state, 'com.old.share'), 'block', 'shareAllowed 迁成 block，不是 allow');
  assert.deepEqual(state.shareAllowed, ['com.old.share'], 'shareAllowed 要保留');

  access.update('com.new.ask', { mode: 'ask' });
  const raw = JSON.parse(fs.readFileSync(access.storePath(), 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.mode['com.old.block'], 'block');
  assert.equal(raw.mode['com.old.share'], 'block');
  assert.deepEqual(raw.shareAllowed, ['com.old.share']);
  assert.equal(raw.mode['com.new.ask'], 'ask');
});

/* ── needsConfirmation：payment / delete 在任何档都要人工 ────────────────── */

test('payment 与 delete 在任何 App 档下 needsConfirmation 都为真，send / submit 为假', () => {
  for (const mode of ['allow', 'ask', 'block']) {
    resetAccess();
    access.update('com.x.y', { mode });
    assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'payment' }), true, `${mode}: payment`);
    assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'delete' }), true, `${mode}: delete`);
    assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'send' }), false, `${mode}: send`);
    assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'submit' }), false, `${mode}: submit`);
  }
});

test('allow 档不能免掉付款确认：付款 tap 仍走人工，没同意不点', async () => {
  freshBinding();
  resetAccess();
  access.update('com.shop.app', { mode: 'allow' });
  const service = fakeService({ 'screen.read': () => ({ packageName: 'com.shop.app', elements: [] }) });
  let asked = 0;
  const approval = { request: async () => { asked += 1; return 'rejected'; } };
  const ctx = mountTools({ service, approval, agents: { get: () => ({ session: {} }) } });
  const value = await ctx.registered.get('phone_tap').execute({ ref: 'e1', target: '立即付款' }, callOf());
  assert.equal(value.ok, false);
  assert.equal(value.blocked, 'payment-confirmation', 'allow 挡不住付款确认');
  assert.equal(asked, 1, '付款确认必须发起一次');
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 0, '没同意绝不能点');
});

/* ── 禁止档不下发动作（变异：删 block 短路 → 红） ───────────────────────── */

test('禁止档不下发动作：service.call 一次都不发（读屏之外）', async () => {
  freshBinding();
  resetAccess();
  access.update('com.blocked.app', { mode: 'block' });
  const service = fakeService({ 'screen.read': () => ({ packageName: 'com.blocked.app', elements: [] }) });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  // 先读一屏让 lastPackage 记住当前前台包，再把调用记录清零。
  await ctx.registered.get('phone_screen').execute({}, callOf());
  service.calls.length = 0;
  const value = await ctx.registered.get('phone_tap').execute({ ref: 'e9', target: '确定' }, callOf());
  assert.equal(value.ok, false);
  assert.equal(value.blocked, 'app-blocked');
  assert.equal(service.calls.length, 0, '禁止档绝不能往手机发任何动作');
});

test('拿不到前台包又学不到：保守拒 app-access-unverified', async () => {
  freshBinding();
  resetAccess();
  const service = fakeService({ 'screen.read': () => ({ elements: [] }) });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const value = await ctx.registered.get('phone_tap').execute({ ref: 'e9', target: '确定' }, callOf());
  assert.equal(value.ok, false);
  assert.equal(value.blocked, 'app-access-unverified');
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 0);
});

/* ── ask：每轮每 App 只问一次，换轮重问 ─────────────────────────────────── */

test('ask 每轮每 App 只问一次；换一轮重新问', async () => {
  freshBinding();
  resetAccess();
  access.update('com.ask.app', { mode: 'ask' });
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.ask.app', elements: [] }),
    tap: () => ({ packageName: 'com.ask.app', elements: [] }),
  });
  let asked = 0;
  const approval = { request: async () => { asked += 1; return 'allowed-once'; } };
  const ctx = mountTools({ service, approval, agents: { get: () => ({ session: {} }) } });
  const tap = ctx.registered.get('phone_tap');
  await ctx.registered.get('phone_screen').execute({}, callOf()); // 让 lastPackage = com.ask.app
  await tap.execute({ ref: 'e1', target: '确定' }, callOf());
  assert.equal(asked, 1, '第一次要问一次');
  await tap.execute({ ref: 'e1', target: '确定' }, callOf());
  assert.equal(asked, 1, '同一轮同一 App 第二次不该再问');

  freshBinding('sess-ask-2');
  await ctx.registered.get('phone_screen').execute({}, callOf('sess-ask-2', 'c2'));
  await tap.execute({ ref: 'e1', target: '确定' }, callOf('sess-ask-2', 'c3'));
  assert.equal(asked, 2, '新的一轮要重新问一次');
});

/* ── 批量：入口 app.open 到 block 包整批不下发 ─────────────────────────── */

test('phone_steps 入口 app.open 到 block 包：整批不下发', async () => {
  freshBinding();
  resetAccess();
  access.update('com.blocked.app', { mode: 'block' });
  const service = fakeService();
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const value = await ctx.registered.get('phone_steps').execute({
    steps: [
      { action: 'app.open', args: { packageName: 'com.blocked.app' } },
      { action: 'tap', args: { ref: 'e1', target: '搜索' } },
    ],
  }, callOf());
  assert.equal(value.ok, false);
  assert.equal(value.blocked, 'app-blocked');
  assert.equal(service.calls.filter((c) => c.action === 'batch').length, 0, '整批不下发');
  assert.equal(service.calls.filter((c) => c.action === 'app.open').length, 0);
});

/* ── 批量：ref-only 付款 tap 被停在之前 ─────────────────────────────────── */

test('批里 ref-only 的付款 tap：按最近一屏元素文字判出来，停在之前', async () => {
  freshBinding();
  resetAccess();
  access.update('com.shop.app', { mode: 'allow' });
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.shop.app', elements: [{ ref: 'e9', text: '立即付款', bounds: [10, 20, 30, 40] }] }),
  });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  // 先读一屏，让 lastElements 记住 e9 是「立即付款」。
  await ctx.registered.get('phone_screen').execute({}, callOf());
  const value = await ctx.registered.get('phone_steps').execute({
    steps: [{ action: 'tap', args: { ref: 'e9' } }],
  }, callOf());
  assert.equal(value.stopReason, 'blocked-irreversible', 'ref-only 付款 tap 也要判出来');
  assert.equal(value.stoppedAt, 0);
  assert.deepEqual(value.steps, []);
  assert.equal(service.calls.filter((c) => c.action === 'batch').length, 0, '付款那一步绝不能进批');
});

'use strict';

/**
 * v2.1 插件侧四件事的守卫：**付款确认、过期编号重试、知识挂批量、体积预算**。
 *
 * 这里不打桩代替实现，而是把 `installPhoneTools` 真跑起来：它注册的每条工具都被收进一张
 * 表，然后拿一个假的服务去执行。四件事里有三件只在「工具真的被调用」时才成立
 * （确认要真的发起审批、重试要真的再读一屏、预算要真的累计字节），所以只能这么测。
 *
 * 四条最容易出的错各钉一条：
 *   1. **付款那一步绝对不能私自执行**。审批通道拿不到 / 用户没同意 / 没人看屏，三条路
 *      都必须停在原地 —— 一条走漏就是「AI 自己把钱付了」。
 *   2. **拿不到审批通道不能挂死**。宿主没这个服务时必须是立刻回 unavailable，
 *      而不是等一个永远不会来的答案（工具挂住 = 整轮对话停在那里）。
 *   3. **批里付款停在它之前**，而发送 / 提交 / 删除不再熔断（那是第一轮的旧口径）。
 *   4. **体积账与次数账共用一次重置**：轮次一变两本账都得归零，否则新的一轮第一次读屏
 *      就被判超限。
 *
 * 运行：node --test test/phone-confirm.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 绑定账落在 $DSH_HOME 下，而 paths 在调用时解析 —— 先把 HOME 指到临时目录再 require。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-confirm-'));
process.env.DSH_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const binding = require('../lib/mobile/phone/binding.js');
const registry = require('../lib/mobile/stream-registry.js');
const confirm = require('../lib/mobile/phone/confirm.js');
const access = require('../lib/mobile/phone/access.js');
const { installPhoneTools } = require('../lib/mobile/phone/tools.js');

const DEVICE = 'dev-confirm';
const SESSION = 'sess-confirm';

/**
 * 每一条用例都从「这条会话绑着这台手机、而那台手机开着流」开始 —— 后者就是审批卡
 * 能不能被看见的判据（工具层靠它决定要不要去问人）。
 *
 * 这几条用例只测付款 / 不可逆 / 预算，不测按 App 授权：所以把用到的前台包设成 allow，
 * 免得默认的「ask」在每个动作前先弹一张 App 授权卡，污染审批计数。
 */
function freshBinding() {
  fs.rmSync(binding.stateFile(), { force: true });
  binding.resetForTest();
  registry.reset();
  binding.setBinding(SESSION, DEVICE);
  registry.track(DEVICE, { end() {}, destroy() {} });
  fs.rmSync(access.storePath(), { force: true });
  access.writeState({ version: 2, mode: { 'com.example.app': 'allow', 'com.tencent.mm': 'allow' }, shareAllowed: [] });
}

test.after(() => registry.reset());

/**
 * 假插件上下文：`inject(['tools'])` 把注册结果交出来，`get('approval')` 给一个可控的审批
 * 服务。`approval.request` 返回什么由用例决定（结论 / 抛错 / 永不返回）。
 */
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

/** 装工具并把表交出来。 */
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

/** 一台假手机：记下每个动作、按需抛错或回数据。 */
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

const callOf = () => ({ agent: { id: SESSION }, signal: undefined, callId: 'call-1' });

/* ── 判定：谁能进确认 ─────────────────────────────────────────────────── */

// 决策变了：不可逆动作里 payment 与 delete（收钱 / 毁数据）都强制人工；send / submit 仍不拦。
test('needsConfirmation 认 payment 与 delete：收钱 / 毁数据要人工，send / submit 不拦', () => {
  assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'payment' }), true);
  assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'delete' }), true);
  assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'send' }), false);
  assert.equal(confirm.needsConfirmation({ irreversible: true, kind: 'submit' }), false);
  assert.equal(confirm.needsConfirmation({ irreversible: false, kind: 'none' }), false);
  assert.equal(confirm.needsConfirmation(null), false);
});

/* ── 拿不到通道：必须立刻回 unavailable，不许挂死 ───────────────────────── */

test('没有审批服务：当场回 unavailable，不挂住', async () => {
  const startedAt = Date.now();
  const outcome = await confirm.requestConfirmation(fakeCtx({ approval: null }), {
    sessionId: SESSION,
    summary: '在手机上点「立即付款」',
    agent: { session: {} },
  });
  assert.equal(outcome, 'unavailable');
  assert.ok(Date.now() - startedAt < 1000, '拿不到通道必须立刻结束，不能等');
});

test('拿不到会话上下文：回 unavailable', async () => {
  const approval = { request: async () => 'allowed-once' };
  assert.equal(
    await confirm.requestConfirmation(fakeCtx({ approval, agents: { get: () => undefined } }), { sessionId: SESSION }),
    'unavailable',
  );
  assert.equal(await confirm.requestConfirmation(fakeCtx({ approval }), { sessionId: '' }), 'unavailable');
});

test('没有手机在看：不问，直接 unavailable', async () => {
  let asked = 0;
  const approval = { request: async () => { asked += 1; return 'allowed-once'; } };
  const outcome = await confirm.requestConfirmation(fakeCtx({ approval }), {
    sessionId: SESSION,
    watching: false,
    agent: { session: {} },
  });
  assert.equal(outcome, 'unavailable');
  assert.equal(asked, 0, '没人看屏时发一张没人答的卡只是白白挂住');
});

test('宿主那头发不出结论（永不返回）：自己的硬期限收尾，并撤掉那次请求', async () => {
  let revoked = 0;
  const approval = {
    request: (req) => {
      req.signal.addEventListener('abort', () => { revoked += 1; }, { once: true });
      return new Promise(() => {});
    },
  };
  const startedAt = Date.now();
  const outcome = await confirm.requestConfirmation(fakeCtx({ approval }), {
    sessionId: SESSION,
    agent: { session: {} },
    timeoutMs: 40,
  });
  assert.equal(outcome, 'unavailable', '等不到答案必须交 unavailable，不能挂死');
  assert.ok(Date.now() - startedAt < 2000, '必须按期限结束');
  assert.equal(revoked, 1, '到点要把挂起的审批一起撤掉，别留一张没人答的卡');
});

test('审批服务抛错：折算成 unavailable，不把异常漏给工具层', async () => {
  const approval = { request: async () => { throw new Error('outside an open turn'); } };
  const outcome = await confirm.requestConfirmation(fakeCtx({ approval }), { sessionId: SESSION, agent: { session: {} } });
  assert.equal(outcome, 'unavailable');
});

test('三种结论各自归一：allowed-once / rejected / cancelled→rejected', async () => {
  const mk = (value) => ({ request: async () => value });
  const opts = { sessionId: SESSION, agent: { session: {} } };
  assert.equal(await confirm.requestConfirmation(fakeCtx({ approval: mk('allowed-once') }), opts), 'allowed-once');
  assert.equal(await confirm.requestConfirmation(fakeCtx({ approval: mk('rejected') }), opts), 'rejected');
  assert.equal(await confirm.requestConfirmation(fakeCtx({ approval: mk('cancelled') }), opts), 'rejected');
  assert.equal(await confirm.requestConfirmation(fakeCtx({ approval: mk('unavailable') }), opts), 'unavailable');
});

/* ── 工具层：付款那一步必须真的停下来 ─────────────────────────────────── */

test('付款：没拿到 allowed-once 就不调用手机，且如实说没做', async () => {
  freshBinding();
  const service = fakeService();
  const ctx = mountTools({
    service,
    // 没有审批服务 = 没人能确认。手机那一步必须一次都不发。
    approval: null,
    agents: { get: () => ({ session: {} }) },
  });
  const tap = ctx.registered.get('phone_tap');
  const value = await tap.execute({ ref: 'e3', target: '立即付款' }, callOf());
  assert.equal(value.ok, false);
  assert.equal(value.blocked, 'payment-confirmation');
  assert.match(value.note, /确认/);
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 0, '没确认就绝不能按下去');
});

test('付款：拿到 allowed-once 才真的点下去', async () => {
  freshBinding();
  const service = fakeService();
  const asked = [];
  const approval = { request: async (req) => { asked.push(req); return 'allowed-once'; } };
  const ctx = mountTools({ service, approval, agents: { get: () => ({ session: {} }) } });
  const tap = ctx.registered.get('phone_tap');
  const value = await tap.execute({ ref: 'e3', target: '立即付款' }, callOf());
  assert.equal(value.ok, true);
  assert.equal(asked.length, 1, '应当走一次审批');
  assert.match(asked[0].reason, /付款/);
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 1);
});

test('付款：用户拒绝 → 不执行', async () => {
  freshBinding();
  const service = fakeService();
  const approval = { request: async () => 'rejected' };
  const ctx = mountTools({ service, approval, agents: { get: () => ({ session: {} }) } });
  const tap = ctx.registered.get('phone_tap');
  const value = await tap.execute({ ref: 'e3', target: '确认购买' }, callOf());
  assert.equal(value.ok, false);
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 0);
});

// 决策变了：delete 并入强制人工（收钱或毁数据），不再和 send / submit 一样直接放行。
test('发送不拦；删除现在要走一次人工确认（拒绝则不执行）', async () => {
  freshBinding();
  const service = fakeService();
  const asked = [];
  const approval = { request: async (req) => { asked.push(req); return 'rejected'; } };
  const ctx = mountTools({ service, approval, agents: { get: () => ({ session: {} }) } });
  const tap = ctx.registered.get('phone_tap');
  const sent = await tap.execute({ ref: 'e5', target: '发送' }, callOf());
  assert.equal(sent.ok, true, '发送不该被拦');
  assert.equal(asked.length, 0, '发送不该去问审批');
  const removed = await tap.execute({ ref: 'e6', target: '删除' }, callOf());
  assert.equal(removed.ok, false, '删除要人工确认，用户拒绝就不执行');
  assert.equal(removed.blocked, 'payment-confirmation');
  assert.equal(asked.length, 1, '删除要走一次确认');
  assert.equal(service.calls.filter((c) => c.action === 'tap').length, 1, '只有发送那一下真的点了，删除被拦下');
});

/* ── 批：付款停在它之前 ─────────────────────────────────────────────────── */

test('批里遇到付款：停在它之前，stopReason=blocked-irreversible', async () => {
  freshBinding();
  const service = fakeService({ batch: () => ({ steps: [{ index: 0, action: 'tap', ok: true }], stoppedAt: null, stopReason: null }) });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const steps = ctx.registered.get('phone_steps');
  const value = await steps.execute({
    steps: [
      { action: 'tap', args: { ref: 'e1', target: '搜索' } },
      { action: 'tap', args: { ref: 'e2', target: '立即付款' } },
      { action: 'tap', args: { ref: 'e3', target: '返回' } },
    ],
  }, callOf());
  assert.equal(value.stopReason, 'blocked-irreversible');
  assert.equal(value.stoppedAt, 1, '停点就是付款那一步的下标');
  const batchCall = service.calls.find((c) => c.action === 'batch');
  assert.equal(batchCall.args.steps.length, 1, '付款那一步绝不能出现在发给手机的批里');
  assert.equal(batchCall.args.steps[0].args.target, '搜索');
});

test('批里第一步就是付款：这一批一步都不跑，如实说明', async () => {
  freshBinding();
  const service = fakeService();
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const value = await ctx.registered.get('phone_steps').execute({
    steps: [{ action: 'tap', args: { ref: 'e1', target: '立即支付' } }],
  }, callOf());
  assert.equal(value.stoppedAt, 0);
  assert.equal(value.stopReason, 'blocked-irreversible');
  assert.deepEqual(value.steps, []);
  assert.equal(service.calls.filter((c) => c.action === 'batch').length, 0, '没有能跑的步骤就不该发批');
});

test('批里遇到发送 / 提交：不再熔断，整批照发', async () => {
  freshBinding();
  const service = fakeService({ batch: () => ({ steps: [], stoppedAt: null, stopReason: null }) });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const value = await ctx.registered.get('phone_steps').execute({
    steps: [
      { action: 'tap', args: { ref: 'e1', target: '发送' } },
      { action: 'tap', args: { ref: 'e2', target: '提交' } },
    ],
  }, callOf());
  assert.equal(value.stopReason, undefined, '发送 / 提交不该再被熔断');
  assert.equal(service.calls.find((c) => c.action === 'batch').args.steps.length, 2);
});

/* ── stale-ref：只重试一次 ──────────────────────────────────────────────── */

test('stale-ref：重新读屏、按原文文字 + 位置找回同一个元素、换新编号重试一次', async () => {
  freshBinding();
  let taps = 0;
  // 同一屏先后两版：控件没动，编号从 e1 变成了 e5。模型手里那个编号已经过期。
  let elements = [{ ref: 'e1', text: '发送', bounds: [10, 20, 30, 40] }];
  const service = fakeService({ 'screen.read': () => ({ packageName: 'com.example.app', elements }) });
  const original = service.call.bind(service);
  service.call = async (...args) => {
    const [deviceId, sessionId, action, actArgs] = args;
    if (action === 'tap') {
      taps += 1;
      if (actArgs.ref === 'e1') {
        const error = new Error('e1 已经不在界面上了');
        error.code = 'stale-ref';
        throw error;
      }
      return { data: { packageName: 'com.example.app', elements } };
    }
    return original(deviceId, sessionId, action, actArgs);
  };
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  // 先读一屏，工具层因此知道 e1 是哪个元素（文字 + 位置）。
  await ctx.registered.get('phone_screen').execute({}, callOf());
  elements = [{ ref: 'e5', text: '发送', bounds: [10, 20, 30, 40] }];
  const value = await ctx.registered.get('phone_tap').execute({ ref: 'e1', target: '发送' }, callOf());
  assert.equal(value.ok, true);
  assert.equal(taps, 2, '一次原发 + 一次重试，不能更多');
  assert.match(value.note || '', /重试/);
});

test('stale-ref 重试后还是失败：如实报错，不循环', async () => {
  freshBinding();
  let taps = 0;
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.example.app', elements: [{ ref: 'e1', text: '确认' }] }),
  });
  const original = service.call.bind(service);
  service.call = async (...args) => {
    const action = args[2];
    if (action === 'tap') {
      taps += 1;
      const error = new Error('已经不在界面上了');
      error.code = 'stale-ref';
      throw error;
    }
    return original(...args);
  };
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  await assert.rejects(
    () => ctx.registered.get('phone_tap').execute({ ref: 'e9', target: '发送' }, callOf()),
    /已经不在界面上了/,
  );
  assert.ok(taps <= 2, `最多两次（原发 + 一次重试），实际 ${taps}`);
});

/* ── 知识挂批量 ─────────────────────────────────────────────────────────── */

test('phone_steps 也附知识，且与 phone_screen 共用同一份去重', async () => {
  freshBinding();
  const knowledge = require('../lib/mobile/phone-knowledge.js');
  knowledge.resetNotes();
  knowledge.resetCache();
  binding.setBinding('sess-know', DEVICE);
  // 用一个必中的包名（微信那条知识文件一直在），靠 noteFor 自己的去重账验「只附一次」。
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.tencent.mm', elements: [] }),
    batch: () => ({ steps: [], stoppedAt: null, stopReason: null, packageName: 'com.tencent.mm' }),
  });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  const steps = await ctx.registered.get('phone_steps').execute({
    steps: [{ action: 'tap', args: { ref: 'e1', target: '搜索' } }],
  }, { agent: { id: 'sess-know' }, signal: undefined, callId: 'c1' });
  const screen = await ctx.registered.get('phone_screen').execute({}, { agent: { id: 'sess-know' }, signal: undefined, callId: 'c2' });
  const firstHasNote = typeof steps.note === 'string' && steps.note.length > 0;
  const secondHasNote = typeof screen.note === 'string' && screen.note.length > 0;
  assert.ok(firstHasNote, '批量结果里应当附上知识');
  assert.equal(secondHasNote, false, '同一个对话同一个 App 只附一次，读屏那条不该再来一遍');
});

/* ── 体积预算 ───────────────────────────────────────────────────────────── */

test('体积预算：累计越过 400KB 软线就在结果里提醒收尾，越 800KB 直接拒', async () => {
  freshBinding();
  // 一屏约 180KB：第三屏越过 400KB 软线（提醒），到第六屏越过 800KB（拒）。
  const big = 'x'.repeat(180 * 1024);
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.example.app', elements: [{ ref: 'e1', text: big }] }),
  });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  binding.setBinding('sess-bytes', DEVICE);
  const screen = ctx.registered.get('phone_screen');
  const exec = { agent: { id: 'sess-bytes' }, signal: undefined, callId: 'cb' };
  const notes = [];
  let rejected = false;
  for (let i = 0; i < 8; i += 1) {
    try {
      const value = await screen.execute({}, exec);
      notes.push(value.note || '');
    } catch (error) {
      rejected = true;
      assert.match(error.message, /KB/, '硬拒绝要说清是体积超了');
      break;
    }
  }
  assert.ok(notes.some((note) => /读得太多了/.test(note)), '越过软线必须提醒');
  assert.equal(rejected, true, '越过硬线必须拒绝');
});

test('体积账与次数账一起被轮次重置：换了一轮，体积从零开始', async () => {
  freshBinding();
  const big = 'y'.repeat(300 * 1024);
  const service = fakeService({
    'screen.read': () => ({ packageName: 'com.example.app', elements: [{ ref: 'e1', text: big }] }),
  });
  const ctx = mountTools({ service, approval: null, agents: { get: () => ({ session: {} }) } });
  binding.setBinding('sess-turn', DEVICE);
  binding.setBinding('sess-turn-2', DEVICE);
  const screen = ctx.registered.get('phone_screen');
  const exec = { agent: { id: 'sess-turn' }, signal: undefined, callId: 'ct' };
  // 第一轮累计到 600KB（两屏），软线之上、硬线之下。
  await screen.execute({}, exec);
  const second = await screen.execute({}, exec);
  assert.match(second.note || '', /读得太多了/);

  // 拿不到轮次号时走兜底键，这里直接换一个会话 id 模拟「新的一轮」——两条账共用同一次
  // 重置，所以新会话第一屏不该带着上一轮的体积。
  const fresh = await screen.execute({}, { agent: { id: 'sess-turn-2' }, signal: undefined, callId: 'ct2' });
  assert.doesNotMatch(fresh.note || '', /读得太多了/, '新的一轮体积必须从零开始');
});

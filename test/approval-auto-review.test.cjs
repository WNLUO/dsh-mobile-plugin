'use strict';

/**
 * 自动审阅档的判定语义守卫（`lib/mobile/auto-review.js`）。
 *
 * 这一档是唯一会**替人放行**的东西，所以它的每一条边界都要能被证伪：
 *
 *  1. **「人不在」只按这条会话有没有手机订阅算**。进程级的「最近有没有手机请求」既会把
 *     「在别的会话里刷了一下」当成有人看着这条会话，也会把「手机放着不动两分钟」当成离开；
 *  2. **没人看不等于无条件放行**：工作区内的写也必须过一次受限只读判定，判不出来（没模型 /
 *     超时 / 回 UNSURE）**一律拒绝**；
 *  3. **越界动作永不自动放行**：danger-full-access 与认不出档的都推卡；
 *  4. **有人看着这条会话时一律推卡** —— 人就在屏幕前，不替他做决定；
 *  5. 判定模型只能读：调用里不带任何工具。
 *
 * 运行：node --test test/approval-auto-review.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autoReview = require('../lib/mobile/auto-review.js');
const autoReviewLog = require('../lib/mobile/auto-review-log.js');
const approvals = require('../lib/mobile/approvals.js');

/** 一次沙箱越权重试。`reason` 的固定前缀由宿主拼出。 */
const request = (mode, overrides = {}) => ({
  toolName: 'bash',
  callId: 'call-1',
  reason: `escalate sandbox to ${mode}: 在会话工作区里改文件`,
  ...overrides,
});

/** 会话日志里一条 `request/header`：判定模型就从这里取。 */
function sessionWithModel(provider = 'deepseek', model = 'chat') {
  // `seq` 是「下一条要写的序号」，回扫从 seq-1 往前找（与宿主同一口径），所以这里给两条：
  // 一条占位、一条 request/header。
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'request/header', data: { header: { config: { provider, model } } } },
  ];
  return {
    id: 's-1',
    get seq() { return events.length; }, // 下一条要写的序号（回扫从 seq-1 开始）
    eventAt(i) { return events[i] || null; },
    append(type, data) { events.push({ type, data }); },
    events,
  };
}

/** 假 ctx：`llm.stream` 按给定字节回答（不给 llm 就是「判定叫不起来」）。 */
function ctxWith(answer, { throws = false, tools = [] } = {}) {
  const calls = [];
  return {
    calls,
    tools,
    get(name) {
      if (name !== 'llm') return undefined;
      return {
        async *stream(args) {
          calls.push(args);
          if (throws) throw new Error('provider down');
          // 判定模型**不许**有任何工具：这里顺带钉住调用里没带 tools 字段。
          if (args.tools || args.toolChoice) throw new Error('判定调用不该带工具');
          yield { type: 'text-delta', text: answer };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
}

/** 一份「工作区内写」的事实包：判定必须拿到真实参数才肯判，没有它一律推卡。 */
const withinFacts = (overrides = {}) => ({
  fact: '修改工作区内的文件 src/app.ts',
  highlight: false,
  classKey: 'write:src@workspace-write',
  tier: 'workspace-write',
  keyArgs: 'write\u0000src',
  ...overrides,
});

// ── 1. 没人看 ≠ 无条件放行 ──────────────────────────────────────────────────

test('没人看 + 工作区内写 + 判定叫不起来：推卡，绝不静默放行', async () => {
  // 口径 2026-11-10 改：含糊时**推卡**而不是拒绝。旧断言钉的是 `reject`——那会把「没判出来」
  // 说成「用户拒绝了」，agent 去解释一个从没发生的拒绝，而用户手机上连卡都没见到。fail-closed
  // 的对象是「放行」，不是「问人」，所以这里只许 `card`，且永远不许 `allow`。
  const session = sessionWithModel();
  const ctx = { get: () => undefined }; // 没有 llm 服务
  const decision = await autoReview.decide(ctx, request('workspace-write'), session, false, withinFacts());
  assert.equal(decision.action, 'card', '判不出来就推卡，绝不静默放行');
  assert.equal(decision.verdict, 'unsure');
  assert.equal(decision.by, 'judge');
});

test('没人看 + 工作区内写 + 判定回 UNSURE：推卡', async () => {
  const decision = await autoReview.decide(ctxWith('UNSURE'), request('workspace-write'), sessionWithModel(), false, withinFacts());
  assert.equal(decision.action, 'card');
});

test('没人看 + 工作区内写 + 判定调用抛错：推卡，不能当成通过', async () => {
  const decision = await autoReview.decide(ctxWith('WITHIN', { throws: true }), request('workspace-write'), sessionWithModel(), false, withinFacts());
  assert.equal(decision.action, 'card', 'provider 挂了也只能推卡，不能当成通过');
});

test('会话日志里没有 request/header（认不出判定模型）：推卡', async () => {
  const bare = { id: 's-1', seq: 0, eventAt: () => null };
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, request('workspace-write'), bare, false, withinFacts());
  assert.equal(decision.action, 'card');
  assert.equal(ctx.calls.length, 0, '认不出模型就别发那一发');
});

test('拿不到真实参数（facts 缺失）：推卡，不猜', async () => {
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, request('workspace-write'), sessionWithModel(), false, null);
  assert.equal(decision.action, 'card');
  assert.equal(decision.by, 'facts');
  assert.equal(ctx.calls.length, 0, '没有事实就别叫判定模型');
});

test('判定明确回 WITHIN 才放行工作区内的写', async () => {
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, request('workspace-write'), sessionWithModel(), false, withinFacts());
  assert.equal(decision.action, 'allow');
  assert.equal(decision.by, 'judge');
  assert.equal(ctx.calls.length, 1, '放行必须真过一次判定');
  assert.equal(ctx.calls[0].tools, undefined, '判定调用不带任何工具（它天生没有写能力）');
});

test('判定回 BOUNDARY：推卡，不放行', async () => {
  const decision = await autoReview.decide(ctxWith('BOUNDARY'), request('workspace-write'), sessionWithModel(), false, withinFacts());
  assert.equal(decision.action, 'card');
  assert.equal(decision.verdict, 'boundary');
});

// ── 2. 越界动作永不自动放行 ────────────────────────────────────────────────

test('没人看 + danger-full-access：推卡，且根本不叫判定模型', async () => {
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, request('danger-full-access'), sessionWithModel(), false);
  assert.equal(decision.action, 'card');
  assert.equal(decision.verdict, 'boundary');
  assert.equal(ctx.calls.length, 0, '越界动作连判定都不做，直接交给人');
});

test('认不出目标档：推卡（当作未证明）', async () => {
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, { toolName: 'bash', callId: 'c', reason: '想跑个命令' }, sessionWithModel(), false);
  assert.equal(decision.action, 'card');
  assert.equal(decision.verdict, 'unsure');
  assert.equal(ctx.calls.length, 0);
});

test('任何情况下都没有「工作区外的东西静默放行」这条分支', async () => {
  // 逐档扫一遍：只有 workspace-write + 判定 WITHIN 这一个组合能拿到 allow。
  const cases = [
    ['danger-full-access', 'WITHIN'],
    ['danger-full-access', 'BOUNDARY'],
    ['workspace-write', 'BOUNDARY'],
    ['workspace-write', 'UNSURE'],
  ];
  for (const [mode, answer] of cases) {
    const decision = await autoReview.decide(ctxWith(answer), request(mode), sessionWithModel(), false);
    assert.notEqual(decision.action, 'allow', `${mode} / ${answer} 不该放行`);
  }
});

// ── 3. 有人看这条会话：一律推卡 ────────────────────────────────────────────

test('有人看着这条会话：工作区内写也推卡（不替屏幕前的人做决定）', async () => {
  const ctx = ctxWith('WITHIN');
  const decision = await autoReview.decide(ctx, request('workspace-write'), sessionWithModel(), true);
  assert.equal(decision.action, 'card');
  assert.equal(decision.by, 'watching');
  assert.equal(ctx.calls.length, 0, '人在场时不必叫判定模型');
});

// ── 4. 「谁在看」的判据来自审批桥的订阅表 ──────────────────────────────────

test('isSessionWatched 只看这条会话的订阅数，不受别的会话影响', () => {
  approvals.resetForTest();
  const detach = approvals.attachSession('s-1', () => {});
  assert.equal(approvals.isSessionWatched('s-1'), true);
  assert.equal(approvals.isSessionWatched('s-2'), false, '别的会话有人看，不算这条有人看');
  detach();
  assert.equal(approvals.isSessionWatched('s-1'), false, '最后一个人断开就是没人看了');
});

test('开关打开时，没人看的界外动作走推卡而不是放行', async () => {
  // 端到端口径：装上桥、开自动审阅档、没人订阅，让 danger-full-access 那条钩子跑。
  approvals.resetForTest();
  const listeners = new Map();
  const ctx = {
    apiProxy: { respond: async () => ({ accepted: false }) },
    get: () => undefined,
    on(name, listener) {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      };
    },
  };
  approvals.installApprovalBridge(ctx);
  approvals.setAutoReviewConfig(() => ({ approvalAutoReview: true }));
  const hook = (listeners.get('approval/request') || [])[0];
  assert.ok(hook, '审批钩子必须装上');
  const outcome = await hook(request('danger-full-access', { agent: { session: sessionWithModel() } }), () => Promise.resolve('unavailable'));
  assert.equal(outcome, 'unavailable', '没人看 + 越界：交回推卡那条路，绝不回 allowed-once');
  approvals.resetForTest();
});

test('record 把判定记进插件自己的账本（旁路，坏了也不改结论）', () => {
  // 口径 2026-11-10 改：判定记录**不写会话日志**。宿主读盘时遇到不认识的事件类型会拒绝解释
  // 整份日志，一条旁路记账不该有让会话打不开的力气，所以改落插件自己的
  // `auto-review-log.json`（路径可用 `DSH_MOBILE_AUTO_REVIEW_LOG` 指到临时文件）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-review-'));
  const file = path.join(dir, 'auto-review-log.json');
  const previous = process.env.DSH_MOBILE_AUTO_REVIEW_LOG;
  process.env.DSH_MOBILE_AUTO_REVIEW_LOG = file;
  try {
    const session = sessionWithModel();
    autoReview.record(session, { action: 'card', verdict: 'unsure', by: 'judge', targetMode: 'workspace-write' }, request('workspace-write'));
    assert.ok(!session.events.some((item) => item.type === 'approval/auto-review'), '会话日志里一个字都不许写');
    const items = autoReviewLog.list('s-1');
    assert.equal(items.length, 1, '账本里要留一条可查的判定');
    assert.equal(items[0].action, 'card');
    assert.equal(items[0].decidedBy, 'judge');
    assert.equal(items[0].targetMode, 'workspace-write');
    // 没有 append 的会话不该抛
    assert.doesNotThrow(() => autoReview.record({}, { action: 'card' }, request('workspace-write')));
  } finally {
    autoReviewLog.resetForTest();
    if (previous === undefined) delete process.env.DSH_MOBILE_AUTO_REVIEW_LOG;
    else process.env.DSH_MOBILE_AUTO_REVIEW_LOG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

/**
 * 审批三档 + 事实行 + 同轮重复自动拒的行为守卫（`lib/mobile/approvals.js`）。
 *
 * 锁死五件事：
 *  - 「这一类以后都同意」（allowed-class）：当前这条折成 allowed-once 交回宿主，同时把动作类别
 *    记进本机规则账；下一次同类请求**不再弹卡**、直接静默放行；
 *  - 事实行：从会话日志按 callId 取原始参数算出，随卡下发（`fact` / `rememberable` / `classLabel`）；
 *  - 同一轮里相同请求再次出现 → 直接 auto-reject，不再问；档位不同不算重复；
 *  - 自动放行 / 自动拒之后**不许留下幽灵挂起项**（`approval/asked` 后到的那条不建档）；
 *  - 拒绝理由与规则账的两条路（列出 / 撤销）。
 *
 * 类别键都带沙箱档位（`<base>@<tier>`），所以断言里写的是 `bash:git:commit@danger-full-access`
 * 这种全名。
 *
 * 规则账落盘路径用环境变量指到临时文件，绝不动用户真实账本。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const RULES_FILE = path.join(os.tmpdir(), `dsh-appr-threeway-${process.pid}.json`);
process.env.DSH_MOBILE_APPROVAL_RULES = RULES_FILE;

const approvals = require('../lib/mobile/approvals.js');
const approvalMemory = require('../lib/mobile/approval-memory.js');

function clearRules() {
  try { fs.unlinkSync(RULES_FILE); } catch { /* ignore */ }
}

const HOLD = () => new Promise(() => {});

function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    apiProxy: { respond: async () => ({ accepted: false }) },
    on(name, listener, options) {
      const list = listeners.get(name) || [];
      list.push({ listener, options });
      listeners.set(name, list);
      return () => {
        const index = list.findIndex((entry) => entry.listener === listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };
}

function fire(ctx, name, ...args) {
  for (const { listener } of ctx.listeners.get(name) || []) listener(...args);
}

function runHook(ctx, request, downstream) {
  const chain = (ctx.listeners.get('approval/request') || []).map((entry) => entry.listener);
  const step = (index) => (index < chain.length
    ? chain[index](request, () => step(index + 1))
    : Promise.resolve(downstream()));
  return Promise.resolve(step(0));
}

function jsonRequest(body) {
  const req = new EventEmitter();
  req.url = '/api/mobile/v1/approval/respond';
  req.method = 'POST';
  req.headers = {};
  setImmediate(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

function jsonResponse() {
  const res = { status: 0, body: null, headersSent: false, writableEnded: false };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.end = (chunk) => {
    res.writableEnded = true;
    res.body = chunk == null || chunk === '' ? null : JSON.parse(String(chunk));
  };
  res.on = () => res;
  res.once = () => res;
  return res;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 假会话：eventAt/seq 供事实行按 callId 回扫日志取参数。 */
function fakeSession(id, events) {
  const list = events.slice();
  return {
    id,
    cwd: '/repo',
    get seq() { return list.length - 1; },
    eventAt(i) { return list[i] || null; },
  };
}

const toolCall = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } });

function setup() {
  approvals.resetForTest();
  const ctx = fakeCtx();
  approvals.installApprovalBridge(ctx);
  const cards = [];
  const watch = (sessionId) => approvals.attachSession(sessionId, (frame) => cards.push(frame));
  return { ctx, cards, watch };
}

const approvalReq = (session, overrides = {}) => ({
  agent: { session },
  toolName: 'bash',
  callId: 'call-1',
  reason: 'escalate sandbox to danger-full-access: x',
  ...overrides,
});

// ── 事实行随卡下发 ──────────────────────────────────────────────────────────

test('事实行从会话日志取原始参数算出，随卡下发（write 改文件）', () => {
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [
    toolCall('call-1', 'write', { file_path: '/repo/app/src/ApprovalPanel.tsx', content: 'x' }),
  ]);
  watch('s-1');
  fire(ctx, 'session/event', session, {
    type: 'approval/asked',
    data: { id: 'ap-1', toolName: 'write', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: 改文件' },
  });
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card, '应当出卡');
  assert.equal(card.fact, '改 ApprovalPanel.tsx');
  assert.equal(card.rememberable, true, '能算出动作类别才给第三颗按钮');
  assert.equal(card.classLabel, '改文件 · app（完全访问）', '类别要带沙箱档位的人话');
});

test('参数取不到时卡上没有事实行、也不给第三颗按钮', () => {
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', []);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card);
  assert.equal(card.fact, undefined);
  assert.equal(card.rememberable, undefined);
});

// ── 第三档：这一类以后都同意 ────────────────────────────────────────────────

test('allowed-class：当前这条折成 allowed-once 交回宿主，并记住动作类别', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'git commit -m "补事实行"' })]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const held = runHook(ctx, approvalReq(session), HOLD);
  await flush();
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card);
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-class',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.remembered, true);
  assert.equal(await held, 'allowed-once', '宿主只有 allowed-once 能放行');
  assert.equal(approvalMemory.hasRule('bash:git:commit@danger-full-access'), true, '动作类别带档位被记住');
});

/**
 * 「以后都同意」的粒度：删除 / 推送 / 装软件这三类**不给**这颗按钮。
 *
 * 记住 `bash:rm` 等于把任意 `rm`（包括 `rm -rf ~`）变成静默放行 —— 那不是「同类」，只是
 * 「同名」。这三类每次都要问，宁可多推一张卡。
 */
test('rm / git push / 装包 的卡上没有第三颗按钮', () => {
  for (const [command, label] of [['rm -rf ~', 'bz-rm'], ['git push origin main', 'bz-push'], ['pnpm add lodash', 'bz-install']]) {
    clearRules();
    const { ctx, cards, watch } = setup();
    const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command })]);
    watch('s-1');
    fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
    const card = cards.find((frame) => frame.type === 'approval/requested');
    assert.ok(card, `${label}：卡要照旧出`);
    assert.equal(card.rememberable, undefined, `${label}：不许给「以后都同意」`);
  }
});

test('就算有人硬发 allowed-class，不可记的类别也不会被记住', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'rm -rf ~' })]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const held = runHook(ctx, approvalReq(session), HOLD);
  await flush();
  const card = cards.find((frame) => frame.type === 'approval/requested');
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-class',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.remembered, false, '不可记的类别如实回「没记住」');
  assert.equal(await held, 'allowed-once', '当前这一发照旧放行（那是用户此刻的意思）');
  assert.equal(approvalMemory.hasRule('bash:rm@danger-full-access'), false, '账本里不许出现 bash:rm');
});

test('历史记忆里存过 rm / push / 装包：加载时忽略，也不再生效', async () => {
  clearRules();
  // 模拟旧版本落盘的账本：这三类当时是可记的。
  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify({
    version: 1,
    updatedAt: 1,
    rules: [
      { classKey: 'bash:rm', label: 'Bash · 删除文件', createdAt: 1 },
      { classKey: 'bash:git:push', label: 'Bash · git push', createdAt: 2 },
      { classKey: 'bash:pnpm:add', label: 'Bash · pnpm 装包', createdAt: 3 },
      { classKey: 'write:app', label: '改文件 · app', createdAt: 4 },
    ],
  }));
  assert.equal(approvalMemory.hasRule('bash:rm'), false, '历史规则里的 rm 必须被忽略');
  assert.equal(approvalMemory.hasRule('bash:git:push'), false);
  assert.equal(approvalMemory.hasRule('bash:pnpm:add'), false);
  assert.equal(approvalMemory.hasRule('write:app'), true, '其余规则照旧生效');
  assert.deepEqual(approvalMemory.listRules().map((rule) => rule.classKey), ['write:app'], '撤销页也不该再列出来');
  // 下一次写盘把它们从文件里抹掉（不是只在内存里忽略）。
  approvalMemory.addRule({ classKey: 'read:docs', label: '读文件 · docs' });
  const onDisk = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  assert.deepEqual(onDisk.rules.map((rule) => rule.classKey).sort(), ['read:docs', 'write:app']);
});

test('记住之后同类请求不再弹卡，直接静默放行', async () => {
  clearRules();
  approvalMemory.addRule({ classKey: 'bash:git:commit@danger-full-access', label: 'Bash · git commit（完全访问）' });
  const { ctx, cards } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'git commit -m "x"' })]);
  const held = runHook(ctx, approvalReq(session), HOLD);
  assert.equal(await held, 'allowed-once', '同类此前放行过，直接放行');
  assert.deepEqual(cards, [], '不再弹卡');
});

test('自动放行之后不留幽灵挂起项（事件那侧也不许建档）', async () => {
  clearRules();
  approvalMemory.addRule({ classKey: 'bash:git:commit@danger-full-access', label: 'Bash · git commit（完全访问）' });
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'git commit -m "x"' })]);
  watch('s-1');
  const held = runHook(ctx, approvalReq(session), HOLD);
  assert.equal(await held, 'allowed-once');
  // 钩子已放行，`approval/asked` 随后才到（真实顺序不定）：这一条不许再建一条永不结算的项。
  fire(ctx, 'session/event', session, {
    type: 'approval/asked',
    data: { id: 'ap-1', toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: x' },
  });
  assert.equal(approvals.hasPending('s-1'), false, '自动放行后不许留下挂起项（列表页黄点会常亮）');
  assert.equal(approvals.pendingCardOf('s-1'), undefined);
  assert.deepEqual(cards.filter((frame) => frame.type === 'approval/requested'), [], '也不许推卡');
});

test('同轮自动拒之后同样不留幽灵挂起项', async () => {
  clearRules();
  const { ctx, watch } = setup();
  const session = fakeSession('s-1', [
    toolCall('call-1', 'bash', { command: 'rm -rf build' }),
    toolCall('call-2', 'bash', { command: 'rm -rf build' }),
  ]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
  void runHook(ctx, approvalReq(session, { callId: 'call-1' }), HOLD);
  await flush();
  const second = runHook(ctx, approvalReq(session, { callId: 'call-2' }), HOLD);
  assert.equal(await second, 'rejected');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-2', toolName: 'bash', callId: 'call-2' } });
  const open = approvals.pendingCardOf('s-1');
  assert.notEqual(open && open.approvalId, 'ap-2', '被自动拒的那条不许建档');
});

// ── 同一轮重复请求自动拒 ────────────────────────────────────────────────────

test('同一轮里相同请求再次出现：直接 auto-reject，不再出卡', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [
    toolCall('call-1', 'bash', { command: 'rm -rf build' }),
    toolCall('call-2', 'bash', { command: 'rm -rf build' }),
  ]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
  const first = runHook(ctx, approvalReq(session, { callId: 'call-1' }), HOLD); // 第一次：出卡、挂着
  await flush();
  const second = runHook(ctx, approvalReq(session, { callId: 'call-2' }), HOLD); // 第二次：同 sig → 拒
  assert.equal(await second, 'rejected', '同一轮相同请求应自动拒绝');
  const shown = cards.filter((frame) => frame.type === 'approval/requested');
  assert.equal(shown.length, 1, '重复的那条不该再出卡');
  void first;
});

test('同一轮里档位不同不算重复：两条都出卡', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [
    toolCall('call-1', 'bash', { command: 'rm -rf build' }),
    toolCall('call-2', 'bash', { command: 'rm -rf build' }),
  ]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
  const first = runHook(ctx, approvalReq(session, { callId: 'call-1', reason: 'escalate sandbox to workspace-write: x' }), HOLD);
  await flush();
  const second = runHook(ctx, approvalReq(session, { callId: 'call-2', reason: 'escalate sandbox to danger-full-access: x' }), HOLD);
  await flush();
  const shown = cards.filter((frame) => frame.type === 'approval/requested');
  assert.equal(shown.length, 2, '档位是不同授权范围，不该被当成同一条');
  const labels = shown.map((frame) => frame.classLabel);
  assert.ok(labels.includes('Bash · 删除文件（工作区内）'), labels.join(' / '));
  assert.ok(labels.includes('Bash · 删除文件（完全访问）'), labels.join(' / '));
  void first;
  void second;
});

test('turn/end 之后同一条请求再出现：照常出卡（不误杀）', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'rm -rf build' })]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
  void runHook(ctx, approvalReq(session, { callId: 'call-1' }), HOLD);
  await flush();
  fire(ctx, 'session/event', session, { type: 'turn/end', seq: 9, data: { turn: 'T1' } });
  const again = runHook(ctx, approvalReq(session, { callId: 'call-1' }), HOLD);
  await flush();
  const shown = cards.filter((frame) => frame.type === 'approval/requested');
  assert.ok(shown.length >= 1, '新一轮里同一条请求应重新出卡');
  void again;
});

// ── 拒绝带理由 ──────────────────────────────────────────────────────────────

test('拒绝可带一句 reason，照常交回 rejected', async () => {
  clearRules();
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'rm -rf build' })]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const held = runHook(ctx, approvalReq(session), HOLD);
  await flush();
  const card = cards.find((frame) => frame.type === 'approval/requested');
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'rejected', reason: '这条命令我不放心',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(await held, 'rejected');
  // 理由落可查处：结算帧带上，账本里也留一条（挂起项一结算，只写在它上面的理由就没人读得到了）。
  const resolved = cards.find((frame) => frame.type === 'approval/resolved');
  assert.equal(resolved.reason, '这条命令我不放心');
  const decisions = approvalMemory.listDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, '这条命令我不放心');
  assert.equal(decisions[0].classKey, 'bash:rm@danger-full-access');
  assert.equal(decisions[0].toolName, 'bash');
});

// ── 规则账两条路 ────────────────────────────────────────────────────────────

test('规则清单能列出、能逐条撤销，拒绝记录一并返回', async () => {
  clearRules();
  approvalMemory.addRule({ classKey: 'bash:git:commit@danger-full-access', label: 'Bash · git commit（完全访问）' });
  approvalMemory.addRule({ classKey: 'write:app@workspace-write', label: '改文件 · app（工作区内）' });
  approvalMemory.recordDecision({
    sessionId: 's-1', approvalId: 'ap-9', toolName: 'bash', classKey: 'bash:rm@danger-full-access', reason: '不放心',
  });
  const ctx = fakeCtx();
  const list = jsonResponse();
  await approvals.handleApprovalRules(ctx, {}, list);
  assert.equal(list.body.ok, true);
  assert.equal(list.body.rules.length, 2);
  assert.ok(list.body.rules.some((rule) => rule.classKey === 'bash:git:commit@danger-full-access'));
  assert.equal(list.body.decisions.length, 1, '拒绝记录随规则一起返回');
  assert.equal(list.body.decisions[0].reason, '不放心');

  const revoke = jsonResponse();
  await approvals.handleApprovalRuleRevoke(ctx, jsonRequest({ classKey: 'bash:git:commit@danger-full-access' }), revoke);
  assert.equal(revoke.body.ok, true);
  assert.equal(revoke.body.removed, true);
  assert.equal(approvalMemory.hasRule('bash:git:commit@danger-full-access'), false);

  const missing = jsonResponse();
  await approvals.handleApprovalRuleRevoke(ctx, jsonRequest({ classKey: 'bash:git:commit@danger-full-access' }), missing);
  assert.equal(missing.body.removed, false, '撤不存在的规则如实回 false');
});

test('拒绝记录新到旧、最多 30 条，读坏当空', async () => {
  clearRules();
  for (let i = 0; i < 35; i += 1) {
    approvalMemory.recordDecision({ sessionId: 's-1', approvalId: `ap-${i}`, toolName: 'bash', classKey: 'bash:rm@unknown', reason: `r${i}` });
  }
  const decisions = approvalMemory.listDecisions();
  assert.equal(decisions.length, 30, '最多留 30 条');
  assert.equal(decisions[0].reason, 'r34', '新到旧');

  fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
  fs.writeFileSync(RULES_FILE, '{ 这不是 JSON');
  assert.deepEqual(approvalMemory.listDecisions(), [], '读坏当空，绝不抛');
  assert.deepEqual(approvalMemory.listRules(), []);
});

test('规则撤销缺少 classKey → 400', async () => {
  const ctx = fakeCtx();
  const res = jsonResponse();
  await approvals.handleApprovalRuleRevoke(ctx, jsonRequest({}), res);
  assert.equal(res.status, 400);
});

test.after(() => { clearRules(); });

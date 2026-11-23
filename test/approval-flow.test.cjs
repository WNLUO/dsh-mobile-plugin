'use strict';

/**
 * 审批卡 + 事实行 + 同轮重复自动拒的行为守卫（`lib/mobile/approvals.js`）。
 *
 * 锁死三件事：
 *  - 事实行：从会话日志按 callId 取原始参数算出，随卡下发（`fact` / `factHighlight`）；
 *  - 同一轮里相同请求再次出现 → 直接 auto-reject，不再问；
 *  - 两种作答（允许一次 / 拒绝，拒绝可带理由）如实交回宿主。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const approvals = require('../lib/mobile/approvals.js');

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
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'write', callId: 'call-1' } });
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card, '应当出卡');
  assert.equal(card.fact, '改 ApprovalPanel.tsx');
});

test('参数取不到时卡上没有事实行', () => {
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', []);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card);
  assert.equal(card.fact, undefined);
});

// ── 同一轮重复请求自动拒 ────────────────────────────────────────────────────

test('同一轮里相同请求再次出现：直接 auto-reject，不再出卡', async () => {
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

test('turn/end 之后同一条请求再出现：照常出卡（不误杀）', async () => {
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

// ── 两种作答 ────────────────────────────────────────────────────────────────

test('允许一次：交回 allowed-once', async () => {
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
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-once',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(await held, 'allowed-once');
});

test('拒绝可带一句 reason，照常交回 rejected', async () => {
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
});

test('已下线的 allowed-class 不再被认（400）', async () => {
  const { ctx, cards, watch } = setup();
  const session = fakeSession('s-1', [toolCall('call-1', 'bash', { command: 'git commit -m "x"' })]);
  watch('s-1');
  fire(ctx, 'session/event', session, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call-1' } });
  const held = runHook(ctx, approvalReq(session), HOLD);
  await flush();
  const card = cards.find((frame) => frame.type === 'approval/requested');
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-class',
  }), res);
  assert.equal(res.status, 400);
  void held;
});

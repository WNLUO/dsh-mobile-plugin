'use strict';

/**
 * 手机端审批桥的守卫（`lib/mobile/approvals.js`）。
 *
 * 这条链在 0.2.x 上有三处会**静默**失效，所以三处都真跑一遍，不转写实现：
 *
 *   1. **卡片的形状**。App 的审批面板只认带**帧级 rpcId** 的帧
 *      （`app/src/utils/approvalFrames.ts`，宁可什么都不显示也不给一个按了必然 409 的
 *      按钮）。0.2.x 的宿主不再提供任何帧级 rpcId，本桥铸的那个必须真进到帧里，
 *      而且**不许拿 approvalId 冒充** —— 2026-10 那次「审批弹窗点不动」就是这么来的。
 *   2. **谁先答谁算数**。钩子上的下游（桌面窗口 / ACP / 宿主的 fail-closed）必须照旧拿到
 *      这条请求、卡片照旧出现；手机答得早就用手机的。任何一边落定之后，另一个的卡都要被
 *      收掉，否则手机上留一张点不动的卡。
 *   3. **注册姿势本身就是功能的一部分**。少了 `prepend`，桌面窗口开着时下游会一直等桌面
 *      回答、不调用 `next()`，于是永远轮不到手机（正是这次要修的现象）；少了「只在
 *      0.2.x 装」这道门，0.1.x 上同一个审批会多推一张卡。这两条只能对着注册结果断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const approvals = require('../lib/mobile/approvals.js');
const { handleStream } = require('../lib/mobile/stream.js');

/** 下游永远不给结论：模拟「桌面窗口开着、人还没点」。 */
const HOLD = () => new Promise(() => {});

/** 假 ctx：只记监听器，`on()` 的返回值就是卸载函数（cordis 的约定）。 */
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

/**
 * 按 cordis 的 waterfall 语义跑一遍 `approval/request`：每个监听器拿到 `next`，
 * 调用它就往下走，最后一个的 `next` 是下游（桌面那条路）。
 */
function runHook(ctx, request, downstream) {
  const chain = (ctx.listeners.get('approval/request') || []).map((entry) => entry.listener);
  const step = (index) => (index < chain.length
    ? chain[index](request, () => step(index + 1))
    : Promise.resolve(downstream()));
  return Promise.resolve(step(0));
}

const askEvent = (data) => ({ type: 'approval/asked', seq: 11, time: 1_000, data });
const decidedEvent = (data) => ({ type: 'approval/decided', seq: 12, time: 2_000, data });

/** 假 req：POST 一个 JSON body（`readJsonBody` 挂的是 data/end 两个事件）。 */
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
  const res = {
    status: 0,
    body: null,
    headersSent: false,
    writableEnded: false,
  };
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

function setup() {
  approvals.resetForTest();
  const ctx = fakeCtx();
  approvals.installApprovalBridge(ctx);
  const cards = [];
  const watch = (sessionId) => approvals.attachSession(sessionId, (frame) => cards.push(frame));
  return { ctx, cards, watch };
}

const escalation = (overrides = {}) => ({
  agent: { session: { id: 's-1' } },
  toolName: 'bash',
  callId: 'call-1',
  reason: 'escalate sandbox to danger-full-access: copy the QR code to the desktop',
  displayReason: {
    en: 'Allow this operation with danger-full-access permissions: copy the QR code to the desktop',
    zh: '允许本次操作使用 danger-full-access 权限：把配对二维码复制到桌面',
  },
  ...overrides,
});

// ── 卡片 ────────────────────────────────────────────────────────────────────

test('没人看这个会话时不推卡，但待处理账记着（列表页那颗黄点靠它）', () => {
  const { ctx, cards, watch } = setup();
  watch('s-2');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  assert.equal(approvals.hasPending('s-1'), true, '审批挂起必须记进待处理账');
  assert.equal(approvals.hasPending('s-2'), false);
  assert.deepEqual(cards, [], '没有观众的会话不推卡');
});

test('手机接入时补发，卡里必须是帧级 rpcId（不许拿 approvalId 冒充）', async () => {
  const { ctx, cards, watch } = setup();
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox' }));
  void runHook(ctx, escalation(), HOLD);
  await flush();
  watch('s-1');
  const card = cards.find((frame) => frame.type === 'approval/requested');
  assert.ok(card, '接入后必须补发那张卡，否则用户在列表页点进来是空的');
  assert.equal(card.sessionId, 's-1');
  assert.equal(card.approvalId, 'ap-1', 'approvalId 用宿主自己的 id（App 靠它把 approval/decided 对上）');
  assert.equal(typeof card.rpcId, 'string');
  assert.ok(card.rpcId.length > 0, '帧级 rpcId 不能缺');
  assert.notEqual(card.rpcId, card.approvalId, 'rpcId 不许拿 approvalId 冒充：那样点一下必然 409');
  assert.equal(card.toolName, 'bash');
});

test('钩子上的 displayReason 会升级到卡上（与桌面同一句中文文案）', async () => {
  const { ctx, cards } = setup();
  approvals.attachSession('s-1', (frame) => cards.push(frame));
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox to danger-full-access' }));
  void runHook(ctx, escalation(), HOLD);
  await flush();
  const shown = cards.filter((frame) => frame.type === 'approval/requested');
  assert.equal(shown.length, 2, '事件一次、绑定一次：同一个 rpcId 换一份内容，App 只是替换面板');
  assert.equal(shown[0].rpcId, shown[1].rpcId);
  assert.match(shown[1].reason, /允许本次操作使用 danger-full-access 权限/, '第二帧应是宿主给的 tz 化文案');
});

test('钩子先到也不丢：后到的 approval/asked 把真实 approvalId 补进同一张卡', async () => {
  const { ctx, cards, watch } = setup();
  void runHook(ctx, escalation(), HOLD);
  watch('s-1');
  const first = cards.filter((frame) => frame.type === 'approval/requested');
  assert.equal(first.length, 1, '钩子先到时就该有一张卡（先铸的 id）');
  assert.notEqual(first[0].approvalId, 'ap-1');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  const shown = cards.filter((frame) => frame.type === 'approval/requested');
  assert.equal(shown.length, 2, '补 id 只该换内容，不该再多一张卡');
  assert.equal(shown[1].rpcId, shown[0].rpcId, 'rpcId 不变，已经打开的卡照样答得动');
  assert.equal(shown[1].approvalId, 'ap-1');
});

// ── 回答 ────────────────────────────────────────────────────────────────────

test('手机答了：钩子拿到同一个结论，卡当场收掉，agent 才真的往下走', async () => {
  const { ctx, cards, watch } = setup();
  watch('s-1');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  const held = runHook(ctx, escalation(), HOLD);
  await flush();
  const card = cards.find((frame) => frame.type === 'approval/requested');
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId,
    sessionId: 's-1',
    approvalId: 'ap-1',
    outcome: 'allowed-once',
  }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(await held, 'allowed-once', '结论必须交回宿主那个钩子，否则 agent 一直等');
  const resolved = cards.find((frame) => frame.type === 'approval/resolved');
  assert.ok(resolved, '手机自己答完也要收卡，不能等宿主绕一圈');
  assert.equal(resolved.approvalId, 'ap-1');
  assert.equal(resolved.outcome, 'allowed-once');
});

test('桌面（下游）先答：钩子返回下游的结论，手机那张卡被收掉且再也答不动', async () => {
  const { ctx, cards, watch } = setup();
  watch('s-1');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  const held = runHook(ctx, escalation(), () => Promise.resolve('rejected'));
  assert.equal(await held, 'rejected', '下游答了就以下游为准');
  const resolved = cards.find((frame) => frame.type === 'approval/resolved');
  assert.equal(resolved && resolved.outcome, 'rejected');
  const card = cards.find((frame) => frame.type === 'approval/requested');
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: card.rpcId, sessionId: 's-1', approvalId: 'ap-1', outcome: 'allowed-once',
  }), res);
  assert.equal(res.status, 409, '已经落定的审批要如实回 not-pending，不许谎报成功');
});

test('别人的结论（approval/decided）同样收卡并结算，钩子不必再等', async () => {
  const { ctx, cards, watch } = setup();
  watch('s-1');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  const held = runHook(ctx, escalation(), HOLD);
  await flush();
  fire(ctx, 'session/event', { id: 's-1' }, decidedEvent({ id: 'ap-1', outcome: 'rejected' }));
  assert.equal(await held, 'rejected');
  const resolved = cards.find((frame) => frame.type === 'approval/resolved');
  assert.equal(resolved && resolved.approvalId, 'ap-1');
  assert.equal(approvals.hasPending('s-1'), false, '落定后不许再把会话标成待处理');
});

test('turn 被中止（signal abort）时结算 cancelled，不留一张点不动的卡', async () => {
  const { ctx, cards, watch } = setup();
  watch('s-1');
  fire(ctx, 'session/event', { id: 's-1' }, askEvent({ id: 'ap-1', toolName: 'bash', callId: 'call-1' }));
  const controller = new AbortController();
  const held = runHook(ctx, escalation({ signal: controller.signal }), HOLD);
  await flush();
  controller.abort();
  assert.equal(await held, 'cancelled');
  const resolved = cards.find((frame) => frame.type === 'approval/resolved');
  assert.equal(resolved && resolved.outcome, 'cancelled');
});

test('不认识的 rpcId 交回旧通道（0.1.x 那份真 apiProxy），两条路都不谎报成功', async () => {
  const { ctx } = setup();
  const seen = [];
  ctx.apiProxy.respond = async (body) => { seen.push(body); return { accepted: false }; };
  const res = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: 'rpc-from-0.1.x', sessionId: 's-1', approvalId: 'ap-9', outcome: 'rejected',
  }), res);
  assert.equal(res.status, 409);
  assert.equal(seen.length, 1, '本桥表里没有的 rpcId 必须原样交回 apiProxy.respond');
  assert.equal(seen[0].rpcId, 'rpc-from-0.1.x');
  ctx.apiProxy.respond = async () => ({ accepted: true });
  const ok = jsonResponse();
  await approvals.handleApprovalRespond(ctx, jsonRequest({
    rpcId: 'rpc-from-0.1.x', sessionId: 's-1', approvalId: 'ap-9', outcome: 'rejected',
  }), ok);
  assert.equal(ok.status, 200, '旧通道认了就必须回 200（0.1.x 的行为不能被这条改动挤掉）');
});

// ── 注册姿势 ────────────────────────────────────────────────────────────────

test('注册带 prepend：不抢在宿主自己的转发器前面，桌面窗口一开就永远轮不到手机', () => {
  const { ctx } = setup();
  const registration = (ctx.listeners.get('approval/request') || [])[0];
  assert.ok(registration, 'approval/request 钩子必须装上');
  assert.equal(registration.options.prepend, true, 'prepend 是本桥能生效的前提（见文件头）');
  assert.equal(registration.options.global, true);
  const event = (ctx.listeners.get('session/event') || [])[0];
  assert.ok(event, 'session/event 必须听：卡片的数据源是 approval/asked');
  assert.equal(event.options.global, true, '不带 global 就收不到别的会话的事件');
});

test('审批桥与兼容桥同一道门：0.1.x 上不许再装一遍（那边帧与回答都还走得通）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
  assert.match(source, /if \(!hasHostApiProxy\) ctx\.effect\(\(\) => installApprovalBridge\(ctx\)/,
    '审批桥必须和兼容桥共用 hasHostApiProxy 这道门，否则 0.1.x 上同一个审批会多推一张卡');
});

// ── 写队列 ──────────────────────────────────────────────────────────────────

/** 假 res：`socketBufferedBytes` 模拟写队列里已经积压的字节数（真宿主就这样暴露）。 */
function streamResponse({ socketBufferedBytes = 0 } = {}) {
  const chunks = [];
  const listeners = {};
  return {
    chunks,
    writableLength: 0,
    socket: { writableLength: socketBufferedBytes },
    ended: false,
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.ended = true; },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    once(event, fn) { (listeners[event] ||= []).push(fn); },
    off() {},
    emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
  };
}

function dataFrames(chunks) {
  const out = [];
  for (const chunk of chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6).trim()));
    }
  }
  return out;
}

test('写队列积压到软水位时，草稿可以丢，审批卡不许丢', async () => {
  const { ctx } = setup();
  const sessionId = 's-shed';
  fire(ctx, 'session/event', { id: sessionId }, askEvent({ id: 'ap-shed', toolName: 'bash', callId: 'call-1' }));
  void runHook(ctx, escalation({ agent: { session: { id: sessionId } } }), HOLD);

  // mux 只发一帧没有 seq 的草稿：按这条流的软水位策略它该被 shed。
  const draft = { type: 'session/event', sessionId, event: { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text: 'x' } } } };
  const mux = async function* () { yield { payload: draft }; };
  const streamCtx = {
    apiProxy: {
      events: { mux },
      sessions: { history: async () => ({ result: { ok: true, value: { events: [] } } }) },
    },
  };
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = () => ({ unref() {} });
  global.clearInterval = () => {};
  const req = new EventEmitter();
  req.url = `/api/mobile/v1/session/stream?sessionId=${sessionId}`;
  req.headers = {};
  const res = streamResponse({ socketBufferedBytes: 5 * 1024 * 1024 });
  try {
    const pending = handleStream(streamCtx, req, res);
    await flush();
    const frames = dataFrames(res.chunks);
    assert.ok(
      frames.some((frame) => frame.type === 'approval/requested' && frame.rpcId),
      '审批帧是人工决策的入口，不许被软水位丢掉',
    );
    assert.equal(
      frames.some((frame) => frame.type === 'assistant/chunk'),
      false,
      '同一个水位下草稿照旧该丢：这条规则只对审批帧开口子',
    );
    res.emit('close');
    await pending;
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

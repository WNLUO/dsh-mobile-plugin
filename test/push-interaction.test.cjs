'use strict';

/**
 * 审批 / 提问卡接进推送帧的守卫（`mobile/push-notify.js` + `approvals.js` / `questions.js`）。
 *
 * 这一版要钉住的东西：
 *   1. `notifyInteraction` 把两类卡帧归一成给原生挂按钮用的 `interaction`：审批带 approvalId、
 *      提问带 options/multiSelect/intent，摘要是一句人话，`category` 与 `pushKind` 对得上。
 *   2. 推送帧的 `kind` 恒为 `'push'`（worker 靠它分流到 PUSH_SEND），事件种类放 `pushKind`；
 *      旧实现同一个对象写了两次 `kind`，后者覆盖前者，帧被当 sync 发进黑洞。
 *   3. 同一张卡（会话:rpcId）只推一帧 —— 例外只有一种：approvalId 从 `approvals.js` 铸的占位
 *      （`m-…`）换成 `approval/asked` 带来的真 id。那一帧是内容升级，吃掉它通知里就留着占位 id，
 *      用户点「允许」回 409、白点一下。
 *   4. 桥里只有「已绑上钩子（bound）= 答得动」的卡才推；未绑上的不推。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPushNotifier } = require('../lib/mobile/push-notify.js');
const approvals = require('../lib/mobile/approvals.js');
const questions = require('../lib/mobile/questions.js');

/** 假 sidecar：pushSync 把 payload 记进数组，永远成功。 */
function fakeNotifier() {
  const pushed = [];
  const notifier = createPushNotifier({
    getSidecar: () => ({ pushSync: async (payload) => { pushed.push(payload); } }),
    tunnelConnected: () => true,
    instanceId: () => 'inst-1',
  });
  return { notifier, pushed };
}

const approvalCard = (overrides = {}) => ({
  type: 'approval/requested',
  sessionId: 's-1',
  rpcId: 'm-appr',
  approvalId: 'a-1',
  toolName: 'bash',
  reason: '允许本次操作使用 danger-full-access 权限',
  ...overrides,
});

const questionCard = (overrides = {}) => ({
  type: 'question/requested',
  sessionId: 's-2',
  rpcId: 'm-q',
  questions: [
    {
      id: 'q1',
      question: '选哪个方案？',
      options: [
        { label: '方案 A', description: '更快' },
        { label: '方案 B' },
      ],
      multiSelect: false,
    },
  ],
  ...overrides,
});

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('notifyInteraction：审批卡组出正确的 interaction 与推送帧', async () => {
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-1', approvalCard(), '我的会话');
  await flush();
  assert.equal(pushed.length, 1, '一张卡应只推一帧');
  const frame = pushed[0];
  assert.equal(frame.kind, 'push', 'kind 必须是 push（不能被事件种类覆盖）');
  assert.equal(frame.pushFrame, 'send');
  assert.equal(frame.pushKind, 'approval');
  assert.equal(frame.category, 'dsh.approval');
  assert.equal(frame.title, '我的会话');
  assert.equal(frame.body, '允许本次操作使用 danger-full-access 权限', 'body 用 reason 当摘要');
  assert.equal(frame.interaction.kind, 'approval');
  assert.equal(frame.interaction.rpcId, 'm-appr');
  assert.equal(frame.interaction.approvalId, 'a-1');
  assert.equal(frame.interaction.sessionId, 's-1');
  assert.equal(frame.interaction.summary, frame.body);
  assert.equal(frame.interaction.questions, undefined, '审批卡不带 questions');
});

test('notifyInteraction：审批无 reason 时摘要落到「工具 X 请求越权执行」', async () => {
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-1', approvalCard({ reason: '' }));
  await flush();
  assert.equal(pushed[0].body, '工具 bash 请求越权执行');
});

test('notifyInteraction：提问卡的 options / multiSelect / intent 原样进 interaction', async () => {
  const { notifier, pushed } = fakeNotifier();
  const card = questionCard({
    questions: [{
      id: 'q1',
      question: '选哪个方案？',
      multiSelect: true,
      options: [{ label: '方案 A', description: '更快' }, { label: '方案 B' }],
      intent: { kind: 'plan-review', approve: '允许执行' },
    }],
  });
  await notifier.notifyInteraction('s-2', card);
  await flush();
  const frame = pushed[0];
  assert.equal(frame.kind, 'push', 'kind 必须是 push');
  assert.equal(frame.pushKind, 'plan-review');
  assert.equal(frame.category, 'dsh.pending');
  assert.equal(frame.body, '选哪个方案？');
  const q = frame.interaction.questions[0];
  assert.equal(q.id, 'q1');
  assert.equal(q.multiSelect, true);
  assert.deepEqual(q.options, [{ label: '方案 A', description: '更快' }, { label: '方案 B' }]);
  assert.deepEqual(q.intent, { kind: 'plan-review', approve: '允许执行' });
});

test('notifyInteraction：普通提问 pushKind=question、category=dsh.question', async () => {
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-2', questionCard());
  await flush();
  assert.equal(pushed[0].pushKind, 'question');
  assert.equal(pushed[0].category, 'dsh.question');
  assert.equal(pushed[0].interaction.approvalId, undefined, '提问卡不带 approvalId');
});

test('notifyInteraction：同一 rpcId、approvalId 没变只推一帧', async () => {
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-same' }));
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-same' }));
  await flush();
  assert.equal(pushed.length, 1, '同一张卡只放一帧');
});

test('notifyInteraction：占位 approvalId 换成真 id 必须重推（内容升级，不是重复）', async () => {
  // 缺陷现场：approvals.js 在钩子先到时铸一个 `m-<uuid>` 占位，`approval/asked` 到了才换成
  // 宿主的真 id 并重推同一 rpcId。按（会话, rpcId）去重把那第二帧吃掉 ⇒ 通知里留的是占位 id，
  // 用户点「允许」回 409，原生把 409 当已结算撤通知，宿主那张卡还挂着 —— 白点一下。
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-up', approvalId: 'm-0000' }));
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-up', approvalId: 'req-real-1' }));
  await flush();
  assert.equal(pushed.length, 2, '占位 → 真 id 是内容升级，要放过去');
  assert.equal(pushed[0].interaction.approvalId, 'm-0000');
  assert.equal(pushed[1].interaction.approvalId, 'req-real-1', '第二帧带的是可作答的真 id');
});

test('notifyInteraction：真 id 反过来换成占位不重推', async () => {
  const { notifier, pushed } = fakeNotifier();
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-down', approvalId: 'req-real-2' }));
  await notifier.notifyInteraction('s-1', approvalCard({ rpcId: 'm-down', approvalId: 'm-1111' }));
  await flush();
  assert.equal(pushed.length, 1, '只认「占位 → 真 id」这一个方向');
});

test('notifyTurnEnded：kind 恒为 push，结局放 pushKind', async () => {
  const { notifier, pushed } = fakeNotifier();
  notifier.notifyTurnEnded('s-3', { turn: 7, status: 'completed' }, '会话三');
  await flush();
  assert.equal(pushed[0].kind, 'push');
  assert.equal(pushed[0].pushKind, 'completed');
  assert.equal(pushed[0].body, '✓');
});

// ---------------------------------------------------------------------------
// 桥的推入口：未 bound 不推，bound 只推一次
// ---------------------------------------------------------------------------

/** 只记监听器的假 ctx（`on()` 返回卸载函数，cordis 约定）。 */
function fakeCtx() {
  const listeners = new Map();
  return {
    apiProxy: { respond: async () => ({ accepted: false }) },
    on(name, listener) {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    listeners,
  };
}

function fire(ctx, name, ...args) {
  for (const listener of ctx.listeners.get(name) || []) listener(...args);
}

/** 按 cordis waterfall 语义跑一遍钩子：最后一个 next 交给 downstream（这里永不落定）。 */
function runHook(ctx, name, request) {
  const chain = ctx.listeners.get(name) || [];
  const step = (index) => (index < chain.length
    ? chain[index](request, () => step(index + 1))
    : new Promise(() => {}));
  return step(0);
}

test('审批桥：未 bound 的卡不推，bind 之后只推一次', async () => {
  approvals.resetForTest();
  const ctx = fakeCtx();
  const pushed = [];
  approvals.installApprovalBridge(ctx, (sessionId, card) => pushed.push({ sessionId, card }));

  // approval/asked 先到：建项但还没绑上钩子 → 不可作答 → 不推。
  fire(ctx, 'session/event', { id: 's-9' }, {
    type: 'approval/asked',
    data: { id: 'a-9', toolName: 'bash', callId: 'call-9', reason: '要越权' },
  });
  await flush();
  assert.equal(pushed.length, 0, '未 bound 的卡不该推');

  // 钩子到达：绑上同一条（按 callId/toolName 配对）→ bound → 推一次。
  void runHook(ctx, 'approval/request', {
    agent: { session: { id: 's-9' } },
    toolName: 'bash',
    callId: 'call-9',
    reason: '要越权',
  });
  await flush();
  assert.equal(pushed.length, 1, 'bind 之后推一次');
  assert.equal(pushed[0].card.type, 'approval/requested');
  assert.equal(pushed[0].card.rpcId.startsWith('m-'), true);
  approvals.resetForTest();
});

test('提问桥：hook 绑定的卡推一次', async () => {
  questions.resetForTest();
  const ctx = fakeCtx();
  const pushed = [];
  questions.installQuestionBridge(ctx, (sessionId, card) => pushed.push({ sessionId, card }));

  void runHook(ctx, 'user-questions/request', {
    agent: { session: { id: 's-8' } },
    wait: { callId: 'call-8' },
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }],
  });
  await flush();
  assert.equal(pushed.length, 1, '可作答的提问卡推一次');
  assert.equal(pushed[0].card.rpcId.startsWith('m-'), true);
  questions.resetForTest();
});

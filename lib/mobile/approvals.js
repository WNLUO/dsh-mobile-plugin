'use strict';

/**
 * 手机端审批桥（DSH 0.2.x）。
 *
 * 0.2.x 删掉了 apiProxy，审批变成会话日志里的 `approval/asked` / `approval/decided` 事件对
 * 加一个进程内 waterfall 钩子 `approval/request`，帧级 rpcId 就此消失，而 App 的审批面板
 * 只认带 rpcId 的帧。这里按新形状把那半条通道补起来，App 契约一行不改：听 `approval/asked`
 * 自己铸 rpcId 推卡，同时挂 `approval/request` 把手机挂成候选人，`/approval/respond` 按
 * rpcId 找到挂起项把结论交回钩子。
 *
 * 钩子必须 prepend：宿主自己的转发器在桌面窗口开着时会一直等桌面回答、不调用 `next()`，
 * 老实排在注册顺序后面等于「桌面开着时手机永远收不到」。
 *
 * 钩子上没有宿主 id，且与 `approval/asked` 的到达顺序不定，所以两个来源共用一张挂起项表：
 * 先到的建项，后到的补字段。
 */

const { randomUUID } = require('node:crypto');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** `/approval/respond` 只认这两种结论（与 App 的两个按钮一一对应）。 */
const ANSWER_OUTCOMES = new Set(['allowed-once', 'rejected']);
/** 宿主 `approval/decided` 的结论词表（`dsh-user-approval` 的 OUTCOMES）。 */
const DECISIONS = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/** sessionId → Set<sink>：正在看这个会话的手机连接（每条 SSE 一个 sink）。 */
const watchers = new Map();
/** rpcId → entry：回答时按它定位。 */
const entries = new Map();
/** sessionId → entry[]（保序）：把钩子上的请求和事件里的审批对上。 */
const bySession = new Map();

function watcherCount(sessionId) {
  const set = watchers.get(sessionId);
  return set ? set.size : 0;
}

function openEntries(sessionId) {
  const list = bySession.get(sessionId);
  return list ? list.filter((entry) => !entry.settled) : [];
}

/**
 * 卡片帧。形状严格照 App `utils/approvalFrames.ts` 认的那一种：**帧级 rpcId** + payload 上的
 * approvalId；reason 为空时 App 会自己落到「工具 X 请求越权执行」，与桌面同一句兜底文案。
 */
function cardFrame(entry) {
  return {
    type: 'approval/requested',
    sessionId: entry.sessionId,
    rpcId: entry.rpcId,
    approvalId: entry.approvalId,
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

/**
 * 结算帧。App 按 approvalId 比对（`approvalResolved`），所以这条让手机立刻收卡，不必等
 * 宿主的 `approval/decided` 绕一圈 —— 尤其是手机自己答的那一条，桌面那条路已经不需要了。
 */
function resolvedFrame(entry, outcome) {
  return { type: 'approval/resolved', sessionId: entry.sessionId, approvalId: entry.approvalId, outcome };
}

function broadcast(sessionId, frame) {
  const set = watchers.get(sessionId);
  if (!set) return;
  for (const sink of set) {
    // 单条连接写失败（客户端正好走了）不影响别的手机拿到这张卡。
    try { sink(frame); } catch { /* ignore */ }
  }
}

function pushCard(entry) {
  if (entry.settled || watcherCount(entry.sessionId) === 0) return;
  broadcast(entry.sessionId, cardFrame(entry));
}

/**
 * 取（或建）一条挂起项。两个来源都走这里：按 callId → toolName 配对，配对不上的就新建。
 *
 * `unboundOnly` 只给钩子用：钩子绑上一条就已经接管了它（回答由那条钩子的 promise 决定），
 * 第二条钩子请求绝不能共用同一条挂起项。反过来，事件那一侧必须能认领**已经绑上**的挂起项 ——
 * 「钩子先到、`approval/asked` 后到」时就是靠这一步把真实的 approvalId 补进去的。
 */
function entryFor(sessionId, ask, { unboundOnly = false } = {}) {
  const open = openEntries(sessionId).filter((entry) => !unboundOnly || !entry.bound);
  // 两个来源拿到的是宿主**同一个** request 对象（`dsh-user-approval.request()` 把 req 原样
  // 交给钩子，`approval/asked` 也照它记 toolName/callId），所以按 callId → toolName 配对是
  // 精确的；配对不上就新建（宁可多一张卡，也不要两条审批共用一张卡）。
  const match = open.find((entry) => ask.callId && entry.callId === ask.callId)
    || open.find((entry) => ask.toolName && entry.toolName === ask.toolName);
  if (match) return match;
  const entry = {
    // rpcId 是本桥自己铸的：0.2.x 的宿主不再提供任何可作答的帧级 id，而 App 只认带 rpcId 的帧。
    rpcId: `m-${randomUUID()}`,
    sessionId,
    // 钩子先到时还不知道宿主的 approvalId，先铸一个占位（只用于挂起项身份，回答不看它）；
    // `approval/asked` 一到就换成真 id，好让 App 能把 approval/decided 对上。
    approvalId: ask.approvalId || `m-${randomUUID()}`,
    toolName: ask.toolName,
    callId: ask.callId,
    reason: ask.reason,
    bound: false,
    settled: false,
    wait: null,
    release: null,
  };
  entry.wait = new Promise((resolve) => { entry.release = resolve; });
  entries.set(entry.rpcId, entry);
  let list = bySession.get(sessionId);
  if (!list) { list = []; bySession.set(sessionId, list); }
  list.push(entry);
  return entry;
}

/** 结算一条挂起项：唤醒等待中的钩子、撤下挂起项、让手机收卡。重复调用无副作用。 */
function settle(entry, outcome) {
  if (entry.settled) return false;
  entry.settled = true;
  entries.delete(entry.rpcId);
  const list = bySession.get(entry.sessionId);
  if (list) {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) bySession.delete(entry.sessionId);
  }
  entry.release({ outcome });
  broadcast(entry.sessionId, resolvedFrame(entry, outcome));
  return true;
}

/**
 * 手机接上/离开某条会话流。接入时补发仍然可作答的卡；断开只摘掉这一个 sink —— 挂起项本身
 * 继续等（用户可能马上就回来），由宿主的 signal 中止或别人答掉来收尾。
 */
function attachSession(sessionId, sink) {
  let set = watchers.get(sessionId);
  if (!set) { set = new Set(); watchers.set(sessionId, set); }
  set.add(sink);
  // 补发：审批可能在手机还没看这个会话时就挂起了（用户在列表页点了进来），
  // 而钩子上的请求还在等 —— 那时候这张卡仍然答得动。
  for (const entry of openEntries(sessionId)) {
    if (entry.bound) { try { sink(cardFrame(entry)); } catch { /* ignore */ } }
  }
  return () => {
    set.delete(sink);
    if (set.size === 0) watchers.delete(sessionId);
  };
}

/** 会话摘要里的待处理标记（0.2.x 的宿主不会再下发这个字段，见 sessions.js 的用法）。 */
function hasPending(sessionId) {
  return openEntries(sessionId).length > 0;
}

/** 测试用：清空全部进程内状态（真实运行时由插件卸载时的 disposer 收尾）。 */
function resetForTest() {
  watchers.clear();
  entries.clear();
  bySession.clear();
}

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null;
  if (typeof session.id === 'string' && session.id) return session.id;
  // 宿主自己的两处写法不一致（`dsh-api-session-controller` 用 `session.id`，
  // `dsh-acp` 用 `session.header.id`）；认不出会话 id 就等于这条审批没人能答，所以两种都认。
  const header = session.header;
  return header && typeof header.id === 'string' && header.id ? header.id : null;
}

function sessionIdOfRequest(request) {
  const agent = request && request.agent;
  const session = agent && agent.session;
  return sessionIdOf(session);
}

/** 升级卡片的文案：宿主给 `displayReason`（tz 化文案）时优先用它，与桌面同一句。 */
function displayReasonOf(request) {
  const display = request && request.displayReason;
  if (!display || typeof display !== 'object') return undefined;
  const zh = display.zh;
  if (typeof zh === 'string' && zh) return zh;
  return Object.values(display).find((value) => typeof value === 'string' && value);
}

/** `approval/asked`：宿主记下这次审批。details 见 `dsh-user-approval` 的 `request()`。 */
function noteAsk(sessionId, data) {
  const approvalId = typeof data.id === 'string' && data.id ? data.id : null;
  if (!approvalId) return;
  const entry = entryFor(sessionId, {
    approvalId,
    toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
    callId: typeof data.callId === 'string' ? data.callId : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  });
  if (entry.approvalId === approvalId) { pushCard(entry); return; }
  // 钩子先到、铸了占位 id：换成宿主的真 id 并重发一次卡（同 rpcId，App 只是换一份内容）。
  entry.approvalId = approvalId;
  pushCard(entry);
}

/** `approval/decided`：这条审批已经有结论了（桌面答的、或被取消），把卡和挂起项一起收掉。 */
function noteDecided(sessionId, data) {
  const approvalId = typeof data.id === 'string' && data.id ? data.id : null;
  if (!approvalId) return;
  const entry = openEntries(sessionId).find((candidate) => candidate.approvalId === approvalId);
  if (!entry) return;
  settle(entry, DECISIONS.has(data.outcome) ? data.outcome : 'unavailable');
}

/**
 * 把一条钩子请求绑到挂起项上。
 *
 * 绑上才算「答得动」：`/approval/respond` 只结算 bound 的挂起项，否则手机点了按钮而 agent
 * 那头没人接（比如本桥没装上、请求走的是别的回答者），如实回 409 比假成功好。
 */
function bindRequest(entry, request) {
  entry.bound = true;
  entry.toolName = entry.toolName || (typeof request.toolName === 'string' ? request.toolName : undefined);
  entry.callId = entry.callId || (typeof request.callId === 'string' ? request.callId : undefined);
  const nicer = displayReasonOf(request) || (typeof request.reason === 'string' ? request.reason : undefined);
  if (nicer) entry.reason = nicer;
  // 绑上再推一次：`approval/asked` 那条路已经推过一张（可能是占位 id、也可能是没 tz 化的
  // 原始 reason），这里换成最终那份内容。同一个 rpcId，App 只是替换面板内容。
  pushCard(entry);
  const signal = request.signal;
  if (signal && typeof signal.addEventListener === 'function') {
    const onAbort = () => { settle(entry, 'cancelled'); };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      // 结算时把监听撤掉：这条 signal 归调用方的 turn 所有，挂着的监听会跟到 turn 结束。
      const release = entry.release;
      entry.release = (result) => { signal.removeEventListener('abort', onAbort); release(result); };
    }
  }
}

/**
 * 挂起这条请求直到有人给结论。
 *
 * 传了 `next` 就与下游竞速：`next()` 一调，桌面窗口那张卡照旧出现，谁先给结论谁算数，
 * 输的那张卡由结算帧收掉；两边都没人答就一直挂着。
 *
 * 不传 `next`（手机正在看这个会话）就是手机独家作答：不往下游转发，桌面从源头就不弹卡。
 * 桌面那张卡挂在被转发的请求上，本桥没有替它收尾的口子，转发出去手机先答，它只会永远
 * 悬着。独家作答后结论照常走 `approval/decided`，桌面看得到裁决结果。
 */
function holdForPhone(entry, next) {
  const downstream = next === undefined
    ? new Promise(() => {})
    : Promise.resolve().then(() => next()).then((outcome) => {
      const value = DECISIONS.has(outcome) ? outcome : 'unavailable';
      settle(entry, value);
      return value;
    });
  return Promise.race([entry.wait.then((result) => result.outcome), downstream]);
}

function onApprovalRequest(request, next) {
  const sessionId = sessionIdOfRequest(request);
  if (!sessionId) return next();
  const entry = entryFor(sessionId, {
    approvalId: undefined,
    toolName: typeof request.toolName === 'string' ? request.toolName : undefined,
    callId: typeof request.callId === 'string' ? request.callId : undefined,
    reason: typeof request.reason === 'string' ? request.reason : undefined,
  }, { unboundOnly: true });
  bindRequest(entry, request);
  // 手机正在看这个会话就不往下游转发（不传 next）：桌面从源头不弹卡，由手机独家作答。
  // 没有观众时照旧竞速，纯桌面使用一字不改。
  return holdForPhone(entry, watcherCount(sessionId) > 0 ? undefined : next);
}

/**
 * 装上审批桥（只在 0.2.x 那一侧装：0.1.x 宿主自带 apiProxy，帧和回答都还走得通，装上去
 * 只会多推一张卡）。
 */
function installApprovalBridge(ctx) {
  const disposers = [
    ctx.on('session/event', (session, event) => {
      const sessionId = sessionIdOf(session);
      if (!sessionId || !event || typeof event !== 'object') return;
      if (event.type === 'approval/asked') noteAsk(sessionId, event.data || {});
      else if (event.type === 'approval/decided') noteDecided(sessionId, event.data || {});
    }, { global: true }),
    // prepend 是前提不是优化，理由见文件头。
    ctx.on('approval/request', onApprovalRequest, { prepend: true, global: true }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
    for (const entry of [...entries.values()]) settle(entry, 'cancelled');
  };
}

/**
 * POST /api/mobile/v1/approval/respond —— `{rpcId, sessionId, approvalId, outcome}`。
 *
 * 先查本桥的挂起项；查不到就交回 `ctx.apiProxy.respond`（0.1.x 宿主那份真 apiProxy 才是
 * 它的归宿；0.2.x 的兼容桥会如实回 `host-unsupported`，于是落到下面那条 409）。
 *
 * `respond` 的返回形态两条通道不同（0.1.x 是 Promise、0.2.x 兼容桥是同步对象），
 * 所以这里不能直接 `.catch()` —— 同步对象上没有这个方法，会抛 TypeError 被路由守卫
 * 兜成 500。详见 `mobile/questions.js` 的 `respondViaLegacyProxy`，两处同一口径。
 */
async function handleApprovalRespond(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.rpcId !== 'string' || !body.rpcId
    || typeof body.sessionId !== 'string' || !body.sessionId
    || typeof body.approvalId !== 'string' || !body.approvalId
    || !ANSWER_OUTCOMES.has(body.outcome)) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { rpcId, sessionId, approvalId, outcome }' } });
  }
  const entry = entries.get(body.rpcId);
  if (entry && !entry.settled && entry.bound
    && entry.sessionId === body.sessionId && entry.approvalId === body.approvalId) {
    settle(entry, body.outcome);
    return sendJson(res, 200, { ok: true, accepted: true });
  }
  const receipt = await respondViaLegacyProxy(ctx, {
    type: 'client-response',
    rpcId: body.rpcId,
    result: { ok: true, value: { sessionId: body.sessionId, approvalId: body.approvalId, outcome: body.outcome } },
  });
  if (!receipt || receipt.accepted !== true) {
    // 本桥不认识、旧通道也不认：这条审批在**我们这一侧**已经死了（挂起项只活在进程内，
    // 插件重载 / 宿主重启就没了）。
    //
    // 与提问桥同一口径（见 questions.js 同位置）：**不推结算帧**。手机端要靠这张卡把
    // 失败原因写出来（`ApprovalPanel` 的 error 行），卡一收掉就跟着卸载，那句话没地方落。
    return sendJson(res, 409, {
      ok: false,
      error: {
        code: 'not-pending',
        message: '这条审批已经不在等待结论（插件重载或宿主重启后挂起的审批会失效），请回桌面端处理。',
      },
    });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

/**
 * 把结论交回旧通道的 `ctx.apiProxy.respond`，Promise 与同步对象两种返回都收。
 *
 * 两条通道形态不同：0.1.x 的真 apiProxy 回 Promise，0.2.x 的兼容桥回同步对象。同步对象上
 * 没有 `.catch`，直接链 Promise 会抛 TypeError 被路由守卫兜成 500。抛错与「通道说不认」
 * 一律折算成 null，调用方据此如实回 409。
 */
async function respondViaLegacyProxy(ctx, message) {
  const proxy = ctx && ctx.apiProxy;
  if (!proxy || typeof proxy.respond !== 'function') return null;
  try {
    const reply = proxy.respond(message);
    const settled = await reply;
    return settled && typeof settled === 'object' ? settled : null;
  } catch {
    return null;
  }
}

module.exports = {
  installApprovalBridge,
  handleApprovalRespond,
  attachSession,
  hasPending,
  resetForTest,
};

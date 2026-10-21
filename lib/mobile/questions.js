'use strict';

/**
 * 手机端提问桥（DSH 0.2.x）：`ask_user_question` 与「计划评审」。
 *
 * ≤0.1.x 的宿主把提问当成 apiProxy 事件流上的 server-request：
 * `{rpcId, payload:{type:'question/requested', sessionId, questions}}`，手机凭**帧级 rpcId**
 * 回答（`/question/respond` 把 rpcId 回给宿主那张 pending 表）。0.2.x 把 apiProxy 删了，
 * 提问只剩一个**进程内** waterfall 钩子 `user-questions/request`（`dsh-user-questions`
 * 发起，`dsh-tool-ask-user` 与 `dsh-plan-mode` 是它的两个调用方），帧级 rpcId 随之消失，
 * 于是手机既收不到卡片、也没有能回传的 id。
 *
 * 这里按 0.2.x 的形状把这条通道补起来，**手机端契约一行不改**（App 仍然收
 * `question/requested` + 帧级 rpcId，仍然 POST `/question/respond`）：
 *
 *   1. 听 `user-questions/request` 钩子（**prepend**，理由与审批桥同一条：宿主的转发器
 *      `dsh-api-remotes` 在桌面窗口开着时会一直等桌面回答、不调用 `next()`）。铸一个自己的
 *      rpcId，把卡片推给正在看这个会话的手机，然后把请求挂住。
 *   2. 下游照旧拿到请求（桌面那张卡照旧出现，`dsh-plan-mode` 也一样），两边竞速：
 *      手机答得早就用手机的，桌面答得早就用桌面的。
 *   3. `/question/respond` 拿 rpcId 找到挂起项，把回答交回钩子 —— 这才是真正让 agent
 *      继续往下跑的那一步。落定后广播 `question/resolved`，另一边那张卡被收掉。
 *
 * 「计划评审」不走另一条通道：`dsh-plan-mode` 的 `exit_plan_mode` 就是拿
 * `ctx.userQuestions.ask()` 问的（问题带 `intent.kind='plan-review'`、`detail` 是计划正文、
 * 选项里有一个「批准」标签），所以这道桥同时修好它。App 的问题面板本来就渲染
 * `detail` 与 `options`，计划正文直接显示在详情里。
 */

const { randomUUID } = require('node:crypto');
const { sendJson, readJsonBody } = require('../shared/http-util');

/** sessionId → Set<sink>：正在看这个会话的手机连接（每条 SSE 一个 sink）。 */
const watchers = new Map();
/** rpcId → entry：回答时按它定位。 */
const entries = new Map();
/** sessionId → entry[]（保序）：接入时补发、摘要里数待处理。 */
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
 * 卡片的 `intent`：只带「这是什么」的 kind 与批准按钮的标签。
 *
 * `dsh-plan-mode` 的 `exit_plan_mode` 也是走 `ctx.userQuestions.ask()` 提问的，问题带
 * `intent:{kind:'plan-review', approve:'允许执行', callId}`。手机要靠 kind 把它渲染成
 * 「计划待审」接管卡而不是一张普通选择题；callId 是宿主的内部句柄，**不许**跟着外泄。
 * 没有 intent（或 kind 不合法）时返回 undefined，调用方据此不往卡里塞空对象。
 */
function intentOf(question) {
  const intent = question && question.intent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return undefined;
  const kind = typeof intent.kind === 'string' ? intent.kind.trim() : '';
  if (!kind) return undefined;
  const approve = typeof intent.approve === 'string' ? intent.approve.trim() : '';
  return { kind, ...(approve ? { approve } : {}) };
}

/**
 * 卡片帧。形状严格照 App `streamFrame.ts` 认的那一种：**帧级 rpcId** + 顶层
 * `sessionId` + `questions`（每题至少 `id` 与 `question` 两个字符串）。
 * 只转发 App 认识的字段；`intent` 只留 kind 与 approve，宿主的其它内部键
 * （如 `intent` 里的 callId）不外泄。
 */
function cardFrame(entry) {
  return {
    type: 'question/requested',
    sessionId: entry.sessionId,
    rpcId: entry.rpcId,
    questions: entry.questions.map((question) => {
      const intent = intentOf(question);
      return {
        id: question.id,
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        ...(question.detail ? { detail: question.detail } : {}),
        ...(question.options ? { options: question.options } : {}),
        ...(question.multiSelect ? { multiSelect: question.multiSelect } : {}),
        ...(intent ? { intent } : {}),
      };
    }),
  };
}

/**
 * 结算帧。App 按 `questionRpcId` 比对后清掉面板（`streamFrame.ts` 的
 * `question/resolved` 分支），所以这里必须带上本桥铸的那个 rpcId。
 */
function resolvedFrame(entry) {
  return { type: 'question/resolved', sessionId: entry.sessionId, questionRpcId: entry.rpcId };
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

function entryFor(sessionId, request) {
  const entry = {
    // rpcId 是本桥自己铸的：0.2.x 的宿主不再提供任何可作答的帧级 id，而 App 只认带 rpcId 的帧。
    rpcId: `m-${randomUUID()}`,
    sessionId,
    callId: request && request.wait && typeof request.wait.callId === 'string' ? request.wait.callId : undefined,
    questions: Array.isArray(request && request.questions) ? request.questions : [],
    bound: false,
    settled: false,
    signalReason: null,
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

/**
 * 结算一条挂起项：撤下挂起项、让手机收卡、唤醒等待中的钩子。
 * `answers` 有值 = 手机给了答案；null = 手机这条路没结论（被取消 / 别人先答了）。
 */
function settle(entry, answers) {
  if (entry.settled) return false;
  entry.settled = true;
  entries.delete(entry.rpcId);
  const list = bySession.get(entry.sessionId);
  if (list) {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) bySession.delete(entry.sessionId);
  }
  entry.release({ answers });
  broadcast(entry.sessionId, resolvedFrame(entry));
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
  for (const entry of openEntries(sessionId)) {
    if (entry.bound) { try { sink(cardFrame(entry)); } catch { /* ignore */ } }
  }
  return () => {
    set.delete(sink);
    if (set.size === 0) watchers.delete(sessionId);
  };
}

/** 会话摘要里的待处理标记（0.2.x 的宿主不会再下发这个字段，见 sessions.js 的用法）。 */
function pendingKind(sessionId) {
  const open = openEntries(sessionId);
  if (open.length === 0) return undefined;
  const planReview = open.some((entry) => entry.questions.some((question) => {
    const intent = question && question.intent;
    return intent && typeof intent === 'object' && intent.kind === 'plan-review';
  }));
  return planReview ? 'plan-review' : 'question';
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
  const header = session.header;
  return header && typeof header.id === 'string' && header.id ? header.id : null;
}

function sessionIdOfRequest(request) {
  const agent = request && request.agent;
  const session = agent && agent.session;
  return sessionIdOf(session);
}

/** 把回答批次校验成宿主 `AskUserQuestionAnswer` 的形状：每题恰好一条、标题合法。 */
function normalizeAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return null;
  const byId = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer.id !== 'string' || byId.has(answer.id)) return null;
    if (!Array.isArray(answer.selected) || !answer.selected.every((label) => typeof label === 'string')) return null;
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return null;
    byId.set(answer.id, {
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    });
  }
  if (!questions.every((question) => byId.has(question.id))) return null;
  return questions.map((question) => byId.get(question.id));
}

/** 绑上钩子请求：从此这条挂起项「答得动」，并接上宿主的取消信号。 */
function bindRequest(entry, request) {
  entry.bound = true;
  pushCard(entry);
  const signal = request.signal;
  if (!signal || typeof signal.addEventListener !== 'function') return;
  const onAbort = () => {
    entry.signalReason = signal.reason;
    settle(entry, null);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const release = entry.release;
  entry.release = (result) => {
    signal.removeEventListener('abort', onAbort);
    release(result);
  };
}

/**
 * 挂起这条请求直到有人回答。
 *
 * 下游**先叫**：`next()` 一调，桌面窗口那张卡照旧出现（这条路径的行为一字不改）。手机答得
 * 早就用手机的；下游答得早就用下游的。手机上那张卡由结算帧收掉。
 */
function holdForPhone(entry, next) {
  const downstream = Promise.resolve().then(() => next()).then(
    (answer) => { settle(entry, null); return answer; },
    (error) => { settle(entry, null); throw error; },
  );
  const fromPhone = entry.wait.then((result) => {
    if (result.answers) return { answers: result.answers };
    // 手机这条路没给出答案（被取消）：按宿主的 abort 语义把原因抛回去，
    // 别假装成了一个空回答。
    const reason = entry.signalReason;
    throw reason instanceof Error ? reason : new Error('ask_user_question aborted');
  });
  return Promise.race([fromPhone, downstream]);
}

function onQuestionRequest(request, next) {
  const sessionId = sessionIdOfRequest(request);
  if (!sessionId) return next();
  const entry = entryFor(sessionId, request);
  bindRequest(entry, request);
  return holdForPhone(entry, next);
}

/** 装上提问桥（只在 0.2.x 那一侧装，理由与审批桥相同）。 */
function installQuestionBridge(ctx) {
  const dispose = ctx.on('user-questions/request', onQuestionRequest, { prepend: true, global: true });
  return () => {
    dispose();
    for (const entry of [...entries.values()]) settle(entry, null);
  };
}

/**
 * POST /api/mobile/v1/question/respond —— `{rpcId, sessionId, answer:{answers}}`。
 *
 * 先查本桥的挂起项；查不到就交回 `ctx.apiProxy.respond`（0.1.x 宿主那份真 apiProxy 才是
 * 它的归宿；0.2.x 的兼容桥会如实回 `host-unsupported`，于是落到下面那条 409）。
 */
async function handleQuestionRespond(ctx, req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body.rpcId !== 'string' || !body.rpcId || typeof body.sessionId !== 'string' || !body.sessionId) {
    return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '需要 { rpcId, sessionId, answer }' } });
  }
  const entry = entries.get(body.rpcId);
  if (entry && !entry.settled && entry.bound && entry.sessionId === body.sessionId) {
    const answers = normalizeAnswers(entry.questions, body.answer && body.answer.answers);
    if (!answers) {
      return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'answer.answers 必须每题恰好一条、含合法 selected' } });
    }
    settle(entry, answers);
    return sendJson(res, 200, { ok: true, accepted: true });
  }
  const receipt = await ctx.apiProxy.respond({
    type: 'client-response',
    rpcId: body.rpcId,
    result: { ok: true, value: { sessionId: body.sessionId, answer: { answers: (body.answer && body.answer.answers) || [] } } },
  }).catch(() => null);
  if (!receipt || receipt.accepted !== true) {
    return sendJson(res, 409, { ok: false, error: { code: 'not-pending', message: '该问题已完成或不可回答' } });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

module.exports = {
  installQuestionBridge,
  handleQuestionRespond,
  attachSession,
  pendingKind,
  resetForTest,
};

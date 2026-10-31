'use strict';

/**
 * 手机端提问桥（DSH 0.2.x）：`ask_user_question` 与「计划评审」。
 *
 * 0.2.x 删掉了 apiProxy，提问只剩一个进程内 waterfall 钩子 `user-questions/request`，帧级
 * rpcId 随之消失，手机既收不到卡片、也没有能回传的 id。这里按新形状补起来，App 契约不变：
 * prepend 钩子、自己铸 rpcId 推卡、`/question/respond` 找到挂起项把回答交回钩子。
 *
 * 钩子必须 prepend：宿主的转发器在桌面窗口开着时会一直等桌面回答、不调用 `next()`。下游
 * 总是拿到请求，桌面那张卡与手机那张同时存在，谁先答用谁的，落定后广播 `question/resolved`。
 *
 * 「计划评审」不走另一条通道：`exit_plan_mode` 就是拿 `ctx.userQuestions.ask()` 问的
 * （`intent.kind='plan-review'`，detail 是计划正文），这道桥同时修好它。
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
  // 留一个身份引用：手机答完之后要按它找回宿主转发给桌面窗口的那一发（见 cancelForwardedCards）。
  entry.requestRef = request;
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

/** 宿主「这一趟没有任何答案方」的失败码（`dsh-user-questions` 的 `noAnswerer`）。 */
function noAnswerer(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'NO_PROVIDER';
}

/**
 * 挂起这条请求直到有人回答：桌面的转发与手机的卡**同时进行**，谁先答就用谁的答案。
 *
 * 桌面先答：下游给出答案，结算挂起项（手机那张卡由结算帧收掉）。
 * 手机先答：把手机的回答交回钩子，桌面那张卡由 `cancelForwardedCards` 主动收掉 —— 宿主
 * 只在「限时提问」里给这条转发做了收尾，本桥跑的这版宿主是阻塞式提问，没人替桌面窗口
 * 撤回那一发，卡会一直悬着直到人手动点。那一发被撤时 `downstream` 会再落一次；上面的
 * race 已经挂着它的处理函数，迟到的那次不会冒成未处理异常，`settle` 本身也是幂等的。
 *
 * `NO_PROVIDER`（桌面没开 / 桌面把请求 delegate 回来）不是结论：手机正在看这个会话时
 * 卡还在手机上等着，继续等手机答；没人看时照旧把失败交回去，纯桌面表现一字不改。
 */
function holdForPhone(entry, next) {
  const downstream = Promise.resolve().then(() => next()).then(
    (answer) => { settle(entry, null); return answer; },
    (error) => {
      if (noAnswerer(error) && watcherCount(entry.sessionId) > 0) return new Promise(() => {});
      settle(entry, null);
      throw error;
    },
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

/**
 * 收掉桌面那张卡：把宿主已经发给桌面窗口、还挂着的那一发转发撤掉。
 *
 * 桌面那张卡不是本桥画的：宿主把提问转发给桌面窗口之后，窗口自己按那一发长出一张卡，
 * 只有三种情况会让它消失 —— 桌面自己答、这一轮被取消、宿主主动撤回那一发。「两边同时
 * 出卡」靠的就是转发，而宿主只在「限时提问」路径上做了落定后的撤回；这版宿主的
 * `ask_user_question` 跑的是阻塞式，手机先答之后没人去收，卡就一直悬着。
 *
 * 网关（`typertGateway`）按请求对象本身登记着这些挂起的转发。这里用同一个请求对象认回
 * 那一发、调它自己的撤回接口：窗口收到 `cancel` 帧后按 abort 处理，卡跟着撤，不会冒成
 * 错误提示。认不到就什么都不做 —— 老宿主没有这道网关，「桌面没卡可收」本来就是对的。
 */
function cancelForwardedCards(ctx, entry) {
  const gateway = ctx && typeof ctx.get === 'function' ? ctx.get('typertGateway') : undefined;
  const pending = gateway && gateway.pendingRemoteEvents;
  if (!pending || typeof pending.values !== 'function' || typeof gateway.cancelRemoteEvent !== 'function') return;
  for (const item of [...pending.values()]) {
    if (!item || !item.source || item.source.request !== entry.requestRef) continue;
    try {
      gateway.cancelRemoteEvent(item, new Error('手机已经回答了这条提问'));
    } catch { /* 那一发已经走了（别人先收掉）：没什么可撤的 */ }
  }
}

function onQuestionRequest(request, next) {
  const sessionId = sessionIdOfRequest(request);
  if (!sessionId) return next();
  const entry = entryFor(sessionId, request);
  bindRequest(entry, request);
  // 旁路转发：桌面和手机同时出卡。少转这一下，手机看着的时候桌面从源头就没有卡 ——
  // 而桌面那张卡只由「被转发的请求」长出来，之后切过去也补不回来。
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
 * 先查本桥的挂起项；查不到就交回 `ctx.apiProxy.respond`（0.1.x 真 apiProxy 的归宿；0.2.x
 * 兼容桥会回 `host-unsupported`，落到下面那条 409）。
 *
 * respond 在两条通道上的返回形态不一样：0.1.x 是 `Promise<{accepted}>`，0.2.x 兼容桥是同步
 * 对象。同步对象上没有 `.catch`，直接链 Promise 会抛 TypeError 被路由守卫兜成 500，而不是
 * 409，手机只看到「提交失败」的原始异常。
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
    cancelForwardedCards(ctx, entry);
    return sendJson(res, 200, { ok: true, accepted: true });
  }
  const receipt = await respondViaLegacyProxy(ctx, {
    type: 'client-response',
    rpcId: body.rpcId,
    result: { ok: true, value: { sessionId: body.sessionId, answer: { answers: (body.answer && body.answer.answers) || [] } } },
  });
  if (!receipt || receipt.accepted !== true) {
    // 本桥不认识这个 rpcId，旧通道也不认：这条提问在**我们这一侧**已经死了
    // （挂起项只活在进程内，插件重载 / 宿主重启就没了）。
    //
    // 这里**故意不推 question/resolved 收卡**：手机端要靠这张卡把「为什么没答成」
    // 显示出来（`UserQuestionDock` 的 error 行），卡一收掉就跟着卸载，那句话没地方落。
    // 留着卡也没有副作用：这条 rpcId 在本桥表里根本不存在，再点一次同样回 409、刷新
    // 同一句说明。真正该收卡的是「别人已经答掉了」，那条路在 settle 里。
    return sendJson(res, 409, {
      ok: false,
      error: {
        code: 'not-pending',
        message: '这条提问已经不在等待回答（插件重载或宿主重启后挂起的提问会失效），请回桌面端作答。',
      },
    });
  }
  sendJson(res, 200, { ok: true, accepted: true });
}

/**
 * 把回答交回旧通道的 `ctx.apiProxy.respond`，Promise 与同步对象两种返回都收。
 *
 * 0.1.x 是 Promise，0.2.x 兼容桥是同步的 `{result:{ok:false,...}}`；同步对象上没有 `.catch`，
 * 不能链 Promise。抛错与「通道说没有」一律折算成 null，调用方据此如实回 409。
 */
async function respondViaLegacyProxy(ctx, message) {
  const proxy = ctx && ctx.apiProxy;
  if (!proxy || typeof proxy.respond !== 'function') return null;
  try {
    const reply = proxy.respond(message);
    // 同步对象与 Promise 都要：先 await（对普通对象是恒等），拿到的仍可能是信封。
    const settled = await reply;
    return settled && typeof settled === 'object' ? settled : null;
  } catch {
    return null;
  }
}

module.exports = {
  installQuestionBridge,
  handleQuestionRespond,
  attachSession,
  pendingKind,
  resetForTest,
};

'use strict';

/**
 * 付款确认：把「这一下点下去要花钱」送去宿主已有的审批通道，等人点了「同意」再放行。
 *
 * ## 为什么复用审批通道，而不是自己推一张卡
 *
 * 手机上那张确认卡、用户点按钮、结论交回来，这条链在 0.2.x 上已经由审批桥
 * （`mobile/approvals.js`）铺好了：它 `prepend` 了宿主的 `approval/request` 钩子，钩子一响
 * 就把卡推给正在看这条会话的手机，用户点了同意再 `settle` 回钩子的 promise。我们自己再造
 * 一条推卡的路，等于让手机上同时存在两套确认卡、两套回答接口，谁先答都说不清。
 *
 * 所以这里只做一件事：以 `ctx.get('approval')` 的身份发起一次真正的审批请求。宿主的
 * `ApprovalService.request()` 会把这次的 `approval/asked` / `approval/decided` 记进会话日志
 * （审计里就是这么写的），再走一遍 `approval/request` waterfall —— 审批桥在那一步把卡交给
 * 手机。拿回 `allowed-once` 才等于「用户就这一下点了同意」。
 *
 * ## 为什么绝对不会挂死
 *
 * 三处都可能「永远没人答」：手机没在看（卡没有去处）、用户在别处把这一轮取消了、钩子上
 * 下游是个不回答的转发器。前两处各自有出路（下面判 unavailable / 跟着 signal 取消），
 * 第三处靠一道自己的硬期限兜底：到点就回 `unavailable`，且先 `abort()` 让宿主那头把
 * 挂起的审批一起收掉。工具调用挂在这里，模型的整轮就会一直转下去 —— 那比「没确认」
 * 严重得多，所以宁可超时也不要等。
 *
 * ## 三个返回值
 *
 * `allowed-once`（就这一次可以） / `rejected`（问过了，答案是拒绝或取消） /
 * `unavailable`（压根没能问到人）。调用点只认 `allowed-once`，别的一律不执行。
 */

/**
 * 一次确认最多等多久。
 *
 * 够用户拿起手机看一眼再点同意，又不至于让模型的这一发停在那里。之所以不设「等到有人答
 * 为止」：卡没推到人手上（手机没在看这条会话、用户把 App 切走了）时，等的是一个永远不来
 * 的答案；而一次工具调用挂着一分钟以上，在模型那边就是「卡住了」。
 */
const APPROVAL_TIMEOUT_MS = 90_000;

/**
 * 这一步要不要人确认。判定仍由 `irreversible.js` 给，这里只挑「收钱」与「毁数据」两类：
 * payment（付款 / 下单 / 购买 / 结算）和 delete（删除 / 清空 / 移除）强制走一次人工确认。
 * 发送、提交是这条任务本来就该做的事，每一步都拦会让「让它发条消息」变成一连串确认框，
 * 所以维持「不逐条拦」的既有取舍 —— 这是刻意的，别把 send / submit 也扩进来。
 */
function needsConfirmation(judged) {
  return Boolean(judged && judged.irreversible === true && (judged.kind === 'payment' || judged.kind === 'delete'));
}

/**
 * 宿主的审批服务。`ctx.get()` 而不是写进 inject：这个服务的装配顺序跟手机那几条路由无关，
 * 注入一个当前宿主版本里没有的服务会把整个插件装载拖垮（与 `mobile/host-web.js` 同一口径）。
 */
function approvalOf(ctx) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('approval');
      if (service && typeof service.request === 'function') return service;
    }
  } catch { /* 服务没装就往下试属性那一种写法 */ }
  const direct = ctx.approval;
  return direct && typeof direct.request === 'function' ? direct : null;
}

/**
 * 这条会话的 agent。审批请求要求请求方带着自己的会话（`ApprovalService.request()` 要往
 * 那条会话里记审计事件，还要看它的 `approval/policy`），拿不到就等于没人能答。
 *
 * 工具层手上一般已经握着这次调用的 agent，优先用它 —— 比按 id 去服务里捞更准，
 * 子代理那条路径上 `agents.get(childSessionId)` 本来就取不到。
 */
function agentOf(ctx, sessionId, hint) {
  if (hint && hint.session) return hint;
  if (!ctx || typeof ctx.get !== 'function' || !sessionId) return null;
  try {
    const agents = ctx.get('agents');
    if (agents && typeof agents.get === 'function') return agents.get(sessionId) || null;
  } catch { /* 没这个服务就没有别的路可走 */ }
  return null;
}

/** 卡片上那句话：做了什么都写进去，用户看着手机就能判断这一下该不该点。 */
function summaryText(summary, amountText) {
  const parts = [];
  const head = typeof summary === 'string' ? summary.trim().slice(0, 200) : '';
  const amount = typeof amountText === 'string' ? amountText.trim().slice(0, 60) : '';
  if (head) parts.push(head);
  if (amount) parts.push(`金额 ${amount}`);
  return parts.join('；') || '操作手机：这一步涉及付款 / 下单，需要你确认';
}

/** 宿主那套结论词表收成一个三选一。取消与拒绝对调用点是一回事：都别执行。 */
function normalizeOutcome(outcome) {
  if (outcome === 'allowed-once') return 'allowed-once';
  if (outcome === 'rejected' || outcome === 'cancelled') return 'rejected';
  return 'unavailable';
}

/**
 * 发起一次确认并等结论。
 *
 * @param {object} ctx 插件上下文（要能 `get('approval')`）
 * @param {object} options
 * @param {string} options.sessionId 这条对话
 * @param {string} [options.summary] 卡片摘要：这一步在做什么
 * @param {string} [options.amountText] 金额一类的字样，有就一起上卡
 * @param {object} [options.agent] 工具层手上这次调用的 agent（有就用，没有按会话捞）
 * @param {string} [options.toolName] 卡片上那个「工具 X」的名字
 * @param {string} [options.callId] 与这一步的工具调用对上，便于手机与桌面对同一张卡
 * @param {AbortSignal} [options.signal] 这一轮工具的取消信号（用户取消整轮时跟着结束）
 * @param {boolean} [options.watching] 有没有手机在看着这条会话；明确为 false 就不必问了
 * @param {number} [options.timeoutMs] 覆盖默认期限：调用方自己的预算比三分钟还短时用它，
 *   确认不该比整条调用活得久
 * @returns {Promise<'allowed-once'|'rejected'|'unavailable'>}
 */
async function requestConfirmation(ctx, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
  // 认不出是哪条对话：卡片没有归属，宿主也会因为「没有开着的轮次」拒绝记账。
  if (!sessionId) return 'unavailable';
  // 没有手机在看：卡推不出去，问也白问。如实说「没问到」，别把这一步挂在那儿。
  if (opts.watching === false) return 'unavailable';

  const approval = approvalOf(ctx);
  if (!approval) return 'unavailable';
  const agent = agentOf(ctx, sessionId, opts.agent);
  if (!agent || !agent.session) return 'unavailable';

  const reason = summaryText(opts.summary, opts.amountText);
  const controller = new AbortController();
  const parent = opts.signal;
  const onAbort = () => controller.abort();
  if (parent && typeof parent.addEventListener === 'function') {
    // 工具已经被取消了就别再发一张卡出来：那一轮已经没有人在等这个答案。
    if (parent.aborted) return 'unavailable';
    parent.addEventListener('abort', onAbort, { once: true });
  }

  const waitMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.min(APPROVAL_TIMEOUT_MS, Math.round(opts.timeoutMs))
    : APPROVAL_TIMEOUT_MS;
  let timer = null;
  // 硬期限与请求本身赛跑：即便宿主那头不理会 abort，这里也一定在期限内交出结论。
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('unavailable');
    }, waitMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    const asked = Promise.resolve()
      .then(() => approval.request({
        agent,
        ...(typeof opts.toolName === 'string' && opts.toolName ? { toolName: opts.toolName } : {}),
        ...(typeof opts.callId === 'string' && opts.callId ? { callId: opts.callId } : {}),
        reason,
        // 桌面与手机上的卡片都优先用这句（审批桥的 `displayReasonOf` 认 zh）。
        displayReason: { zh: reason },
        signal: controller.signal,
      }))
      // 宿主在「没有开着的轮次」「策略是 never」这些情况下会抛，一律折算成没问到。
      .then((outcome) => normalizeOutcome(outcome), () => 'unavailable');
    return await Promise.race([asked, deadline]);
  } catch {
    return 'unavailable';
  } finally {
    if (timer) clearTimeout(timer);
    if (parent && typeof parent.removeEventListener === 'function') parent.removeEventListener('abort', onAbort);
  }
}

/** 确认没拿到时给模型的那句话。两种没拿到的原因要分开说，模型据此决定要不要请用户回来。 */
function blockedMessage(outcome, what) {
  const step = typeof what === 'string' && what ? what : '这一步';
  if (outcome === 'rejected') {
    return `${step}是需要确认的不可逆动作（付款 / 下单 / 删除），需要用户确认；用户没有同意（或者这一轮被取消了），所以没有执行。把这件事如实告诉用户，别自己重试。`;
  }
  return `${step}是需要确认的不可逆动作（付款 / 下单 / 删除），需要用户确认，但刚才没能把确认卡送到用户手上（手机没有在看这条对话，或者确认通道不可用），所以没有执行。请用户回到这条对话、在手机上看着屏幕再试一次；也可以让用户自己点这一下。`;
}

module.exports = {
  needsConfirmation,
  requestConfirmation,
  blockedMessage,
  APPROVAL_TIMEOUT_MS,
};

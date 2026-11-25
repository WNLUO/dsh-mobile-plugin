'use strict';

/**
 * iOS 推送的宿主侧出口：完成 / 失败 / 待处理（审批、提问）发生时，直接请求总控，
 * 由总控调 APNs 送到苹果。总控没配密钥时那头静默忽略，这里照发不误——
 * 「推没推成」不是宿主的账，宿主只负责「该推的时候说一声」。
 *
 * 走总控而不是中转：中转是「一人一台」（还有大量自建），苹果密钥只能配在总控那一台上。
 * 请求带本机那枚总控设备令牌（与上报地址同一枚），所以不用再开别的鉴权面。总控连不上时
 * 这次提醒就放弃——App 端自己的本地通知通道会在它回到前台 / 后台刷新时补上，推送只是增强。
 *
 * ## 声音与分类
 *
 * 推送一律带声音：按事件分级、单会话静音这些开关 App 侧已经整体下线，声音与静音交给系统的
 * 通知设置。通知栏能挂哪些按钮由 `category` 决定（审批 / 提问 / 待处理三类）。
 *
 * ## 去重与可作答
 *
 * 去重账按 `${sessionId}:${rpcId}`（卡）与 `${sessionId}:${turn}:${status}`（轮次）分槽，
 * **只在真的送出去之后**才记：先记账后发的话，网络抖一下这一次就永久丢了（账上有它，下一次
 * 同样的收尾被当成重复吃掉）。发不出去留一行 `console.warn`。
 *
 * 通知栏能不能就地作答只由 `isAnswerable` 判（与 iOS 原生建按钮的条件逐条对齐），判为真的
 * 提问才发 `dsh.question`，其余一律 `dsh.pending`——给了 `dsh.question` 而实际答不动，用户
 * 点按钮就是 400。
 */

const FRAME_TTL_MS = 10_000;
/** 一条推送请求的期限：总控回得慢也不该让宿主这一头一直挂着。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 卡帧（审批 / 提问）的去重窗口。同一张卡会经 noteAsk（占位 id）→ `approval/asked`（真 id）
 *  各 pushCard 一次，两次共用同一个 rpcId —— 按（会话, rpcId）只放一帧，**但「占位 → 真 id」
 *  那一帧例外**（见 `notifyInteraction`）：那是内容升级，丢了通知上的 approvalId 就是过期的。
 *  30s 覆盖用户来回切会话、卡又重发的时机。 */
const INTERACTION_TTL_MS = 30_000;

/**
 * @param {object} deps
 * @param {() => {baseUrl: string, token: string, instanceId: string}|null} deps.controlTarget
 *   总控的入口与那枚设备令牌；没登记过（没有令牌 / 关了上报）就返回 null，这次不发。
 */
function createPushNotifier(deps) {
  const controlTarget = typeof deps.controlTarget === 'function' ? deps.controlTarget : () => null;

  /** 已经发出去的帧：key → { at, approvalId? }。key 是 `${sessionId}:${rpcId}`（卡）或
   *  `${sessionId}:${turn}:${status}`（轮次）。同一次收尾会被事件流与列表折叠两条路各观察到
   *  一次，中转那边没有去重账，宿主必须自己只放一帧过去。
   *
   *  用 Map 而不是一个槽：好几条会话的卡同时挂着时，单槽会被后一张顶掉，前一张再来一帧就当成
   *  新的、重发一遍。 */
  const sent = new Map();
  /** 正在发送中的 key → `{ promise, approvalId }`：同一张卡并发到达时只放一帧出去（那时账还没记上）。 */
  const inFlight = new Map();

  /**
   * 这个 approvalId 是不是桥自己铸的占位。
   *
   * `approvals.js` 在钩子先到、`approval/asked` 还没到时会铸一个 `m-<uuid>` 顶上（真 id 只有宿主
   * 那一侧知道），等 `approval/asked` 到了再换成真的、并把同一张卡重推一次。占位长这样，
   * 真 id 不长这样（宿主给的是它自己的 id）。所以去重账必须能认出这一步「内容升级」。
   */
  function isPlaceholderApprovalId(value) {
    return typeof value === 'string' && value.startsWith('m-');
  }

  /** 这个 key 在 `ttl` 之内已经发出去过。 */
  function recentlySent(key, ttl) {
    const record = sent.get(key);
    return !!record && Date.now() - record.at < ttl;
  }

  /** 账只留最近这一小段：卡帧的 TTL 是最长的那个，更老的记录不会再有判据价值。 */
  function pruneSent() {
    const now = Date.now();
    for (const [key, record] of sent) {
      if (now - record.at >= Math.max(FRAME_TTL_MS, INTERACTION_TTL_MS)) sent.delete(key);
    }
  }

  /**
   * 真发一帧，**成功之后**才记账。
   *
   * 先记账后发是这里最容易犯的错：隧道抖一下（`pushSync` 拒绝 / 还没有 sidecar）那一帧就永久
   * 丢了 —— 账上已经有它，下一次同样的收尾被当成重复吃掉，而中转从来没收到过。所以账只记真正
   * 送出去的那一帧；发不出去的留一行日志，别静默（这类丢失最难查）。
   */
  function sendFrame(key, payload, meta) {
    return post(payload).then((ok) => {
      if (!ok) {
        console.warn('[dsh-mobile-plugin] push dropped', {
          kind: meta && meta.kind,
          sessionId: meta && meta.sessionId,
          reason: 'send-failed',
        });
        return false;
      }
      sent.set(key, { at: Date.now(), approvalId: (meta && meta.approvalId) || '' });
      pruneSent();
      return true;
    });
  }

  /**
   * 放一帧出去，并把这一发记在飞行表上：同一张卡在发送期间再来的调用直接拿到这一发（不重发）。
   * 去重账在调用侧判（`recentlySent`），因为「占位 → 真 id」那一次升级要绕过它。
   *
   * `chain` 为真表示这一发必须排在同一张卡的在途那发**之后**：那是内容升级（占位 id → 真 id），
   * 顺序反了通知栏上留的就是过期的占位 id，用户点下去回 409。
   */
  function pushFrame(key, payload, meta, chain) {
    const pending = inFlight.get(key);
    if (pending) {
      if (!chain) return pending.promise;
      const chained = pending.promise.then(() => sendFrame(key, payload, meta));
      const entry = { promise: chained };
      inFlight.set(key, entry);
      void chained.then(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
      return chained;
    }
    const run = sendFrame(key, payload, meta);
    const entry = { promise: run };
    inFlight.set(key, entry);
    void run.then(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
    return run;
  }

  /**
   * 报告一轮收尾。`fact` 是 session-last-turn 的 `lastTurnOf` 形状
   * （{ turn, endedAt, status, ... }），只有 completed / failed 两种值得推。
   */
  function notifyTurnEnded(sessionId, fact, title) {
    if (!sessionId || !fact || typeof fact.turn !== 'number') return;
    if (fact.status !== 'completed' && fact.status !== 'failed') return;
    const fingerprint = `${sessionId}:${fact.turn}:${fact.status}`;
    if (recentlySent(fingerprint, FRAME_TTL_MS)) return;
    // 文案只用跨语言的事实，不写死某一门语言：这条推送由系统直接显示，App 没机会再本地化
    // （没有通知服务扩展），而这个列表在电脑上、读它的手机可能被设成十门语言里的任一门。
    // 所以标题是会话名（用户自己起的），正文只给「成没成」一个符号。
    const body = fact.status === 'failed' ? '✗' : '✓';
    // 推给这台实例登记过的全部手机：按设备记账在 App 自己手里（本机已读水位），
    // 总控只存「实例 + 设备 → 令牌」一级。
    void pushFrame(fingerprint, {
      title: title || String(sessionId).slice(0, 8),
      body,
      sessionId,
    }, { kind: fact.status === 'failed' ? 'failed' : 'completed', sessionId });
  }

  /**
   * 通知栏里这张卡点得动吗 —— **只有这种情况发 `dsh.question`**。
   *
   * 原生那边（iOS `registerQuestionCategory`）只给「单题、单选、1..3 个无描述选项」挂得出
   * 按钮，多题 / 多选 / 带描述 / 带 detail 一律退回「打开」。而这个判定必须在**发帧的这一侧**
   * 就做完：`aps.category` 是随帧发出去的，原生后台拿到一条 `dsh.question` 会按它挂上按钮，
   * 用户点下去宿主只认单题单选的回答 —— 结果是 400。判据与原生逐条对齐。
   */
  function isAnswerable(questions, kind) {
    if (kind !== 'question') return false;
    if (questions.length !== 1) return false;
    const question = questions[0];
    if (!question || question.multiSelect) return false;
    if (question.detail) return false;
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 1 || options.length > 3) return false;
    return options.every((option) => option
      && typeof option.label === 'string' && option.label
      && !option.description);
  }

  /**
   * 报告一张「等你处理」的卡（审批 / 提问 / 计划评审）。
   *
   * 入参 `card` 就是桥里 `cardFrame(entry)` 的产物：审批卡 type 'approval/requested'
   * （rpcId / approvalId / toolName? / reason? / fact? / factHighlight?），
   * 提问卡 type 'question/requested'
   * （rpcId / questions[{id,question,header?,detail?,options?,multiSelect?,intent?}]）。
   * 组出的 `interaction` 是给两端原生挂按钮、把用户答复回传要用的固定结构；`category`
   * 是 iOS 通知类别的名字（App 侧注册同名字符串才会长出按钮）。
   *
   * `hints` 是桥那侧多给的几样东西：`{ fact, factHighlight, title }`。
   * 前两样是审批卡上的展示信息（事实行 / 那一行高亮），通知栏里得原样带上，否则手机在后台
   * 看到的还是没长事实行的那张卡。`title` 是会话名。
   */
  function notifyInteraction(sessionId, card, hints = {}) {
    if (!sessionId || !card || typeof card !== 'object') return;
    // 第三参早先就是「标题」一个字符串；现在扩成带提示的对象，字符串按标题认。
    const hint = typeof hints === 'string'
      ? { title: hints }
      : (hints && typeof hints === 'object' ? hints : {});
    const rpcId = typeof card.rpcId === 'string' ? card.rpcId : '';
    if (!rpcId) return;
    const questions = Array.isArray(card.questions) ? card.questions : [];
    const isApproval = card.type === 'approval/requested';
    const planReview = questions.some(
      (q) => q && q.intent && typeof q.intent === 'object' && q.intent.kind === 'plan-review',
    );
    const kind = isApproval ? 'approval' : (planReview ? 'plan-review' : 'question');

    const fingerprint = `${sessionId}:${rpcId}`;
    const approvalId = kind === 'approval' && typeof card.approvalId === 'string' ? card.approvalId : '';
    // 同一张卡的第二帧有两种：内容没变的重复（丢掉），和「占位 approvalId 换成真 id」的内容
    // 升级（必须放过去）。后者不能丢：通知上挂的是占位 id 时，用户点「允许」会 409，原生把它
    // 当成「已经答过了」直接撤掉通知，而宿主那张卡还挂着 —— 白点一下。只认这一个方向：
    // 占位 → 真 id 重推；真 id → 别的 id、真 id → 占位都不重推（那是异常，重复推只会打扰）。
    const previous = sent.get(fingerprint);
    const previousId = (previous && previous.approvalId) || '';
    const upgrade = isPlaceholderApprovalId(previousId)
      && approvalId !== ''
      && !isPlaceholderApprovalId(approvalId)
      && approvalId !== previousId;
    if (!upgrade && recentlySent(fingerprint, INTERACTION_TTL_MS)) return;

    // 一句人话摘要：审批优先用宿主给的 reason（已被桥换成 displayReason 的 zh），
    // 没有就落到与桌面同一句「工具 X 请求越权执行」；提问直接用第一题。
    const summary = kind === 'approval'
      ? (typeof card.reason === 'string' && card.reason
        ? card.reason
        : `工具 ${(typeof card.toolName === 'string' && card.toolName) || '未知工具'} 请求越权执行`)
      : ((questions[0] && typeof questions[0].question === 'string' && questions[0].question) || '有一个问题等你回答');

    const answerable = isAnswerable(questions, kind);
    // 事实行优先用桥给的提示；没给就退回卡帧自带的那一份（`cardFrame` 里也有同样几个字段）。
    const fact = kind === 'approval'
      ? (typeof hint.fact === 'string' && hint.fact ? hint.fact : (typeof card.fact === 'string' ? card.fact : ''))
      : '';
    const factHighlight = !!(hint.factHighlight || card.factHighlight);
    const interaction = {
      kind,
      rpcId,
      sessionId,
      ...(kind === 'approval' && typeof card.approvalId === 'string' && card.approvalId
        ? { approvalId: card.approvalId }
        : {}),
      summary,
      // 事实行：审批卡原来只写给 App 面板，通知栏那张卡拿不到，用户点开前不知道这条要动什么。
      // 跟 `cardFrame` 同一份值（桥已经算好，这里不重算）。
      ...(fact ? { fact } : {}),
      ...(fact && factHighlight ? { factHighlight: true } : {}),
      // 通知栏能不能就地作答：只有原生挂得出按钮的那一种形状才为真（见 `isAnswerable`）。
      answerable,
      ...(kind !== 'approval'
        ? {
          questions: questions.map((q) => ({
            id: q.id,
            question: q.question,
            multiSelect: !!q.multiSelect,
            options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
              label: o && o.label,
              ...(o && o.description ? { description: o.description } : {}),
            })),
            ...(q && q.intent ? { intent: q.intent } : {}),
          })),
        }
        : {}),
    };

    // category 只按「通知栏点不点得动」给：给了 dsh.question 而实际答不动，用户点按钮就是 400。
    const category = kind === 'approval'
      ? 'dsh.approval'
      : (answerable ? 'dsh.question' : 'dsh.pending');
    return pushFrame(fingerprint, {
      title: hint.title || String(sessionId).slice(0, 8),
      body: summary,
      sessionId,
      category,
      interaction,
    }, { kind, sessionId, approvalId }, upgrade);
  }

  /** 把一条通知交给总控。发不出去返回 false，调用方据此不记去重账。 */
  function post(payload) {
    const target = controlTarget();
    if (!target || !target.baseUrl || !target.token || !target.instanceId) return Promise.resolve(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    return fetch(`${target.baseUrl}/push/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-instance': target.instanceId,
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(
      (response) => response.ok,
      () => false,
    ).finally(() => clearTimeout(timer));
  }

  return { notifyTurnEnded, notifyInteraction };
}

module.exports = { createPushNotifier };

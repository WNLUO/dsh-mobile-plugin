'use strict';

/**
 * iOS 推送的宿主侧出口：完成 / 失败 / 待处理（审批、提问）发生时，经隧道发一帧给中转，
 * 由中转调 APNs 送到苹果。中转没配密钥时那头静默忽略，这里照发不误——
 * 「推没推成」不是宿主的账，宿主只负责「该推的时候说一声」。
 *
 * 走隧道而不是直接 HTTP 打中转：隧道连接已带准入校验（x-dsh-license），复用它
 * 就不用在中转上再开一条要鉴权的 HTTP 面。隧道不在时这次提醒就放弃——App 端
 * 自己的本地通知通道会在它回到前台 / 后台刷新时补上，推送只是增强。
 *
 * ## 发之前先过「按事件类型分级表」
 *
 * App 被杀时本地通知通道不在了，这条推送就是唯一送达路径；不看用户的偏好分级，用户把某类
 * 设成「关闭」也照收，那张表就白设了。所以发 `PUSH_SEND` 之前先按事件 kind 映射成表里的键
 * 查一遍（见 `eventTypeOf`）：`completed` → `done`、`failed` → `failed`；待处理按卡的种类拆成
 * `approval` / `question` / `planReview`，映射不上的按 `approval`——宁可多问一次也别漏掉一张
 * 要用户点头的卡。级别 `off` 的就不发。
 *
 * 这一帧的 `deviceId` 留空（推给该实例全部已登记设备），本仓库又没有「令牌 ↔ 偏好桶」的映射表，
 * 所以口径是：**对文件里登记过的每台设备各查它那一份，全部为 off 才不发；还剩一台是
 * ring / silent 就照发**，没有登记过任何桶时按默认档判。偏严的方向是「宁可按默认发」——
 * 漏一条审批提醒让用户卡在那里，比多发一条打扰重得多。
 *
 * ## 已知限制（做不到，不是没做）
 *
 * 只有 `off` 这一档能在推送里兑现。`silent` 要求「上通知栏但不响」，而声音字段是苹果推送负载
 * 的一部分、由中转仓库的 `apns.rs` 决定，本仓库发出去的帧里改不了它；所以 `silent` 在推送
 * 这条路上仍然可能发声，它在 App 进程活着时的本地通知通道里才有效。
 *
 * ## 去重与可作答
 *
 * 去重账按 `${sessionId}:${rpcId}`（卡）与 `${sessionId}:${turn}:${status}`（轮次）分槽，
 * **只在真的送出去之后**才记：先记账后发的话，隧道抖一下那一帧就永久丢了（账上有它，下一次
 * 同样的收尾被当成重复吃掉）。发不出去留一行 `console.warn`。
 *
 * 通知栏能不能就地作答只由 `isAnswerable` 判（与 iOS 原生建按钮的条件逐条对齐），判为真的
 * 提问才发 `dsh.question`，其余一律 `dsh.pending`——给了 `dsh.question` 而实际答不动，用户
 * 点按钮就是 400。
 */

const notificationPrefs = require('./notification-prefs.js');

const FRAME_TTL_MS = 10_000;

/** 卡帧（审批 / 提问）的去重窗口。同一张卡会经 noteAsk（占位 id）→ `approval/asked`（真 id）
 *  各 pushCard 一次，两次共用同一个 rpcId —— 按（会话, rpcId）只放一帧，**但「占位 → 真 id」
 *  那一帧例外**（见 `notifyInteraction`）：那是内容升级，丢了通知上的 approvalId 就是过期的。
 *  30s 覆盖用户来回切会话、卡又重发的时机。 */
const INTERACTION_TTL_MS = 30_000;

/**
 * @param {object} deps
 * @param {() => object|null} deps.getSidecar 取 sidecar facade 的取值器（它有 pushSync 通道）。
 * @param {() => boolean} deps.tunnelConnected 隧道在不在。
 * @param {() => string} [deps.instanceId] 实例标识，帧里带上便于中转日志定位。
 */
function createPushNotifier(deps) {
  const getSidecar = typeof deps.getSidecar === 'function' ? deps.getSidecar : () => null;
  const tunnelConnected = typeof deps.tunnelConnected === 'function' ? deps.tunnelConnected : () => false;
  const instanceId = typeof deps.instanceId === 'function' ? deps.instanceId : () => '';

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
    return send('push', payload).then((ok) => {
      if (!ok) {
        console.warn('[dsh-mobile-plugin] push frame dropped', {
          kind: meta && meta.kind,
          sessionId: meta && meta.sessionId,
          reason: tunnelConnected() ? 'send-failed' : 'tunnel-down',
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

  /** 事件 kind → 分级表里的类型键（表里只有这五类）。 */
  function eventTypeOf(kind) {
    if (kind === 'completed') return 'done';
    if (kind === 'failed') return 'failed';
    if (kind === 'question') return 'question';
    if (kind === 'plan-review') return 'planReview';
    // 审批卡，以及任何映射不上来的待处理（缺 `pendingInteraction` 等）：按审批算。
    // 要用户点头的卡漏掉一条就会把对话卡死，打扰一条只是响一下。
    return 'approval';
  }

  /**
   * 这一个类型是不是「要推的每一台设备都关了」。
   *
   * 帧里 `deviceId` 为空 = 推给该实例全部已登记设备，而本仓库没有「APNs 令牌 ↔ 偏好桶」的
   * 映射（令牌登记在中转，桶键是凭据 deviceId），所以只能按「文件里登记过的每一个桶」判定：
   * 全部 off 才不发，还剩一台 ring / silent 就照发（见文件头口径）。没有任何桶时按默认档判。
   * 读文件失败也按默认档判——读不出来不该让通知静默消失。
   */
  function mutedEverywhere(type) {
    const fallback = notificationPrefs.DEFAULT_EVENT_LEVELS[type] === 'off';
    let store = null;
    try {
      store = notificationPrefs.loadStore();
    } catch {
      store = null;
    }
    const devices = store && store.ok ? store.devices : null;
    if (!devices) return fallback;
    const ids = Object.keys(devices).filter((id) => devices[id] && typeof devices[id] === 'object');
    if (ids.length === 0) return fallback;
    return ids.every((id) => notificationPrefs.normalizeEvents(devices[id].events)[type] === 'off');
  }

  /**
   * 报告一轮收尾。`fact` 是 session-last-turn 的 `lastTurnOf` 形状
   * （{ turn, endedAt, status, ... }），只有 completed / failed 两种值得推。
   */
  function notifyTurnEnded(sessionId, fact, title) {
    if (!sessionId || !fact || typeof fact.turn !== 'number') return;
    if (fact.status !== 'completed' && fact.status !== 'failed') return;
    // 分级表在这一步判：关着就不发，也**不记去重账**——用户中途改回响铃时，下一次观察同一次
    // 收尾还能发出去。
    if (mutedEverywhere(eventTypeOf(fact.status))) return;
    const fingerprint = `${sessionId}:${fact.turn}:${fact.status}`;
    if (recentlySent(fingerprint, FRAME_TTL_MS)) return;
    // 文案只用跨语言的事实，不写死某一门语言：这条推送由系统直接显示，App 没机会再本地化
    // （没有通知服务扩展），而这个列表在电脑上、读它的手机可能被设成十门语言里的任一门。
    // 所以标题是会话名（用户自己起的），正文只给「成没成」一个符号。
    const body = fact.status === 'failed' ? '✗' : '✓';
    // 注意 `kind` 只能是 'push'（worker 靠它分流到 PUSH_SEND）；事件种类放 pushKind，
    // 否则两次同名键后者覆盖前者，帧就被当成 sync 发进黑洞。
    void pushFrame(fingerprint, {
      kind: 'push',
      pushFrame: 'send',
      deviceId: '',
      // deviceId 留空 = 这台实例上全部已登记设备都推。completion 的按设备记账
      // 在 App 自己手里（本机已读水位），中转只存「实例 → 令牌」一级。
      title: title || String(sessionId).slice(0, 8),
      body,
      sessionId,
      pushKind: fact.status === 'failed' ? 'failed' : 'completed',
      instanceId: instanceId(),
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
   * （rpcId / approvalId / toolName? / reason? / fact? / factHighlight? / rememberable?），
   * 提问卡 type 'question/requested'
   * （rpcId / questions[{id,question,header?,detail?,options?,multiSelect?,intent?}]）。
   * 组出的 `interaction` 是给两端原生挂按钮、把用户答复回传要用的固定结构；`category`
   * 是 iOS 通知类别的名字（App 侧注册同名字符串才会长出按钮）。
   *
   * `hints` 是桥那侧多给的几样东西：`{ fact, factHighlight, rememberable, title }`。
   * 前三样是审批卡上新长出来的展示信息（事实行 / 那一行高亮 / 能不能「以后都同意」），
   * 通知栏里得原样带上，否则手机在后台看到的还是三档之前那张卡。`title` 是会话名。
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
    // 同上：这一级关着就直接不发，去重账也不动。
    if (mutedEverywhere(eventTypeOf(kind))) return;

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
    const rememberable = kind === 'approval' && !!(hint.rememberable || card.rememberable);
    const interaction = {
      kind,
      rpcId,
      sessionId,
      ...(kind === 'approval' && typeof card.approvalId === 'string' && card.approvalId
        ? { approvalId: card.approvalId }
        : {}),
      summary,
      // 事实行与「以后都同意」：审批卡原来只写给 App 面板，通知栏那张卡拿不到，用户点开前
      // 不知道这条要动什么。跟 `cardFrame` 同一份值（桥已经算好，这里不重算）。
      ...(fact ? { fact } : {}),
      ...(fact && factHighlight ? { factHighlight: true } : {}),
      ...(rememberable ? { rememberable: true } : {}),
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
      kind: 'push',
      pushFrame: 'send',
      deviceId: '',
      title: hint.title || String(sessionId).slice(0, 8),
      body: summary,
      sessionId,
      pushKind: kind,
      category,
      interaction,
      instanceId: instanceId(),
    }, { kind, sessionId, approvalId }, upgrade);
  }

  /** App 侧上报的推送令牌转交给中转（登记 / 删除）。 */
  function registerToken(deviceId, token, platform) {
    return send('push', {
      kind: 'push',
      pushFrame: 'register',
      deviceId,
      ...(token ? { token, platform: platform || 'ios' } : { action: 'delete' }),
      instanceId: instanceId(),
    });
  }

  function send(kind, payload) {
    if (!tunnelConnected()) return Promise.resolve(false);
    const sidecar = getSidecar();
    if (!sidecar) return Promise.resolve(false);
    return sidecar.pushSync(payload).then(
      () => true,
      () => false,
    );
  }

  return { notifyTurnEnded, notifyInteraction, registerToken };
}

module.exports = { createPushNotifier };

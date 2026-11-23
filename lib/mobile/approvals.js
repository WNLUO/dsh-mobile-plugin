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
 * 老实排在注册顺序后面等于「桌面开着时手机永远收不到」。手机在看时独占审批，最后一条
 * 会话连接离开后将未裁决的请求交给桌面；桌面不可用时仍保留手机作答入口。
 *
 * 钩子上没有宿主 id，且与 `approval/asked` 的到达顺序不定，所以两个来源共用一张挂起项表：
 * 先到的建项，后到的补字段。
 *
 * 另外两样东西（都不扩能力面、都只是展示）：
 * - **事实行**：宿主 `approval/request` 钩子不带工具参数，所以按 callId 回会话日志取原始参数，
 *   由 `approval-facts.js` 折成一句话随卡下发（删/推/装高亮）；算不出就不出这一行。动作类别只
 *   用来判断「同一轮里重复请求」，不做跨轮记忆。
 * - **拒绝理由**：手机上写的理由随结算帧下发一份，卡收起前那一瞬间的提示要能说出「为什么」。
 * 另有「同一轮里相同请求再次出现直接 auto-reject」（`turnState` 记本轮签名）。
 *
 * 审批的 approvalId 一经下发不再变：钩子先到时的占位 id 保持不变，宿主真 id
 * 另存 `realApprovalId`，只用于认领 `approval/decided` —— App 的审批队列按 approvalId 去重。
 */

const { randomUUID } = require('node:crypto');
const { sendJson, readJsonBody } = require('../shared/http-util');
const { cancelForwardedRequests } = require('./host-bridge/transport.js');
const { sessionIdOf } = require('./session-id.js');
const facts = require('./approval-facts.js');
const { anyApprover } = require('./permissions.js');
const { credentialsEntry } = require('../shared/credentials-entry.js');

/**
 * 这台电脑上还有没有能答审批的设备。只读档设备收到的卡点了必然 403，所以一台能答的都没有时
 * 桥不建卡也不推送。凭据包读不到时按「有」处理（任何异常都回 true，见 permissions.anyApprover）。
 */
function canShowCards() {
  try {
    return anyApprover(credentialsEntry());
  } catch {
    return true;
  }
}

/**
 * `/approval/respond` 认两种结论（与 App 的按钮一一对应）：
 * - `allowed-once` 允许一次；
 * - `rejected` 拒绝（可带一句 reason）。
 */
const ANSWER_OUTCOMES = new Set(['allowed-once', 'rejected']);
/** 宿主 `approval/decided` 的结论词表（`dsh-user-approval` 的 OUTCOMES）。 */
const DECISIONS = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
/** 拒绝理由长度上限（只落本机，宿主不接收 reason）。 */
const REASON_MAX = 200;
/** 事实行回扫会话日志的窗口（事件条数）：tool-call 块与审批之间可能隔着别的工具输出。 */
const ARGS_SCAN_WINDOW = 400;
/** 本轮「已经出现过的请求签名」条数上限：一轮里再长也长不到这么多，纯兜底。 */
const SEEN_MAX = 200;
/** 有 command/cmd 参数、原文值得随卡下发的工具（与 `approval-facts.js` 的 bash 解析同一批）。 */
const COMMAND_TOOLS = new Set(['bash', 'terminal', 'terminal_send', 'pwsh', 'powershell']);

/** sessionId → Set<sink>：正在看这个会话的手机连接（每条 SSE 一个 sink）。 */
const watchers = new Map();
/** rpcId → entry：回答时按它定位。 */
const entries = new Map();
/** sessionId → entry[]（保序）：把钩子上的请求和事件里的审批对上。 */
const bySession = new Map();
/**
 * sessionId → `{ turnKey, seen:Set<sig> }`：本轮的标识与本轮已经出现过的请求签名。
 * 「同一轮里相同请求再次出现直接拒」靠它；`turn/start` 建、`turn/end` 清。审批的钩子与事件
 * 都不带轮次，所以轮次要本桥自己从 `session/event` 的 turn 事件维护。
 */
const turnState = new Map();
/**
 * 推送出口（`mobile/push-notify.js` 的 `notifyInteraction`）。由装配层经
 * `installApprovalBridge(ctx, pushNotify)` 或 `setPushNotifier` 注入；没注入就不推。
 * 装入时机可能早于 sidecar 就绪，注入的是个晚绑定壳，所以这里只存不判空。
 */
let pushNotifier = null;
function setPushNotifier(fn) {
  pushNotifier = typeof fn === 'function' ? fn : null;
}

function watcherCount(sessionId) {
  const set = watchers.get(sessionId);
  return set ? set.size : 0;
}

/**
 * 这条会话此刻有没有手机在看着 —— **自动审阅档唯一的「人在不在」判据**。
 *
 * 进程级的「最近有没有手机请求」不算：在别的会话里刷一下就会把这条会话算成有人，
 * 而手机放着不动两分钟又会把有人算成人不在。观众表按 sessionId 记 sink，才是准确的。
 */
function isSessionWatched(sessionId) {
  return watcherCount(sessionId) > 0;
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
    // 事实行：电脑从原始参数算出来的一句人话；算不出就不带（App 不渲染这一行）。
    ...(entry.fact ? { fact: entry.fact } : {}),
    ...(entry.factHighlight ? { factHighlight: true } : {}),
    // 危险命令的原文：事实行是概括，用户要判断得看原句。
    ...(entry.command ? { command: entry.command } : {}),
  };
}

/**
 * 结算帧。App 按 approvalId 比对（`approvalResolved`），所以这条让手机立刻收卡，不必等
 * 宿主的 `approval/decided` 绕一圈 —— 尤其是手机自己答的那一条，桌面那条路已经不需要了。
 * 拒绝理由随帧下发（可选）：卡收起前那一瞬间的提示要能说出「为什么」。
 */
function resolvedFrame(entry, outcome, reason) {
  return {
    type: 'approval/resolved',
    sessionId: entry.sessionId,
    approvalId: entry.approvalId,
    outcome,
    ...(reason ? { reason } : {}),
  };
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
  if (entry.settled) return;
  // 一台能答审批的设备都没有时（例如只配了只读档手机）：不建卡也不推送。点下去必然 403 的卡
  // 送上去只是打扰，见 `canShowCards`。
  if (!canShowCards()) return;
  if (watcherCount(entry.sessionId) > 0) broadcast(entry.sessionId, cardFrame(entry));
  // 有人看就走 SSE，没人看也别什么都不做：手机在后台 / 被杀时那张卡到不了，
  // 只有这条推送能把它带到系统通知上。只有「已绑上钩子 = 答得动」的卡才推，
  // 否则用户点进来是一条必然 409 的死卡。
  if (entry.bound && pushNotifier) {
    // 事实行要一起带到系统通知上：通知栏那张卡拿不到 App 面板，只靠这一样值才知道这条要动
    // 什么。标题由装配层补（只有镜像调度器手里有会话名）。
    try {
      pushNotifier(entry.sessionId, cardFrame(entry), {
        fact: entry.fact,
        factHighlight: entry.factHighlight,
      });
    } catch { /* 推送失败不影响建卡 */ }
  }
}

/**
 * 在已挂起的项里找这条审批对应的那一条（不建项）。
 *
 * 两个来源拿到的是宿主**同一个** request 对象（`dsh-user-approval.request()` 把 req 原样
 * 交给钩子，`approval/asked` 也照它记 toolName/callId），所以按 callId → toolName 配对是
 * 精确的；配对不上就是没有。
 *
 * `unboundOnly` 只给钩子用：钩子绑上一条就已经接管了它（回答由那条钩子的 promise 决定），
 * 第二条钩子请求绝不能共用同一条挂起项。反过来，事件那一侧必须能认领**已经绑上**的挂起项 ——
 * 「钩子先到、`approval/asked` 后到」时就是靠这一步把真实的 approvalId 补进去的。
 */
function findOpenEntry(sessionId, ask, { unboundOnly = false } = {}) {
  const open = openEntries(sessionId).filter((entry) => !unboundOnly || !entry.bound);
  if (ask.callId) {
    const byCall = open.find((entry) => entry.callId === ask.callId);
    if (byCall) return byCall;
    // 这一侧有 callId 却没配上：只认那些没记 callId 的项。**不许**退成按 toolName 撞上去 ——
    // 同一轮里连着两条 `bash` 审批时，那会把后一条的真 id 贴到前一条的卡上。
    return uniqueByToolName(open.filter((entry) => !entry.callId), ask.toolName);
  }
  return uniqueByToolName(open, ask.toolName);
}

/** 按 toolName 配：只有**恰好一条**同名的才认，两条同名就不猜。 */
function uniqueByToolName(list, toolName) {
  if (!toolName) return null;
  const hits = list.filter((entry) => entry.toolName === toolName);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 取（或建）一条挂起项：找到就复用，找不到就新建（宁可多一张卡，也不要两条审批共用一张卡）。
 */
function entryFor(sessionId, ask, { unboundOnly = false } = {}) {
  const match = findOpenEntry(sessionId, ask, { unboundOnly });
  if (match) return match;
  const entry = {
    // rpcId 是本桥自己铸的：0.2.x 的宿主不再提供任何可作答的帧级 id，而 App 只认带 rpcId 的帧。
    rpcId: `m-${randomUUID()}`,
    sessionId,
    // 钩子先到时还不知道宿主的 approvalId，先铸一个占位（只用于挂起项身份，回答不看它）。
    // 真 id 到了**不改这一格**，另存 `realApprovalId`：App 的审批队列按 approvalId 去重/更新，
    // approvalId 一变就会排成两张卡（见 noteAsk）。真 id 只用来把会话里的 approval/decided 对上。
    approvalId: ask.approvalId || `m-${randomUUID()}`,
    realApprovalId: ask.approvalId || null,
    toolName: ask.toolName,
    callId: ask.callId,
    reason: ask.reason,
    // 宿主那句机器文案（`escalate sandbox to <mode>`）单独留着：`reason` 后面会被 tz 化文案覆盖，
    // 而档位只在机器句里最可靠。
    reasonRaw: ask.reason,
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
function settle(entry, outcome, extra) {
  if (entry.settled) return false;
  entry.settled = true;
  if (extra && typeof extra.reason === 'string' && extra.reason) entry.decisionReason = extra.reason;
  entries.delete(entry.rpcId);
  const list = bySession.get(entry.sessionId);
  if (list) {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) bySession.delete(entry.sessionId);
  }
  entry.release({ outcome });
  broadcast(entry.sessionId, resolvedFrame(entry, outcome, extra && extra.reason));
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
  // 而钩子上的请求还在等 —— 那时候这张卡仍然答得动。没有能答审批的设备时补发也没意义。
  if (canShowCards()) {
    for (const entry of openEntries(sessionId)) {
      if (entry.bound) { try { sink(cardFrame(entry)); } catch { /* ignore */ } }
    }
  }
  return () => {
    if (!set.delete(sink)) return;
    if (set.size === 0) {
      watchers.delete(sessionId);
      for (const entry of openEntries(sessionId)) entry.forwardToDesktop?.();
    }
  };
}

/**
 * 会话摘要里的待处理标记（0.2.x 的宿主不会再下发这个字段，见 sessions.js 的用法）。
 *
 * 口径：还有没结算的挂起项就算挂起。
 */
function hasPending(sessionId) {
  const open = openEntries(sessionId);
  if (open.length === 0) return false;
  return open.length > 0;
}

/**
 * 这条会话此刻挂着的审批卡（形状与推送帧一字不差），没有就 undefined。
 *
 * 与提问桥的 `pendingCardOf` 同一用途：手机回前台时先问原生要卡，不必等流重新接上
 * （见 `questions.js` 那一处的说明）。只认已绑定的项 —— 与 `attachSession` 的补发口径
 * 一致：没绑上钩子的卡答不动，送上去只会让人点出一个 409。
 */
function pendingCardOf(sessionId) {
  if (!canShowCards()) return undefined;
  for (const entry of openEntries(sessionId)) {
    if (entry.bound) return cardFrame(entry);
  }
  return undefined;
}

/** 测试用：清空全部进程内状态（真实运行时由插件卸载时的 disposer 收尾）。 */
function resetForTest() {
  watchers.clear();
  entries.clear();
  bySession.clear();
  turnState.clear();
  pushNotifier = null;
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

/** 会话的工作目录（事实行里写/读文件按它归目录；取不到就空，归类退 `abs`）。 */
function cwdOf(session) {
  if (!session || typeof session !== 'object') return '';
  if (typeof session.cwd === 'string' && session.cwd) return session.cwd;
  const header = session.header;
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd;
  return '';
}

/** 认得的沙箱档位。档位是审批的**授权范围**：同一条命令在 workspace 与 danger 下不是一回事。 */
const TIERS = ['workspace-write', 'danger-full-access'];

/**
 * 从审批文案里认沙箱档位。宿主的 `reason` 是 `escalate sandbox to <mode>: ...` 这种机器句；
 * `displayReason` 是同一句的 tz 化文案，里面仍带档位名。两处都认不出就用 `unknown` —— 宁可
 * 让类别分不清，也不要瞎猜一个档位出来（猜错会把 danger 的键当成 workspace 的键复用）。
 */
function tierOfReason(reason, displayReason) {
  const texts = [reason, displayReason].filter((text) => typeof text === 'string' && text);
  // 先认宿主的机器句（`escalate sandbox to <mode>`），再退到任意位置出现的档位名。
  for (const text of texts) {
    const hit = /escalate sandbox to\s+([a-z-]+)/i.exec(text);
    if (hit && TIERS.includes(hit[1].toLowerCase())) return hit[1].toLowerCase();
  }
  for (const text of texts) {
    for (const tier of TIERS) {
      if (text.includes(tier)) return tier;
    }
  }
  return 'unknown';
}

/** 从一个事件里认出与 callId 对应的工具调用参数（tool/call 事件或 assistant/message 里的块）。 */
function argsFromEvent(ev, callId) {
  if (!ev || typeof ev !== 'object') return null;
  const data = ev.data && typeof ev.data === 'object' ? ev.data : null;
  // tool/call 事件：{ callId, name, arguments }
  const src = data && typeof data === 'object' ? data : ev;
  if (typeof src.callId === 'string' && src.callId === callId && src.arguments !== undefined) {
    return parseArgs(src.arguments);
  }
  // assistant/message：content 里 type==='tool-call' 且 id===callId 的块
  const message = (data && data.message) || ev.message || (data && data.content ? data : null);
  const content = message && Array.isArray(message.content) ? message.content : (Array.isArray(src.content) ? src.content : null);
  if (content) {
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool-call') continue;
      const id = block.id != null ? String(block.id) : '';
      if (id && id === callId) return parseArgs(block.arguments);
    }
  }
  return null;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 按 callId 回会话日志取原始工具参数。宿主的 `approval/request` 钩子不带参数，只有 toolName /
 * callId / reason，所以事实行只能在这条日志里按 callId 找那条 tool-call 块。
 *
 * 同步读：审批发生在工具真正执行前，`assistant/message`（含 tool-call 块）与 `tool/call` 事件
 * 都早于 `approval/asked` 落进日志，回扫一段就够。窗口取 400 条而不是更小：一轮里这个工具调用
 * 前面可能还排着别的工具的成批输出，窗口太窄会把事实行读成空。
 *
 * 没有 `eventAt`（老宿主）时退到 `snapshotEvents(from, to)`（同步、返回数组）再找一遍；两样都
 * 没有就返回 null —— 事实行随之退成空，绝不猜。
 */
function readToolArgs(session, callId) {
  if (!session || typeof session !== 'object' || !callId) return null;
  const id = String(callId);
  const seqNow = typeof session.seq === 'number'
    ? session.seq
    : (session.header && typeof session.header.seq === 'number' ? session.header.seq : NaN);
  if (!Number.isFinite(seqNow)) return null;
  const from = Math.max(0, seqNow - ARGS_SCAN_WINDOW);
  if (typeof session.eventAt === 'function') {
    try {
      for (let i = seqNow; i >= from; i -= 1) {
        const args = argsFromEvent(session.eventAt(i), id);
        if (args) return args;
      }
    } catch { /* ignore */ }
  }
  if (typeof session.snapshotEvents === 'function') {
    try {
      const list = session.snapshotEvents(from, seqNow);
      if (Array.isArray(list)) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const args = argsFromEvent(list[i], id);
          if (args) return args;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 给一条挂起项补齐事实行与动作类别。
 *
 * **不粘滞**：只有真取到参数才置 `factApplied`。取不到就保持可重试 —— 审批卡可能先到、那条
 * tool-call 事件随后才落进日志，一旦把失败定死，这条卡的事实行与第三档就永久丢了。
 *
 * 档位变了要重算：`approval/asked` 那条事件常常不带 `reason`（档位算成 `unknown`），真档位
 * 是钩子那侧才有的。类别键里带着档位，所以按 `entry.tier` 比对，换了档就重算一次 —— 但
 * **只许从 `unknown` 变具体，不许反过来**：否则钩子刚算出的 `danger-full-access` 会被后到的
 * 那条不带 reason 的事件降成 `unknown`。
 */
function applyFacts(entry, session) {
  if (!entry) return;
  const parsed = tierOfReason(entry.reasonRaw, entry.reason);
  const known = entry.tier && entry.tier !== 'unknown';
  const tier = known && parsed === 'unknown' ? entry.tier : parsed;
  if (entry.factApplied && entry.tier === tier) return;
  const args = readToolArgs(session, entry.callId);
  if (!args) return;
  entry.factApplied = true;
  entry.tier = tier;
  const derived = facts.deriveApprovalFacts(
    { toolName: entry.toolName, args },
    { cwd: cwdOf(session), tier },
  );
  entry.fact = derived.fact;
  entry.factHighlight = derived.highlight;
  entry.classKey = derived.classKey;
  entry.keyArgs = facts.keyArgsOf(entry.toolName, args);
  entry.command = commandOf(entry.toolName, args);
}

/** 危险命令的原文：给 App 在事实行下面显示原句用（只有命令类工具才有）。 */
function commandOf(toolName, args) {
  if (!COMMAND_TOOLS.has(toolName) || !args || typeof args !== 'object') return undefined;
  const raw = typeof args.command === 'string' && args.command
    ? args.command
    : (typeof args.cmd === 'string' && args.cmd ? args.cmd : '');
  return raw || undefined;
}

/** 从一条请求直接算（钩子里在建挂起项之前判断要不要自动放行/自动拒）。 */
function prepareFacts(session, request) {
  const args = readToolArgs(session, request && request.callId);
  const tier = tierOfReason(
    request && typeof request.reason === 'string' ? request.reason : undefined,
    displayReasonOf(request),
  );
  const derived = facts.deriveApprovalFacts(
    { toolName: request && request.toolName, args },
    { cwd: cwdOf(session), tier },
  );
  return {
    ...derived,
    tier,
    // 同轮去重按「类别 + 参数 + 档位」认：同一条命令在 workspace 与 danger 下不是同一条请求。
    keyArgs: args ? `${facts.keyArgsOf(request && request.toolName, args)}\u0000${tier}` : '',
  };
}

/** 记一轮的起点：`turn/start` 事件拿到本轮标识，清空上一轮见过的签名。 */
function noteTurnStart(sessionId, event) {
  if (!sessionId) return;
  const data = event && event.data && typeof event.data === 'object' ? event.data : {};
  const turnKey = (data.turn != null ? String(data.turn) : null)
    || (event && event.seq != null ? `seq:${event.seq}` : null)
    || `t:${Date.now()}`;
  turnState.set(sessionId, { turnKey, seen: new Set() });
}

function noteTurnEnd(sessionId) {
  if (!sessionId) return;
  turnState.delete(sessionId);
}

/**
 * 同轮去重用的签名：`<turnKey>\u0000<classKey>\u0000<keyArgs>`。
 *
 * 带上 turnKey 是为了让 `turn/start` 漏收（事件被裁、插件中途装上）时不会把上一轮的签名
 * 当成这一轮的：签名一变，最多是这一轮少拒一次，绝不会跨轮误杀。
 */
function signatureOf(sessionId, prepared) {
  const state = turnState.get(sessionId);
  const turnKey = state ? state.turnKey : '';
  return `${turnKey}\u0000${prepared.classKey}\u0000${prepared.keyArgs}`;
}

/**
 * 去掉类别键末尾的档位尾巴（`bash:rm@danger-full-access` → `bash:rm`）。
 *
 * `approval/asked` 那条事件常常不带 `reason`（档位只能算成 `unknown`），而钩子那侧认得出真
 * 档位。两边算出来的类别键因此会差一个 `@tier` 尾巴 —— 下面两处判断要在这种时候按基名放宽，
 * 否则「钩子已经静默放行 / 自动拒」的那一条会在事件这侧又被建出来，永远没人结算。
 */
function classBaseOf(classKey) {
  const key = String(classKey || '');
  for (const tier of [...TIERS, 'unknown']) {
    const suffix = `@${tier}`;
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  return key;
}

/** 本轮里这条请求是否已经出现过（同轮 + 同类 + 同参 + 同档位）。 */
function isDuplicate(sessionId, prepared) {
  const state = turnState.get(sessionId);
  if (!state || !state.turnKey) return false;
  if (!prepared || !prepared.classKey || !prepared.keyArgs) return false;
  // 认不出类别时不做同轮去重：`tool:unknown` 什么都代表不了，拿去拒等于瞎杀。
  if (classBaseOf(prepared.classKey) === 'tool:unknown') return false;
  if (state.seen.has(signatureOf(sessionId, prepared))) return true;
  if (prepared.tier !== 'unknown') return false;
  // 档位缺失：按「类别基名相同 + 参数相同」再扫一遍。这条只用来决定「要不要建卡」，多拒一次
  // 是最坏结果，而少认一次会留下一条永不结算的挂起项（列表页黄点常亮、点进去没卡）。
  const base = classBaseOf(prepared.classKey);
  const args = prepared.keyArgs.replace(/\u0000unknown$/, '');
  for (const sig of state.seen) {
    const parts = sig.split('\u0000');
    if (parts.length < 4) continue;
    if (parts[0] !== state.turnKey) continue;
    if (classBaseOf(parts[1]) !== base) continue;
    // 参数本身可能带 \u0000（write 的内容段），档位是最后一段，所以重新拼回去再比。
    if (parts.slice(2, -1).join('\u0000') === args) return true;
  }
  return false;
}

function rememberDuplicate(sessionId, prepared) {
  const state = turnState.get(sessionId);
  if (!state || !state.turnKey || !prepared || !prepared.classKey || !prepared.keyArgs) return;
  state.seen.add(signatureOf(sessionId, prepared));
  // 封顶：`Set` 保插入序，删最老的一条即可。一轮正常远到不了这个量。
  while (state.seen.size > SEEN_MAX) {
    const oldest = state.seen.values().next();
    if (oldest.done) break;
    state.seen.delete(oldest.value);
  }
}

/**
 * `approval/asked`：宿主记下这次审批。details 见 `dsh-user-approval` 的 `request()`。
 *
 * **先认领、后判断**，顺序不能换：这条事件的职责是「把宿主的真 id 补给已经挂着的那条」，
 * 而钩子可能先到。如果先判断「已同意 / 本轮重复」再找项，自动放行/自动拒的那一条就会在
 * 这里新建一条永远没人结算的 bound:false 挂起项 —— 列表页的黄点常亮、点进去却没有卡。
 */
function noteAsk(session, sessionId, data) {
  const approvalId = typeof data.id === 'string' && data.id ? data.id : null;
  if (!approvalId) return;
  const ask = {
    approvalId,
    toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
    callId: typeof data.callId === 'string' ? data.callId : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  };
  // 1) 已经挂着的那条（钩子先到）：补真 id、补事实、重推一次卡。这一步**不受**「已同意 /
  //    重复」影响 —— 钩子此刻正等着这个 id，丢了它 `approval/decided` 就永远对不上。
  const existing = findOpenEntry(sessionId, ask);
  if (existing) {
    // **不改 approvalId**：占位 id 已经随第一张卡发给了 App，这一改就会在 App 上排成第二张卡
    // （其中一张回答必然 409）。真 id 另存，只给 `approval/decided` 认领用。
    existing.realApprovalId = approvalId;
    if (ask.reason) {
      existing.reasonRaw = existing.reasonRaw || ask.reason;
      existing.reason = existing.reason || ask.reason;
    }
    applyFacts(existing, session);
    pushCard(existing);
    return;
  }
  // 2) 没有挂起项：先算事实，判一下这条会不会被钩子自动拒。会的话什么都不建。
  const prepared = prepareFacts(session, ask);
  if (isDuplicate(sessionId, prepared)) return;
  // 3) 真会弹卡的才建项。
  const entry = entryFor(sessionId, ask);
  applyFacts(entry, session);
  pushCard(entry);
}

/** `approval/decided`：这条审批已经有结论了（桌面答的、或被取消），把卡和挂起项一起收掉。 */
function noteDecided(sessionId, data) {
  const approvalId = typeof data.id === 'string' && data.id ? data.id : null;
  if (!approvalId) return;
  const entry = openEntries(sessionId).find((candidate) => candidate.approvalId === approvalId
    || candidate.realApprovalId === approvalId);
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
  // 留一个身份引用：手机答完之后要按它找回宿主转发给桌面窗口的那一发（见 cancelForwardedCards）。
  entry.requestRef = request;
  entry.toolName = entry.toolName || (typeof request.toolName === 'string' ? request.toolName : undefined);
  entry.callId = entry.callId || (typeof request.callId === 'string' ? request.callId : undefined);
  const nicer = displayReasonOf(request) || (typeof request.reason === 'string' ? request.reason : undefined);
  if (typeof request.reason === 'string' && request.reason) entry.reasonRaw = entry.reasonRaw || request.reason;
  if (nicer) entry.reason = nicer;
  // 事实行只能在钩子这侧从日志里的原始参数算（手机线路已把参数裁掉），绑定时补上再推卡。
  applyFacts(entry, request && request.agent ? request.agent.session : null);
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
 * 手机在看时先独占；最后一条连接离开后，将同一审批交给桌面竞速一次。
 * 交接时桌面不可用只表示没人接手，仍等手机回来作答；不改变无人观看时的原有下游结论。
 */
function holdForPhone(entry, next) {
  const handoff = isSessionWatched(entry.sessionId);
  const downstream = new Promise((resolve, reject) => {
    let forwarded = false;
    entry.forwardToDesktop = () => {
      if (forwarded || entry.settled) return;
      forwarded = true;
      Promise.resolve().then(() => {
        if (!entry.settled) return next();
      }).then((outcome) => {
        if (entry.settled) return;
        const value = DECISIONS.has(outcome) ? outcome : 'unavailable';
        if (handoff && value === 'unavailable') return;
        settle(entry, value);
        resolve(value);
      }, (error) => {
        if (entry.settled || (handoff && error?.code === 'NO_PROVIDER')) return;
        reject(error);
      });
    };
    if (!handoff) entry.forwardToDesktop();
  });
  return Promise.race([entry.wait.then((result) => result.outcome), downstream])
    .finally(() => { entry.forwardToDesktop = null; });
}

/**
 * 收掉桌面那张审批卡：把宿主已经发给桌面窗口、还挂着的那一发转发撤掉。
 *
 * 手机在看时不转发；没有观众或最后一条连接离开后，桌面那一发会与手机作答竞速。手机先答
 * 时按请求对象撤回桌面卡，与提问桥共用传输层的收尾口子。认不到（老宿主没这道网关）就
 * 什么都不做 —— 「桌面没卡可收」本来就是对的。
 */
function cancelForwardedCards(ctx, entry) {
  if (!entry.requestRef) return;
  cancelForwardedRequests(ctx, entry.requestRef, new Error('手机已经回答了这条审批'));
}

async function onApprovalRequest(ctx, request, next) {
  const sessionId = sessionIdOfRequest(request);
  if (!sessionId) return next();
  const session = request.agent && request.agent.session ? request.agent.session : null;
  // 事实行与动作类别：在钩子这侧从日志原始参数算（手机线路已裁参数）。下半段的同轮去重要用
  // 同一份，所以在这里算一次。
  const prepared = prepareFacts(session, request);
  // 同一轮里相同请求再次出现：直接拒，不再问一次（原因由 App 侧展示）。
  if (isDuplicate(sessionId, prepared)) {
    return 'rejected';
  }
  rememberDuplicate(sessionId, prepared);
  const entry = entryFor(sessionId, {
    approvalId: undefined,
    toolName: typeof request.toolName === 'string' ? request.toolName : undefined,
    callId: typeof request.callId === 'string' ? request.callId : undefined,
    reason: typeof request.reason === 'string' ? request.reason : undefined,
  }, { unboundOnly: true });
  bindRequest(entry, request);
  // 在场时手机先答；最后一条手机连接离开后由 attachSession 交接给桌面。
  return holdForPhone(entry, next);
}

/**
 * 装上审批桥（只在 0.2.x 那一侧装：0.1.x 宿主自带 apiProxy，帧和回答都还走得通，装上去
 * 只会多推一张卡）。
 */
function installApprovalBridge(ctx, pushNotify) {
  if (pushNotify !== undefined) setPushNotifier(pushNotify);
  const disposers = [
    ctx.on('session/event', (session, event) => {
      const sessionId = sessionIdOf(session);
      if (!sessionId || !event || typeof event !== 'object') return;
      if (event.type === 'approval/asked') noteAsk(session, sessionId, event.data || {});
      else if (event.type === 'approval/decided') noteDecided(sessionId, event.data || {});
      else if (event.type === 'turn/start') noteTurnStart(sessionId, event);
      else if (event.type === 'turn/end') noteTurnEnd(sessionId);
    }, { global: true }),
    // prepend 是前提不是优化，理由见文件头。
    ctx.on('approval/request', (request, next) => onApprovalRequest(ctx, request, next), { prepend: true, global: true }),
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
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, REASON_MAX) : '';
  const entry = entries.get(body.rpcId);
  if (entry && !entry.settled && entry.bound
    && entry.sessionId === body.sessionId
    && (entry.approvalId === body.approvalId || entry.realApprovalId === body.approvalId)) {
    settle(entry, body.outcome, { reason });
    cancelForwardedCards(ctx, entry);
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
  pendingCardOf,
  isSessionWatched,
  setPushNotifier,
  resetForTest,
};

'use strict';

/**
 * dsh-mobile 流式：SSE 转发目标会话的增量事件。
 *
 * 订阅宿主事件流，仅转发目标会话的 session/event 帧（增量事件），
 * 每 15s 发一行注释 + 一帧 `session/heartbeat` 数据帧；客户端断开即取消订阅。
 *
 * 为什么要那帧心跳：注释行只是保活，客户端一个事件都收不到。而「流被正常收尾」
 * （中转重启、隧道掉了、宿主自己结束响应）在 App 那边看起来和「这条流还开着」一模一样
 * —— react-native-sse 在 readyState 走到 DONE 时既不派发 error 也不派发 close。所以
 * App 需要一个**自己数得到**的活口，两拍没到就主动断开重连（见 app 侧
 * services/viewmodels/stream-liveness.ts）。这帧不带 seq、不进消息模型、不写缓存。
 *
 * 断线恢复：SSE 客户端重连时携带 `Last-Event-ID: <sessionId>:<seq>`（或查询参数
 * `lastSeq=<seq>`）。服务端先在 history 中回放 `seq > lastSeq` 的事件（收敛状态），
 * 再无缝接入实时流，并用 seq 去重避免回放/实时交界处重复交付。由于宿主 history
 * 只支持窗口回放，若断线窗口超过回放上限，客户端仍应在其 SSRD 重连补偿刷新
 * 权威快照（/session/messages、/workspaces）兜底。
 *
 * 生命周期：所有失败路径都必须经 logStream 留痕（守卫 test/stream-liveness.test.cjs
 * 逐条钉着字面量），收尾一定给客户端一帧 `session/resync-required`；keepAlive 定时器
 * 要 unref —— 它只是保活，不该把进程退出按在 15s 一拍上。
 */

const { sendJson } = require('../shared/http-util');
const {
  writeSse: sharedWriteSse,
  waitForDrain,
  ssePadding,
  shedWithoutSeq,
} = require('../shared/sse-write.js');
const { resolveEventAttachments } = require('./sessions.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { normalizeJobs } = require('./jobs.js');
const approvals = require('./approvals.js');
const questions = require('./questions.js');

// Android React Native's XHR may buffer tiny chunked responses until its
// internal progress threshold. Pad each SSE record so onprogress exposes it
// promptly; the padding is an SSE comment and is ignored by clients.
const SSE_FLUSH_PADDING_BYTES = 2048;
const REPLAY_WINDOW = 3000; // 断线补偿回放的最大事件数

/**
 * keepalive 节奏，同时也是 `session/heartbeat` 的间隔。
 *
 * 必须与 App 的 `STREAM_HEARTBEAT_MS` 一致（`app/src/services/viewmodels/stream-liveness.ts`，
 * 由 `test/stream-liveness.test.cjs` 的跨仓断言钉着）。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 可回答的审批请求帧类型。宿主 apiProxy 的 `requestedFrame()` 发的是 mux 帧
 * `approval/requested`（`rpcId` 在帧级、`approvalId` 在 payload）；会话事件
 * `approval/asked` 只是同一件事的持久化形态，且**不带** rpcId。
 *
 * 两种形态都必须把帧级 rpcId 透给客户端：`/approval/respond` 的 rpcId 是宿主
 * `pendingApprovals` 表的键，用 approvalId 冒充它会被判 `not-pending` 并回 409
 * 「该审批已完成或不可回答」。旧实现只给 `approval/asked` 合入 rpcId，而宿主
 * 实际发的是 `approval/requested` —— 于是 App 拿到的审批帧永远没有 rpcId。
 */
const ANSWERABLE_APPROVAL_TYPES = new Set(['approval/requested', 'approval/asked']);

/**
 * 诊断日志。这条流过去把三处失败都静默吞掉（keepalive 写失败、mux 循环抛错、
 * res.end 失败），于是「preamble 之后既不产出也不终止」这种状态在宿主侧没有任何
 * 痕迹，只能靠 relay/nginx 侧反推。任何一条异常路径都必须留下可 grep 的行。
 */
function logStream(sessionId, message, error) {
  const detail = error instanceof Error ? (error.stack || error.message) : (error == null ? '' : String(error));
  try {
    process.stderr.write(`[dsh-mobile-plugin] session/stream ${sessionId} ${message}${detail ? `: ${detail}` : ''}\n`);
  } catch { /* ignore */ }
}

/**
 * 写一条 SSE 记录（策略声明，实现见 `lib/shared/sse-write.js`）。
 *
 * 这条流的策略：软水位只丢**没有 seq** 的增量（`assistant/chunk` 是可丢弃草稿，同一轮
 * 收尾的 `assistant/message` 带完整正文且有 seq，重连回放能补齐）；每条记录补 2048 字节
 * 注释，让 RN 的 XHR 尽快吐出来。
 *
 * @returns {{ok: boolean, shed?: boolean, needDrain?: boolean}}
 *   `ok:false` → 这条流该收尾（客户端走了，或积压超过硬水位）；
 *   `shed:true` → 这条**增量**帧被丢掉、连接还活着；
 *   `needDrain:true` → 写成功了，但底下已经写不动，调用方要先 await 一次 drain 再继续。
 */
function writeSse(res, payload, frame) {
  return sharedWriteSse(res, payload, {
    frame,
    padding: ssePadding(SSE_FLUSH_PADDING_BYTES),
    // 审批帧没有 seq，按默认口径会在软水位上被丢掉（见上面那条策略）。但它是「人工决策
    // 的入口」不是草稿：丢一张，手机就再也看不到那张卡（软水位只在客户端跟不上时到，
    // 回放也不覆盖这一段）。它一次审批也就一两帧，不是撑爆写队列的那类帧。
    // 心跳同理必须保住：丢了它，App 会把一条健康的流判成死链（见 isLivenessHeartbeat）。
    shedWhenBuffered: (value) => !isApprovalPayload(value) && !isLivenessHeartbeat(value) && shedWithoutSeq(value),
  });
}

/**
 * 审批卡与它的结算帧，外加提问卡与它的结算帧：都是「人工决策的入口」，一次就一两帧，
 * 不是撑爆写队列的那类增量，按软水位丢掉就再也补不回来（回放不覆盖这一段）。
 */
function isApprovalPayload(payload) {
  const type = payload && payload.type;
  return type === 'approval/requested' || type === 'approval/resolved'
    || type === 'question/requested' || type === 'question/resolved';
}

/**
 * 这一帧是「App 用来数活口」的心跳，不是聊天内容。
 *
 * 它走和正文一样的 writeSse（所以同样受背压闸门管），但**必须**在软水位上被保住：
 * 心跳被丢掉就等于这条流没说话，App 会在 35s 后把一条完全健康的连接判死并重连 ——
 * 那是比「丢一张草稿」贵得多的代价。它一帧一百多字节，不是撑爆写队列的那类帧。
 *
 * 它不带 seq，所以**绝不能**推进 `lastDeliveredSeq`（那会让回放跳过一个真事件）。
 */
function isLivenessHeartbeat(payload) {
  return Boolean(payload) && payload.type === 'session/heartbeat';
}

/**
 * 解析断线续传位置：
 *  - `Last-Event-ID: <sessionId>:<seq>`（标准 SSE 头）；
 *  - 或查询参数 `lastSeq=<seq>`。
 * 返回安全非负整数 seq，缺失/非法返回 null。
 */
function parseResumeSeq(req, sessionId) {
  const header = req?.headers?.['last-event-id'];
  if (typeof header === 'string' && header) {
    // 只认 `<sessionId>:<seq>` 形式，防止别的 `id:` 误判。
    const m = /^(?:[^:]*):([0-9]+)$/.exec(header.trim());
    if (m) {
      const seq = Number(m[1]);
      if (Number.isSafeInteger(seq) && seq >= 0) return seq;
    }
  }
  const lastSeq = new URL(req.url, 'http://x').searchParams.get('lastSeq');
  if (lastSeq !== null && lastSeq !== '') {
    const seq = Number(lastSeq);
    if (Number.isSafeInteger(seq) && seq >= 0) return seq;
  }
  return null;
}

/**
 * GET /api/mobile/v1/session/stream?sessionId=…&lastSeq=…（token）
 * SSE：订阅宿主事件流，仅转发目标会话的 session/event 帧（增量事件），
 * 每 15s 发一行注释保持连接；客户端断开即取消订阅。
 */
async function handleStream(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'content-encoding': 'identity',
    });
  } catch (error) { logStream(sessionId, 'writeHead failed', error); return; }
  res.write(': connected\n\n');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // 与设备级流（mobile/events.js）对齐：写坏掉的连接不该让 'error' 在 res 上无人接住
  // 而变成未捕获异常，那时 aborted 仍是 false，收尾分支会以为客户端还在、白写一帧 resync。
  res.on('error', () => ac.abort());
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (error) {
      // 写失败 = 客户端已经不在了。旧实现把它吞掉，interval 继续空转，连接既不
      // 产出也不终止；这里立刻收尾，别把它留在 relay 的 pending 里等超时。
      logStream(sessionId, 'keepalive write failed', error);
      clearInterval(keepAlive);
      ac.abort();
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    // 注释行客户端看不见，所以每一拍再补一帧数据心跳：App 靠「最近真的收到过帧」判断
    // 这条流还在说话（见 app 侧 services/viewmodels/stream-liveness.ts）。写不出去同样
    // 说明客户端已经不在，按上面那条路径收尾。
    if (!writeSse(res, { type: 'session/heartbeat', sessionId, at: Date.now() }).ok) {
      logStream(sessionId, 'heartbeat write failed', null);
      clearInterval(keepAlive);
      ac.abort();
      try { res.end(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  // 定时器不该拖住进程退出：宿主/worker 关停时若这条 SSE 还挂着，事件循环会被它按在
  // 15s 一拍上，收尾要等到下一次 tick 才发生（lib/sidecar-facade-worker.cjs 的
  // shutdown 就是这么做的）。测试里的 setInterval 桩没有 unref，所以先判类型。
  if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref();

  // 审批卡由审批桥在帧循环之外推进这条连接：宿主那半条通道（`approval/request` 钩子）
  // 跟 mux 帧流没关系，见 mobile/approvals.js。接入时它会把仍然可作答的卡补发一遍。
  const detachApprovals = approvals.attachSession(sessionId, (frame) => {
    writeSse(res, frame, { payload: frame });
  });
  // 提问卡同理（见 mobile/questions.js）：`user-questions/request` 钩子与 mux 帧流无关。
  const detachQuestions = questions.attachSession(sessionId, (frame) => {
    writeSse(res, frame, { payload: frame });
  });

  const resumeSeq = parseResumeSeq(req, sessionId);
  // 已交付的 seq 水位：从续传位置开始，重连时先回放、后接入实时流，并用它去重。
  let lastDeliveredSeq = resumeSeq != null ? resumeSeq : 0;
  // 「客户端已经走了」与「mux 循环正常结束」必须分开：前者不必再回写 resync，
  // 后者必须回写，否则客户端会把一次静默断流当成正常状态一直等下去。
  let clientGone = false;
  let loopEnded = false;

  try {
    // 断线续传：先回放 history 中 seq > resumeSeq 的事件（收敛状态）。
    if (resumeSeq != null && resumeSeq > 0) {
      const replay = await replaySince(ctx, sessionId, resumeSeq, res, ac.signal, (seq) => { lastDeliveredSeq = Math.max(lastDeliveredSeq, seq); });
      if (replay.gap && !ac.signal.aborted) {
        const value = { type: 'session/resync-required', sessionId, resumeSeq, oldestSeq: replay.oldestSeq };
        // 旧实现在这里直接 `return`：既不清 keepAlive 也不 end，漏出一条永不收尾的连接。
        if (!writeSse(res, value, { payload: value }).ok) clientGone = true;
      }
    }

    if (!clientGone) {
      // payload 里带 sessionId：0.2.0 的宿主没有设备级事件流了，兼容桥据此收窄成
      // 这一条会话的 follow + 投影 + 任务三条流（见 mobile/host-bridge.js 的 muxFrames）。
      // 不带就是设备级视角，只会给工作区基线与全局投影 —— 这里反正只要单会话。
      const frames = ctx.apiProxy.events.mux({ rpcId: 'mobile-stream', payload: { sessionId } }, ac.signal);
      // 写一帧并把三种结果统一收口：丢增量、需要等 drain、该收尾。
      // 「需要等 drain」这一步是这次 OOM 的正解 —— 写不动就停手，等底层消化完再继续，
      // 而不是把帧继续往内存里塞。
      const push = async (payload, frameArg) => {
        const sent = writeSse(res, payload, frameArg);
        if (sent.shed) return 'shed';
        if (!sent.ok) return 'closed';
        if (sent.needDrain) {
          const drained = await waitForDrain(res, ac.signal);
          if (!drained) { logStream(sessionId, 'drain timeout', null); return 'closed'; }
        }
        return 'sent';
      };
      for await (const frame of frames) {
        const p = frame.payload;
        if (!p || p.sessionId !== sessionId) continue;
        // 增量事件保持原 wire：data 仍是原事件 JSON，SSE 元数据独立于 data。
        if (p.type === 'session/event') {
          const seq = p.event && Number.isFinite(p.event.seq) ? p.event.seq : null;
          // 回放已覆盖该 seq（回放与实时交界处）→ 跳过，避免重复交付。
          if (seq !== null && seq <= lastDeliveredSeq) continue;
          // 引用模式：图片只下发 attachmentId，不取字节（见 attachments.js）。
          const event = await resolveEventAttachments(ctx, sessionId, p.event, { referencesOnly: true });
          // 被 shed 的只可能是没有 seq 的增量（见 writeSse 的软水位闸）；它不推进水位，
          // 同一轮收尾的 assistant/message 会把完整正文补上。
          const result = await push(event, { ...frame, payload: { ...p, event } });
          if (result === 'shed') continue;
          if (result === 'closed') { clientGone = true; break; }
          if (seq !== null) lastDeliveredSeq = seq;
        } else if (p.type === 'session/queue' || p.type === 'session/projection') {
          // 队列/投影整帧转发；不假定存在可重放的宿主 API。
          const result = await push(p, frame);
          if (result === 'shed') continue;
          if (result === 'closed') { clientGone = true; break; }
        } else if (p.type === 'session/jobs') {
          // 后台任务整帧（桌面端会话头部任务面板的数据源）。宿主只在任务有变化时发，
          // 且**空数组也要转发** —— 那是「任务都结束了」的唯一信号，丢掉它就永远清不掉。
          const value = { type: 'session/jobs', sessionId, jobs: normalizeJobs(p.jobs) };
          if (await push(value, frame) === 'closed') { clientGone = true; break; }
        } else if (p.type === 'question/requested') {
          // 问题是可回答的 mux server-request，而非 session/event；保留 rpcId 供回答关联。
          const value = { ...p, rpcId: frame.rpcId };
          if (await push(value, { ...frame, payload: value }) === 'closed') { clientGone = true; break; }
        } else if (p.type === 'question/resolved' || p.type === 'approval/requested' || p.type === 'approval/asked' || p.type === 'approval/decided' || p.type === 'approval/resolved') {
          // Approval frames are server requests/resolutions, not session/event frames;
          // forward the rpcId and approval identity so the mobile client can answer safely.
          const value = ANSWERABLE_APPROVAL_TYPES.has(p.type) && frame.rpcId ? { ...p, rpcId: frame.rpcId } : p;
          if (await push(value, { ...frame, payload: value }) === 'closed') { clientGone = true; break; }
        }
      }
      if (!clientGone) loopEnded = true;
    }
  } catch (error) {
    // 旧实现是 `catch { }`：mux 循环一旦抛错（底层 /api/events.mux 的 HTTP SSE 连接
    // 中断、返回非异步可迭代、signal abort），连接就永远停在 preamble 之后 ——
    // 客户端无限期静默挂起，relay 侧条目也一直挂着，两边都查不出原因。
    logStream(sessionId, 'mux loop threw', error);
  }
  clearInterval(keepAlive);
  detachApprovals();
  detachQuestions();
  try {
    if (!res.writableEnded) {
      // 明确告诉客户端「流到此为止，请带 lastSeq 重连」：它会走已验证可用的 replay
      // 路径补上缺口，而不是把静默断流当成正常状态。
      if (!ac.signal.aborted && !clientGone) {
        writeSse(res, { type: 'session/resync-required', sessionId, oldestSeq: lastDeliveredSeq + 1 });
      }
      res.end();
      logStream(sessionId, `stream closed (loopEnded=${loopEnded}, aborted=${ac.signal.aborted}, clientGone=${clientGone}, deliveredSeq=${lastDeliveredSeq})`, null);
    }
  } catch (error) {
    // 旧实现把 end 失败也吞了 —— 这正是「relay 永远收不到 httpEnd」的直接原因。
    logStream(sessionId, 'stream end failed', error);
  }
}

/**
 * 从会话 history 回放 seq > sinceSeq 的事件（升序），逐个经附件解析后写 SSE。
 * 通过 onDelivered(seq) 回报已交付的最大 seq，供上层去重。
 */
async function replaySince(ctx, sessionId, sinceSeq, res, signal, onDelivered) {
  try {
    const { value } = unwrap(await callSessions(ctx, 'history', { sessionId, maxMessages: REPLAY_WINDOW }));
    const events = (value && Array.isArray(value.events)) ? value.events : [];
    const seqs = events
      .map((entry) => (entry?.event || entry)?.seq)
      .filter((seq) => Number.isSafeInteger(seq) && seq >= 0);
    const oldestSeq = seqs.length ? Math.min(...seqs) : null;
    // hasMore means the retained history starts before this page. If its first
    // sequence is more than one past the cursor, replay cannot be contiguous.
    const gap = Boolean(value && value.hasMore === true && (oldestSeq === null || oldestSeq - sinceSeq > 1));
    const candidates = events
      .filter((entry) => {
        const e = entry?.event || entry;
        return e && Number.isFinite(e.seq) && e.seq > sinceSeq;
      })
      .sort((a, b) => ((a?.event || a).seq) - ((b?.event || b).seq));
    for (const entry of candidates) {
      if (signal.aborted) break;
      const e = entry?.event || entry;
      const event = await resolveEventAttachments(ctx, sessionId, e, { referencesOnly: true });
      // Keep replay data identical to live SSE data: the client reducer consumes
      // the event's own type (turn/start, assistant/message, etc.).
      const payload = { type: 'session/event', sessionId, event };
      const sent = writeSse(res, event, { payload });
      if (!sent.ok) break;
      // 回放是「一次性灌几千条」，最容易把写队列撑爆：写不动就在这里等，别一口气塞完。
      if (sent.needDrain && !(await waitForDrain(res, signal))) break;
      if (Number.isFinite(event.seq)) onDelivered(event.seq);
    }
    return { gap, oldestSeq };
  } catch (error) { /* 回放尽力而为；失败不阻塞实时流 */
    logStream(sessionId, 'replay failed', error);
    return { gap: false, oldestSeq: null };
  }
}

module.exports = { handleStream, parseResumeSeq };

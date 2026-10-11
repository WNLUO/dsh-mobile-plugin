'use strict';

/**
 * dsh-mobile 流式：SSE 转发目标会话的增量事件。
 *
 * 订阅宿主事件流，仅转发目标会话的 session/event 帧（增量事件），
 * 每 15s 发一行注释保持连接；客户端断开即取消订阅。
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

const crypto = require('crypto');

const { sendJson } = require('../shared/http-util');
const { resolveEventAttachments } = require('./sessions.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { normalizeJobs } = require('./jobs.js');

const SSE_RETRY_MS = 3000;
// Android React Native's XHR may buffer tiny chunked responses until its
// internal progress threshold. Pad each SSE record so onprogress exposes it
// promptly; the padding is an SSE comment and is ignored by clients.
const SSE_FLUSH_PADDING_BYTES = 2048;
const REPLAY_WINDOW = 3000; // 断线补偿回放的最大事件数

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

function stableEventId(payload, frame) {
  const source = payload && payload.type === 'session/event' ? payload : frame?.payload;
  if (source && typeof source === 'object') {
    if (source.type === 'session/event' && source.sessionId && source.event && Number.isFinite(source.event.seq)) {
      return `${source.sessionId}:${source.event.seq}`;
    }
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['eventId', 'rpcId', 'id', 'approvalId']) {
      if (typeof payload[key] === 'string' && payload[key]) return payload[key];
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'session';
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
    return `${sessionId}:${payload.type || 'event'}:${digest}`;
  }
  return frame && typeof frame.rpcId === 'string' && frame.rpcId ? frame.rpcId : undefined;
}

function writeSse(res, payload, frame) {
  const id = stableEventId(payload, frame);
  const fields = [`retry: ${SSE_RETRY_MS}`];
  if (id) fields.push(`id: ${id}`);
  fields.push(`data: ${JSON.stringify(payload)}`);
  fields.push(`: ${' '.repeat(SSE_FLUSH_PADDING_BYTES)}`, '', '');
  try { res.write(`${fields.join('\n')}\n`); return true; } catch { return false; }
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
    }
  }, 15_000);
  // 定时器不该拖住进程退出：宿主/worker 关停时若这条 SSE 还挂着，事件循环会被它按在
  // 15s 一拍上，收尾要等到下一次 tick 才发生（lib/sidecar-facade-worker.cjs 的
  // shutdown 就是这么做的）。测试里的 setInterval 桩没有 unref，所以先判类型。
  if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref();

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
        if (!writeSse(res, value, { payload: value })) clientGone = true;
      }
    }

    if (!clientGone) {
      // payload 里带 sessionId：0.2.0 的宿主没有设备级事件流了，兼容桥据此收窄成
      // 这一条会话的 follow + 投影 + 任务三条流（见 mobile/host-bridge.js 的 muxFrames）。
      // 不带就是设备级视角，只会给工作区基线与全局投影 —— 这里反正只要单会话。
      const frames = ctx.apiProxy.events.mux({ rpcId: 'mobile-stream', payload: { sessionId } }, ac.signal);
      for await (const frame of frames) {
        const p = frame.payload;
        if (!p || p.sessionId !== sessionId) continue;
        // 增量事件保持原 wire：data 仍是原事件 JSON，SSE 元数据独立于 data。
        if (p.type === 'session/event') {
          const seq = p.event && Number.isFinite(p.event.seq) ? p.event.seq : null;
          // 回放已覆盖该 seq（回放与实时交界处）→ 跳过，避免重复交付。
          if (seq !== null && seq <= lastDeliveredSeq) continue;
          const event = await resolveEventAttachments(ctx, sessionId, p.event);
          if (!writeSse(res, event, { ...frame, payload: { ...p, event } })) { clientGone = true; break; }
          if (seq !== null) lastDeliveredSeq = seq;
        } else if (p.type === 'session/queue' || p.type === 'session/projection') {
          // 队列/投影整帧转发；不假定存在可重放的宿主 API。
          if (!writeSse(res, p, frame)) { clientGone = true; break; }
        } else if (p.type === 'session/jobs') {
          // 后台任务整帧（桌面端会话头部任务面板的数据源）。宿主只在任务有变化时发，
          // 且**空数组也要转发** —— 那是「任务都结束了」的唯一信号，丢掉它就永远清不掉。
          const value = { type: 'session/jobs', sessionId, jobs: normalizeJobs(p.jobs) };
          if (!writeSse(res, value, frame)) { clientGone = true; break; }
        } else if (p.type === 'question/requested') {
          // 问题是可回答的 mux server-request，而非 session/event；保留 rpcId 供回答关联。
          const value = { ...p, rpcId: frame.rpcId };
          if (!writeSse(res, value, { ...frame, payload: value })) { clientGone = true; break; }
        } else if (p.type === 'question/resolved' || p.type === 'approval/requested' || p.type === 'approval/asked' || p.type === 'approval/decided' || p.type === 'approval/resolved') {
          // Approval frames are server requests/resolutions, not session/event frames;
          // forward the rpcId and approval identity so the mobile client can answer safely.
          const value = ANSWERABLE_APPROVAL_TYPES.has(p.type) && frame.rpcId ? { ...p, rpcId: frame.rpcId } : p;
          if (!writeSse(res, value, { ...frame, payload: value })) { clientGone = true; break; }
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
      const event = await resolveEventAttachments(ctx, sessionId, e);
      // Keep replay data identical to live SSE data: the client reducer consumes
      // the event's own type (turn/start, assistant/message, etc.).
      const payload = { type: 'session/event', sessionId, event };
      if (!writeSse(res, event, { payload })) break;
      if (Number.isFinite(event.seq)) onDelivered(event.seq);
    }
    return { gap, oldestSeq };
  } catch (error) { /* 回放尽力而为；失败不阻塞实时流 */
    logStream(sessionId, 'replay failed', error);
    return { gap: false, oldestSeq: null };
  }
}

module.exports = { handleStream, parseResumeSeq };

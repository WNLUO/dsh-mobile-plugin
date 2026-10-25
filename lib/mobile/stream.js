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
 *
 * 出流量的三个口子（2026-10-25，都在这一层收）：
 *  - 草稿增量按 200ms 合并成一帧（`DRAFT_FLUSH_MS`）：一帧固定成本两三百字节，而一个
 *    token 只有十几字节，逐帧发等于按帧收费；
 *  - 草稿的填充窗口 250ms（`DRAFT_PAD_INTERVAL_MS`）：填充是按时间补的，120ms 就是
 *    16KB/s 的底线，与正文多少无关；
 *  - 推理只推每一步的开头 600 字、工具结果只推前 2000 字：运行中用户不读它们，完整内容
 *    仍在 `assistant/message` 与 `/session/messages` 里，一个字都不丢。
 */

const { sendJson } = require('../shared/http-util');
const e2ee = require('../shared/e2ee');
const { headerOf, wrapper, signedPath } = require('../shared/e2ee-request');
const { ACCEPT_ENC_HEADER, compressPlain } = require('../shared/e2ee-plain');
const {
  writeSse: sharedWriteSse,
  waitForDrain,
  ssePadding,
  shedWithoutSeq,
} = require('../shared/sse-write.js');
const { resolveEventAttachments } = require('./sessions.js');
const { createTextImageBudget } = require('./local-images.js');
const { callSessions } = require('./rpc.js');
const { unwrap } = require('./envelope.js');
const { normalizeJobs } = require('./jobs.js');
const approvals = require('./approvals.js');
const questions = require('./questions.js');
const streamRegistry = require('./stream-registry.js');
const { credentialsEntry } = require('../shared/credentials-entry.js');
const { viaChannel } = require('../shared/via-header');

// Android React Native's XHR may buffer tiny chunked responses until its
// internal progress threshold. Keep each window of records padded past that
// threshold so onprogress exposes them promptly; the padding is an SSE comment
// and is ignored by clients.
const SSE_FLUSH_PADDING_BYTES = 2048;
/**
 * 草稿增量的补齐窗口。
 *
 * **只对 `assistant/chunk` 生效**：一次流式回复每秒有几十条增量，每条都补 2048 字节
 * 等于把正文放大十几倍，而这些字节两条腿（宿主→中转、中转→手机）都是实打实要走的。
 * 按 120ms 一个窗口补齐，界面出字节奏不变（客户端本来就攒够一个阈值才渲染一次）。
 * 带 seq 的事件、审批卡、排队/任务帧、心跳照旧补满整份 —— 它们慢一拍就是「消息不落地」
 * 「卡不出现」。实现见 lib/shared/sse-write.js 的 takePadding。
 */
const SSE_PAD_MIN_INTERVAL_MS = 120;
const REPLAY_WINDOW = 3000; // 断线补偿回放的最大事件数

/**
 * 一次断线重放最多灌多少字节。
 *
 * `REPLAY_WINDOW` 按事件条数限量，挡不住「几百条事件、每个都带大附件」的会话：实测有
 * 一条会话单次重放 36MB，同一个游标被反复重放一天烧掉 450MB。到了这条线就不补了，
 * 改成让客户端去按页拉权威历史 —— 那条路一页两百条、实测几十 KB，便宜一个数量级。
 */
const REPLAY_MAX_BYTES = 512 * 1024;

/**
 * 缺口超过这个跨度就干脆不回放。
 *
 * 客户端落后得这么远时，把窗口整个灌过去再让它去拉历史，等于同一段内容走了两遍
 * （App 收到 resync 帧本来就会做一次全量 authoritative 拉取）。这个值远小于
 * `REPLAY_WINDOW`：只补「刚刚断线这几下」的缺口，剩下的交给分页历史。
 */
const REPLAY_MAX_GAP = 200;

/**
 * 草稿增量的合并窗口。
 *
 * 这条流的流量有一多半是「每来一个 token 写一帧」的固定成本：一帧正文三十来个字节，线上
 * 的 SSE 头 + 稳定 id + 加密信封要两三百字节。同一步里同一块的增量可以合并 —— 客户端就是
 * 按块序号累积、文本按拼接处理，所以攒一小段时间再发一次，内容一个字不少。
 *
 * 200ms 是一次渲染周期的一点几倍：再久，正文出字就会一跳一跳；攒到 DRAFT_FLUSH_BYTES
 * 提前发，避免一次写出去几千字节被 RN 的 XHR 一口吞下。
 */
const DRAFT_FLUSH_MS = 200;
const DRAFT_FLUSH_BYTES = 1024;
/** 可合并的增量类型：文本与工具参数都是「按块序号累积」的拼接语义。 */
const MERGEABLE_CHUNK_TYPES = new Set(['text-delta', 'tool-call-delta']);

/**
 * 草稿填充的窗口（覆盖 `SSE_PAD_MIN_INTERVAL_MS`，只给草稿用）。
 *
 * 填充的唯一理由是让安卓 RN 的 XHR 越过进度阈值尽快吐字节；它按窗口补，所以流量等于
 * 「2048 / 窗口」—— 120ms 就是 16KB/s 的底线，与正文多少无关。合并成 200ms 一帧之后，
 * 窗口放到 250ms：每帧本身就带一两百字节正文，补到 2048 仍是 4 拍/秒的出字节奏，
 * 底线降到 8KB/s。
 */
const DRAFT_PAD_INTERVAL_MS = 250;

/**
 * 推理（思考）增量在实时流里只推开头这么多字，之后改推轻量进度帧。
 *
 * 运行中那段思考正文用户基本不读（它自己滚、而且长得飞快），却按 token 一帧地发，是
 * 这条流里帧数最多的一类。完整思考仍然在每一步落定的 `assistant/message` 里跟着来，
 * 也仍然在 `/session/messages` 的历史里 —— 这里省的只是「逐字推」那一段。
 */
const REASONING_LIVE_CHARS = 600;

/**
 * 工具结果在实时流里最多带这么长的可见输出。
 *
 * 工具输出（读文件、跑命令、构建日志）是这条流里单帧最大的一类，几十到几百 KB 很常见，
 * 而运行中那几秒用户看的是工具卡的状态与一两行摘要；要看全文时走历史那一条
 * （`/session/messages` 的块与补丁），那里给的是全文。
 */
const TOOL_RESULT_LIVE_CHARS = 2000;

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
 * 这一帧是不是「流式回复里的草稿增量」——唯一可以按窗口补齐的那一类。
 *
 * 判据与丢帧口径同源：没有 seq 的 `assistant/chunk` 是草稿，同一轮收尾的
 * `assistant/message` 带完整正文、重连回放也能补齐；所以把它按窗口补齐最坏只是慢一拍，
 * 而其它帧慢一拍就可能表现为「消息不落地」「审批卡不出现」。
 */
function isStreamDraft(payload) {
  if (!payload) return false;
  // 实时帧写的是内层事件（`{type:'assistant/chunk', data}`），回放路径偶尔仍带一层
  // `session/event` 外壳，两种形状都认。
  const type = payload.type === 'session/event' && payload.event ? payload.event.type : payload.type;
  return type === 'assistant/chunk';
}

/**
 * 写一条 SSE 记录（策略声明，实现见 `lib/shared/sse-write.js`）。
 *
 * 这条流的策略：软水位只丢**没有 seq** 的增量（`assistant/chunk` 是可丢弃草稿，同一轮
 * 收尾的 `assistant/message` 带完整正文且有 seq，重连回放能补齐）；草稿增量按 120ms
 * 一个窗口补到 2048 字节以上，**成批灌入的回放**同样按窗口补齐，其余帧补满整份，
 * 让 RN 的 XHR 尽快吐出来（见 `SSE_PAD_MIN_INTERVAL_MS`）。
 *
 * `options.burst` = 成批灌入（断线回放）。回放是几百到几千条连着写出去的：客户端本来
 * 就在持续收字节、进度事件照常触发，而逐条补满分摊到一次重连就是几 MB 白字节（实测一次
 * 903 帧的回放共 2.06MB，其中约 1.85MB 是注释）。窗口机制照样保证「每 120ms 至少一窗
 * 2048 字节」，而且这条流的**第一条**记录总是落在空窗口上、拿到整份填充，所以「重连后
 * 界面立刻出内容」不受影响。实时流里那条「带 seq 的帧补满整份」的理由（它可能夹在一串
 * 慢草稿后面单独到达，慢一拍就是「消息不落地」）在成批灌入里不成立，别把它抄到回放上。
 *
 * @param {{burst?: boolean}} [options] 成批灌入（回放）标记，见上。
 * @returns {{ok: boolean, shed?: boolean, needDrain?: boolean}}
 *   `ok:false` → 这条流该收尾（客户端走了，或积压超过硬水位）；
 *   `shed:true` → 这条**增量**帧被丢掉、连接还活着；
 *   `needDrain:true` → 写成功了，但底下已经写不动，调用方要先 await 一次 drain 再继续。
 */
function writeSse(res, payload, frame, options = {}) {
  // 两条路走窗口补齐：可丢弃的草稿增量，与成批灌入的回放（见上面 options.burst）。
  // 其余帧一律补满整份 —— 带 seq 的事件、审批卡、排队/任务帧、心跳是一次回复里真正
  // 要落地的东西，宁可多花 2KB 也不让它们卡在客户端的缓冲里等下一次写入。
  return sharedWriteSse(res, payload, {
    frame,
    ...(options.burst === true
      ? { paddingBytes: SSE_FLUSH_PADDING_BYTES, padEveryMs: SSE_PAD_MIN_INTERVAL_MS }
      : isStreamDraft(payload)
        // 草稿已经按 200ms 合并过，窗口放到 250ms：出字仍是 4 拍/秒，底线从 16KB/s 降到 8KB/s。
        ? { paddingBytes: SSE_FLUSH_PADDING_BYTES, padEveryMs: DRAFT_PAD_INTERVAL_MS }
        : { padding: ssePadding(SSE_FLUSH_PADDING_BYTES) }),
    // 审批帧没有 seq，按默认口径会在软水位上被丢掉（见上面那条策略）。但它是「人工决策
    // 的入口」不是草稿：丢一张，手机就再也看不到那张卡（软水位只在客户端跟不上时到，
    // 回放也不覆盖这一段）。它一次审批也就一两帧，不是撑爆写队列的那类帧。
    // 心跳同理必须保住：丢了它，App 会把一条健康的流判成死链（见 isLivenessHeartbeat）。
    shedWhenBuffered: (value) => !isApprovalPayload(value) && !isLivenessHeartbeat(value) && shedWithoutSeq(value),
    // 协议 v2：每帧一条独立密文（§8.3(5)）。封装器由开流那一处给 —— 它才知道这条流的
    // 请求 ts / nonce 与帧序号（AAD 要绑这三样）。
    sealFrame: typeof options.sealFrame === 'function' ? options.sealFrame : null,
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
/**
 * 造这条流的帧封装器（§8.3(5)）。
 *
 * AAD 绑「路径 + 请求的 ts/nonce + 帧序号」：前三个把这一帧钉死在这条流上（别的流、
 * 上一次连接都塞不进来），帧序号再挡住「把上一段流的帧插到这一段里」，顺带让客户端能发现丢帧。
 *
 * 帧序号从 1 起、宿主自己数、不进明文。
 *
 * 逐帧也先压再封（`x-dsh-accept-enc` 带 `g` 时）：一轮流式回复里带完整正文的
 * `assistant/message` 常常几十 KB，草稿增量里的中文也压得很动，而每帧压一次的开销
 * 远小于它省下的字节。小于阈值（1KB）的帧不压，信封形状与原来逐字节一致。
 *
 * @returns {null | ((payload: unknown) => { v: number, z?: string, n: string, c: string })}
 */
function createFrameSealer(req) {
  const opened = req && req.__dshE2ee;
  if (!opened || !opened.keys || !opened.req) return null;
  const { keys, req: request } = opened;
  const path = signedPath(req);
  const acceptEnc = headerOf(req, ACCEPT_ENC_HEADER);
  let seq = 0;
  return (payload) => {
    seq += 1;
    const { payload: plain, z } = compressPlain(Buffer.from(JSON.stringify(payload), 'utf8'), acceptEnc);
    const sealed = e2ee.seal(keys.down, plain, e2ee.sseAad(path, request.ts, request.nonce, seq));
    return wrapper(sealed, z);
  };
}

/** 工具结果被截断时留在正文末尾的说明（客户端原样显示，不参与解析）。 */
const TOOL_RESULT_LIVE_ELIDED = '\n…（运行中只推前一段，展开时取全文）';

/** 草稿增量的合并键：同一步、同一块、同一类型才可并。 */
function chunkKeyOf(event) {
  const data = event && event.data;
  const chunk = data && data.chunk;
  if (!chunk || typeof chunk.index !== 'number') return null;
  return `${data.turn}:${data.step}:${chunk.index}:${chunk.type}`;
}

/**
 * 把后到的增量并进已经攒着的那一帧。
 *
 * 只并「客户端按块序号累积」的两类：文本（拼接 `text`）与工具参数（拼接 `argumentsDelta`）。
 * 其余类型（block-start/end、推理、协议 v2 的其它通知）一律不并 —— 它们带着语义边界，
 * 合并等于把边界抹掉。
 */
function mergeDraft(into, from) {
  const a = into && into.data && into.data.chunk;
  const b = from && from.data && from.data.chunk;
  if (!a || !b || a.type !== b.type) return null;
  if (a.type === 'text-delta') {
    if (typeof a.text !== 'string' || typeof b.text !== 'string') return null;
    return { ...into, time: from.time, data: { ...into.data, chunk: { ...a, text: a.text + b.text } } };
  }
  if (a.type === 'tool-call-delta') {
    const chunk = { ...a };
    if (typeof b.argumentsDelta === 'string' && b.argumentsDelta) {
      chunk.argumentsDelta = (typeof a.argumentsDelta === 'string' ? a.argumentsDelta : '') + b.argumentsDelta;
    }
    return { ...into, time: from.time, data: { ...into.data, chunk } };
  }
  return null;
}

/**
 * 草稿缓冲区：把 200ms 内的同类增量并成一帧再写出去。
 *
 * 两条必须守住的语义：
 *  - **顺序**：任何非草稿帧写之前都要 `flushAll()`，否则「攒着的正文」会跑到收尾的
 *    `assistant/message` 后面，界面先把整段画好、又把草稿补一遍；
 *  - **不丢**：收尾（正常结束 / 客户端断开 / 硬水位）都要先把攒着的写完，再 res.end。
 *    合并出来的帧仍然是「可丢的草稿」（没有 seq），软水位照旧能 shed 它。
 */
function createDraftBuffer({ push }) {
  const pending = [];
  const byKey = new Map();
  let timer = null;
  let running = null;
  let closed = false;

  const bufferedBytes = () => pending.reduce((sum, item) => sum + item.bytes, 0);
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const drain = async () => {
    stopTimer();
    while (pending.length && !closed) {
      const item = pending.shift();
      if (item.key !== null) byKey.delete(item.key);
      if (await push(item.event, item.frame) === 'closed') {
        closed = true;
        pending.length = 0;
        byKey.clear();
      }
    }
  };

  const schedule = () => {
    if (timer || running || !pending.length || closed) return;
    timer = setTimeout(() => { timer = null; void flush(); }, DRAFT_FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };

  function flush() {
    if (running) return running;
    running = drain().finally(() => {
      running = null;
      if (pending.length && !closed) schedule();
    });
    return running;
  }

  /** 把攒着的全部写完（写的过程中新攒进来的也写掉），供「非草稿帧要出去」时调用。 */
  const flushAll = async () => {
    while (!closed && (pending.length || running)) await flush();
  };

  const accept = (event, frame) => {
    const key = chunkKeyOf(event);
    const existing = key === null ? null : byKey.get(key);
    if (existing) {
      const merged = mergeDraft(existing.event, event);
      if (merged) {
        existing.event = merged;
        existing.frame = frame;
        existing.bytes = Buffer.byteLength(JSON.stringify(merged), 'utf8');
        return Promise.resolve();
      }
    }
    const item = { key, event, frame, bytes: Buffer.byteLength(JSON.stringify(event), 'utf8') };
    pending.push(item);
    if (key !== null) byKey.set(key, item);
    if (bufferedBytes() >= DRAFT_FLUSH_BYTES) return flush();
    schedule();
    return Promise.resolve();
  };

  return { accept, flush, flushAll, isClosed: () => closed };
}

/**
 * 推理增量的实时截断（见 `REASONING_LIVE_CHARS`）。
 *
 * 每一步只推开头那一段，之后整段丢掉 —— 不新增帧类型，也就不动 App：组头那句「正在思考」
 * 本身一直在闪，用户看到的就是「它还在想」；完整正文在 `assistant/message` 与历史里，
 * 一个字都不丢。返回 `null` 表示这一帧不写。
 */
function createReasoningGate() {
  const state = { step: null, sent: 0 };
  return (event) => {
    const data = event && event.data;
    const chunk = data && data.chunk;
    if (!chunk || typeof chunk.index !== 'number' || typeof data.turn !== 'number') return event;
    const step = `${data.turn}:${data.step}`;
    if (step !== state.step) {
      state.step = step;
      state.sent = 0;
    }
    const remaining = REASONING_LIVE_CHARS - state.sent;
    if (remaining <= 0) return null;
    if (chunk.text.length <= remaining) {
      state.sent += chunk.text.length;
      return event;
    }
    const text = chunk.text.slice(0, remaining);
    state.sent += text.length;
    return { ...event, data: { ...data, chunk: { ...chunk, text } } };
  };
}

/** 实时流里把工具结果的可见输出截到 `TOOL_RESULT_LIVE_CHARS`（两种内容形状都认）。 */
function trimTextParts(parts, state) {
  let changed = false;
  const next = parts.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (Array.isArray(part.content)) {
      const nested = trimTextParts(part.content, state);
      if (nested === part.content) return part;
      changed = true;
      return { ...part, content: nested };
    }
    if (typeof part.text !== 'string' || !part.text) return part;
    if (state.budget <= 0) {
      changed = true;
      return { ...part, text: TOOL_RESULT_LIVE_ELIDED.trimStart() };
    }
    if (part.text.length <= state.budget) {
      state.budget -= part.text.length;
      return part;
    }
    const text = `${part.text.slice(0, state.budget)}${TOOL_RESULT_LIVE_ELIDED}`;
    state.budget = 0;
    changed = true;
    return { ...part, text };
  });
  return changed ? next : parts;
}

function truncateToolResultOutput(event) {
  const data = event && event.data;
  const message = data && data.message;
  if (!message || !Array.isArray(message.content)) return event;
  const content = trimTextParts(message.content, { budget: TOOL_RESULT_LIVE_CHARS });
  if (content === message.content) return event;
  return { ...event, data: { ...data, message: { ...message, content } } };
}

async function handleStream(ctx, req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } });
  // 子会话地址：App 打开子会话的流时带上父会话与模式（见 app/src/sse.ts 的
  // openSessionStream 传参）。缺这两个字段就是普通会话，与历史那条同一套判定。
  const parentSessionId = url.searchParams.get('parentSessionId');
  const mode = url.searchParams.get('mode');
  const streamAddress = typeof parentSessionId === 'string' && parentSessionId
    ? { sessionId, parentSessionId, ...(mode === 'one-shot' || mode === 'continuable' ? { mode } : {}) }
    : { sessionId };
  // 协议 v2：这条流要逐帧封装。`req.__dshE2ee` 由 `createGuarded` 在解封请求时挂上。
  // **要在 writeHead 之前算**：`X-Dsh-Proto: 2` 只能在头发出去之前声明，写过头再
  // `setHeader` 是无效的（Node 会静默忽略），客户端就永远不知道帧是信封。
  const sealFrame = createFrameSealer(req);
  const head = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'content-encoding': 'identity',
    ...(sealFrame ? { 'x-dsh-proto': '2' } : {}),
  };
  try {
    res.writeHead(200, head);
  } catch (error) { logStream(sessionId, 'writeHead failed', error); return; }
  res.write(': connected\n\n');
  const ac = new AbortController();
  // 按设备登记这条流：吊销时宿主主动断它（§3.3）。没有这一步，被踢的手机还能继续
  // 收消息，直到它自己重连 —— 「单台吊销」就只生效了一半。
  const untrack = streamRegistry.track(req.__dshRecord && req.__dshRecord.deviceId, res);
  res.on('close', () => { untrack(); ac.abort(); });
  // 与设备级流（mobile/events.js）对齐：写坏掉的连接不该让 'error' 在 res 上无人接住
  // 而变成未捕获异常，那时 aborted 仍是 false，收尾分支会以为客户端还在、白写一帧 resync。
  res.on('error', () => ac.abort());

  const keepAlive = setInterval(() => {
    // 开着流但没轮询的会话也要算「在线」（§3.4）：只靠请求命中来记「最近连接」的话，
    // 一条长对话流开着、列表不轮询，面板上那台设备会被误判成离线。
    if (req.__dshRecord) {
      try { credentialsEntry().touch(req.__dshRecord, { channel: viaChannel(req) }); } catch { /* 记账失败不影响流 */ }
    }
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
    if (!writeSse(res, { type: 'session/heartbeat', sessionId, at: Date.now() }, null, { sealFrame }).ok) {
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
    writeSse(res, frame, { payload: frame }, { sealFrame });
  });
  // 提问卡同理（见 mobile/questions.js）：`user-questions/request` 钩子与 mux 帧流无关。
  const detachQuestions = questions.attachSession(sessionId, (frame) => {
    writeSse(res, frame, { payload: frame }, { sealFrame });
  });

  const resumeSeq = parseResumeSeq(req, sessionId);
  // 已交付的 seq 水位：从续传位置开始，重连时先回放、后接入实时流，并用它去重。
  let lastDeliveredSeq = resumeSeq != null ? resumeSeq : 0;
  // 「客户端已经走了」与「mux 循环正常结束」必须分开：前者不必再回写 resync，
  // 后者必须回写，否则客户端会把一次静默断流当成正常状态一直等下去。
  let clientGone = false;
  let loopEnded = false;
  // 本机路径图片的内联预算：**一条流共用一份**，与历史那一页共用一份同口径。
  // 此前实时帧是每帧一预算，一条消息里几张截图就能把几百 KB 到几 MB 的 base64 推过去。
  const imageBudget = createTextImageBudget();

  try {
    // **先开实时流、再回放**：之前是先 replay 再 mux，两步之间的 follow 还没订阅，
    // 这段时间发生的事件既不在 replay 快照里、也不在实时流里，只能等下一次重连补。
    // 现在先让 mux 把 follow 订阅建立起来（第一帧在 `firstFrame` 里等着，尚未消费），
    // 再回放 history；回放与 follow 的重叠由 `seq <= lastDeliveredSeq` 去重。
    // 注意：payload 里带 sessionId（0.2.0 兼容桥据此收窄成单会话 follow + 投影 + 任务）。
    const frames = ctx.apiProxy.events.mux({ rpcId: 'mobile-stream', payload: streamAddress }, ac.signal);
    const frameIterator = frames[Symbol.asyncIterator]();
    // 立刻踢一脚让上游订阅开始；回放期间不消费，事件由 follow 连续读入并在这里排队。
    let firstFrame = frameIterator.next();
    firstFrame.catch(() => { /* 错误在下面统一收口，这里只避免回放期间未处理的 rejection */ });

    // 断线续传：回放 history 中 seq > resumeSeq 的事件（收敛状态）。
    if (resumeSeq != null && resumeSeq > 0) {
      const replay = await replaySince(ctx, sessionId, resumeSeq, res, ac.signal, (seq) => { lastDeliveredSeq = Math.max(lastDeliveredSeq, seq); }, streamAddress, sealFrame, imageBudget);
      if (replay.gap && !ac.signal.aborted) {
        const value = { type: 'session/resync-required', sessionId, resumeSeq, oldestSeq: replay.oldestSeq };
        // 旧实现在这里直接 `return`：既不清 keepAlive 也不 end，漏出一条永不收尾的连接。
        if (!writeSse(res, value, { payload: value }, { sealFrame }).ok) clientGone = true;
      }
    }

    if (!clientGone) {
      // 写一帧并把三种结果统一收口：丢增量、需要等 drain、该收尾。
      // 「需要等 drain」这一步是这次 OOM 的正解 —— 写不动就停手，等底层消化完再继续，
      // 而不是把帧继续往内存里塞。
      const push = async (payload, frameArg) => {
        const sent = writeSse(res, payload, frameArg, { sealFrame });
        if (sent.shed) return 'shed';
        if (!sent.ok) return 'closed';
        if (sent.needDrain) {
          const drained = await waitForDrain(res, ac.signal);
          if (!drained) { logStream(sessionId, 'drain timeout', null); return 'closed'; }
        }
        return 'sent';
      };
      // 草稿合并 + 推理限流 + 整条流共用一份内联图片预算（见上面三组常量与
      // `createDraftBuffer` / `createReasoningGate` 的注释）。
      const drafts = createDraftBuffer({ push });
      const reasoningGate = createReasoningGate();
      /**
       * 非草稿帧写之前先把攒着的草稿写出去：草稿是按发生顺序攒的，晚写一步就会变成
       * 「收尾的 assistant/message 先到、被并过的正文后到」，界面上同一段话画两遍。
       */
      const pushOrdered = async (payload, frameArg) => { await drafts.flushAll(); return push(payload, frameArg); };
      for (;;) {
        const step = firstFrame ? await firstFrame : await frameIterator.next();
        firstFrame = null;
        if (step.done) break;
        const frame = step.value;
        const p = frame.payload;
        if (!p || p.sessionId !== sessionId) continue;
        // 增量事件保持原 wire：data 仍是原事件 JSON，SSE 元数据独立于 data。
        if (p.type === 'session/event') {
          const seq = p.event && Number.isFinite(p.event.seq) ? p.event.seq : null;
          // 回放已覆盖该 seq（回放与实时交界处）→ 跳过，避免重复交付。
          if (seq !== null && seq <= lastDeliveredSeq) continue;
          // 引用模式：图片只下发 attachmentId，不取字节（见 attachments.js）。
          // 预算按**整条流**共享：本机路径的图片内联（local-images.js）此前是每帧一份，
          // 一条消息里几张截图就能把几百 KB 到几 MB 的 base64 推进去。
          let event = await resolveEventAttachments(ctx, sessionId, p.event, { referencesOnly: true, budget: imageBudget });
          if (event.type === 'tool/result') event = truncateToolResultOutput(event);
          const chunk = event.data && event.data.chunk;
          if (seq !== null || !chunk || typeof chunk.type !== 'string') {
            // 持久事件（或不是增量的会话事件）：先把攒着的草稿写掉，再按原样写这一帧。
            const result = await pushOrdered(event, { ...frame, payload: { ...p, event } });
            if (result === 'shed') continue;
            if (result === 'closed') { clientGone = true; break; }
            if (seq !== null) lastDeliveredSeq = seq;
          } else if (chunk.type === 'reasoning-delta') {
            const kept = reasoningGate(event);
            if (kept === null) continue;
            await drafts.accept(kept, { ...frame, payload: { ...p, event: kept } });
            if (drafts.isClosed()) { clientGone = true; break; }
          } else if (MERGEABLE_CHUNK_TYPES.has(chunk.type)) {
            // 被 shed 的只可能是没有 seq 的增量（见 writeSse 的软水位闸）；它不推进水位，
            // 同一轮收尾的 assistant/message 会把完整正文补上。
            await drafts.accept(event, { ...frame, payload: { ...p, event } });
            if (drafts.isClosed()) { clientGone = true; break; }
          } else {
            // 块边界这类带语义的增量不合并，直接写（但要排在攒着的草稿后面）。
            if (await pushOrdered(event, { ...frame, payload: { ...p, event } }) === 'closed') { clientGone = true; break; }
          }
        } else if (p.type === 'session/queue' || p.type === 'session/projection') {
          // 队列/投影整帧转发；不假定存在可重放的宿主 API。
          const result = await pushOrdered(p, frame);
          if (result === 'shed') continue;
          if (result === 'closed') { clientGone = true; break; }
        } else if (p.type === 'session/jobs') {
          // 后台任务整帧（桌面端会话头部任务面板的数据源）。宿主只在任务有变化时发，
          // 且**空数组也要转发** —— 那是「任务都结束了」的唯一信号，丢掉它就永远清不掉。
          const value = { type: 'session/jobs', sessionId, jobs: normalizeJobs(p.jobs) };
          if (await pushOrdered(value, frame) === 'closed') { clientGone = true; break; }
        } else if (p.type === 'question/requested') {
          // 问题是可回答的 mux server-request，而非 session/event；保留 rpcId 供回答关联。
          const value = { ...p, rpcId: frame.rpcId };
          if (await pushOrdered(value, { ...frame, payload: value }) === 'closed') { clientGone = true; break; }
        } else if (p.type === 'question/resolved' || p.type === 'approval/requested' || p.type === 'approval/asked' || p.type === 'approval/decided' || p.type === 'approval/resolved') {
          // Approval frames are server requests/resolutions, not session/event frames;
          // forward the rpcId and approval identity so the mobile client can answer safely.
          const value = ANSWERABLE_APPROVAL_TYPES.has(p.type) && frame.rpcId ? { ...p, rpcId: frame.rpcId } : p;
          if (await pushOrdered(value, { ...frame, payload: value }) === 'closed') { clientGone = true; break; }
        }
      }
      // 收尾也要把攒着的草稿写完：它们是正常结束前最后那一两百毫秒的正文。
      await drafts.flushAll();
      if (drafts.isClosed()) clientGone = true;
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
        writeSse(res, { type: 'session/resync-required', sessionId, oldestSeq: lastDeliveredSeq + 1, final: true }, null, { sealFrame });
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
async function replaySince(ctx, sessionId, sinceSeq, res, signal, onDelivered, address, sealFrame = null, imageBudget = null) {
  try {
    // 子会话的重放也要带父会话（同 historyAddress 的口径），否则宿主回 agent-busy，
    // 这条断线续传静默退化成「后面缺一段」。
    const { value } = unwrap(await callSessions(ctx, 'history', {
      sessionId,
      maxMessages: REPLAY_WINDOW,
      ...(address && address.parentSessionId ? { parentSessionId: address.parentSessionId, mode: address.mode || 'continuable' } : {}),
    }));
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
    // 落后太远就别在流里补了：这一段客户端本来就要靠权威历史重拉一遍，再从流里灌一遍
    // 是同一份内容走两趟。空回放 + 报缺口，让 App 走分页历史那条便宜的路。
    const farBehind = Boolean(candidates.length) && (candidates[candidates.length - 1].event || candidates[candidates.length - 1]).seq - sinceSeq > REPLAY_MAX_GAP;
    if (gap || farBehind) {
      logStream(sessionId, `replay skipped (gap=${gap} farBehind=${farBehind} cursor=${sinceSeq} newest=${(candidates[candidates.length - 1]?.event || candidates[candidates.length - 1])?.seq})`, null);
      return { gap: true, oldestSeq: oldestSeq ?? sinceSeq + 1 };
    }
    let written = 0;
    for (const entry of candidates) {
      if (signal.aborted) break;
      const e = entry?.event || entry;
      const event = await resolveEventAttachments(ctx, sessionId, e, { referencesOnly: true });
      // Keep replay data identical to live SSE data: the client reducer consumes
      // the event's own type (turn/start, assistant/message, etc.).
      const payload = { type: 'session/event', sessionId, event };
      // 成批灌入：这一节几百条连着写，逐条补满 2048 字节注释等于给一次重连凭空加几 MB
      // （见 writeSse 的 options.burst）。
      const sent = writeSse(res, event, { payload }, { burst: true, sealFrame });
      if (!sent.ok) break;
      written += (sent.bytes ?? 0);
      // 回放是「一次性灌几千条」，最容易把写队列撑爆：写不动就在这里等，别一口气塞完。
      if (sent.needDrain && !(await waitForDrain(res, signal))) break;
      if (Number.isFinite(event.seq)) onDelivered(event.seq);
      // 字节到顶也一样：剩下的交给分页历史，别再灌。
      if (written >= REPLAY_MAX_BYTES) {
        logStream(sessionId, `replay truncated at ${written}B (cursor=${sinceSeq})`, null);
        break;
      }
    }
    return { gap, oldestSeq };
  } catch (error) { /* 回放尽力而为；失败不阻塞实时流 */
    logStream(sessionId, 'replay failed', error);
    return { gap: false, oldestSeq: null };
  }
}

module.exports = { handleStream, parseResumeSeq, createFrameSealer };

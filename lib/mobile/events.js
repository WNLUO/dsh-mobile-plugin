/**
 * 设备级事件流（GET /api/mobile/v1/events/stream）：手机上侧栏那条 SSE。
 *
 * 它只被当成「有东西变了」的信号，绝不当作数据源（真正的数据还要 App 自己去拉列表），
 * 所以这里把每条宿主帧削到只剩能表示「列表需要重拉」的部分（见 listRelevantPayload）。
 * 但宿主在 DSH 0.2.0 兼容桥下只会订阅 workspace/follow + session/control，会话状态变化
 * 走的是 session/projection（被白名单丢掉），于是这条流连着却可能长时间一帧都不发；
 * 插件自己补了 device/list-changed（来自 lib/shared/list-signal.js，清单变了）、
 * device/session-activity（来自 lib/shared/session-signal.js，某个会话的正文水位涨了）、
 * device/desktop-view-changed（来自 lib/shared/desktop-view-signal.js，桌面侧栏折叠态
 * 变了）与 device/heartbeat（心跳）四类自产帧，App 侧靠它们判断「这条流还活着」
 * 「该重拉列表」「该给某个会话补正文」「该重取折叠态」并据此决定要不要把兜底轮询降频。
 *
 * 断流补偿：这条流不做 Last-Event-ID 续传（App 只把它当信号，不当数据源），所以**连上时**
 * 会立刻补发「当前状态」——一帧最近已知 revision 的 device/list-changed + 每个已跟踪会话
 * 各一帧 device/session-activity（见 replayKnownSignals）。补的是断流窗口，不是新变更：
 * 只读信号总线的快照，不 bump、不前移基准，App 侧对同 revision / 同水位幂等。
 */
'use strict';

const streamRegistry = require('./stream-registry.js');
const { createFrameSealer } = require('./stream.js');
const { listSignal: sharedListSignal } = require('../shared/list-signal.js');
const { sessionSignal: sharedSessionSignal } = require('../shared/session-signal.js');
const { desktopViewSignal: sharedDesktopViewSignal } = require('../shared/desktop-view-signal.js');
const { writeSse: sharedWriteSse, stableEventId: sharedEventId } = require('../shared/sse-write.js');

const DEDUP_WINDOW = 2048;
/** 心跳帧间隔。App 用它判定「这条流真的还活着」，必须与 app 侧的 SIGNAL_HEARTBEAT_MS 一致。 */
const HEARTBEAT_MS = 15_000;

/**
 * 诊断日志。这条流过去的失败路径是一个空 catch（里面只有一句「客户端断开或流已结束」
 * 的注释），于是「连着却一句话都不说」在宿主侧没有任何痕迹：手机把兜底轮询降成 60s，
 * 而宿主日志里查不到这条流是正常收尾、被客户端断开，还是循环抛错。会话级流
 * （mobile/stream.js）早就有 logStream，这里是它的设备级对偶——任何一条异常路径都必须
 * 留下可 grep 的行。
 */
function logDeviceStream(message, error) {
  const detail = error instanceof Error ? (error.stack || error.message) : (error == null ? '' : String(error));
  try {
    process.stderr.write(`[dsh-mobile-plugin] device/stream ${message}${detail ? `: ${detail}` : ''}\n`);
  } catch { /* ignore */ }
}

/**
 * 写一条 SSE 记录（策略声明，实现见 `lib/shared/sse-write.js`）。
 *
 * 这条流的策略：软水位**一律** shed —— 但 shed 不能当成功：设备流没有 Last-Event-ID
 * 续传，丢了帧又继续读，App 就会停在缺少那一次变更的状态。所以调用方看到 `shed` 必须
 * 立即 `abort` 断流，让客户端重连后走 `replayKnownSignals()` 全量补水位。
 * 这比把帧堆在写缓冲里好（2026-10-17 现场：466MB 的 SSE 帧挂在 socket 写队列上，宿主撞
 * 4GB 上限被杀）。不补填充：这里的帧少、单帧也小，不需要撑 RN 的缓冲阈值。
 *
 * 返回值与会话流一致：`ok:false` 该收尾，`shed:true` 这条被丢掉（调用方必须断流），
 * `needDrain:true` 写进去了但底下已经写不动。
 */
function writeSse(res, payload, frame, sealFrame) {
  return sharedWriteSse(res, payload, {
    frame,
    namespace: 'device',
    // 协议 v2 的会话上这条流也逐帧封装：`App` 判定「这条会话是加密的」之后，收到一帧
    // 明文就当畸形帧计数，连着十帧就把整条流判死、退回 15 秒轮询（2026-10-24 现场）。
    sealFrame: typeof sealFrame === 'function' ? sealFrame : null,
    shedWhenBuffered: () => true,
  });
}

async function* mergeHostAndMux(ctx, signal) {
  const sources = [];
  if (typeof ctx.apiProxy?.events?.mux === 'function') {
    sources.push(ctx.apiProxy.events.mux({ rpcId: 'mobile-device-stream', payload: {} }, signal)[Symbol.asyncIterator]());
  }
  if (typeof ctx.apiProxy?.events?.host === 'function') {
    sources.push(ctx.apiProxy.events.host({ rpcId: 'mobile-host-stream', payload: {} }, signal)[Symbol.asyncIterator]());
  }
  const pending = new Map(sources.map((source, index) => [index, source.next()]));
  while (pending.size > 0) {
    const result = await Promise.race([...pending.entries()].map(async ([index, promise]) => ({ index, step: await promise })));
    if (result.step.done) {
      pending.delete(result.index);
      continue;
    }
    pending.set(result.index, sources[result.index].next());
    yield result.step.value;
  }
}

/**
 * Trim a device-wide stream payload to the metadata the mobile session-list
 * actually consumes. `session/event` frames carry the FULL message content
 * (payload.event.data includes the whole assistant/user message); forwarding
 * them to every paired phone floods the relay and the client with megabytes
 * whenever a session is actively generating. The device-wide stream is only
 * used by the phone to refresh the session list (turn/start/end/title), so it
 * needs the event identity and inner type, not the content. Other frame types
 * (summary/queue/projection/question/approval/host) are small and kept intact.
 */
function lightPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'session/event') return payload;
  const ev = payload.event && typeof payload.event === 'object' ? payload.event : null;
  if (!ev) return payload;
  const innerType = ev.data && typeof ev.data === 'object' && typeof ev.data.type === 'string' ? ev.data.type : undefined;
  return {
    type: 'session/event',
    sessionId: payload.sessionId,
    event: {
      type: ev.type,
      seq: ev.seq,
      time: ev.time,
      ...(innerType ? { data: { type: innerType } } : {}),
    },
  };
}

// Only the event kinds the mobile session-list sidebar actually consumes are
// allowed through the device-wide stream. Message/tool/projection frames are
// irrelevant to the sidebar and are the bulk of the flood whenever any session
// is generating; they belong to the per-session /session/stream instead.
const LIST_EVENT_INNER = new Set(['turn/start', 'turn/end', 'session/title', 'session/disposed']);
function listRelevantPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const type = rawPayload.type;
  if (type === 'session/summary' || type === 'session/queue' || type === 'session/subscribed') return rawPayload;
  if (type === 'question/requested' || type === 'question/resolved' || type === 'approval/requested' || type === 'approval/asked' || type === 'approval/decided' || type === 'approval/resolved') return rawPayload;
  if (typeof type === 'string' && type.startsWith('host/')) return rawPayload;
  if (type === 'session/event') {
    const ev = rawPayload.event && typeof rawPayload.event === 'object' ? rawPayload.event : null;
    const inner = ev && ev.data && typeof ev.data === 'object' ? ev.data.type : undefined;
    if (LIST_EVENT_INNER.has(inner)) return lightPayload(rawPayload);
    return null;
  }
  return null;
}

/**
 * Device-wide compatibility stream. The mux frame remains intact in `payload`;
 * the envelope only provides a stable event identity for future clients.
 */
async function handleDeviceStream(ctx, req, res) {
  // 协议 v2：与 /session/stream 一样逐帧封装，头必须在 writeHead 之前声明。
  const sealFrame = createFrameSealer(req);
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(sealFrame ? { 'x-dsh-proto': '2' } : {}),
    });
  } catch { return; }

  res.write(': connected\n\n');
  const ac = new AbortController();
  // 按设备登记这条流：吊销时宿主主动断它（§3.3）。设备级流同样是「开着就一直收」。
  const untrack = streamRegistry.track(req.__dshRecord && req.__dshRecord.deviceId, res);
  req.on('close', () => { untrack(); ac.abort(); });
  // 写坏掉的连接不该把宿主整条流拖住，也不该让 'error' 在 res 上无人接住而变成未捕获异常。
  // （守卫 on 的存在是为了那些只实现 writeHead/write/end 的最小假体。）
  if (typeof res.on === 'function') res.on('error', () => ac.abort());
  /** 这条连接上真正写出去的帧数，只用于收尾日志（诊断「连着却一帧不发」）。 */
  let framesSent = 0;
  const writeFrame = (devicePayload) => {
    const result = writeSse(res, {
      type: 'device/event',
      version: 1,
      payload: devicePayload,
    }, null, sealFrame);
    if (!result.ok) return false;
    // shed 不是成功：不能继续读，否则这一帧代表的变更永远补不回来。
    if (result.shed) return false;
    framesSent += 1;
    // 所有调用点都是同步回调（信号总线、心跳），没法在这里 await；写不动就如实回报，
    // 由调用方 abort —— 这条流本来就是「断了重连、靠补发收敛」的语义。
    return !result.needDrain;
  };
  /**
   * 自产的「清单变了」帧：镜像推送调度器每 500ms 比一次清单内容哈希，变了就在这里推给手机。
   *
   * 设备级流此前只有宿主事件这一个来源，而宿主的 0.2.0 兼容桥只订阅 workspace/follow +
   * session/control，会话状态变化（session/projection）会被 listRelevantPayload 丢掉 ——
   * 手机于是「连着却收不到任何会话状态变化」，兜底轮询又被降成 60s。这里补上真源。
   *
   * 走直订而不是塞进 mergeHostAndMux：那是个无限流，混进去之后「宿主事件流结束」就不再
   * 等于「这条 SSE 该收尾」。watch() 让推送调度器知道有人在听（隧道断着也照常判定），
   * 收尾时必须注销，否则它永远以为有人听。
   */
  const releaseSignal = sharedListSignal.watch();
  const unsubscribeSignal = sharedListSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/list-changed', revision: event.revision, at: event.at })) ac.abort();
  });
  /**
   * 自产的「某个会话的正文水位涨了」帧，与「清单变了」是两条独立的通知。
   *
   * 清单信号只说「列表内容变了」，手机据此重拉列表；但列表摘要里的 lastMessage 只是
   * 一句话，正文（回复的长文本、提问的选项）在会话缓存里。没有这条帧时，只有**打开着**
   * 那个会话的手机才会实时收到正文（session/stream 是按会话订阅的），没打开的会话要等
   * 用户点进去才拉 —— 而这正好是「点开对话要等一会儿才看到内容」的来源。
   *
   * 水位由镜像调度器**算出后广播**，与镜像是否真的推进去解耦（见 lib/mirror/pusher.cjs
   * 的 announceSessionActivity：隧道未连、内容未变跳过、推送成功三条路径都会广播）——
   * 它说的是「本机正文到哪了」，不是「中转镜像里有到哪了」。手机收到帧后立刻带 afterSeq
   * 去 /session/messages 增量拉：走中转的手机读到的是刚推上去的镜像，走局域网直连的手机
   * 读到的是 sidecar 本地那份快照（/tunnel/send 先落盘再尝试发），两条路都拿得到。
   * 同样必须直订 + 收尾注销，理由与上面那条一致。
   */
  const unsubscribeActivity = sharedSessionSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/session-activity', sessionId: event.sessionId, seq: event.seq, at: event.at })) ac.abort();
  });
  /**
   * 自产的「桌面侧栏折叠态变了」帧。
   *
   * 桌面端那份 groupExpansion 只活在浏览器 localStorage，插件靠客户端半边轮询上报，
   * 落在 lib/desktop-view.cjs；手机要拿到它只能问 GET /desktop-view。过去 App 用
   * 「跟列表刷新走 + 5 分钟最短间隔」去猜它有没有变，稳态下一天白问几百次 —— 而插件
   * 早就知道它哪一刻变了（desktop-view.cjs 的 update()）。这里补上那个出口。
   *
   * 只发 updatedAt、不发内容：手机据此重拉那一发，拿到的是与列表同一口径的完整镜像，
   * 也不必让这条「信号流」承担数据同步（它的帧一律可丢、可重放）。
   * 同样必须直订 + 收尾注销，理由与上面两条一致。
   */
  const unsubscribeDesktopView = sharedDesktopViewSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/desktop-view-changed', updatedAt: event.updatedAt, at: event.at })) ac.abort();
  });
  /**
   * 连上就先补一帧「当前状态」。
   *
   * 设备级流没有会话级流那套 Last-Event-ID 续传（App 对这条流不做断点续传，它只把帧
   * 当「有东西变了」的信号），所以断流窗口里发生的清单变更与正文水位在重连后必须补上。
   * 不补的后果：手机重连后 state 是空的，而侧栏兜底轮询已经因为「流活着」被降到 60s ——
   * 中间这几分钟的变化要等到下一次真实变更才可见。
   *
   * 这里只读两条信号总线**已经广播过**的最近值（snapshot），既不 bump 也不前移任何基准，
   * 所以不会制造新变更、不影响推送侧的幂等。App 侧对同 revision / 同水位是幂等的
   * （app 的 handleDeviceSignal 按 revision 与 seq 判重），重连补发不会引发重复刷新。
   * 帧形状与实时帧完全一致（同为 device/event 信封包 device/list-changed 或
   * device/session-activity），App 不需要任何改动。
   */
  const replayKnownSignals = () => {
    const list = sharedListSignal.snapshot();
    if (list && list.revision) {
      if (!writeFrame({ type: 'device/list-changed', revision: list.revision, at: list.at || Date.now() })) return false;
    }
    // 桌面侧栏折叠态：手机从此只在变化时拉一次。老 App 不认识这一帧（走默认分支忽略），
    // 所以补发它不会改变老客户端的任何行为。
    const view = sharedDesktopViewSignal.snapshot();
    if (view && view.updatedAt > 0) {
      if (!writeFrame({ type: 'device/desktop-view-changed', updatedAt: view.updatedAt, at: view.at || Date.now() })) return false;
    }
    for (const [sessionId, seq] of Object.entries(sharedSessionSignal.snapshot())) {
      if (!(seq > 0)) continue;
      if (!writeFrame({ type: 'device/session-activity', sessionId, seq, at: Date.now() })) return false;
    }
    return true;
  };
  // 补发失败说明连接已经不可写（writeSse 只在 res.write 抛错时返回 false），此时
  // 继续跑 mux 循环只会一路失败；abort 掉让它走正常收尾。
  if (!replayKnownSignals()) ac.abort();
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { ac.abort(); return; }
    // 心跳必须是**数据帧**：注释帧 App 看不见，而 App 只有「最近真的收到过帧」才敢把
    // 兜底轮询降到 60s（见 app/src/services/viewmodels/signal-liveness.ts）。
    if (!writeFrame({ type: 'device/heartbeat', at: Date.now() })) ac.abort();
  }, HEARTBEAT_MS);
  // 定时器不该拖住进程退出（同 lib/sidecar-facade-worker.cjs 的 shutdown）。测试里的
  // setInterval 桩没有 unref，先判类型。
  if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref();
  const seenEventIds = new Set();
  const seenEventOrder = [];
  // 「客户端走了」与「循环正常结束」必须分开：前者不该再写日志说流被关，后者要留痕，
  // 否则「连着却一帧不发」在宿主日志里查不出是哪种。
  let clientGone = false;
  let loopEnded = false;
  try {
    for await (const frame of mergeHostAndMux(ctx, ac.signal)) {
      const rawPayload = frame && frame.payload;
      if (!rawPayload || typeof rawPayload !== 'object') continue;
      // Keep only the lightweight session-list signals; drop message/tool/
      // projection frames that flood every paired phone during active sessions.
      const payload = listRelevantPayload(rawPayload);
      if (!payload) continue;
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
      const eventId = sharedEventId(rawPayload, frame, 'device');
      if (eventId) {
        if (seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);
        seenEventOrder.push(eventId);
        if (seenEventOrder.length > DEDUP_WINDOW) {
          const evicted = seenEventOrder.shift();
          if (evicted) seenEventIds.delete(evicted);
        }
      }
      const envelope = {
        type: 'device/event',
        version: 1,
        eventId,
        sessionId,
        rpcId: typeof frame.rpcId === 'string' ? frame.rpcId : undefined,
        payload,
      };
      // Keep the existing device/event JSON envelope unchanged; SSE metadata is additive.
      const sent = writeSse(res, envelope, frame, sealFrame);
      if (sent.shed) { clientGone = true; break; }
      if (!sent.ok || sent.needDrain) { clientGone = true; break; }
      framesSent += 1;
    }
    if (!clientGone) loopEnded = true;
  } catch (error) {
    // 旧实现是裸 catch：mux 循环一旦抛错（底层 HTTP SSE 中断、返回非异步可迭代、
    // signal abort），这条流就停在 preamble 之后既不产出也不终止，宿主侧查不出原因。
    logDeviceStream('mux loop threw', error);
  }
  clearInterval(keepAlive);
  unsubscribeSignal();
  unsubscribeActivity();
  unsubscribeDesktopView();
  releaseSignal();
  try {
    if (!res.writableEnded) {
      res.end();
      logDeviceStream(`stream closed (loopEnded=${loopEnded}, aborted=${ac.signal.aborted}, clientGone=${clientGone}, frames=${framesSent})`, null);
    }
  } catch (error) {
    logDeviceStream('stream end failed', error);
  }
}

module.exports = { handleDeviceStream, listRelevantPayload, lightPayload, HEARTBEAT_MS };

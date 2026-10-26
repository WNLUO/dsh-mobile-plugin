/**
 * 设备级事件流（GET /api/mobile/v1/events/stream）：手机上侧栏那条 SSE。
 *
 * 它只是「有东西变了」的信号，绝不是数据源，所以每条宿主帧都削到只剩「列表需要重拉」的
 * 部分。0.2.0 兼容桥只订阅 workspace/follow + session/control，会话状态变化会被丢掉；插件
 * 因此自产四类帧：device/list-changed、device/session-activity、device/desktop-view-changed
 * 与 device/heartbeat，App 靠它们判断流还活着并决定是否降频兜底轮询。
 *
 * 这条流没有 Last-Event-ID 续传，所以连上时立刻补一帧当前 revision 与每个已跟踪会话的水位；
 * 补的是断流窗口，不是新变更。
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
 * 诊断日志。失败路径一条都不许静默：手机把兜底轮询降成 60s，宿主日志里却查不到这条流是
 * 正常收尾、被客户端断开，还是循环抛错。会话级流早有 logStream，这里是它的设备级对偶。
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
 * 这条流的软水位一律 shed，而 shed 不能当成功：没有 Last-Event-ID 续传，丢了帧又继续读，
 * App 就会停在缺少那一次变更的状态。所以调用方看到 `shed` 必须立即断流，让客户端重连后
 * 走 `replayKnownSignals()` 全量补水位 —— 这比把帧堆在写缓冲里好。
 *
 * 返回值与会话流一致：`ok:false` 该收尾，`shed:true` 这条被丢掉（调用方必须断流），
 * `needDrain:true` 写进去了但底下已经写不动。
 */
function writeSse(res, payload, frame, sealFrame) {
  return sharedWriteSse(res, payload, {
    frame,
    namespace: 'device',
    // 协议 v2 的会话上这条流也逐帧封装：`App` 判定「这条会话是加密的」之后，收到一帧
    // 明文就当畸形帧计数，连着十帧就把整条流判死、退回 15 秒轮询。
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
 * Trim a device-wide stream payload to the metadata the mobile session-list consumes.
 * `session/event` frames carry the full message content; forwarding them to every paired
 * phone floods the relay whenever a session is generating. Only the event identity and
 * inner type are needed. Other frame types are small and kept intact.
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
   * 自产的「清单变了」帧：镜像推送调度器每 500ms 比一次清单内容哈希，变了就推给手机。
   *
   * 设备级流此前只有宿主事件这一个来源，而 0.2.0 兼容桥的订阅里没有 session/projection，
   * 会话状态变化会被丢掉，手机于是「连着却收不到任何变化」。
   *
   * 走直订而不是塞进 mergeHostAndMux：那是个无限流，混进去之后「宿主事件流结束」就不再等于
   * 「这条 SSE 该收尾」。watch() 让推送调度器知道有人在听，收尾时必须注销。
   */
  const releaseSignal = sharedListSignal.watch();
  const unsubscribeSignal = sharedListSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/list-changed', revision: event.revision, at: event.at })) ac.abort();
  });
  /**
   * 自产的「某个会话的正文水位涨了」帧，与「清单变了」是两条独立的通知。
   *
   * 清单信号只说列表内容变了；而正文在会话缓存里，没有这条帧时只有打开着那个会话的手机才
   * 会实时收到正文，没打开的会话要等点进去才拉 —— 这正是「点开对话要等一会儿才看到内容」
   * 的来源。
   *
   * 水位由镜像调度器算出后广播，说的是「本机正文到哪了」，不是「中转镜像里有到哪了」，与
   * 镜像是否真的推成功解耦。同样必须直订 + 收尾注销。
   */
  const unsubscribeActivity = sharedSessionSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/session-activity', sessionId: event.sessionId, seq: event.seq, at: event.at })) ac.abort();
  });
  /**
   * 自产的「桌面侧栏折叠态变了」帧。
   *
   * groupExpansion 只活在浏览器 localStorage，插件靠客户端半边轮询上报落在
   * lib/desktop-view.cjs；手机要拿它只能问 GET /desktop-view。过去 App 按「跟列表刷新走 +
   * 5 分钟最短间隔」去猜它变没变，而插件早就知道它哪一刻变了。
   *
   * 只发 updatedAt、不发内容：手机据此重拉那一发，不必让信号流承担数据同步。
   * 同样必须直订 + 收尾注销。
   */
  const unsubscribeDesktopView = sharedDesktopViewSignal.onBump((event) => {
    if (ac.signal.aborted) return;
    if (!writeFrame({ type: 'device/desktop-view-changed', updatedAt: event.updatedAt, at: event.at })) ac.abort();
  });
  /**
   * 连上就先补一帧「当前状态」。
   *
   * 这条流没有 Last-Event-ID 续传，断流窗口里发生的清单变更与正文水位必须在重连后补上，
   * 否则手机 state 是空的，而兜底轮询已经因为「流活着」被降到 60s。
   *
   * 只读两条信号总线已经广播过的最近值，既不 bump 也不前移基准，所以不会制造新变更；
   * App 对同 revision / 同水位幂等，重连补发不会引发重复刷新。
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

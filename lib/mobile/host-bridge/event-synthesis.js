'use strict';

/**
 * 事件合成：旧设备级 `events.mux` 的帧流 ⇄ 0.2.0 拆开的三条流。
 *
 * 旧 mux 一次给出「这个设备正在发生的一切」，0.2.0 没有对应端点（事件已拆成
 * session/follow、session/control、workspace/follow），这里按 payload 里有没有 sessionId
 * 合成同形帧：带 sessionId → 该会话的 follow + job 整帧 + 投影整帧；不带 → 设备级的
 * 工作区基线 + 全局投影整帧。调用方（stream.js / events.js / index.js 的 mirror）本来就
 * 按 frame.payload 里的 type 分发，形状对上了它们一行都不用改。
 */

const { gatewayOf, openStream, warn } = require('./transport.js');

const warnedUnavailableContexts = new WeakSet();

/**
 * Keep the compatibility SSE alive when a host has no streaming gateway. The
 * device stream also carries plugin-owned signals and heartbeats, so ending it
 * here would cause reconnect churn and disable that independent data path.
 */
async function* unavailableHostStream(ctx, signal) {
  const gateway = gatewayOf(ctx);
  if (gateway && typeof gateway.stream === 'function') return false;

  if (ctx && typeof ctx === 'object' && !warnedUnavailableContexts.has(ctx)) {
    warnedUnavailableContexts.add(ctx);
    warn(ctx, '宿主未提供 typertGateway.stream，跳过宿主事件并保持设备流空闲');
  }

  if (!signal || signal.aborted) return true;
  await new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
  return true;
}

// ── 事件合成 ──────────────────────────────────────────────────────────────

/** 把 payload.sessionId 取出来；没有就按设备级处理。 */
function sessionHint(request) {
  const payload = request && request.payload;
  const sessionId = payload && payload.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/**
 * 这条单会话流该按哪种地址订阅。
 *
 * 子会话必须换成 `{kind:'subagent'}` 的 durable 地址：宿主 `validateAddress` 对
 * `origin === 'subagent'` 的会话拿普通地址一律回 agent-busy，subscribe 直接失败 ——
 * 表现就是「子代理页面打得开，但内容永远不自己更新」。请求体里带上 `parentSessionId`
 * 就是「这是个子会话」的信号（与历史那条同源，见 stream.js 的 handleStream）。
 */
function sessionAddress(payload) {
  const sessionId = payload && payload.sessionId;
  const parentSessionId = payload && payload.parentSessionId;
  if (typeof parentSessionId === 'string' && parentSessionId) {
    return {
      kind: 'subagent',
      parentSessionId,
      childSessionId: sessionId,
      mode: (payload && payload.mode) || 'continuable',
    };
  }
  return { kind: 'session', sessionId };
}

/** 一条流跑不通不该拖垮其余流：这里把异常吃掉，只丢这一条源的帧。 */
async function* tolerate(frames, what, ctx) {
  try {
    for await (const frame of frames) yield frame;
  } catch (error) {
    warn(ctx, `${what} 事件流中断：${error && error.message ? error.message : String(error)}`);
  }
}

/** 正文 / 推理 / 工具参数的增量：同一块的连续 delta 在基线里可以合并成一帧。 */
const BASELINE_DELTA_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);

/**
 * 展开 follow 首帧里那条「正在跑的那一步已生成的内容」。
 *
 * 宿主的 follow 第一帧是 `{type:'snapshot', cursor, assistantStream:{ revision, activeAttempt }}`，
 * `activeAttempt.stream` 是一份**压缩过的**增量记录（连续同块 delta 被压成
 * `{type:'text-chunks', index, time0, dt, texts}` 这类一条记录多个成员），
 * `nextIndex` 是「下一帧实时增量应有的密排位置」，也就是这条前缀展开后应有的成员数。
 * 中途进入会话的人只有这一份，宿主不会把已发过的实时帧补给他。
 *
 * 返回 `[{ time, chunk }]`；形状认不出就跳过那一条记录，绝不让整条流挂掉。
 */
function expandBaselineStream(stream, limit) {
  const out = [];
  if (!Array.isArray(stream)) return out;
  const cap = Number.isSafeInteger(limit) && limit >= 0 ? limit : Number.POSITIVE_INFINITY;
  for (const record of stream) {
    if (out.length >= cap) break;
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'chunk') {
      if (record.chunk && typeof record.chunk === 'object' && typeof record.chunk.index === 'number') {
        out.push({ time: Number.isSafeInteger(record.time) ? record.time : 0, chunk: record.chunk });
      }
      continue;
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
    if (!Array.isArray(members) || typeof record.index !== 'number') continue;
    const dt = Array.isArray(record.dt) ? record.dt : [];
    let time = Number.isSafeInteger(record.time0) ? record.time0 : 0;
    for (let i = 0; i < members.length && out.length < cap; i += 1) {
      if (i > 0 && Number.isSafeInteger(dt[i - 1])) time += dt[i - 1];
      if (record.type === 'text-chunks' && typeof members[i] === 'string') {
        out.push({ time, chunk: { type: 'text-delta', index: record.index, text: members[i] } });
      } else if (record.type === 'reasoning-chunks' && typeof members[i] === 'string') {
        out.push({ time, chunk: { type: 'reasoning-delta', index: record.index, text: members[i] } });
      } else if (record.type === 'tool-call-chunks') {
        out.push({
          time,
          chunk: {
            type: 'tool-call-delta',
            index: record.index,
            ...(typeof record.id === 'string' ? { id: record.id } : {}),
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            argumentsDelta: members[i],
          },
        });
      }
    }
  }
  return out;
}

/**
 * 同一块的连续增量合成一帧：一条 3k 字的回复展开后是几千帧，逐帧发给手机既占带宽
 * 又会在 App 的守门缓冲里被挤掉。App 的草稿本来就是按块累积文本，合并后观感一致。
 */
function coalesceBaselineStream(members) {
  const out = [];
  for (const member of members) {
    const chunk = member && member.chunk;
    if (!chunk || typeof chunk !== 'object') continue;
    const last = out[out.length - 1];
    const previous = last && last.chunk;
    if (
      previous && BASELINE_DELTA_TYPES.has(chunk.type) &&
      previous.type === chunk.type && previous.index === chunk.index
    ) {
      if (typeof chunk.text === 'string' && typeof previous.text === 'string') {
        last.chunk = { ...previous, text: previous.text + chunk.text };
        continue;
      }
      if (typeof chunk.argumentsDelta === 'string' && typeof previous.argumentsDelta === 'string') {
        last.chunk = { ...previous, argumentsDelta: previous.argumentsDelta + chunk.argumentsDelta };
        continue;
      }
    }
    out.push({ time: member.time, chunk });
  }
  return out;
}

/**
 * follow 流的一帧 → 0..n 个 mux 帧（事件原样转发；实时增量通知合成 assistant/chunk）。
 *
 * 0.2.0 的宿主把逐块流式增量从「会话事件」里拿了出去：正文/推理的每个 delta 只以 follow 流的
 * `assistant-stream` 通知下发，而且**要显式传 `assistantStream: true` 才发**，事件流里只剩
 * 「一步落定」的 `assistant/message`。不订阅通知的话，正文与运行中明细都只能在一步结束时整块
 * 出现（真机故障 2026-10-21：回复整段蹦出来、运行中那一行没有实时明细）。
 *
 * 合成事件用的是移动协议早已认识的 `assistant/chunk` 形状，但**不带 seq** —— 它没有持久化
 * 事件的身份，不该参与客户端的 seq 序门、去重与续传水位（App 侧对无 seq 帧一律放行），
 * turn/step 由最近一次 start 通知补上。设备级推送只看 turn/start、turn/end、session/title
 * （`lib/mobile/events.js` 的 LIST_EVENT_INNER），合成增量到不了那条通道，不会形成推送风暴。
 *
 * `state` 是这条流的记账（{ turn, step, streaming }），由调用方持有 —— 一帧的处理要看
 * 「之前收到过什么」。历史正文走 session.history，但首帧 snapshot 里那份
 * `assistantStream.activeAttempt` 不能丢：中途进入会话的人拿不到开跑之前的实时增量，
 * 那一段只存在于这份基线里（见 expandBaselineStream）。
 */
function* followFramePayloads(frame, sessionId, state) {
  if (!frame) return;
  if (frame.type === 'snapshot') {
    const opening = frame.assistantStream && frame.assistantStream.activeAttempt;
    if (!opening || !Number.isSafeInteger(opening.turn) || !Number.isSafeInteger(opening.step)) return;
    // 这条流后面收到的实时增量要靠这两个值带上作用域（App 按「本轮·本步」分家草稿），
    // 中途进来的客户端收不到 start 通知，基线是唯一来源。
    state.turn = opening.turn;
    state.step = opening.step;
    state.streaming = true;
    for (const member of coalesceBaselineStream(expandBaselineStream(opening.stream, opening.nextIndex))) {
      yield {
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'assistant/chunk',
            time: Number.isSafeInteger(member.time) ? member.time : Date.now(),
            data: { turn: state.turn, step: state.step, chunk: member.chunk },
          },
        },
      };
    }
    return;
  }
  if (frame.type === 'event') {
    if (!frame.event) return;
    // 增量只交付一次：宿主若同时把 chunk 也当成事件发，以通知为准（通知先到）。
    if (state.streaming && frame.event.type === 'assistant/chunk') return;
    yield { payload: { type: 'session/event', sessionId, event: frame.event } };
    return;
  }
  const notice = frame.type === 'assistant-stream' ? frame.frame : null;
  if (!notice) return;
  if (notice.type === 'start') {
    if (Number.isSafeInteger(notice.turn)) state.turn = notice.turn;
    if (Number.isSafeInteger(notice.step)) state.step = notice.step;
    return;
  }
  if (notice.type !== 'chunk' || !notice.chunk || typeof notice.chunk !== 'object') return;
  // 块序号在通知帧上，chunk 自己也带一份；自己没带就补上（App 侧按 chunk.index 拼草稿）。
  const chunk = typeof notice.chunk.index === 'number' || typeof notice.index !== 'number'
    ? notice.chunk
    : { ...notice.chunk, index: notice.index };
  state.streaming = true;
  yield {
    payload: {
      type: 'session/event',
      sessionId,
      event: {
        type: 'assistant/chunk',
        time: Number.isFinite(notice.time) ? notice.time : Date.now(),
        data: { turn: state.turn, step: state.step, chunk },
      },
    },
  };
}

/** 后台任务整帧。宿主 job/list 是流，首帧即全量 rows，之后按变化推。 */
async function* sessionJobFrames(ctx, sessionId, signal) {
  const frames = await openStream(ctx, 'job', 'list', { request: { sessionId } }, signal);
  for await (const frame of tolerate(frames, `job/${sessionId}`, ctx)) {
    if (!frame || frame.type !== 'rows') continue;
    yield { payload: { type: 'session/jobs', sessionId, jobs: Array.isArray(frame.jobs) ? frame.jobs : [] } };
  }
}

/**
 * 投影整帧（排队条、计划条、目标条、模型选择等全量快照）。
 *
 * 宿主 session.control 是设备级投影流：首帧 baseline 一次性给出
 * { projections: { [sessionId]: { asOfSeq, values } } }，之后是
 * { type:'projection', sessionId, key, value, seq } 的单键更新。
 * 旧帧是整帧（幂等全量），这里保持整帧语义 —— 更新帧就带上累积后的 values 重发。
 */
function projectionState() {
  const values = new Map();   // sessionId -> { asOfSeq, values }
  return {
    applyBaseline(baseline) {
      const projections = baseline && typeof baseline === 'object' ? baseline.projections : null;
      if (!projections || typeof projections !== 'object') return [];
      const touched = [];
      for (const [sessionId, entry] of Object.entries(projections)) {
        const next = {
          asOfSeq: Number.isSafeInteger(entry && entry.asOfSeq) ? entry.asOfSeq : 0,
          values: (entry && entry.values && typeof entry.values === 'object') ? entry.values : {},
        };
        values.set(sessionId, next);
        touched.push(sessionId);
      }
      return touched;
    },
    applyUpdate(update) {
      const sessionId = update && update.sessionId;
      if (typeof sessionId !== 'string') return [];
      const current = values.get(sessionId) || { asOfSeq: 0, values: {} };
      if (typeof update.key === 'string') current.values = { ...current.values, [update.key]: update.value };
      if (Number.isSafeInteger(update.seq)) current.asOfSeq = update.seq;
      values.set(sessionId, current);
      return [sessionId];
    },
    snapshot(sessionId) {
      return values.get(sessionId) || null;
    },
    /** 全量快照的平表（sessionId → values），只读用途：投影基线要一次看全部会话。 */
    all() {
      return new Map(values);
    },
  };
}

/**
 * 宿主投影 `inbox` → 移动端 `session/queue` 帧的**平铺 items**。
 *
 * 形状差是这条链上唯一的坑：宿主把 inbox 定义成按键分组的对象
 * `{ 'next-turn': Message[], 'next-step': Message[] }`（桌面 bundle 里
 * `@deepseek-ai/dsh-agent-loop/inbox` 的 `key: 'inbox'` + `wire.view: (state) => state`，
 * 桌面 QueueDock 读的也正是 `inbox['next-turn']`），而移动端帧的约定是数组
 * `[{ id, placement, message }]`（`app/src/types/chatStream.ts` 的 QueueItem、
 * `app/src/hooks/streamFrame.ts` 的 `session/queue` 分支）。原样转发对象时 App 的
 * `Array.isArray(items)` 判定失败、整帧被静默丢弃 —— 排队条一次都不显示。
 *
 * `next-turn`（等下一轮才开始的消息）→ `placement: 'queued'`，QueueDock 只认这一个值。
 * `next-step`（本步末尾注入的插话）暂不合成 `steering`：手机发起的插话已有本地待发气泡
 * （`useChatStream` 的 `pending-<clientMessageId>`）与落定后的正文行，多推一份会在同一处
 * 多画一条用户气泡。`message.id` 用宿主行自己的 id，App 靠它与正文去重（chatRenderRows）。
 */
function queueItems(inbox, ctx) {
  const rows = inbox && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : [];
  const items = [];
  let dropped = 0;
  for (const message of rows) {
    if (!message || typeof message !== 'object') continue;
    const id = typeof message.id === 'string' && message.id ? message.id : '';
    if (!id) { dropped += 1; continue; } // 没有 id 的行没法被 session.updateQueue 定位，别发出去
    items.push({ id, placement: 'queued', message: { id, content: message.content } });
  }
  // 丢弃必须留痕：旧实现是裸 continue，手机上少一条待发消息而宿主侧一行日志都没有，
  // 只能靠人对着桌面端数气泡。凭空造 id 更糟——App 的 session.updateQueue 按 id 定位，
  // 假 id 会让「已落定」和「待发」两条记录对不上。
  if (dropped > 0) warn(ctx, `session/queue 丢了 ${dropped} 条没有 id 的待发行（App 无法定位，手机上会少这几条）`);
  return items;
}

async function* projectionFrames(ctx, sessionId, signal) {
  const frames = await openStream(ctx, 'session', 'control', {}, signal);
  const state = projectionState();
  for await (const frame of tolerate(frames, 'session/control', ctx)) {
    if (!frame) continue;
    let touched = [];
    if (frame.type === 'baseline') touched = state.applyBaseline(frame.value);
    else if (frame.type === 'projection') touched = state.applyUpdate(frame);
    for (const id of touched) {
      if (sessionId && id !== sessionId) continue;
      const current = state.snapshot(id);
      yield { payload: { type: 'session/projection', sessionId: id, seq: current.asOfSeq, values: current.values } };
      // 排队条按旧约定走独立的 session/queue 整帧（移动端 QueueDock 读这个类型），
      // 宿主侧的对应投影是 inbox。
      if (current.values && current.values.inbox !== undefined) {
        yield { payload: { type: 'session/queue', sessionId: id, items: queueItems(current.values.inbox, ctx) } };
      }
    }
  }
}

/** 设备级：工作区基线 + 全局投影（没有 sessionId 时能给的就这些）。 */
async function* deviceFrames(ctx, signal) {
  const workspace = await openStream(ctx, 'workspace', 'follow', {}, signal).catch(() => null);
  if (workspace) {
    for await (const frame of tolerate(workspace, 'workspace/follow', ctx)) {
      if (!frame) continue;
      if (frame.type === 'baseline' && frame.value) {
        yield { payload: { type: 'host/workspace', ...frame.value } };
      } else if (frame.type === 'increment' || frame.type === 'change') {
        yield { payload: { type: 'host/workspace', ...(frame.value && typeof frame.value === 'object' ? frame.value : { change: frame }) } };
      }
    }
  }
  yield* projectionFrames(ctx, null, signal);
}

/** 旧 `events.mux`：设备级帧流，带 sessionId 时收窄成单会话视角。 */
function muxFrames(ctx, request, signal) {
  const sessionId = sessionHint(request);
  const payload = request && request.payload;
  return (async function* run() {
    if (yield* unavailableHostStream(ctx, signal)) return;
    if (!sessionId) {
      yield* deviceFrames(ctx, signal);
      // **设备级这一支不能跟着宿主那几条流一起结束**：这条 SSE 还捎带着插件自己产的
      // 清单变更、正文水位与 15s 心跳（由 `handleDeviceStream` 直接写这条连接）。
      // 迭代器一返回，SSE 立刻收尾，手机端只会看到「连几秒就断」：信号永远不「活着」，
      // 兜底轮询降不下去，每次重连还要重放一遍水位（2026-10-24 现场：17 帧后 loopEnded）。
      // 单会话那一支不适用 —— 会话结束了就该收尾。
      if (!signal || signal.aborted) return;
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
        if (signal.aborted) resolve();
      });
      return;
    }
    const address = sessionAddress(payload);
    // 子会话没有 job 面板（任务归属父会话），也就不订阅那一条：拿子会话 id 去问 job.list
    // 只会白打一发，而且它的失败会被 tolerate 吞成一条警告。
    const control = openStream(ctx, 'session', 'control', {}, signal).then((frames) => tolerate(frames, 'session/control', ctx));
    const jobs = address.kind === 'session'
      ? openStream(ctx, 'job', 'list', { request: { sessionId } }, signal).then((frames) => tolerate(frames, `job/${sessionId}`, ctx))
      : null;
    // assistantStream: 逐块增量只走这条流的 assistant-stream 通知（见 followFramePayloads）。
    const follow = openStream(ctx, 'session', 'follow', {
      request: { address, maxMessages: 1, assistantStream: true },
    }, signal).then((frames) => tolerate(frames, `session/${sessionId}`, ctx));
    const projections = projectionState();
    const followState = { turn: null, step: null, streaming: false };
    const opening = [['control', control], ['follow', follow]];
    if (jobs !== null) opening.push(['jobs', jobs]);
    const sources = await Promise.all(opening.map(([source, promise]) => promise.then(async function* wrap(iterable) {
      for await (const frame of iterable) {
        if (source === 'follow') {
          // follow 一帧可能产出 0..n 个 mux 帧（事件原样 + 增量通知合成 chunk 事件）。
          yield* followFramePayloads(frame, sessionId, followState);
        } else if (frame && frame.type === 'rows') {
          yield { payload: { type: 'session/jobs', sessionId, jobs: Array.isArray(frame.jobs) ? frame.jobs : [] } };
        } else if (frame && frame.type === 'baseline') {
          yield* applyBaseline(frame, projections, sessionId, ctx);
        } else if (frame && frame.type === 'projection') {
          yield* applyUpdate(frame, projections, sessionId, ctx);
        }
      }
    }).catch((error) => {
      warn(ctx, `事件流中断：${error && error.message ? error.message : String(error)}`);
      return (async function* empty() {})();
    })));
    const pending = new Map(sources.map((source, index) => [index, source.next()]));
    while (pending.size > 0) {
      const winner = await Promise.race([...pending.entries()].map(async ([index, step]) => ({ index, step: await step })));
      if (winner.step.done) {
        pending.delete(winner.index);
        continue;
      }
      pending.set(winner.index, sources[winner.index].next());
      yield winner.step.value;
    }
  })();
}

// 单会话视角下的投影合并：整条 mux 生命周期共用一个 state，否则增量帧会把
// baseline 里的 values 冲掉（移动端把 session/projection 当整帧消费）。
function applyBaseline(frame, state, sessionId, ctx) {
  return projectionFramesFrom(ctx, frame, sessionId, state);
}

function applyUpdate(frame, state, sessionId, ctx) {
  return projectionFramesFrom(ctx, frame, sessionId, state);
}

async function* projectionFramesFrom(ctx, frame, sessionId, state) {
  const touched = frame.type === 'baseline' ? state.applyBaseline(frame.value) : state.applyUpdate(frame);
  for (const id of touched) {
    if (id !== sessionId) continue;
    const current = state.snapshot(id);
    yield { payload: { type: 'session/projection', sessionId: id, seq: current.asOfSeq, values: current.values } };
    if (current.values && current.values.inbox !== undefined) {
      yield { payload: { type: 'session/queue', sessionId: id, items: queueItems(current.values.inbox, ctx) } };
    }
  }
}

module.exports = { muxFrames };

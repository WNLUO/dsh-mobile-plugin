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

const { openStream, warn } = require('./transport.js');

// ── 事件合成 ──────────────────────────────────────────────────────────────

/** 把 payload.sessionId 取出来；没有就按设备级处理。 */
function sessionHint(request) {
  const payload = request && request.payload;
  const sessionId = payload && payload.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/** 一条流跑不通不该拖垮其余流：这里把异常吃掉，只丢这一条源的帧。 */
async function* tolerate(frames, what, ctx) {
  try {
    for await (const frame of frames) yield frame;
  } catch (error) {
    warn(ctx, `${what} 事件流中断：${error && error.message ? error.message : String(error)}`);
  }
}

/** 单会话事件流：follow 的 live 事件（跳过 snapshot，历史走 session.history）。 */
async function* sessionEventFrames(ctx, sessionId, signal) {
  const frames = await openStream(ctx, 'session', 'follow', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 1 },
  }, signal);
  for await (const frame of tolerate(frames, `session/${sessionId}`, ctx)) {
    if (!frame || frame.type !== 'event' || !frame.event) continue;
    yield { payload: { type: 'session/event', sessionId, event: frame.event } };
  }
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
  return (async function* run() {
    if (!sessionId) {
      yield* deviceFrames(ctx, signal);
      return;
    }
    const control = openStream(ctx, 'session', 'control', {}, signal).then((frames) => tolerate(frames, 'session/control', ctx));
    const jobs = openStream(ctx, 'job', 'list', { request: { sessionId } }, signal).then((frames) => tolerate(frames, `job/${sessionId}`, ctx));
    const follow = openStream(ctx, 'session', 'follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 1 },
    }, signal).then((frames) => tolerate(frames, `session/${sessionId}`, ctx));
    const projections = projectionState();
    const sources = await Promise.all([control, jobs, follow].map((promise) => promise.then(async function* wrap(iterable) {
      for await (const frame of iterable) {
        if (frame && frame.type === 'rows') {
          yield { payload: { type: 'session/jobs', sessionId, jobs: Array.isArray(frame.jobs) ? frame.jobs : [] } };
        } else if (frame && frame.type === 'baseline') {
          yield* applyBaseline(frame, projections, sessionId, ctx);
        } else if (frame && frame.type === 'projection') {
          yield* applyUpdate(frame, projections, sessionId, ctx);
        } else if (frame && frame.type === 'event' && frame.event) {
          yield { payload: { type: 'session/event', sessionId, event: frame.event } };
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

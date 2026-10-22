'use strict';

/**
 * SSE 写帧的唯一实现：单会话流（lib/mobile/stream.js）与设备级流（lib/mobile/events.js）
 * 共用这一份。
 *
 * 为什么要合并：两条流曾经各有一份几乎相同的实现，而 2026-10-17 的宿主 OOM（堆快照里
 * 17.6 万条 SSE 帧、466MB 挂在 `WriteWrap._chunks` 上，七十分钟涨到 3.9G 被杀）先修了
 * 会话流那份，隔一轮才发现设备流那份还漏着 —— 同一个坑修两遍，就是因为实现有两份。
 * 现在「这条连接上到底积压了多少字节」「软/硬水位怎么判」「SSE 记录长什么样」「稳定
 * 事件 id 怎么算」「写不动时怎么等 drain」都只在这里，两条流只在调用点上声明自己的策略。
 *
 * 两条流刻意保留的差异（不是遗漏，改之前先看各自的理由）：
 *  - 丢帧口径：会话流的软水位只丢**明确可丢的增量**（只有 `assistant/chunk` 草稿：同一轮
 *    收尾的 `assistant/message` 带完整正文、重连 `replaySince` 能补齐）。`session/queue`、
 *    `session/jobs`、`session/resync-required` 这些控制帧没有 seq，但绝不能丢；设备级流的
 *    帧全是「有东西变了」的幂等信号，软水位丢弃后由调用方**断流重连**并用
 *    `replayKnownSignals()` 补发。由调用方传 `shedWhenBuffered`。
 *  - 写不动时：会话流 `await` 一次 drain（20s 超时再收尾）；设备级流直接收尾让客户端
 *    重连 —— 它没有 Last-Event-ID 续传，但连上时会 `replayKnownSignals()` 补发当前状态，
 *    所以「断开重连」是它的正常收敛路径。
 *  - 填充：会话流每条记录补 2048 字节 SSE 注释（Android RN 的 XHR 会攒小 chunk，
 *    不补就迟迟不触发 onprogress）；设备级流的帧很少、单帧也小，不补。
 */

const crypto = require('crypto');

const SSE_RETRY_MS = 3000;

/**
 * 写缓冲的两道水位（字节）。
 *
 * `res.write()` 在客户端读得慢时返回 false，字节留在 Node 的写队列里。两道闸分开，因为
 * 两种帧「丢了能不能补」不一样：软水位只丢可丢弃的帧（见上面丢帧口径），连接继续活着；
 * 硬水位连不可丢的帧都放不下了，就收尾让客户端重连补齐 —— 断流可恢复，堆内存不会。
 */
const SSE_SHED_BUFFERED_BYTES = 4 * 1024 * 1024;
const SSE_CLOSE_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * 等一次 `drain` 的上限。超过这么久还没排空，说明对面不是慢、是真的不读了（手机切
 * 后台、中转卡住），继续等只是把这条连接挂在那里，不如收尾让客户端重连。
 */
const SSE_DRAIN_TIMEOUT_MS = 20_000;

/**
 * 默认丢帧口径：只有**明确可丢**的无 seq 增量帧可以丢；有 seq 的一律不能丢。
 *
 * 旧实现是「没有 seq 就丢」，结果把 `session/queue` / `session/jobs` /
 * `session/resync-required` 这些控制帧一起丢了 —— 它们没有 seq，但丢了没有回放路径，
 * 队列/任务面板会永久停在旧状态，gap 提示也到不了客户端。
 */
const SHEDDABLE_INCREMENTAL_TYPES = new Set(['assistant/chunk']);
const shedWithoutSeq = (payload) => {
  if (!payload || !SHEDDABLE_INCREMENTAL_TYPES.has(payload.type)) return false;
  return !Number.isFinite(payload.seq);
};

/** 每条记录后面补的 SSE 注释（客户端忽略内容，只用来把小 chunk 撑过 RN 的缓冲阈值）。 */
function ssePadding(bytes) {
  const size = Number(bytes) > 0 ? Math.floor(Number(bytes)) : 0;
  return size > 0 ? `: ${' '.repeat(size)}` : '';
}

/**
 * 这条连接上真正「还没发出去」的字节数。
 *
 * 只看 `res.writableLength` 是错的：它只算响应对象自己那一层，真正的积压在底下的套接字
 * 写队列里（堆快照里那些 `{chunk, encoding, callback}`）。2026-10-18 复测证实：只看前者
 * 时闸门从不触发，内存照涨。所以顺着 socket 一起看，取较大值。
 */
function bufferedBytesOf(res) {
  const own = Number(res.writableLength) || 0;
  const socket = res.socket || res.connection;
  const queued = socket ? Number(socket.writableLength) || 0 : 0;
  return Math.max(own, queued);
}

/**
 * SSE 记录的 `id:` 字段：客户端断线重连时用它续传，所以必须对同一帧稳定。
 *
 * `namespace` 只参与「认不出身份时按内容摘要兜底」的那一支：两条流的兜底前缀不同
 * （会话流用 `session`、设备级流用 `device`），改它会改客户端看到的 id 形状。
 */
function stableEventId(payload, frame, namespace = 'session') {
  const source = payload && payload.type === 'session/event' ? payload : frame && frame.payload;
  if (source && typeof source === 'object') {
    if (source.type === 'session/event' && source.sessionId && source.event && Number.isFinite(source.event.seq)) {
      return `${source.sessionId}:${source.event.seq}`;
    }
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['eventId', 'rpcId', 'id', 'approvalId']) {
      if (typeof payload[key] === 'string' && payload[key]) return payload[key];
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : namespace;
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
    return `${sessionId}:${payload.type || 'event'}:${digest}`;
  }
  return frame && typeof frame.rpcId === 'string' && frame.rpcId ? frame.rpcId : undefined;
}

/**
 * 每条连接上「距离上次补齐注释」的状态：上次补齐的时刻、之后写出去的字节数。
 *
 * 键是响应对象，连接收掉后自然被回收，不需要显式清理。
 */
const PAD_STATES = new WeakMap();

/**
 * 决定这一条记录要不要补注释、补多少。
 *
 * 补注释的**唯一理由**是让安卓 RN 的 XHR 攒够字节尽快把进度事件吐给界面；补多少与补
 * 多勤都不影响这条理由，只影响代价 —— 一条记录补整份 2048 字节时，一次几十秒的流式
 * 回复（每秒几十条增量）光注释就要几 MB。所以改成按窗口补齐：
 *  - 距离上次补齐不到 `padEveryMs` 且累计字节还没越过 `padBytes` → 先不补，攒着；
 *  - 到了窗口边界或单条记录自己就够大 → 补到「自上次补齐以来累计 ≥ padBytes」为止。
 * 客户端看到的仍然是「每 ≥padBytes 就有一条补过注释的记录」，界面的出字节奏不变。
 */
function takePadding(res, written, padBytes, padEveryMs) {
  let state = PAD_STATES.get(res);
  if (!state) {
    state = { at: 0, bytes: 0 };
    PAD_STATES.set(res, state);
  }
  const now = Date.now();
  const pending = state.bytes + written;
  const due = padEveryMs > 0 ? now - state.at >= padEveryMs : true;
  if (pending >= padBytes) {
    // 这一发自己就越过了阈值，注释是纯浪费。
    state.bytes = 0;
    state.at = now;
    return '';
  }
  if (!due) {
    state.bytes = pending;
    return '';
  }
  const padding = ssePadding(padBytes - pending);
  state.bytes = 0;
  state.at = now;
  return padding;
}

/**
 * 写一条 SSE 记录。
 *
 * @param {object} res 响应对象（真实 http.ServerResponse，或测试里的最小假体）
 * @param {object} payload 要写进 `data:` 的内容
 * @param {object} [options]
 * @param {object} [options.frame] 宿主 mux 帧，只用于算稳定 id
 * @param {string} [options.namespace='session'] 兜底 id 的前缀
 * @param {string} [options.padding=''] 固定的 SSE 注释行（调用方自己算好时用，见 ssePadding）
 * @param {number} [options.paddingBytes=0] 让这条流维持的最小出字节数：>0 时按窗口补齐（见 takePadding）
 * @param {number} [options.padEveryMs=0] 补齐窗口；0 表示每条记录都补到 paddingBytes
 * @param {number} [options.retryMs=SSE_RETRY_MS] SSE 重连间隔
 * @param {(payload: object) => boolean} [options.shedWhenBuffered] 超过软水位时这一帧能不能丢
 * @returns {{ok: boolean, shed?: boolean, needDrain?: boolean}}
 *   `ok:false` → 这条流该收尾（客户端走了，或积压超过硬水位）；
 *   `shed:true` → 这条帧被丢掉、连接还活着；
 *   `needDrain:true` → 写成功了，但底下已经写不动，调用方要先 await 一次 drain 再继续。
 */
function writeSse(res, payload, options = {}) {
  const {
    frame = null,
    namespace = 'session',
    padding = '',
    paddingBytes = 0,
    padEveryMs = 0,
    retryMs = SSE_RETRY_MS,
    shedWhenBuffered = shedWithoutSeq,
  } = options;
  const buffered = bufferedBytesOf(res);
  if (buffered > SSE_CLOSE_BUFFERED_BYTES) return { ok: false };
  if (buffered > SSE_SHED_BUFFERED_BYTES && shedWhenBuffered(payload)) return { ok: true, shed: true };
  const id = stableEventId(payload, frame, namespace);
  const fields = [`retry: ${retryMs}`];
  if (id) fields.push(`id: ${id}`);
  fields.push(`data: ${JSON.stringify(payload)}`);
  const extra = padding || (paddingBytes > 0
    // 按字节算：正文是中文时字符数只有字节数三分之一，按字符算会低估、补多。
    ? takePadding(res, Buffer.byteLength(`${fields.join('\n')}\n`, 'utf8'), Math.floor(paddingBytes), Math.floor(padEveryMs))
    : '');
  if (extra) fields.push(extra);
  fields.push('', '');
  try {
    // `write()` 返回 false 才是背压的正信号：数据已经堆到高水位，继续写只会把内存
    // 堆起来。把它当成功吞掉，正是那次 4GB OOM 的直接原因。
    const accepted = res.write(`${fields.join('\n')}\n`);
    return { ok: true, needDrain: accepted === false };
  } catch { return { ok: false }; }
}

/**
 * 等底层把缓冲吐出去（`drain`）。背压的正解：写不动就停手，而不是继续塞。
 *
 * @returns {Promise<boolean>} 真的 drain 了 → true；超时或流被中断 → false（该收尾）。
 */
function waitForDrain(res, signal, timeoutMs = SSE_DRAIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(false);
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (typeof res.off === 'function') res.off('drain', onDrain);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const finish = (value) => { if (done) return; done = true; cleanup(); resolve(value); };
    const onDrain = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof res.once === 'function') res.once('drain', onDrain);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  SSE_RETRY_MS,
  SSE_SHED_BUFFERED_BYTES,
  SSE_CLOSE_BUFFERED_BYTES,
  SSE_DRAIN_TIMEOUT_MS,
  ssePadding,
  bufferedBytesOf,
  stableEventId,
  writeSse,
  waitForDrain,
  shedWithoutSeq,
};

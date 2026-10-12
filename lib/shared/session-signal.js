'use strict';

/**
 * 设备级「某个会话的正文水位涨了」信号总线。
 *
 * 与 list-signal.js（清单变了）是同一形状的第二条通道，存在的理由是对话页的第二种场景：
 * 手机上**没有打开**某个会话时，那条会话的正文此前完全没人订阅 —— 只有打开的会话才建
 * `session/stream`（app/src/hooks/useChatStream.ts 的唯一调用点），所以「在别的地方盯着
 * 列表」时，运行中的助手回复只能等下一次点开该会话才被拉下来。
 *
 * 而插件这边本来就把正文推到了中转镜像：镜像调度器（lib/mirror/pusher.cjs）每轮为高优先
 * 会话（运行中 / 5 分钟内动过）构建 200 条消息快照，冷会话每 500ms 轮转补一个。缺的只是
 * 「这个会话的正文又长了，你（手机）可以来取」这一句通知，本模块就是那个出口。
 *
 * 与 list-signal 的关键差别：清单信号是**全局**的（一个 revision），这条是**按会话**的
 * （sessionId → 已广播到的消息水位 seq）。水位取的是快照里**真正装上的消息的最大 seq**
 * （见 pusher 的 messageWatermarkOf），也就是 App 侧会话缓存的水位口径（同一个 seq 空间），
 * 手机拿它和自己的缓存水位一比就知道该不该增量拉一次。
 *
 * 为什么是模块级单例：生产端（mirror/pusher.cjs，CJS）与消费端（mobile/events.js，CJS）
 * 都 require 到同一个实例，两边不需要认识对方；测试可以 createSessionSignal() 造独立实例。
 * 为什么订阅者抛错要吞掉：bus 的调用方是镜像推送链，一条写坏的 SSE 连接不能把推送拖垮
 * （真故障会从连接自身的 close 反映出来）。
 */

const NOOP_RELEASE = () => {};

/**
 * 最多额外保留多少个非当前会话水位。当前完整会话清单通过 retain() 保留，不受此上限影响；
 * 这样长跑插件仍能回放所有未归档会话，同时把归档/一次性会话的尾巴限制在有限范围内。
 */
const MAX_TRACKED = 512;

function createSessionSignal() {
  const listeners = new Set();
  /** sessionId -> { seq, at }：最近一次广播出去的水位。 */
  const watermarks = new Map();
  const retainedSessionIds = new Set();

  const pruneOldest = () => {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of watermarks) {
      if (retainedSessionIds.has(key)) continue;
      if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key; }
    }
    if (oldestKey !== null) watermarks.delete(oldestKey);
    return oldestKey !== null;
  };

  const trimWatermarks = () => {
    while (watermarks.size > MAX_TRACKED && pruneOldest()) { /* keep every current session */ }
  };

  return {
    /**
     * 广播一个会话的正文水位。
     *
     * 同一个会话的水位不变（或更低）时什么都不做（幂等）：镜像推送每轮都带着所有高优先
     * 会话的快照，没有这一层判重就会变成每 500ms 给手机发一遍同样的帧。
     *
     * @param {string} sessionId
     * @param {number} seq 快照里真正装上的消息的最大 seq
     * @returns {boolean} 是否真的广播了
     */
    bump(sessionId, seq) {
      const id = typeof sessionId === 'string' ? sessionId : '';
      const value = Number(seq);
      if (!id || !Number.isFinite(value) || value <= 0) return false;
      const previous = watermarks.get(id);
      if (previous && value <= previous.seq) return false;
      const at = Date.now();
      watermarks.set(id, { seq: value, at });
      trimWatermarks();
      for (const listener of [...listeners]) {
        try { listener({ sessionId: id, seq: value, at }); } catch { /* 订阅者自己的异常不该影响推送方 */ }
      }
      return true;
    },

    /**
     * 声明当前完整、未归档会话集合；这些水位必须留到 SSE 重连回放，超出时只淘汰非当前会话。
     * 同时清除刚从权威列表消失的会话（归档/删除），避免重放幽灵水位。
     */
    retain(sessionIds) {
      const next = new Set(Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id.length > 0) : []);
      for (const id of watermarks.keys()) {
        if (!next.has(id)) watermarks.delete(id);
      }
      retainedSessionIds.clear();
      for (const id of next) retainedSessionIds.add(id);
      trimWatermarks();
      return retainedSessionIds.size;
    },

    /** 订阅水位变化；返回退订函数（可重复调用）。 */
    onBump(listener) {
      if (typeof listener !== 'function') return NOOP_RELEASE;
      listeners.add(listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
      };
    },

    /** 某个会话当前已广播到的水位（0 = 还没广播过）。 */
    peek(sessionId) {
      const entry = watermarks.get(sessionId);
      return entry ? entry.seq : 0;
    },

    /** 全部水位（供诊断面板观测）；键为 sessionId，值为 seq。 */
    snapshot() {
      const out = {};
      for (const [key, value] of watermarks) out[key] = value.seq;
      return out;
    },

    /** 测试用：清空状态。 */
    reset() {
      watermarks.clear();
      retainedSessionIds.clear();
    },
  };
}

const sessionSignal = createSessionSignal();

module.exports = { createSessionSignal, sessionSignal, MAX_TRACKED };

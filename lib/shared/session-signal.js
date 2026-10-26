'use strict';

/**
 * 设备级「某个会话的正文水位涨了」信号总线。
 *
 * 与 list-signal（清单变了）形状相同，但管的是另一种场景：手机上没打开某个会话时，那条会话
 * 的正文没人订阅，运行中的回复只能等下次点开才拉下来。插件本来就把正文推进了中转镜像，缺的
 * 只是「这个会话的正文又长了，可以来取」这句通知。
 *
 * 清单信号是全局的（一个 revision），这条是按会话的（sessionId → 已广播的消息水位 seq）。
 * 水位取快照里真正装上的消息的最大 seq，与 App 侧缓存水位同一个 seq 空间。
 *
 * 做成模块级单例：生产端与消费端 require 到同一个实例，互不认识；测试可以自己造实例。
 * 订阅者抛错要吞掉——bus 的调用方是镜像推送链，一条写坏的 SSE 连接不能把推送拖垮。
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

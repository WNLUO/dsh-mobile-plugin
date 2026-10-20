'use strict';

/**
 * 「桌面侧栏折叠态变了」的信号总线。
 *
 * 桌面端那份 groupExpansion 只活在浏览器 localStorage 里，插件靠客户端半边轮询上报
 * （lib/client.js 每 2 秒读一次，变了才 POST /api/relay/desktop-view），落到
 * lib/desktop-view.cjs。手机要看这份镜像只有一条路：GET /api/mobile/v1/desktop-view。
 *
 * 过去 App 按一个 5 分钟最短间隔去问它 —— 因为没有任何「它变了」的信号可用：列表
 * revision 只哈希会话与工作区，桌面改折叠不动它。那套是「猜一个足够长的周期」，
 * 稳态下一天白问几百次。本模块给出真正的出口：上报落盘且**内容真变了**时广播一次，
 * 设备级流立刻推给手机，App 收到才拉。
 *
 * 与 list-signal 同款模块级单例：生产端（desktop-view.cjs）与消费端
 * （mobile/events.js）不需要互相认识；测试用 createDesktopViewSignal() 造独立实例。
 *
 * 内容没变不广播：客户端半边会重复 POST 同一份（页面重载、切窗口都会重来一次），
 * 每次都给每台手机推一帧，等于把「5 分钟一问」换成「一上报一帧」。
 */

const NOOP_RELEASE = () => {};

function createDesktopViewSignal() {
  const listeners = new Set();
  let updatedAt = 0;
  let at = 0;

  return {
    /**
     * 广播一次折叠态变更。同一个 updatedAt 连着广播两次只算一次（幂等）。
     *
     * @param {number} nextUpdatedAt 快照的 receivedAt（desktop-view.cjs 落盘时的时间）
     * @returns {boolean} 是否真的广播了
     */
    bump(nextUpdatedAt) {
      const value = Number(nextUpdatedAt) || 0;
      if (value && value === updatedAt) return false;
      updatedAt = value;
      at = Date.now();
      for (const listener of [...listeners]) {
        try { listener({ updatedAt, at }); } catch { /* 订阅者自己的异常不该影响上报链路 */ }
      }
      return true;
    },

    /** 订阅变更；返回退订函数（可重复调用）。 */
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

    /** 最近一次变更（供断流重连后的补发与诊断）。 */
    snapshot() { return { updatedAt, at }; },
  };
}

const desktopViewSignal = createDesktopViewSignal();

module.exports = { createDesktopViewSignal, desktopViewSignal };

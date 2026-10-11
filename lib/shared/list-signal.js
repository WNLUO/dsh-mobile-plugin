'use strict';

/**
 * 设备级「清单变了」信号总线：插件内部唯一一条「有内容值得让手机立刻刷新」的通道。
 *
 * 存在的理由（真机现象）：侧边栏的实时性此前完全押在设备级 SSE 上，而那条流在宿主的
 * 0.2.0 兼容桥里只订阅了 workspace/follow 与 session/control —— 会话状态变化表现为
 * session/projection 帧，被手机侧白名单（lib/mobile/events.js 的 listRelevantPayload）
 * 丢掉。于是流「连着但一句话都不说」，App 却因为 open 就把兜底轮询从 15s 降到 60s，
 * 侧栏变成一分钟才动一次。
 *
 * 而插件这边**本来就知道列表何时变了**：镜像推送调度器（lib/mirror/pusher.cjs）每
 * 500ms 完整构建一次会话清单，清单自带内容指纹 revision。缺的只是「把这件事说给手机
 * 听」的出口，本模块就是那个出口。
 *
 * 为什么是模块级单例而不是 ctx 上的服务：生产端（pusher.cjs，CJS）与消费端
 * （mobile/events.js，CJS）都通过 require 拿到同一个实例，两边都不需要认识对方；
 * 测试可以 createListSignal() 造一个独立实例注入。
 *
 * 为什么订阅者抛错要被吞掉：bus 的调用方是推送调度器的 500ms tick，一个写坏的 SSE
 * 连接不能把镜像推送整条链拖垮（真故障会从连接自身的 close 反映出来）。
 */

const NOOP_RELEASE = () => {};

function createListSignal() {
  const listeners = new Set();
  let watchers = 0;
  let revision = '';
  let at = 0;

  return {
    /**
     * 广播一次清单变更。同一个 revision 连着广播两次只算一次（幂等）。
     *
     * @param {string} nextRevision 清单内容指纹（lib/shared/list-revision.js 的 listRevision）
     * @returns {boolean} 是否真的广播了
     */
    bump(nextRevision) {
      const value = typeof nextRevision === 'string' ? nextRevision : '';
      if (value && value === revision) return false;
      revision = value;
      at = Date.now();
      for (const listener of [...listeners]) {
        try { listener({ revision, at }); } catch { /* 订阅者自己的异常不该影响推送方 */ }
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

    /**
     * 登记一个「有人在听」的观众（每条设备级 SSE 连接一个），返回注销函数。
     *
     * watching() 决定推送调度器在**隧道断开**时还要不要空转构建：没有观众时那份快照
     * 没有任何去处，构建纯属浪费；有观众时它是手机唯一的变更来源，必须继续构建。
     */
    watch() {
      watchers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers = Math.max(0, watchers - 1);
      };
    },

    watching() { return watchers > 0; },

    /** 最近一次变更（供诊断面板观测）。 */
    snapshot() { return { revision, at }; },
  };
}

const listSignal = createListSignal();

module.exports = { createListSignal, listSignal };

// 桌面网络变化与系统唤醒检测，不依赖手机蜂窝网络分类。
// 2026-11-19：网卡集合变化先等 800ms 落定再采纳（窗口内再变就重置计时、合并成一次），
// 唤醒只按时间跳变单独上报、不参与去抖；onChange 增加 lost 标记（上一轮有外网卡、这一轮全空），
// 只取 reason 的旧调用不受影响。
'use strict';

const os = require('node:os');

/** 换网稳定窗口：两步式切网（旧网先断、新网再连）在窗口内落定，只拆一次连接。 */
const NETWORK_SETTLE_MS = 800;

function interfacesOf(read = os.networkInterfaces) {
  const rows = [];
  for (const [name, addresses] of Object.entries(read() || {})) {
    for (const entry of addresses || []) {
      if (entry.internal) continue;
      rows.push([name, entry.family, entry.address, entry.netmask, entry.scopeid || 0].join('|'));
    }
  }
  return rows.sort();
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createNetworkMonitor({ onChange = () => {}, onTick = () => {}, now = Date.now, interfaces = os.networkInterfaces, intervalMs = 5000, settleMs = NETWORK_SETTLE_MS } = {}) {
  let previous = interfacesOf(interfaces);
  let last = now();
  let running = false;
  let closed = false;

  // 等网卡集合落定：窗口内又变了就重置计时，最终只采纳稳定后的那一份。
  async function settledAfter(current) {
    let settled = current;
    for (;;) {
      await delay(settleMs);
      if (closed) return null;
      const next = interfacesOf(interfaces);
      if (sameSet(next, settled)) return settled;
      settled = next;
    }
  }

  async function poll() {
    if (closed || running) return;
    running = true;
    try {
      const currentTime = now();
      const current = interfacesOf(interfaces);
      const changed = !sameSet(current, previous);
      const woke = currentTime - last > intervalMs * 3 || currentTime < last;
      if (changed) {
        const settled = await settledAfter(current);
        if (!settled) return;
        last = currentTime;
        // 窗口内又变回原样：这一步不算换网，不采纳，也不误报丢网。
        if (!sameSet(settled, previous)) {
          const lost = previous.length > 0 && settled.length === 0;
          previous = settled;
          void Promise.resolve(onChange({ reason: 'network', lost })).catch(() => {});
        }
      } else if (woke) {
        last = currentTime;
        // 网卡集合没变，只是时间跳变（系统睡眠后醒来）：不参与去抖，也永远不是丢网。
        void Promise.resolve(onChange({ reason: 'wake', lost: false })).catch(() => {});
      } else {
        last = currentTime;
      }
      await onTick(currentTime);
    } finally { running = false; }
  }

  const timer = setInterval(() => { void poll().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { poll, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createNetworkMonitor, interfacesOf, NETWORK_SETTLE_MS };

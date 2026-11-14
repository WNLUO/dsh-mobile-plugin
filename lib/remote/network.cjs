// 桌面网络变化与系统唤醒检测，不依赖手机蜂窝网络分类。
'use strict';

const os = require('node:os');

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

function createNetworkMonitor({ onChange = () => {}, onTick = () => {}, now = Date.now, interfaces = os.networkInterfaces, intervalMs = 5000 } = {}) {
  let previous = interfacesOf(interfaces);
  let last = now();
  let running = false;
  let closed = false;

  async function poll() {
    if (closed || running) return;
    running = true;
    try {
      const currentTime = now();
      const current = interfacesOf(interfaces);
      const changed = current.length !== previous.length || current.some((value, index) => value !== previous[index]);
      const woke = currentTime - last > intervalMs * 3 || currentTime < last;
      previous = current; last = currentTime;
      if (changed || woke) void Promise.resolve(onChange({ reason: changed ? 'network' : 'wake' })).catch(() => {});
      await onTick(currentTime);
    } finally { running = false; }
  }

  const timer = setInterval(() => { void poll().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { poll, close() { closed = true; clearInterval(timer); } };
}

module.exports = { createNetworkMonitor, interfacesOf };

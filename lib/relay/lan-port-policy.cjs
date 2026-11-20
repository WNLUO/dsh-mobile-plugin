'use strict';
// 固定入口禁止漂移；新端口仅在监听和发现发布成功后保存。

function lanPortLockReason(state, forwarding = false) {
  if (state.lanPortFixed === true) return 'fixed';
  if (forwarding || state.manualLanUrl || state.manualIpv6Url || state.manualTcpUrl) return 'forwarding';
  return '';
}

function canChangeLanPort(store, instanceId) {
  store.refresh?.();
  const rows = store.listActive().filter(row => row.instanceId === instanceId && row.kind !== 'computer');
  return rows.length > 0 && rows.every(row => row.lanDiscovery === 1);
}

function createLanPortPolicy({ state, saveState }) {
  let adjusted = false;
  let changedAt = 0;
  let recoveredAt = 0;
  return {
    port: () => state.lanPort,
    resolve: () => Promise.resolve(state.lanPort),
    adjusted: () => adjusted,
    apply(lan) {
      if (lan?.state !== 'listening' || !Number.isInteger(lan.port) || lan.port < 1024 || lan.port > 65535) return;
      if (lan.port === state.lanPort) return;
      if (lan.requestedPort !== state.lanPort) return;
      saveState({ ...state, lanPort: lan.port });
      state.lanPort = lan.port;
      adjusted = true;
      changedAt = Date.now();
      recoveredAt = 0;
    },
    noteAuthorized(req, channel) {
      if (channel !== 'lan' || !changedAt) return;
      const host = String(req?.headers?.host || '');
      if (Number(host.match(/:(\d+)$/)?.[1]) === state.lanPort) recoveredAt = Date.now();
    },
    recovery: () => ({ changedAt, recoveredAt, state: !changedAt ? 'unchanged' : recoveredAt ? 'verified' : 'awaiting-device' }),
  };
}

module.exports = { lanPortLockReason, canChangeLanPort, createLanPortPolicy };

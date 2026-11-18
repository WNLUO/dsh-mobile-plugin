'use strict';
// 由 App 通道表同步；运行 scripts/sync-route-policy.mjs 更新。
function createRouteChannels() {
  const exports = {};
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ROUTE_CHANNELS = void 0;
  exports.ROUTE_CHANNELS = [
      { channel: 'lan', backoffThreshold: 2, budget: 'lan' },
      { channel: 'ipv6', backoffThreshold: 2, budget: 'lan' },
      { channel: 'relay', backoffThreshold: 2, budget: 'lan' },
      { channel: 'tunnel', backoffThreshold: 1, budget: 'tunnel' },
      { channel: 'p2p', backoffThreshold: 1, budget: 'tunnel' },
      { channel: 'tcp', backoffThreshold: 2, budget: 'tunnel' },
  ];

  return exports;
}
module.exports = { createRouteChannels, ...createRouteChannels() };

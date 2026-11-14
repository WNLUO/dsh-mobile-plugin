'use strict';
// 桌面策略直接同步手机规则；各设备的失败、滞回和身份结论不得互相污染。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRoutePolicy } = require('../lib/shared/route-order.cjs');
const routes = [{ url: 'http://lan', channel: 'lan' }, { url: 'https://relay', channel: 'relay' }];
test('生成策略与手机源一致，不能独立漂移', () => {
  const source = path.resolve(__dirname, '../../app/src/services/viewmodels/route-order.ts');
  if (!fs.existsSync(source)) return;
  const result = spawnSync(process.execPath, ['scripts/sync-route-policy.mjs', '--check'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
test('稳定正常线路不会为几毫秒收益换线，明显更快的线路可以接管下一连接', () => {
  const policy = createRoutePolicy();
  policy.noteRouteLatency(routes[0].url, 3);
  policy.noteRouteLatency(routes[1].url, 1);
  assert.equal(policy.orderRouteCandidates(routes, routes[0].url)[0].url, routes[0].url);
  policy.forgetRouteFacts();
  policy.noteRouteLatency(routes[0].url, 300);
  policy.noteRouteLatency(routes[1].url, 80);
  assert.equal(policy.orderRouteCandidates(routes, routes[0].url)[0].url, routes[1].url);
});
test('同地址不同设备的失败与外来身份不会互相污染，换网可清除旧证据', () => {
  const a = createRoutePolicy();
  const b = createRoutePolicy();
  a.noteRouteForeign(routes[0].url);
  a.noteRouteLatency(routes[1].url, 100);
  b.noteRouteLatency(routes[0].url, 1);
  assert.equal(a.orderRouteCandidates(routes)[0].url, routes[1].url);
  assert.equal(b.orderRouteCandidates(routes)[0].url, routes[0].url);
  a.forgetRouteFacts();
  assert.equal(a.isRouteForeign(routes[0].url), false);
  assert.equal(a.routeLatencyOf(routes[1].url), null);
});

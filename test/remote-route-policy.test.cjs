'use strict';
// 桌面策略直接同步手机规则；各设备的失败、滞回和身份结论不得互相污染。
// 2026-11-19：通道顺序、失败阈值与建连档位改从同步的通道表派生，--check 同时校验选路规则与通道表。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { createRoutePolicy } = require('../lib/shared/route-order.cjs');
const { ROUTE_CHANNELS } = require('../lib/shared/route-channels.cjs');
const routes = [{ url: 'http://lan', channel: 'lan' }, { url: 'https://relay', channel: 'relay' }];

/** 按同步脚本同一套转译，取出 App 通道表在运行时的通道顺序；App 源不在（独立检出）回 null。 */
function appChannelOrder() {
  const source = path.resolve(__dirname, '../../app/src/services/viewmodels/route-channels.ts');
  if (!fs.existsSync(source)) return null;
  const ts = createRequire(path.resolve(__dirname, '../React/package.json'))('typescript');
  const out = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
  }).outputText;
  return [...out.matchAll(/channel:\s*'([^']+)'/g)].map((match) => match[1]);
}

test('生成策略与手机源一致，不能独立漂移（--check 覆盖选路规则与通道表）', () => {
  const source = path.resolve(__dirname, '../../app/src/services/viewmodels/route-order.ts');
  if (!fs.existsSync(source)) return;
  const result = spawnSync(process.execPath, ['scripts/sync-route-policy.mjs', '--check'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
test('生成通道表存在且与选路规则共用同一套同步口径', () => {
  assert.ok(fs.existsSync(path.resolve(__dirname, '../lib/shared/route-channels.cjs')));
  assert.ok(ROUTE_CHANNELS.length > 0);
  assert.ok(ROUTE_CHANNELS.every((row) => typeof row.channel === 'string'
    && typeof row.backoffThreshold === 'number' && ['lan', 'tunnel'].includes(row.budget)));
});
test('生成的通道表顺序与 App 源一致', () => {
  const order = appChannelOrder();
  if (order === null) return;
  assert.deepEqual(ROUTE_CHANNELS.map((row) => row.channel), order);
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

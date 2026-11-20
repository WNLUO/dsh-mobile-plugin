// 桌面同步纯核按scope隔离，显式轮次与Verified/Proven分别守住证据和业务账。
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
  // T01 明确要求挑战者两格新鲜样本，单样本只准首连，不据此切掉既有线路。
  policy.advanceRouteEvidenceRound(2, 2);
  policy.noteRouteLatency(routes[0].url, 300);
  policy.noteRouteLatency(routes[1].url, 80);
  assert.equal(policy.orderRouteCandidates(routes, routes[0].url)[0].url, routes[0].url);
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

test('同一策略工厂内显式scope隔离，默认空scope兼容旧调用且只清指定设备', () => {
  const policy = createRoutePolicy();
  policy.advanceRouteEvidenceRound(2, 2, 'device-a');
  policy.noteRouteLatency(routes[0].url, 100, null, 'device-a');
  policy.noteRouteFailure(routes[0].url, 'device-a');
  policy.noteRouteForeign(routes[1].url, 'device-a');
  policy.noteRouteLatency(routes[0].url, 1, null, 'device-b');
  policy.noteRouteLatency(routes[0].url, 30);
  assert.equal(policy.routeCostOf(routes[0].url, 'device-a'), 150);
  assert.equal(policy.routeCostOf(routes[0].url, 'device-b'), 1);
  assert.equal(policy.routeCostOf(routes[0].url), 30);
  assert.equal(policy.isRouteForeign(routes[1].url, 'device-b'), false);
  assert.equal(policy.isRouteForeign(routes[1].url), false);
  policy.forgetRouteFacts('device-a');
  assert.equal(policy.routeLatencyOf(routes[0].url, 'device-a'), null);
  assert.equal(policy.routeLatencyOf(routes[0].url, 'device-b'), 1);
  assert.equal(policy.routeLatencyOf(routes[0].url), 30);
});

test('Verified只解除身份排除，Proven才清业务失败，探测缺发数或null都不洗丢包', () => {
  const policy = createRoutePolicy();
  const scope = 'instance';
  const url = routes[0].url;
  policy.advanceRouteEvidenceRound(2, 2, scope);
  policy.noteRouteLatency(url, 100, { ok: 1, attempts: 2 }, scope);
  policy.noteRouteFailure(url, scope);
  policy.noteRouteForeign(url, scope);
  policy.noteRouteLatency(url, 100, undefined, scope);
  policy.noteRouteLatency(url, null, undefined, scope);
  assert.equal(policy.routeCostOf(url, scope), 300);
  assert.equal(policy.isRouteForeign(url, scope), true);
  policy.noteRouteVerified(url, scope);
  assert.equal(policy.isRouteForeign(url, scope), false);
  assert.equal(policy.routeCostOf(url, scope), 300);
  policy.noteRouteProven(url, scope);
  assert.equal(policy.routeCostOf(url, scope), 200, '真实成功也不能抹掉实测丢包');
});

test('常态轮次显式前进，密集采样与排序不使另一条证据过期', () => {
  const policy = createRoutePolicy();
  const scope = 'rounds';
  policy.advanceRouteEvidenceRound(2, 1, scope);
  policy.noteRouteLatency(routes[0].url, 100, null, scope);
  policy.noteRouteLatency(routes[1].url, 1, null, scope);
  for (let i = 0; i < 50; i++) {
    policy.noteRouteLatency(routes[0].url, 100, null, scope);
    assert.equal(policy.orderRouteCandidates(routes, '', [], scope)[0].url, routes[1].url);
  }
  for (let i = 0; i < 5; i++) policy.advanceRouteEvidenceRound(2, 1, scope);
  assert.equal(policy.orderRouteCandidates(routes, '', [], scope)[0].url, routes[0].url, '两轮完整轮转覆盖后证据才过期');
});

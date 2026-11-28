'use strict';
// 外壳能力契约的读取端：老/缺失/脏的一律降级为 legacy，别让代因为外壳旧就崩。
const test = require('node:test');
const assert = require('node:assert/strict');
const { readShellCompat } = require('../lib/shell-compat.cjs');

test('外壳能力契约：老外壳不报版本时一律降级（legacy）', () => {
  const cases = [
    null,
    undefined,
    {},
    { status: () => ({}) },
    { shellApiVersion: 'x', shellCapabilities: 'nope' },
    { shellApiVersion: -1, shellCapabilities: [] },
  ];
  for (const raw of cases) {
    const c = readShellCompat(raw);
    assert.equal(c.apiVersion, 0);
    assert.equal(c.legacy, true);
    assert.equal(c.has('route-dispatch'), false);
    assert.equal(c.atLeast(1), false);
    assert.deepEqual(c.capabilities, []);
  }
});

test('外壳能力契约：按外壳报出来的版本与能力判定', () => {
  const runtime = {
    status: () => ({ shellApiVersion: 2, shellCapabilities: ['route-dispatch', 'transport-hosts', 42, null] }),
  };
  const c = readShellCompat(runtime);
  assert.equal(c.apiVersion, 2);
  assert.equal(c.legacy, false);
  assert.equal(c.has('route-dispatch'), true);
  assert.equal(c.has('transport-hosts'), true);
  assert.equal(c.has('nope'), false);
  assert.equal(c.atLeast(2), true);
  assert.equal(c.atLeast(3), false);
  assert.deepEqual(c.capabilities, ['route-dispatch', 'transport-hosts'], '脏值要滤掉');
});

test('外壳能力契约：直接传 status() 的结果也认', () => {
  const c = readShellCompat({ shellApiVersion: 1, shellCapabilities: ['host-half'] });
  assert.equal(c.apiVersion, 1);
  assert.equal(c.legacy, false);
  assert.equal(c.has('host-half'), true);
});

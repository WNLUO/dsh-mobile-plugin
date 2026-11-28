'use strict';
// 更新前的「隧道助手闸」：Windows 停不掉就拦下这一轮，其它平台不碰。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const GATE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'shell', 'tailcat-gate.js')).href;

test('隧道助手闸：非 Windows 直接放行，不碰控制服务', async () => {
  const { createTailcatGate } = await import(GATE_URL);
  let calls = 0;
  const gate = createTailcatGate({
    platform: 'darwin',
    getControl: () => ({ stop() { calls += 1; }, start() { calls += 1; } }),
  });
  assert.deepEqual(await gate.stop(), { ok: true, stopped: false });
  assert.equal(calls, 0, '非 Windows 不该去停隧道助手');
  await gate.resume();
  assert.equal(calls, 0, '没停过就没必要恢复');
});

test('隧道助手闸：Windows 停得掉就放行并恢复；停不掉返回 ok:false 拦下这一轮', async () => {
  const { createTailcatGate } = await import(GATE_URL);
  let stopped = 0;
  let started = 0;
  const status = { running: true };
  const gate = createTailcatGate({
    platform: 'win32',
    getControl: () => ({
      stop() { stopped += 1; status.running = false; },
      start() { started += 1; status.running = true; },
      status: () => status,
    }),
  });
  assert.deepEqual(await gate.stop(), { ok: true, stopped: true });
  assert.deepEqual(await gate.stop(), { ok: true, stopped: false }, '已经停过就不再重复停');
  assert.equal(stopped, 1);
  await gate.resume();
  assert.equal(started, 1, '装完要把助手拉回来');

  const bad = createTailcatGate({
    platform: 'win32',
    getControl: () => ({ stop() { throw new Error('exe busy'); } }),
  });
  const result = await bad.stop();
  assert.equal(result.ok, false);
  assert.match(String(result.error), /exe busy/);
});

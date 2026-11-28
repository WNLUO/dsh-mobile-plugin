'use strict';
// 可选线路通用登记表：同指纹沿用、指纹变了重建、卸载全撤、control 转发、建实例失败不炸。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync } = require('node:fs');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'lib', 'shell', 'optional-lines.js')).href;

/** 一个最小的外壳 ctx：只用到 effect（登记并在 disposeAll 时按逆序撤销）。 */
function makeCtx() {
  const disposers = [];
  return {
    effect(fn) {
      const off = fn();
      const d = typeof off === 'function' ? off : () => {};
      disposers.push(d);
      return d;
    },
    reflect: { provide() {} },
    disposeAll() {
      while (disposers.length) {
        const d = disposers.pop();
        try { d(); } catch { /* ignore */ }
      }
    },
  };
}

test('可选线路登记表：同指纹沿用、指纹变了重建、卸载全撤', async () => {
  const { createOptionalLineRegistry } = await import(MODULE_URL);
  const ctx = makeCtx();
  const reg = createOptionalLineRegistry({ ctx, warn() {} });
  let mounted = 0;
  let stopped = 0;
  const mount = () => { mounted += 1; return { stop() { stopped += 1; } }; };

  const a = reg.adopt({ name: 'demo', fingerprint: 'fp1', mount });
  assert.equal(mounted, 1);
  assert.equal(reg.get('demo'), a);
  assert.equal(reg.adopt({ name: 'demo', fingerprint: 'fp1', mount }), a, '同指纹必须沿用同一个实例');
  assert.equal(mounted, 1, '同指纹不该重建');

  const b = reg.adopt({ name: 'demo', fingerprint: 'fp2', mount });
  assert.notEqual(b, a, '指纹变了要换新实例');
  assert.equal(mounted, 2);
  assert.equal(stopped, 1, '旧实例要停掉');

  ctx.disposeAll();
  assert.equal(stopped, 2, '卸载时当前实例也要停掉');
  assert.equal(reg.get('demo'), null, '卸载后登记表要清空');
});

test('可选线路登记表：同指纹只刷新取值器、不重建，实例读到新值', async () => {
  const { createOptionalLineRegistry } = await import(MODULE_URL);
  const ctx = makeCtx();
  const reg = createOptionalLineRegistry({ ctx, warn() {} });
  let mountCount = 0;
  const mount = bag => {
    mountCount += 1;
    return { read: () => (bag.provider('port') ? bag.provider('port')() : null), stop() {} };
  };
  const door = reg.adopt({ name: 'p', fingerprint: 'f', providers: { port: () => 1 }, mount });
  assert.equal(door.read(), 1);
  reg.adopt({ name: 'p', fingerprint: 'f', providers: { port: () => 2 } });
  assert.equal(door.read(), 2, '同指纹刷新取值器后，实例要读到新值');
  assert.equal(mountCount, 1, '刷新取值器不该重建实例');
  ctx.disposeAll();
});

test('可选线路登记表：control 把停/起/查转发到当前实例', async () => {
  const { createOptionalLineRegistry } = await import(MODULE_URL);
  const ctx = makeCtx();
  const reg = createOptionalLineRegistry({ ctx, warn() {} });
  const calls = [];
  reg.adopt({
    name: 'c',
    fingerprint: 'x',
    mount: () => ({
      start() { calls.push('start'); },
      stop() { calls.push('stop'); return Promise.resolve(); },
      status() { calls.push('status'); return { running: true }; },
    }),
  });
  const ctl = reg.control('c');
  ctl.start();
  const st = ctl.status();
  await ctl.stop();
  assert.deepEqual(calls, ['start', 'status', 'stop']);
  assert.deepEqual(st, { running: true });
  ctx.disposeAll();
});

test('可选线路登记表：某条线路建实例失败不炸整表，其余照常', async () => {
  const { createOptionalLineRegistry } = await import(MODULE_URL);
  const ctx = makeCtx();
  const warnings = [];
  const reg = createOptionalLineRegistry({ ctx, warn: (...a) => warnings.push(a.join(' ')) });
  assert.equal(reg.adopt({ name: 'bad', fingerprint: 'f', mount: () => { throw new Error('boom'); } }), null);
  assert.equal(reg.get('bad'), null);
  assert.ok(warnings.some(w => /bad/.test(w)), '失败要有一条告警');
  const ok = reg.adopt({ name: 'good', fingerprint: 'f', mount: () => ({ stop() {} }) });
  assert.ok(ok, '一条失败不影响别的线路');
  ctx.disposeAll();
});

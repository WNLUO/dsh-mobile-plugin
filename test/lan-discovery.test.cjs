'use strict';
// 发现名片不含凭据；发布成功、失败和关闭的事实决定是否允许迁移入口。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLanDiscovery } = require('../lib/relay/lan-discovery.cjs');

test('发布当前端口和实例标识，关闭后清理服务与 socket', async () => {
  let options; let stopped = 0; let destroyed = 0;
  const service = new EventEmitter(); service.stop = done => { stopped += 1; done(); };
  const discovery = createLanDiscovery({ instanceId: 'paired-host', makeBonjour: () => ({
    publish: value => { options = value; queueMicrotask(() => service.emit('up')); return service; },
    destroy: () => { destroyed += 1; },
  }) });
  assert.equal(await discovery.publish(23456), true);
  assert.deepEqual(options.txt, { id: 'paired-host', v: '1' });
  assert.equal(options.type, 'dsh-mobile'); assert.equal(options.port, 23456);
  assert.equal(discovery.snapshot().state, 'ready');
  await discovery.stop();
  assert.equal(stopped, 1); assert.equal(destroyed, 1);
  assert.equal(discovery.snapshot().state, 'off');
});

test('发现发布失败与超时不报 ready，后续 socket 故障也如实变 error', async () => {
  const failed = createLanDiscovery({ makeBonjour: () => { throw new Error('UDP unavailable'); } });
  assert.equal(await failed.publish(23456), false);
  assert.equal(failed.snapshot().state, 'error');
  const timed = createLanDiscovery({ timeoutMs: 5, makeBonjour: () => ({ publish: () => new EventEmitter(), destroy() {} }) });
  assert.equal(await timed.publish(23456), false);
  assert.match(timed.snapshot().error, /超时/); await timed.stop();
  let fail;
  const service = new EventEmitter(); service.stop = done => done();
  const live = createLanDiscovery({ makeBonjour: callback => {
    fail = callback;
    return { publish: () => { queueMicrotask(() => service.emit('up')); return service; }, destroy() {} };
  } });
  await live.publish(23456); fail(new Error('socket closed'));
  assert.equal(live.snapshot().state, 'error'); await live.stop();
});

// 发现名片不含凭据；发布、退订和底层错误决定入口迁移事实。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createLanDiscovery, bindLanEndpoint } = require('../lib/relay/lan-discovery.cjs');
const file = require.resolve('../lib/relay/lan-discovery.cjs');
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function mutate(before, after) {
  const raw = fs.readFileSync(file, 'utf8');
  const source = raw.replace(before, after);
  assert.notEqual(source, raw);
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source)(createRequire(file), loaded, loaded.exports);
  return loaded.exports;
}

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

async function assertUdpError(create = createLanDiscovery) {
  const mdns = new EventEmitter();
  const service = new EventEmitter(); service.stop = done => done();
  const discovery = create({ makeBonjour: () => ({ server: { mdns }, publish: () => service, destroy() {} }) });
  const pending = discovery.publish(23456);
  try {
    await flush();
    const denied = Object.assign(new Error('bind EACCES 0.0.0.0:5353'), { code: 'EACCES' });
    assert.doesNotThrow(() => mdns.emit('error', denied));
    assert.equal(await pending, false);
    assert.equal(discovery.snapshot().state, 'error');
    assert.match(discovery.snapshot().error, /EACCES.*5353/);
  } finally { await discovery.stop(); await pending; }
  assert.equal(mdns.listenerCount('error'), 0, '已销毁实例必须退订底层错误');
}
test('底层 UDP 拒绝绑定会结束发布，关闭后退订错误监听', async () => { await assertUdpError(); });

test('真实 Bonjour 的 UDP 绑定错误通过底层事件结束发布', async () => {
  const { Bonjour } = require('bonjour-service');
  const socket = new EventEmitter(); let closed = 0; let client;
  socket.bind = () => queueMicrotask(() => socket.emit('error', Object.assign(new Error('bind EACCES 0.0.0.0:5353'), { code: 'EACCES' })));
  socket.close = done => { closed += 1; done?.(); };
  const discovery = createLanDiscovery({ makeBonjour: onError => { client = new Bonjour({ socket }, onError); return client; } });
  try {
    assert.equal(await discovery.publish(23456), false);
    assert.match(discovery.snapshot().error, /EACCES.*5353/);
  } finally { await discovery.stop(); }
  assert.equal(closed, 1);
  assert.equal(client.server.mdns.listenerCount('error'), 0);
});

test('底层 UDP 就绪后失败仍报告 error，旧实例错误不能覆盖下一轮', async () => {
  const instances = [];
  const discovery = createLanDiscovery({ makeBonjour: () => {
    const mdns = new EventEmitter(); const service = new EventEmitter(); service.stop = done => done();
    instances.push({ mdns, service });
    return { server: { mdns }, publish: () => { queueMicrotask(() => service.emit('up')); return service; }, destroy() {} };
  } });
  try {
    assert.equal(await discovery.publish(18787), true);
    const [old] = instances; const oldError = old.mdns.listeners('error')[0];
    old.mdns.emit('error', new Error('UDP socket failed'));
    assert.match(discovery.snapshot().error, /UDP socket failed/);
    assert.equal(await discovery.publish(23456), true);
    assert.equal(old.mdns.listenerCount('error'), 0);
    oldError(new Error('late UDP error'));
    assert.equal(discovery.snapshot().state, 'ready');
    assert.equal(discovery.snapshot().error, null);
  } finally { await discovery.stop(); }
});

async function assertSharedStop(create = createLanDiscovery) {
  const instances = [];
  const discovery = create({ makeBonjour: () => {
    const service = new EventEmitter();
    const instance = { destroyed: false, finishStop: null };
    service.stop = done => { instance.finishStop = done; };
    instances.push(instance);
    return { publish: () => { queueMicrotask(() => service.emit('up')); return service; }, destroy() { instance.destroyed = true; } };
  } });
  let reopening; let next; let stopping; let stopped = false;
  try {
    assert.equal(await discovery.publish(18787), true);
    reopening = discovery.publish(23456);
    stopping = discovery.stop().then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false, '重复关闭也必须等待旧服务退订');
    next = discovery.publish(34567);
    await flush();
    assert.equal(instances.length, 1, '旧 socket 销毁前不能创建下一轮发现');
    instances[0].finishStop();
    await stopping;
    assert.equal(await reopening, false, '已取消的初始化必须完成为 false');
    assert.equal(await next, true);
    assert.equal(instances[0].destroyed, true);
    assert.equal(instances.length, 2);
  } finally {
    for (const instance of instances) instance.finishStop?.();
    await reopening;
    const ending = discovery.stop();
    for (const instance of instances) instance.finishStop?.();
    await ending; await next; await stopping;
  }
}
test('并发 stop 与重新发布等待同一次退订，旧初始化完成为 false', async () => { await assertSharedStop(); });

test('发布中的 stop 立即完成等待，迟到 up 不恢复 ready', async () => {
  const service = new EventEmitter(); service.stop = done => done();
  const discovery = createLanDiscovery({ makeBonjour: () => ({ publish: () => service, destroy() {} }) });
  const pending = discovery.publish(23456);
  await flush();
  await discovery.stop();
  assert.equal(await pending, false);
  service.emit('up');
  assert.equal(discovery.snapshot().state, 'off');
});

async function assertFailureReason(bind = bindLanEndpoint) {
  const discovery = createLanDiscovery({ makeBonjour: () => { throw new Error('UDP bind EACCES'); } });
  const stopped = [];
  const args = { requestedPort: 18787, retryDelays: [], instanceId: 'host', discovery,
    store: { listActive: () => [{ instanceId: 'host', lanDiscovery: 1 }] },
    createProxy: port => ({
      start: async () => { if (port) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); },
      stop: async () => { stopped.push(port); }, port: () => port || 23456,
    }),
  };
  await assert.rejects(bind(args), error => {
    assert.match(error.message, /新端口已释放/);
    assert.match(error.message, /UDP bind EACCES/);
    assert.match(error.message, /保留原端口配置/);
    return true;
  });
  assert.deepEqual(stopped, [18787, 0]);
  assert.equal(discovery.snapshot().state, 'off');
}
test('新入口发布失败关闭监听后，返回错误仍保留底层原因', async () => { await assertFailureReason(); });

test('变异：丢掉 UDP 错误监听会被同一行为断言拒绝', async () => {
  const changed = mutate("mdns.on('error', fail);", '');
  await assert.rejects(assertUdpError(changed.createLanDiscovery), { code: 'ERR_ASSERTION' });
});

test('变异：重复 stop 提前完成会被同一退订断言拒绝', async () => {
  const changed = mutate('if (stopping) return stopping;', '');
  await assert.rejects(assertSharedStop(changed.createLanDiscovery), { code: 'ERR_ASSERTION' });
});

test('变异：清理前不保存底层原因会被同一错误断言拒绝', async () => {
  const changed = mutate('const discoveryError = discovery.snapshot?.().error;', 'const discoveryError = null;');
  await assert.rejects(assertFailureReason(changed.bindLanEndpoint), { code: 'ERR_ASSERTION' });
});

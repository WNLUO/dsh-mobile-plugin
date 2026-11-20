// 验证两类隧道装配门面的启用意图、就绪与启动失败，并用同一行为断言拒绝变异。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const TYPES = ['tailcat', 'p2p'];
const flush = () => new Promise(setImmediate);

// 沿用 lan-mux-liveness 的源码装载与依赖假体，只替换监听器和助手会话。
function fixture(type, options = {}, mutate = source => source) {
  const file = require.resolve(`../lib/${type}/wiring.cjs`);
  const anchored = createRequire(file);
  const loaded = { exports: {} };
  let state = { [`${type}Enabled`]: true };
  const seen = { forwarderStarts: 0, ingressStarts: 0, sessions: [], warnings: [], cleanups: [] };
  const forwarder = {
    start() { seen.forwarderStarts += 1; return options.forwarderStart ? options.forwarderStart() : Promise.resolve(40911); },
    port: () => 40911,
    close() {},
  };
  const ingress = {
    start() { seen.ingressStarts += 1; return options.ingressStart ? options.ingressStart() : Promise.resolve(40912); },
    close() {},
  };
  const createSession = config => {
    if (options.sessionError) throw options.sessionError;
    const session = {
      ready: false,
      status: () => ({ available: true, enabled: config.readState()[`${type}Enabled`] === true,
        ready: session.ready, error: '' }),
      start() { if (options.startError) throw options.startError; },
      watch() {}, unwatch() {}, stop: () => Promise.resolve(),
    };
    seen.sessions.push(session);
    return session;
  };
  vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), {
    module: loaded, exports: loaded.exports,
    require: name => {
      if (name === '../relay/tunnel-forwarder.cjs') return { createTunnelForwarder(config) {
        if (options.forwarderError) throw options.forwarderError;
        seen.forwarderConfig = config; return forwarder;
      } };
      if (name === './ingress.cjs') return { createLoopbackIngress(config) {
        if (options.ingressError) throw options.ingressError;
        seen.ingressConfig = config; return ingress;
      } };
      if (name === './session.cjs') return type === 'tailcat'
        ? { createTailcatSession: createSession } : { createP2PSession: createSession, P2P_PORT: 48950 };
      return anchored(name);
    },
  }, { filename: file });
  const door = loaded.exports[type === 'tailcat' ? 'mountTailcat' : 'mountP2P']({
    mount: (label, fn) => {
      if (options.missing === label) return undefined;
      try { return fn(); } catch (error) { seen.warnings.push(`${label} 没挂上：${error.message}`); return undefined; }
    },
    warn: message => seen.warnings.push(message),
    getState: () => state, saveState() {},
    localPort: () => options.localPort ?? 18787,
    lanEnabled: () => false, lanPort: () => 18787, webPort: () => 61494,
    hostName: () => 'test', name: 'test',
    ctx: { effect(fn) { seen.effect = fn; if (!options.deferEffect) seen.cleanups.push(fn()); }, reflect: { provide() {} } },
  });
  return { door, seen, setState: next => { state = next; }, close: () => seen.cleanups.forEach(fn => fn()) };
}

function assertPendingIntent(f, type) {
  assert.equal(f.door.status().enabled, true, '会话未创建时仍须报告开启意图');
  assert.equal(f.door.status().ready, false, '端口未就绪不能报告 ready');
  f.setState({ [`${type}Enabled`]: false });
  assert.equal(f.door.status().enabled, false, '门面每次读取当前状态');
  f.setState({ [`${type}Enabled`]: true });
}

async function assertFailure(f, error) {
  await flush();
  const status = f.door.status();
  assert.equal(status.error, error, '失败须保留具体原因');
  assert.equal(status.enabled, true, '失败不能冒充用户关闭');
  assert.equal(status.ready, false, '失败不能报告 ready');
  assert.equal(status.available, false, '装配失败的通道不可用');
}

function replaceMutation(source, before, after) {
  // 定位失败不能冒充行为断言捕获了变异。
  if (source.split(before).length !== 2) throw new Error(`mutation anchor must match once: ${before}`);
  return source.replace(before, after);
}

for (const type of TYPES) {
  test(`${type}：等待端口时 enabled 取当前 state，就绪取会话实际值`, async t => {
    let release;
    const f = fixture(type, { forwarderStart: () => new Promise(resolve => { release = resolve; }) });
    t.after(f.close);
    assertPendingIntent(f, type);
    await flush();
    assert.equal(f.seen.sessions.length, 0);
    release(40911);
    await flush();
    assert.equal(f.seen.forwarderStarts, 1, '前置监听和生命周期共用一次启动');
    assert.equal(f.seen.sessions.length, 1);
    assert.equal(f.door.status().ready, false);
    f.seen.sessions[0].ready = true;
    assert.equal(f.door.status().ready, true);
    assert.equal(f.door.status().error, '');
  });

  for (const mode of ['throw', 'reject']) {
    test(`${type}：落点代理 ${mode} 保留原始错误并阻止会话启动`, async t => {
      const error = new Error(`${type} bind denied ${mode}`);
      const f = fixture(type, { forwarderStart: () => { if (mode === 'throw') throw error; return Promise.reject(error); } });
      t.after(f.close);
      await assertFailure(f, error.message);
      assert.equal(f.seen.sessions.length, 0);
      if (type === 'p2p') assert.equal(f.door.exchange('x').error, error.message);
    });
  }

  test(`${type}：组件构造异常不会被缺组件原因覆盖`, async t => {
    const f = fixture(type, { forwarderError: new Error('forwarder construction denied') });
    t.after(f.close);
    await assertFailure(f, 'forwarder construction denied');
    assert.equal(f.seen.sessions.length, 0);
  });

  test(`${type}：effect 尚未运行时前置启动拒绝也会收口`, async t => {
    const f = fixture(type, { deferEffect: true, forwarderStart: () => Promise.reject(new Error('early bind denied')) });
    t.after(f.close);
    await assertFailure(f, 'early bind denied');
  });

  for (const [missing, error] of [
    [type === 'tailcat' ? '隧道落点代理' : '点对点隧道落点代理', 'forwarder-unavailable'],
    ...(type === 'tailcat' ? [['直连隧道入口', 'ingress-unavailable']] : []),
  ]) {
    test(`${type}：缺少 ${missing} 不会永久 starting`, async t => {
      const f = fixture(type, { missing });
      t.after(f.close);
      await assertFailure(f, error);
      assert.equal(f.seen.sessions.length, 0);
    });
  }

  test(`${type}：落点端口为零不能继续创建会话`, async t => {
    const f = fixture(type, { forwarderStart: () => Promise.resolve(0) });
    t.after(f.close);
    await assertFailure(f, 'forwarder-port-unavailable');
    assert.equal(f.seen.sessions.length, 0);
  });

  test(`${type}：会话创建和启动异常保留在门面`, async t => {
    for (const kind of ['sessionError', 'startError']) {
      const f = fixture(type, { [kind]: new Error(`${kind} denied`) });
      t.after(f.close);
      await assertFailure(f, `${kind} denied`);
    }
  });

  test(`${type}：监听器只写日志但未完成启动时，门面仍保留真实错误`, async t => {
    const f = fixture(type, { forwarderStart: () => new Promise(() => {}) });
    t.after(f.close);
    await flush();
    f.seen.forwarderConfig.log('隧道落点代理没有开起来：EACCES');
    await assertFailure(f, '隧道落点代理没有开起来：EACCES');
    f.seen.forwarderConfig.log('后续错误不得覆盖首个失败');
    await assertFailure(f, '隧道落点代理没有开起来：EACCES');
  });

  test(`${type}：变异后同一组 enabled 与错误断言必须失败`, async t => {
    const disabled = fixture(type, { forwarderStart: () => new Promise(() => {}) }, source =>
      replaceMutation(source, `enabled: (readState() || {}).${type}Enabled === true`, 'enabled: false'));
    t.after(disabled.close);
    assert.throws(() => assertPendingIntent(disabled, type), { code: 'ERR_ASSERTION' });
    const prematureReady = fixture(type, { forwarderStart: () => new Promise(() => {}) }, source =>
      replaceMutation(source, 'ready: false,', 'ready: true,'));
    t.after(prematureReady.close);
    assert.throws(() => assertPendingIntent(prematureReady, type), { code: 'ERR_ASSERTION' });
    const lostError = fixture(type, { forwarderStart: () => Promise.reject(new Error('bind denied')) }, source =>
      replaceMutation(source, "startupError = error && error.message ? error.message : String(error);", "startupError = 'starting';"));
    t.after(lostError.close);
    await assert.rejects(() => assertFailure(lostError, 'bind denied'), { code: 'ERR_ASSERTION' });
    const zeroPort = fixture(type, { forwarderStart: () => Promise.resolve(0) }, source =>
      replaceMutation(source, "if (!Number.isInteger(targetPort) || targetPort <= 0) throw new Error('forwarder-port-unavailable');", ''));
    t.after(zeroPort.close);
    await assert.rejects(() => assertFailure(zeroPort, 'forwarder-port-unavailable'), { code: 'ERR_ASSERTION' });
    const lostLog = fixture(type, { forwarderStart: () => new Promise(() => {}) }, source =>
      replaceMutation(source, 'if (!session && !startupError) startupError = String(message);', ''));
    t.after(lostLog.close);
    lostLog.seen.forwarderConfig.log('listen denied');
    await assert.rejects(() => assertFailure(lostLog, 'listen denied'), { code: 'ERR_ASSERTION' });
    const earlyReject = fixture(type, { deferEffect: true, forwarderStart: () => Promise.reject(new Error('early bind denied')) }, source =>
      replaceMutation(source, '})().catch(error => { failed(error); return 0; });', '})().catch(() => 0);'));
    t.after(earlyReject.close);
    await assert.rejects(() => assertFailure(earlyReject, 'early bind denied'), { code: 'ERR_ASSERTION' });
  });
}

test('tailcat：入口拒绝、零端口和未完成监听错误都会终结假 starting', async t => {
  const construction = fixture('tailcat', { ingressError: new Error('ingress construction denied') });
  t.after(construction.close);
  await assertFailure(construction, 'ingress construction denied');
  const rejected = fixture('tailcat', { ingressStart: () => Promise.reject(new Error('ingress bind denied')) });
  t.after(rejected.close);
  await assertFailure(rejected, 'ingress bind denied');
  const zero = fixture('tailcat', { ingressStart: () => Promise.resolve(0) });
  t.after(zero.close);
  await assertFailure(zero, 'ingress-port-unavailable');
  assert.equal(zero.seen.sessions.length, 0);
  const logged = fixture('tailcat', { ingressStart: () => new Promise(() => {}) });
  t.after(logged.close);
  await flush();
  logged.seen.ingressConfig.log('隧道入口没有开起来：EADDRINUSE');
  await assertFailure(logged, '隧道入口没有开起来：EADDRINUSE');
});

test('p2p：缺少本机端口时保留开启意图，操作返回具体不可用原因', async t => {
  const f = fixture('p2p', { localPort: 0 });
  t.after(f.close);
  await assertFailure(f, 'local-port-unavailable');
  assert.equal(f.seen.sessions.length, 0);
  assert.equal(f.door.exchange('x').error, 'local-port-unavailable');
});

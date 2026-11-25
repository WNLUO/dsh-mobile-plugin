// 常驻工作区与控制流并发、取消清理和内存变异共用同一组行为断言。
'use strict'

/**
 * 缺流网关降级的守卫：`typertGateway.stream` 是可选宿主能力，缺失时兼容 mux 必须保持
 * 空闲直到客户端断开，不能抛错、也不能立即结束 —— 设备级 SSE 还捎带着插件自产的清单
 * 变更与心跳，迭代器一结束 SSE 就断，手机端会陷入重连风暴。
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

function memoryMux(before, after) {
  const file = require.resolve('../lib/mobile/host-bridge/event-synthesis.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, '变异必须命中唯一生产逻辑');
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(path.dirname(file));
  instance._compile(source.replace(before, after), file);
  return instance.exports.muxFrames;
}

function residentGateway({ delayWorkspace = false, extraProjection = false } = {}) {
  const seen = [];
  const signals = new Map();
  const returned = new Set();
  const aborted = new Set();
  const finishes = new Map();
  const gateway = {
    async stream(request) {
      const name = `${request.namespace}/${request.method}`;
      seen.push(name);
      signals.set(name, request.signal);
      const stopped = new Promise(resolve => {
        const finish = () => {
          request.signal.removeEventListener('abort', finish);
          aborted.add(name);
          resolve();
        };
        finishes.set(name, finish);
        request.signal.addEventListener('abort', finish, { once: true });
        if (request.signal.aborted) finish();
      });
      return (async function* () {
        try {
          if (name === 'workspace/follow') {
            if (delayWorkspace) await stopped;
            if (!request.signal.aborted) yield { type: 'baseline', value: { revision: 'w1', items: [] } };
          } else {
            yield { type: 'baseline', value: { projections: {
              's-1': { asOfSeq: 7, values: { title: '新对话' } },
              ...(extraProjection ? { 's-2': { asOfSeq: 8, values: { title: '另一条对话' } } } : {}),
            } } };
          }
          await stopped;
        } finally { returned.add(name); }
      })();
    },
  };
  return {
    ctx: { get: name => name === 'typertGateway' ? gateway : undefined, logger: { warn() {} } },
    seen, signals, returned, aborted,
    finish() { for (const finish of finishes.values()) finish(); },
  };
}

async function concurrentDeviceContract(openMux = muxFrames, delayWorkspace = false) {
  const fixture = residentGateway({ delayWorkspace });
  const controller = new AbortController();
  const iterator = openMux(fixture.ctx, {}, controller.signal)[Symbol.asyncIterator]();
  const pending = [];
  try {
    const first = iterator.next();
    pending.push(first);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.seen.slice().sort(), ['session/control', 'workspace/follow'], '常驻 workspace 不能挡住 control 订阅');
    const frame = await first;
    const second = iterator.next();
    pending.push(second);
    const result = delayWorkspace ? frame : await second;
    if (delayWorkspace) {
      const ended = await Promise.race([second.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
      assert.equal(ended, false, '两路常驻流在取消前不该自行结束');
    }
    const frames = delayWorkspace ? [result] : [frame, result];
    assert.ok(frames.some(step => step.value?.payload.type === 'session/projection' && step.value.payload.sessionId === 's-1'), 'workspace 未结束前必须收到控制投影');
    assert.equal(fixture.returned.size, 0, '控制投影到达时两路都应仍然常驻');
  } finally {
    controller.abort();
    fixture.finish();
    await Promise.allSettled(pending);
    await iterator.return();
  }
}

async function deviceCleanupContract(openMux = muxFrames, byReturn = false) {
  const fixture = residentGateway({ extraProjection: byReturn });
  const controller = new AbortController();
  const iterator = openMux(fixture.ctx, {}, controller.signal)[Symbol.asyncIterator]();
  let pending;
  try {
    await iterator.next();
    await iterator.next();
    assert.equal(fixture.signals.size, 2, '清理用例必须先建立两路订阅');
    if (byReturn) {
      await iterator.return();
    } else {
      pending = iterator.next();
      controller.abort();
      const done = await pending;
      assert.equal(done.done, true, 'abort 后设备流必须完成');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.ok([...fixture.signals.values()].every(signal => signal.aborted), '结束设备流必须取消两路子订阅');
    assert.deepEqual([...fixture.aborted].sort(), ['session/control', 'workspace/follow'], '两路宿主订阅都必须收到取消');
    assert.deepEqual([...fixture.returned].sort(), ['session/control', 'workspace/follow'], '两路迭代器都必须执行收尾');
  } finally {
    controller.abort();
    fixture.finish();
    if (pending) await pending;
    await iterator.return();
  }
}

function ctxWithoutGateway(warns = []) {
  return {
    ctx: {
      get: () => undefined,
      logger: { warn: (message) => warns.push(String(message)), error() {} },
    },
    warns,
  };
}

function ctxWithDeadGateway(warns = []) {
  return {
    ctx: {
      get: () => ({}),
      logger: { warn: (message) => warns.push(String(message)), error() {} },
    },
    warns,
  };
}

test('宿主没有 typertGateway：mux 保持空闲、只告警一次、不产帧也不抛错', async () => {
  const warns = [];
  const { ctx } = ctxWithoutGateway(warns);
  const controller = new AbortController();
  const iterator = muxFrames(ctx, {}, controller.signal)[Symbol.asyncIterator]();

  const race = await Promise.race([
    iterator.next().then((step) => ({ step })),
    new Promise((resolve) => setTimeout(() => resolve({ idle: true }), 150)),
  ]);
  assert.equal(race.idle, true, '缺网关时迭代器必须挂着等待，而不是产帧、结束或抛错');

  // 客户端断开（abort）是它唯一的收尾方式。
  controller.abort();
  const done = await iterator.next();
  assert.equal(done.done, true);
  assert.equal(warns.filter((message) => message.includes('typertGateway.stream')).length, 1, '缺网关必须告警，且同一条 ctx 只告警一次');
});

test('同一 ctx 反复开流只告警一次；网关在但缺 stream 方法同样降级', async () => {
  const warns = [];
  const { ctx } = ctxWithoutGateway(warns);
  for (let i = 0; i < 3; i += 1) {
    const controller = new AbortController();
    const iterator = muxFrames(ctx, {}, controller.signal)[Symbol.asyncIterator]();
    controller.abort();
    assert.equal((await iterator.next()).done, true);
  }
  assert.equal(warns.filter((message) => message.includes('typertGateway.stream')).length, 1, '重连风暴不该把宿主日志刷满');

  const dead = ctxWithDeadGateway([]);
  const controller = new AbortController();
  const iterator = muxFrames(dead.ctx, {}, controller.signal)[Symbol.asyncIterator]();
  controller.abort();
  assert.equal((await iterator.next()).done, true);
  assert.equal(dead.warns.filter((message) => message.includes('typertGateway.stream')).length, 1);
});

test('工作区常驻时会话控制流并发订阅并产帧', () => concurrentDeviceContract());

test('工作区首帧未到时控制投影也能先到', () => concurrentDeviceContract(muxFrames, true));

test('abort 取消两路常驻宿主流并收回迭代器', () => deviceCleanupContract());

test('结束消费时取消两路宿主订阅并收回迭代器', () => deviceCleanupContract(muxFrames, true));

test('变异：控制订阅等工作区结束会被同一并发断言拒绝', async () => {
  const broken = memoryMux('    sources.push(projectionFrames(ctx, null, childSignal));', `    sources.push((async function* () {
      await new Promise(resolve => childSignal.addEventListener('abort', resolve, { once: true }));
      yield* projectionFrames(ctx, null, childSignal);
    })());`);
  await assert.rejects(concurrentDeviceContract(broken), { code: 'ERR_ASSERTION', message: /常驻 workspace 不能挡住 control 订阅/ });
});

test('变异：工作区握手串行等待会被控制先到断言拒绝', async () => {
  const broken = memoryMux("    const workspace = openStream(ctx, 'workspace', 'follow', {}, childSignal);", `    const workspace = await openStream(ctx, 'workspace', 'follow', {}, childSignal);
    const firstWorkspace = await workspace.next();
    sources.push((async function* () { if (!firstWorkspace.done) yield firstWorkspace.value; })());`);
  await assert.rejects(concurrentDeviceContract(broken, true), { code: 'ERR_ASSERTION', message: /常驻 workspace 不能挡住 control 订阅/ });
});

test('变异：结束消费漏取消子流会被同一清理断言拒绝', async () => {
  const before = "    controller.abort();\n    signal?.removeEventListener('abort', abort);\n    for (const source of sources) void source.return().catch(() => {});\n  }\n}";
  const broken = memoryMux(before, before.replace('    controller.abort();\n', ''));
  await assert.rejects(deviceCleanupContract(broken, true), { code: 'ERR_ASSERTION', message: /结束设备流必须取消两路子订阅/ });
});

test('变异：只取消却不归还迭代器会被同一清理断言拒绝', async () => {
  const before = "    controller.abort();\n    signal?.removeEventListener('abort', abort);\n    for (const source of sources) void source.return().catch(() => {});\n  }\n}";
  const broken = memoryMux(before, before.replace('    for (const source of sources) void source.return().catch(() => {});\n', ''));
  await assert.rejects(deviceCleanupContract(broken, true), { code: 'ERR_ASSERTION', message: /两路迭代器都必须执行收尾/ });
});

test('宿主提供了可用的 stream 网关：不降级，照常订阅宿主流', async () => {
  const seen = [];
  const gateway = {
    async stream(request) {
      seen.push(request);
      return (async function* empty() {})();
    },
  };
  const ctx = { get: (name) => (name === 'typertGateway' ? gateway : undefined), logger: { warn() {}, error() {} } };
  const iterator = muxFrames(ctx, {}, new AbortController().signal)[Symbol.asyncIterator]();
  await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(resolve, 150)),
  ]);
  assert.ok(seen.length > 0, '网关可用时不该走空闲降级，一条流都没订上');
});

test('宿主的流正常结束之后，设备流仍然挂着（插件自己的信号与心跳还要走它）', async () => {
  // 2026-10-24 现场：workspace/follow 与 session/control 都结束后，设备级 SSE 也跟着收尾，
  // 手机端五秒一轮重连，信号永远不「活着」，列表只能每 15 秒轮询一次。
  const warns = [];
  const ctx = {
    get: () => ({
      stream: () => (async function* () {
        yield { type: 'baseline', value: { revision: 'r1', items: [] } };
      })(),
    }),
    logger: { warn: (message) => warns.push(String(message)), error() {} },
  };
  const controller = new AbortController();
  const iterator = muxFrames(ctx, {}, controller.signal)[Symbol.asyncIterator]();
  // 宿主给的第一帧要能出来。
  const first = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 300)),
  ]);
  assert.notEqual(first.timeout, true, '宿主首帧必须透传');
  // 之后宿主两条流都结束，迭代器必须继续挂住而不是 done。
  const idle = await Promise.race([
    iterator.next().then((step) => ({ step })),
    new Promise((resolve) => setTimeout(() => resolve({ idle: true }), 250)),
  ]);
  assert.equal(idle.idle, true, '宿主流结束后设备流必须保持打开');
  controller.abort();
  const done = await iterator.next();
  assert.equal(done.done, true, '客户端断开才收尾');
});

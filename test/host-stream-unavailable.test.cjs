'use strict'

/**
 * 缺流网关降级的守卫：`typertGateway.stream` 是可选宿主能力，缺失时兼容 mux 必须保持
 * 空闲直到客户端断开，不能抛错、也不能立即结束 —— 设备级 SSE 还捎带着插件自产的清单
 * 变更与心跳，迭代器一结束 SSE 就断，手机端会陷入重连风暴。
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { muxFrames } = require('../lib/mobile/host-bridge/event-synthesis.js')

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

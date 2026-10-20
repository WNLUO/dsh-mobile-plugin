'use strict';

/**
 * 网关请求里的 Peer 身份守卫（DSH 0.2.1 起）。
 *
 * 0.2.1 的 `ctx.typertGateway` 在派发前先 `assertPeerLive(request.peer)`，Peer 缺了就是
 * 对 undefined 读 `.signal` → `Cannot read properties of undefined (reading 'signal')`。
 * 插件把它收敛成 host-call-failed，于是手机上 /sessions、/workspaces 全是 400、会话镜像
 * 永远「未推送」，而本机自算的 /status 一切正常 —— 症状很像「只是显示不对」。
 *
 * 这里的假网关**照抄了那条断言**（缺 peer 抛同一句 TypeError），所以任何把身份摘掉、
 * 或者把取不到身份写成硬失败（旧宿主上会立刻挂）的改动都会当场红。
 *
 * 兼容的另一半同样钉住：0.2.0 及更早没有 `connection.browserPeer`，请求里就**不能有**
 * peer 字段 —— 旧网关自己回落 operatorPeer，凭空塞一个进去是给旧宿主改合约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { invoke, openStream } = require('../lib/mobile/host-bridge/transport.js');

const PEER = Object.freeze({ signal: { aborted: false }, principal: { kind: 'owner' } });

/** 0.2.1 的网关：先验 Peer，再派发。 */
function strictGateway() {
  const seen = [];
  const assertPeerLive = (peer) => {
    if (!peer || !peer.signal) throw new TypeError("Cannot read properties of undefined (reading 'signal')");
    if (peer.signal.aborted) throw new Error('the calling Peer has been disposed');
  };
  return {
    seen,
    async invoke(request) {
      seen.push(request);
      assertPeerLive(request.peer);
      return { ok: true };
    },
    async stream(request) {
      seen.push(request);
      assertPeerLive(request.peer);
      return ['frame'];
    },
  };
}

/** 0.2.0 的网关：没有 Peer 检查，也不认识 peer 字段。 */
function legacyGateway() {
  const seen = [];
  return {
    seen,
    async invoke(request) { seen.push(request); return { ok: true }; },
    async stream(request) { seen.push(request); return ['frame']; },
  };
}

function ctxOf(services) {
  return { get: (name) => services[name] };
}

test('0.2.1 宿主：invoke 与 stream 都带上连接服务里的本机操作者身份', async () => {
  const gateway = strictGateway();
  const ctx = ctxOf({ typertGateway: gateway, connection: { browserPeer: PEER } });

  const result = await invoke(ctx, 'session', 'list', { _request: {} });
  assert.equal(result.error, undefined, '带身份的新版宿主必须调通');
  assert.deepEqual(result.value, { ok: true });

  const frames = await openStream(ctx, 'workspace', 'follow', {});
  assert.deepEqual(frames, ['frame']);

  assert.equal(gateway.seen.length, 2);
  for (const request of gateway.seen) assert.equal(request.peer, PEER);
});

test('0.2.1 宿主：身份取自 connection.browserPeer，不是插件自己造的对象', async () => {
  const gateway = strictGateway();
  const ctx = ctxOf({ typertGateway: gateway, connection: { browserPeer: PEER } });
  await invoke(ctx, 'session', 'list', { _request: {} });
  assert.equal(gateway.seen[0].peer, PEER, '必须是宿主给出的那个 Peer 实例');
});

test('0.2.0 宿主：没有 browserPeer 时不带 peer 字段，请求形状与从前一致', async () => {
  const gateway = legacyGateway();
  const ctx = ctxOf({ typertGateway: gateway, connection: {} });

  const result = await invoke(ctx, 'session', 'list', { _request: {} });
  assert.equal(result.error, undefined);
  assert.equal(Object.hasOwn(gateway.seen[0], 'peer'), false, '旧宿主不认识 peer，不许凭空带上');

  const frames = await openStream(ctx, 'workspace', 'follow', {});
  assert.deepEqual(frames, ['frame']);
  assert.equal(Object.hasOwn(gateway.seen[1], 'peer'), false);
});

test('取不到 connection 服务不影响调用（旧宿主 / 极简 profile）', async () => {
  const gateway = legacyGateway();
  const ctx = ctxOf({ typertGateway: gateway });
  const result = await invoke(ctx, 'session', 'list', { _request: {} });
  assert.equal(result.error, undefined, '没有 connection 也必须照旧调通');
});

test('connection 读取抛错时退化为不带身份，而不是把整条调用打成失败', async () => {
  const gateway = legacyGateway();
  const ctx = {
    get(name) {
      if (name === 'connection') throw new Error('cannot get property "connection" without inject');
      return name === 'typertGateway' ? gateway : undefined;
    },
  };
  const result = await invoke(ctx, 'session', 'list', { _request: {} });
  assert.equal(result.error, undefined);
});

test('宿主刚重启、网关晚一步就绪时，事件流等一小会儿再看一次而不是直接报没能力', async () => {
  const gateway = legacyGateway();
  let reads = 0;
  const ctx = {
    get(name) {
      if (name !== 'typertGateway') return undefined;
      reads += 1;
      return reads > 1 ? gateway : undefined;
    },
  };
  const frames = await openStream(ctx, 'workspace', 'follow', {});
  assert.deepEqual(frames, ['frame']);
  assert.equal(reads, 2, '取不到要重取一次，而不是把第一眼的空值当结论');
});

test('宿主确实没有网关能力时仍然如实回报，不把等待当成结论', async () => {
  await assert.rejects(
    () => openStream(ctxOf({}), 'workspace', 'follow', {}),
    (error) => error.code === 'host-unavailable',
  );
});

test('等待期间连接已断开就立刻放弃，不把整个窗口拖给调用方', async () => {
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  await assert.rejects(
    () => openStream(ctxOf({}), 'workspace', 'follow', {}, ac.signal),
    (error) => error.code === 'host-unavailable',
  );
  assert.ok(Date.now() - started < 500, `已断开时不该等满窗口（${Date.now() - started}ms）`);
});

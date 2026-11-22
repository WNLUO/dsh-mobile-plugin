/** 工作区快照优先读已激活的 Host 登记服务，保留旧跟随流、错误与取消语义。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createApiProxy } = require('../lib/mobile/host-bridge.js');
const { buildWorkspacesBody } = require('../lib/mobile/workspaces.js');
const { workspaceListViaFollow } = require('../lib/mobile/host-bridge/shims.js');

// 字段照宿主公开 Workspace 接口，故意不暴露 table / state / entities 等内部存储。
function registryOf(items = [{ id: 'w1', path: '/ws/project', title: '项目', sessionIds: ['s2', 's1'], createdAt: '2026-11-01', updatedAt: '2026-11-21' }]) {
  const registry = {
    list: () => items,
    archivedSessionIds: ['archived'],
    pinnedSessionIds: ['s2'],
  };
  return new Proxy(registry, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `不能读取登记服务的私有成员 ${String(key)}`);
      return target[key];
    },
  });
}

// 沿用 host-bridge-peer 的服务假体：ctx.get 默认只返回当前 active 的实现。
function runtime(registry, frames = [{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }]) {
  const calls = [];
  const gateway = { async stream(request) { calls.push(request); return Readable.from(frames); } };
  const services = { workspaceRegistry: registry, typertGateway: gateway };
  const ctx = { get: (key, strict) => { assert.notEqual(strict, false); return services[key]; }, logger: { warn() {} } };
  ctx.apiProxy = createApiProxy(ctx);
  return { ctx, calls, services };
}

async function expectRegistrySnapshot(read) {
  const registry = registryOf();
  const { ctx, calls, services } = runtime(registry);
  // 工作区登记服务正常、Remote controller 缺席的宿主仍应能读取。
  services.typertGateway.stream = async () => {
    calls.push('workspace/follow');
    throw Object.assign(new Error('workspace controller unavailable'), { code: 'gateway/service-unavailable' });
  };
  const response = await read(ctx);
  assert.equal(response.result.ok, true, JSON.stringify(response.result.error));
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.value)), {
    items: [{ workspaceId: 'w1', path: '/ws/project', title: '项目', sessionIds: ['s2', 's1'], createdAt: '2026-11-01', updatedAt: '2026-11-21' }],
    archivedSessionIds: ['archived'],
    pinnedSessionIds: ['s2'],
  });
  assert.deepEqual(calls, [], '已有 Host 登记服务时不能依赖 Remote 流');
  assert.notEqual(response.result.value.items[0].sessionIds, registry.list()[0].sessionIds);
  assert.notEqual(response.result.value.archivedSessionIds, registry.archivedSessionIds);
  assert.notEqual(response.result.value.pinnedSessionIds, registry.pinnedSessionIds);
}

test('Host 登记服务可用时返回同形副本，不依赖 workspace Remote controller', async () => {
  await expectRegistrySnapshot((ctx) => ctx.apiProxy.workspace.list({ payload: {} }));
});

test('buildWorkspacesBody 使用 Host 快照，归档变化仍推进 revision，真空列表明确确认', async () => {
  const registry = registryOf();
  const { ctx, calls } = runtime(registry);
  const before = await buildWorkspacesBody(ctx);
  assert.equal(before.ok, true);
  assert.equal(before.items[0].workspaceId, 'w1');
  registry.archivedSessionIds.push('another-archived');
  const after = await buildWorkspacesBody(ctx);
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.archivedSessionIds, undefined);
  const empty = await buildWorkspacesBody(runtime(registryOf([])).ctx);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.emptyConfirmed, true);
  assert.deepEqual(calls, []);
});

test('登记服务缺席时仍读旧 follow baseline，并在拿到首帧后关闭流', async () => {
  let closed = false;
  const value = { items: [{ workspaceId: 'legacy' }], archivedSessionIds: ['a'], pinnedSessionIds: ['p'] };
  const { ctx, calls, services } = runtime(undefined);
  services.typertGateway.stream = async (request) => {
    calls.push(request);
    return (async function* () {
      try { yield { type: 'baseline', value }; throw new Error('不应再读增量'); }
      finally { closed = true; }
    })();
  };
  const out = await ctx.apiProxy.workspace.list({ payload: {} });
  assert.equal(out.result.ok, true);
  assert.equal(out.result.value, value);
  assert.equal(closed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'workspace');
  assert.equal(calls[0].method, 'follow');
  assert.deepEqual(calls[0].args, {});
});

test('登记服务完成初始化后下次现读，不缓存缺席或旧 follow 结果', async () => {
  const { ctx, calls, services } = runtime(undefined, []);
  const first = await buildWorkspacesBody(ctx);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'host-workspace-baseline-missing');
  services.workspaceRegistry = registryOf();
  const second = await buildWorkspacesBody(ctx);
  assert.equal(second.ok, true);
  assert.equal(second.items[0].workspaceId, 'w1');
  assert.equal(calls.length, 1);
});

async function expectRegistryFailure(read) {
  const { ctx, calls, services } = runtime(registryOf());
  services.workspaceRegistry = {
    list() { throw Object.assign(new Error('workspace domain not started'), { code: 'workspace/read-failed' }); },
  };
  const out = await read(ctx);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'workspace/read-failed');
  assert.equal(out.result.error.message, 'workspace domain not started');
  assert.equal(out.result.value, undefined);
  assert.deepEqual(calls, [], '真实读取错误不得被旧流的空基线盖掉');
}

test('Host 登记读取失败原样报错，不回退成空清单', async () => {
  await expectRegistryFailure(workspaceListViaFollow);
});

test('Host 登记清单和归档字段形状异常仍失败，不生成权威空快照', async () => {
  for (const registry of [
    { list: () => undefined, archivedSessionIds: [], pinnedSessionIds: [] },
    { list: () => [], pinnedSessionIds: [] },
  ]) {
    const { ctx, calls } = runtime(registry);
    const body = await buildWorkspacesBody(ctx);
    assert.equal(body.ok, false);
    assert.equal(body.items, undefined);
    assert.deepEqual(calls, []);
  }
});

// 工作区 domain v1 的旧宿主没有 pinnedSessionIds 字段。置顶只影响画图，缺了顶多少几个图钉，
// 不能让整份工作区清单读失败（与 session-flags.js 对同一字段的容错口径一致）。
function legacyRegistryOf(items = [{ id: 'w1', path: '/ws/project', title: '项目', sessionIds: ['s2', 's1'], createdAt: '2026-11-01', updatedAt: '2026-11-21' }]) {
  return { list: () => items, archivedSessionIds: ['archived'] };
}

async function expectLegacyPinnedSnapshot(read) {
  const { ctx, calls } = runtime(legacyRegistryOf());
  const response = await read(ctx);
  assert.equal(response.result.ok, true, JSON.stringify(response.result.error));
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.value)), {
    items: [{ workspaceId: 'w1', path: '/ws/project', title: '项目', sessionIds: ['s2', 's1'], createdAt: '2026-11-01', updatedAt: '2026-11-21' }],
    archivedSessionIds: ['archived'],
    pinnedSessionIds: [],
  });
  assert.deepEqual(calls, []);
  const body = await buildWorkspacesBody(ctx);
  assert.equal(body.ok, true, JSON.stringify(body.error));
  assert.equal(body.items.length, 1);
}

test('旧宿主没有 pinnedSessionIds 时工作区清单照常返回，置顶按空集合', async () => {
  await expectLegacyPinnedSnapshot((ctx) => ctx.apiProxy.workspace.list({ payload: {} }));
});

test('变异证明：把置顶字段改回必存在会被老宿主用例抓住', async () => {
  const read = mutatedRead(
    'Array.isArray(registry.pinnedSessionIds) ? [...registry.pinnedSessionIds] : []',
    '[...registry.pinnedSessionIds]',
  );
  await assert.rejects(() => expectLegacyPinnedSnapshot(read), /registry\.pinnedSessionIds is not iterable/);
});

test('已取消的读取不访问 Host 登记服务', async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  const { ctx, calls } = runtime({ list() { throw new Error('不能在取消后读取'); } });
  const out = await ctx.apiProxy.workspace.list({ payload: {} }, controller.signal);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error.code, 'cancelled');
  assert.deepEqual(calls, []);
});

// 沿用 session-model-only 的内存变异假体，不改工作树里的实现。
function mutatedRead(from, to) {
  const file = require.resolve('../lib/mobile/host-bridge/shims.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(from));
  const mod = { exports: {} };
  vm.runInNewContext(source.replace(from, to), { exports: mod.exports, module: mod, require: createRequire(file), AbortSignal });
  return mod.exports.workspaceListViaFollow;
}

test('变异证明：删除 Host 直读会被同一成功断言抓住', async () => {
  const read = mutatedRead('if (registry) {', 'if (false) {');
  await assert.rejects(() => expectRegistrySnapshot(read), (error) =>
    error instanceof assert.AssertionError && error.actual === false && error.expected === true);
});

test('变异证明：Host 读失败伪装成空清单会被同一失败断言抓住', async () => {
  const read = mutatedRead(
    '} catch (error) {\n    return fail(error);\n  }\n  // 流',
    '} catch (error) {\n    return ok({ items: [], archivedSessionIds: [], pinnedSessionIds: [] });\n  }\n  // 流',
  );
  await assert.rejects(() => expectRegistryFailure(read), (error) =>
    error instanceof assert.AssertionError && error.actual === true && error.expected === false);
});

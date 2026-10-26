'use strict';

/**
 * 移动端「插件管理」（装 / 卸 / 启用 / 升级这台电脑上的 DSH 插件）的透传契约。
 *
 * 这一层不自己跑包管理器：全部转发给宿主的 `pluginManager` 服务（桌面端 设置 → 插件
 * 那个页面背后的同一个服务）。所以钉的是四件事：
 *  1. **args 键名与宿主 descriptor 逐字一致** —— 多一个少一个宿主都回 arguments-invalid，
 *     而这类失败在手机上只表现成「点了没反应」；
 *  2. **承载 App 连接的那个包不给卸载 / 停用**（卸载它等于把手机变砖），而且这条得在
 *     调网关**之前**拒掉，不能先打一发再拦；
 *  3. 装 / 升都是**异步任务**：立即回 202 + requestId，进度另开一条轮询；失败要落进
 *     那条记录里，不能吞掉；
 *  4. 升级的语义是「卸载再装」（DSH 自己的规矩），官方按需插件用宿主给的确切目标版本，
 *     本地目录 / 压缩包来源没有「最新版」可言，如实拒绝。
 *
 * 本测试驱动真实的 handler（不是转写实现）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');

const {
  handlePluginMarket,
  handlePluginMarketInspect,
  handlePluginMarketInstall,
  handlePluginMarketUpdate,
  handlePluginMarketProgress,
  handlePluginMarketCancel,
  handlePluginMarketRemove,
  handlePluginMarketEnabled,
  normalizeBundle,
  operationView,
  updateTargetOf,
  SELF_NAME,
} = require('../lib/mobile/plugin-market.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 假宿主：记录每一次网关调用，按 endpoint 给假实现
// ---------------------------------------------------------------------------

function makeGateway(impl = {}) {
  const calls = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const key = `${request.namespace}/${request.method}`;
      const fn = impl[key];
      if (fn) return fn(request);
      return [];
    },
  };
}

function makeCtx(gateway) {
  return { get: (name) => (name === 'typertGateway' ? gateway : undefined) };
}

/** POST 走 `req.body`（守卫解包之后就是它）；GET 只需要 url。 */
function makeReq(body, url = '/api/mobile/v1/plugin/market') {
  const req = Readable.from([]);
  req.headers = {};
  req.url = url;
  if (body !== undefined) req.body = body;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

const bundle = (over = {}) => ({
  name: 'some-plugin',
  official: false,
  availability: 'profile',
  version: '1.2.3',
  enabled: true,
  installed: true,
  removable: true,
  optional: false,
  source: '^1.2.0',
  rows: [{ rowId: 'main', moduleName: 'some-plugin' }],
  overrides: [],
  ...over,
});

/** 等一次后台任务落到 done（install/update 是 fire-and-forget 的）。 */
async function settle(task, timeoutMs = 2000) {
  const started = Date.now();
  while (task.state === 'running') {
    if (Date.now() - started > timeoutMs) throw new Error('后台任务没有在时限内结束');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return task;
}

// ---------------------------------------------------------------------------
// 清单：削成手机要的形状
// ---------------------------------------------------------------------------

test('清单按宿主给出的行投影：显示名 / 来源 / 行数 / 官方目标版本 / 自己的保护位', async () => {
  const gateway = makeGateway({
    'pluginManager/listBundles': () => ([
      bundle({
        name: 'dsh-devmap',
        meta: { title: { en: 'Dev map', 'zh-Hans': '开发地图' }, description: '读到代码地图' },
        description: 'map',
      }),
      bundle({ name: SELF_NAME, source: 'file:dsh-mobile-plugin.tgz', version: '0.3.2' }),
      bundle({ name: 'official-x', official: true, installed: false, enabled: false, source: undefined, installTarget: { spec: 'official-x@0.9.0', version: '0.9.0' }, removable: false }),
      { nonsense: true },
    ]),
  });
  const res = makeRes();
  await handlePluginMarket(makeCtx(gateway), makeReq(undefined), res);

  assert.equal(res.status, 200);
  assert.equal(res.body.bundles.length, 3, '没有包名的行必须丢掉');
  const [first, self, official] = res.body.bundles;
  assert.equal(first.title['zh-Hans'], '开发地图', '多语言显示名原样转给 App，由它按语言挑一份');
  assert.equal(first.description, '读到代码地图');
  assert.equal(first.rowCount, 1);
  assert.equal(first.protectedSelf, false);
  assert.equal(self.protectedSelf, true, '承载手机连接的自己要被标出来');
  assert.equal(official.installTarget.spec, 'official-x@0.9.0');
  assert.equal(official.installed, false);
});

test('宿主没有插件管理器时回 503 + plugin-market-unavailable（老版本不该被说成加载失败）', async () => {
  const res = makeRes();
  await handlePluginMarket({ get: () => null }, makeReq(undefined), res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'plugin-market-unavailable');
});

/** 网关自己抛的「服务没装」也要收敛成同一个码。 */
test('网关报服务不存在时同样收敛成 plugin-market-unavailable', async () => {
  const gateway = {
    async invoke() { throw Object.assign(new Error('no such service'), { code: 'gateway/invocation-unavailable' }); },
  };
  const res = makeRes();
  await handlePluginMarket(makeCtx(gateway), makeReq(undefined), res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'plugin-market-unavailable');
});

// ---------------------------------------------------------------------------
// 自己：只可更新，不可卸载 / 停用
// ---------------------------------------------------------------------------

test('卸载承载手机连接的自己：调网关之前就拒，403 self-protected', async () => {
  const gateway = makeGateway({ 'pluginManager/listBundles': () => [bundle({ name: SELF_NAME })] });
  const res = makeRes();
  await handlePluginMarketRemove(makeCtx(gateway), makeReq({ name: SELF_NAME, confirm: true }), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'self-protected');
  assert.equal(gateway.calls.length, 0, '这条不许先打一发再拦');
});

test('停用自己同样拒绝；启用自己则照常转给宿主', async () => {
  const gateway = makeGateway({ 'pluginManager/setBundleEnabled': () => ({ changed: true, application: 'applied', stage: 'enable', target: SELF_NAME }) });
  const denied = makeRes();
  await handlePluginMarketEnabled(makeCtx(gateway), makeReq({ name: SELF_NAME, enabled: false }), denied);
  assert.equal(denied.status, 403);
  assert.equal(gateway.calls.length, 0);

  const allowed = makeRes();
  await handlePluginMarketEnabled(makeCtx(gateway), makeReq({ name: SELF_NAME, enabled: true }), allowed);
  assert.equal(allowed.status, 200);
  assert.deepEqual(gateway.calls[0].args, { name: SELF_NAME, enabled: true });
});

test('卸载必须带 confirm:true 与包名', async () => {
  const gateway = makeGateway();
  const missingConfirm = makeRes();
  await handlePluginMarketRemove(makeCtx(gateway), makeReq({ name: 'x' }), missingConfirm);
  assert.equal(missingConfirm.status, 400);

  const missingName = makeRes();
  await handlePluginMarketRemove(makeCtx(gateway), makeReq({ confirm: true }), missingName);
  assert.equal(missingName.status, 400);
  assert.equal(gateway.calls.length, 0);
});

test('卸载别人的插件：转给 removeBundle，并把 application 原样回报', async () => {
  const gateway = makeGateway({
    'pluginManager/removeBundle': (request) => {
      assert.deepEqual(request.args, { name: 'some-plugin' });
      return { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'remove', target: 'some-plugin' };
    },
  });
  const res = makeRes();
  await handlePluginMarketRemove(makeCtx(gateway), makeReq({ name: 'some-plugin', confirm: true }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.operation.application, 'restart-required');
  assert.equal(res.body.operation.restartReason, 'no-hmr');
});

// ---------------------------------------------------------------------------
// 装：先读一下，再异步装
// ---------------------------------------------------------------------------

test('读一下：accepted 与 refused 两种形状都原样透出（含问过哪些注册表）', async () => {
  const accepted = makeRes();
  await handlePluginMarketInspect(makeCtx(makeGateway({
    'pluginManager/inspect': (request) => {
      assert.deepEqual(request.args, { spec: 'dsh-foo' }, 'inspect 的参数就是 spec 一个键');
      return { status: 'accepted', kind: 'registry', name: 'dsh-foo', version: '1.0.0', description: 'foo', bundle: true, registry: 'https://registry.npmjs.org/' };
    },
  })), makeReq({ spec: 'dsh-foo' }), accepted);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.name, 'dsh-foo');

  const refused = makeRes();
  await handlePluginMarketInspect(makeCtx(makeGateway({
    'pluginManager/inspect': () => ({ status: 'refused', problem: 'not-found', reason: '404', registries: ['https://registry.npmjs.org/'] }),
  })), makeReq({ spec: 'dsh-nope' }), refused);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.accepted, false);
  assert.equal(refused.body.problem, 'not-found');
  assert.deepEqual(refused.body.registries, ['https://registry.npmjs.org/']);
});

test('读一下缺 spec → 400，不打网关', async () => {
  const gateway = makeGateway();
  const res = makeRes();
  await handlePluginMarketInspect(makeCtx(gateway), makeReq({ spec: '   ' }), res);
  assert.equal(res.status, 400);
  assert.equal(gateway.calls.length, 0);
});

test('装：立即回 202 + requestId，任务后台跑完写进进度记录', async () => {
  const gateway = makeGateway({
    'pluginManager/installBundle': (request) => {
      assert.equal(request.args.spec, 'dsh-foo@1.2.0');
      assert.deepEqual(request.args.options, { requestId: 'req-1', enabled: true }, 'enabled 默认开，requestId 是宿主取消时认的那一个');
      return { changed: true, application: 'applied', stage: 'install', target: 'dsh-foo', version: '1.2.0' };
    },
  });
  const res = makeRes();
  await handlePluginMarketInstall(makeCtx(gateway), makeReq({ spec: 'dsh-foo@1.2.0', requestId: 'req-1' }), res);
  assert.equal(res.status, 202);
  assert.equal(res.body.requestId, 'req-1');

  const task = await settle(require('../lib/mobile/plugin-market.js').tasks.get('req-1'));
  assert.equal(task.result.ok, true);
  assert.equal(task.result.operation.application, 'applied');
  assert.equal(task.result.operation.version, '1.2.0');

  const progress = makeRes();
  await handlePluginMarketProgress(makeCtx(gateway), makeReq(undefined, '/api/mobile/v1/plugin/market/progress?requestId=req-1'), progress);
  assert.equal(progress.body.state, 'done');
  assert.equal(progress.body.result.ok, true);
});

test('装：approvedBuilds（允许依赖脚本那次重试）原样透传', async () => {
  const gateway = makeGateway({
    'pluginManager/installBundle': (request) => {
      assert.deepEqual(request.args.options.approvedBuilds, ['esbuild', 'sharp']);
      return { changed: true, application: 'applied', stage: 'install', target: 'dsh-foo' };
    },
  });
  const res = makeRes();
  await handlePluginMarketInstall(makeCtx(gateway), makeReq({ spec: 'dsh-foo', requestId: 'req-builds', approvedBuilds: ['esbuild', 'sharp', 42] }), res);
  assert.equal(res.status, 202);
  await settle(require('../lib/mobile/plugin-market.js').tasks.get('req-builds'));
});

test('装失败：失败也落进那条记录（手机否则只能干等到超时）', async () => {
  const gateway = { async invoke(request) {
    if (request.method === 'installBundle') throw Object.assign(new Error('pnpm 挂了'), { code: 'operation-error' });
    return [];
  } };
  const res = makeRes();
  await handlePluginMarketInstall(makeCtx(gateway), makeReq({ spec: 'dsh-foo', requestId: 'req-fail' }), res);
  const task = await settle(require('../lib/mobile/plugin-market.js').tasks.get('req-fail'));
  assert.equal(task.result.ok, false);
  assert.equal(task.result.error.code, 'operation-error');
});

test('进度：没有这条记录（宿主重启过）就如实说 unknown，不编一个结果', async () => {
  const res = makeRes();
  await handlePluginMarketProgress(makeCtx(makeGateway()), makeReq(undefined, '/api/mobile/v1/plugin/market/progress?requestId=nope'), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'unknown');
});

test('取消：转成 cancelInstall，状态原样回来（too-late 也有）', async () => {
  const seen = [];
  const gateway = makeGateway({
    'pluginManager/cancelInstall': (request) => {
      seen.push(request.args);
      return { status: 'too-late' };
    },
  });
  const res = makeRes();
  await handlePluginMarketCancel(makeCtx(gateway), makeReq({ requestId: 'req-1' }), res);
  assert.deepEqual(seen[0], { requestId: 'req-1' });
  assert.equal(res.body.status, 'too-late');
});

// ---------------------------------------------------------------------------
// 升级：卸载再装
// ---------------------------------------------------------------------------

test('升级目标：官方按需插件用宿主给的确切版本，npm 来源用裸包名，本地来源如实拒绝', () => {
  assert.deepEqual(
    updateTargetOf(normalizeBundle(bundle({ name: 'official-x', official: true, installTarget: { spec: 'official-x@0.9.0', version: '0.9.0' } }))),
    { spec: 'official-x@0.9.0' },
  );
  assert.deepEqual(updateTargetOf(normalizeBundle(bundle({ name: 'dsh-foo', source: '^1.2.0' }))), { spec: 'dsh-foo' });
  assert.deepEqual(updateTargetOf(normalizeBundle(bundle({ name: '@scope/dsh-foo', source: '@scope/dsh-foo@~2.0.0' }))), { spec: '@scope/dsh-foo' });
  assert.ok(updateTargetOf(normalizeBundle(bundle({ name: 'local-x', source: 'file:local-x.tgz' }))).problem);
  assert.ok(updateTargetOf(normalizeBundle(bundle({ name: 'linked-x', source: 'link:/tmp/x' }))).problem);
  assert.ok(updateTargetOf(normalizeBundle(bundle({ name: SELF_NAME, source: '^0.3.0' }))).problem, '自己要走那条有自检与回滚的更新路');
  assert.ok(updateTargetOf(null).problem);
});

test('升级：先卸载再装，两步都走宿主；装那一步带同一个 requestId', async () => {
  const order = [];
  const gateway = makeGateway({
    'pluginManager/listBundles': () => [bundle({ name: 'dsh-foo', source: '^1.2.0' })],
    'pluginManager/removeBundle': (request) => {
      order.push(['remove', request.args]);
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-foo' };
    },
    'pluginManager/installBundle': (request) => {
      order.push(['install', request.args]);
      return { changed: true, application: 'applied', stage: 'install', target: 'dsh-foo', version: '1.3.0' };
    },
  });
  const res = makeRes();
  await handlePluginMarketUpdate(makeCtx(gateway), makeReq({ name: 'dsh-foo', requestId: 'up-1' }), res);
  assert.equal(res.status, 202);
  assert.equal(res.body.spec, 'dsh-foo');
  const task = await settle(require('../lib/mobile/plugin-market.js').tasks.get('up-1'));
  assert.deepEqual(order.map(([step]) => step), ['remove', 'install']);
  assert.deepEqual(order[1][1], { spec: 'dsh-foo', options: { requestId: 'up-1', enabled: true } });
  assert.equal(task.result.operation.version, '1.3.0');
});

test('升级：卸载那步就失败时不再往下装（不能把插件换成半截）', async () => {
  const gateway = makeGateway({
    'pluginManager/listBundles': () => [bundle({ name: 'dsh-foo' })],
    'pluginManager/removeBundle': () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-foo', error: { code: 'bundle-in-use' } }),
    'pluginManager/installBundle': () => { throw new Error('不该走到这里'); },
  });
  const res = makeRes();
  await handlePluginMarketUpdate(makeCtx(gateway), makeReq({ name: 'dsh-foo', requestId: 'up-2' }), res);
  const task = await settle(require('../lib/mobile/plugin-market.js').tasks.get('up-2'));
  assert.equal(task.result.operation.error.code, 'bundle-in-use');
  assert.equal(gateway.calls.filter((call) => call.method === 'installBundle').length, 0);
});

test('升级一个本地来源的插件：明确回 no-update-target，不打网关', async () => {
  const gateway = makeGateway({ 'pluginManager/listBundles': () => [bundle({ name: 'local-x', source: 'file:local-x.tgz' })] });
  const res = makeRes();
  await handlePluginMarketUpdate(makeCtx(gateway), makeReq({ name: 'local-x' }), res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'no-update-target');
  assert.equal(gateway.calls.filter((call) => call.method !== 'listBundles').length, 0);
});

// ---------------------------------------------------------------------------
// 结果投影与接线
// ---------------------------------------------------------------------------

test('动作结果只认宿主那五个 application，别的按失败算', () => {
  assert.equal(operationView({ application: 'applied' }).application, 'applied');
  assert.equal(operationView({ application: 'restart-required' }).application, 'restart-required');
  assert.equal(operationView({ application: 'something-new' }).application, 'failed');
  assert.equal(operationView(null), null);
  const withError = operationView({ application: 'failed', error: { code: 'incompatible-version', diagnostic: '需要 0.3' } });
  assert.equal(withError.error.code, 'incompatible-version');
  assert.equal(withError.error.message, '需要 0.3');
});

test('接线：八条路由都挂在移动端路由表里，且都经 route()（= 带 token 守卫）', () => {
  const table = readSource('lib/routes/mobile-api.js');
  for (const suffix of [
    '/plugin/market',
    '/plugin/market/inspect',
    '/plugin/market/install',
    '/plugin/market/update',
    '/plugin/market/progress',
    '/plugin/market/cancel',
    '/plugin/market/remove',
    '/plugin/market/enabled',
  ]) {
    assert.ok(table.includes(`route('/api/mobile/v1${suffix}'`), `${suffix} 没注册（App 打过去必然 404）`);
  }
});

test('契约：不借道 shell / 不自己跑包管理器（能力面收在 pluginManager 上）', () => {
  const source = readSource('lib/mobile/plugin-market.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  for (const forbidden of ['child_process', 'pnpm', 'npm ', 'ctx.shell', 'shell(']) {
    assert.ok(!source.includes(forbidden), `插件管理不该自己做这些事：${forbidden}`);
  }
  assert.ok(source.includes("invoke(ctx, 'pluginManager'"), '唯一实现应该是转给宿主的 pluginManager');
});

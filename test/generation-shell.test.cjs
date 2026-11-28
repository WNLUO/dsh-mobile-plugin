// 验证整代换装及常驻 Tailcat 依赖的外壳变更提示。
'use strict';

/**
 * 自更新的**机制**测试：外壳能不能在不重启进程的前提下换掉实现。
 *
 * 正式 npm 包由 DSH 市场装进 profile，紧急完整包落在 `$DSH_HOME/plugin-ota/`。稳定外壳
 * `lib/index.js`（导出 `name` / `inject` / `apply`，内部 import `lib/shell/{runtime,updater,manager}.js`）
 * 从这两个来源装载完整包目录；profile 里的 npm 包是一条 symlink：
 *
 *   <PROFILE_NODE_MODULES>/dsh-mobile-plugin  --symlink-->  <store>/<id>/dsh-mobile-plugin
 *
 * 市场在 profile 里跑 pnpm：新版装进**一个新的 store 目录**，装完把那条链接指过去。
 * 「新目录 = 新 realpath = 新 URL」正是同一路径换代码骗不过 ESM 缓存所要求的，所以市场更新
 * 正式包只需「重指链接 + 重新 import 一代」；紧急 OTA 则下载完整包到独立目录。
 *
 * 测试照这个形状造：每一代写在自己的目录里，**换版本 = 写新目录 + 重指链接**。
 * `DSH_MOBILE_PROFILE_NODE_MODULES` 是给测试用的逃生口（指到临时 profile），必须在
 * require/import 外壳**之前**设好 —— `manager.js` 在模块顶层就读它。
 *
 * 这里刻意用**真的 cordis 根上下文**（不是假 ctx）：`ctx.effect` 的清理时机、路由注册的
 * 去重规则、dispose 的串行化都是被测对象本身。假 webServer 保留「重复路径抛错」的行为，
 * 于是「新代能注册同一条路径」本身就证明旧代的注册被摘干净了。
 *
 * 外壳指纹的清单由下面那条守卫按**磁盘目录**钉死：新增外壳文件忘了加进指纹清单就会红，
 * 不必靠人记得同步清单。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const PKG_DIR = path.join(__dirname, '..');
const PLUGIN_PKG = 'dsh-mobile-plugin';

// 一个临时 profile：node_modules 在其下，每一代写进它旁边的 store/（形状同 pnpm）。
// 整个文件共用这一个 profile 根 —— manager.js 在模块加载时就把路径定死了，换不了。
// 真机形状：`DSH_HOME` 是 `~/.dsh`，profile 是它下面的 `profiles/desktop`，而 OTA 落在
// `DSH_HOME/plugin-ota/`。这两者要是共用一个根目录，OTA 代就能**顺手**沿祖先目录解析到
// profile 的 node_modules ——「OTA 包在真实 home 里 import 不到依赖」那个故障
// （`Cannot find package '@deepseek-ai/schemastery'`）在测试里一次都复现不出来。
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-home-'));
const PROFILE_ROOT = path.join(HOME_ROOT, 'profiles', 'desktop');
const PROFILE_NODE_MODULES = path.join(PROFILE_ROOT, 'node_modules');
const STORE_DIR = path.join(PROFILE_ROOT, 'store');
// OTA 包落在 **profile 里面**（`<profile>/.dsh-mobile-ota`）：宿主的模块解析拦截只认
// `profiles/` 树内的模块，树外连宿主的 peer 都解析不到（见 manager.js 的 moveOtaRootIntoProfile）。
const OTA_ROOT = path.join(PROFILE_ROOT, '.dsh-mobile-ota');
const PLUGIN_LINK = path.join(PROFILE_NODE_MODULES, PLUGIN_PKG);
const PREVIOUS_DSH_HOME = process.env.DSH_HOME;
fs.mkdirSync(PROFILE_NODE_MODULES, { recursive: true });

// 只存在于 profile 的包：OTA 代的裸包名能解析到它，就证明解析走的是 profile 那一份。
const FIXTURE_PKG = 'dsh-mobile-fixture-peer';
fs.mkdirSync(path.join(PROFILE_NODE_MODULES, FIXTURE_PKG), { recursive: true });
fs.writeFileSync(path.join(PROFILE_NODE_MODULES, FIXTURE_PKG, 'package.json'), JSON.stringify({ name: FIXTURE_PKG, version: '1.0.0', type: 'module', main: 'index.js' }));
fs.writeFileSync(path.join(PROFILE_NODE_MODULES, FIXTURE_PKG, 'index.js'), "export const mark = 'fixture-ok';\n");
process.env.DSH_HOME = HOME_ROOT;
process.env.DSH_MOBILE_PROFILE_NODE_MODULES = PROFILE_NODE_MODULES;
// 装载失败后的重试间隔压到 50ms（默认 30s）：只给这条守卫用。
process.env.DSH_MOBILE_START_RETRY_MS = '50';

const shellUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'index.js')).href;
const managerUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'shell', 'manager.js')).href;
const updaterUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'shell', 'updater.js')).href;

/** 随包发布的那一代的版本号（外壳自己所在包）。 */
const BUNDLED_VERSION = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;

test.after(() => {
  if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREVIOUS_DSH_HOME;
  fs.rmSync(HOME_ROOT, { recursive: true, force: true });
});

/** 外壳那几个模块只 import 一次（ESM 会缓存），之后各用例共享同一个实例。 */
let modules = null;
function loadShellModules() {
  if (!modules) {
    modules = Promise.all([import(shellUrl), import(managerUrl), import(updaterUrl)])
      .then(([shell, manager, updater]) => ({ shell, manager, updater }));
  }
  return modules;
}

/**
 * 造一代：形状与真实安装一致（一代是自包含的，凭据包嵌在插件包内）
 *
 *   <store>/<id>/dsh-mobile-plugin/{package.json, lib/impl.js}
 *   <store>/<id>/dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js
 *
 * 凭据包必须真的在代内：实现里写死了 `../dsh-mobile-credentials/lib/credentials.js`，
 * 少了它，装上去的代一加载就 MODULE_NOT_FOUND。
 */
function makeGeneration(id, version, implSource) {
  const dir = path.join(STORE_DIR, id);
  const pkgDir = path.join(dir, PLUGIN_PKG);
  const credentialsDir = path.join(pkgDir, 'dsh-mobile-credentials', 'lib');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN_PKG, version, private: true, type: 'module' }, null, 2));
  // 凭据包自带 package.json，而且是 CJS（没有 type: module）——它嵌在插件包内，
  // 若少了这一份，最近的那份 package.json 就是插件的，credentials.js 会被当 ESM 解析
  // 而 `module.exports` 直接 ReferenceError。真实安装里 npm 会带上这个文件。
  fs.writeFileSync(path.join(pkgDir, 'dsh-mobile-credentials', 'package.json'), JSON.stringify({ name: 'dsh-mobile-credentials', version: '0.1.0', private: true, main: 'lib/credentials.js' }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), implSource);
  fs.writeFileSync(path.join(credentialsDir, 'credentials.js'), "module.exports = { mark: 'credentials-ok' };\n");
  return dir;
}

function makeOtaGeneration(version, implSource) {
  const pkgDir = path.join(OTA_ROOT, version, PLUGIN_PKG);
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN_PKG, version, type: 'module' }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), implSource);
  return pkgDir;
}

/** 一代的包目录（`package.json` / `lib/impl.js` 那一层）。 */
function pkgDirOf(dir) {
  return path.join(dir, PLUGIN_PKG);
}

/** 在这一代里写一个 CJS 子模块 `leaf.js`（`lib/relay` 是测试现场造的 commonjs 子包）。 */
function writeLeaf(dir, value) {
  const relayDir = path.join(pkgDirOf(dir), 'lib', 'relay');
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(path.join(relayDir, 'leaf.js'), `module.exports = { value: '${value}' };\n`);
}

/**
 * 「市场装完了」：把 `<PROFILE_NODE_MODULES>/dsh-mobile-plugin` 指向这一代。
 *
 * 真实的 pnpm 也是这么干的：新版进新的 store 目录，链接重指过去，于是这一代的 realpath
 * 是新的（因而绕开所有按路径索引的缓存）。换版本永远走这里，不做原地改写。
 */
function install(dir) {
  fs.rmSync(PLUGIN_LINK, { recursive: true, force: true });
  // 链接指向**包目录**（`<store>/<id>/dsh-mobile-plugin`），不是它上面那层 store 条目。
  fs.symlinkSync(pkgDirOf(dir), PLUGIN_LINK, 'dir');
}

/** 用例之间不互相污染：清 store、摘链接、丢掉模块级那份「已加载过的代」。 */
async function resetProfile() {
  const { manager } = await loadShellModules();
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
  fs.rmSync(OTA_ROOT, { recursive: true, force: true });
  fs.rmSync(PLUGIN_LINK, { recursive: true, force: true });
  manager.invalidateGeneration();
}

/** profile 里当前装着的那一代（`installedPackageDir()` 那一份）。 */
function installedGeneration(manager) {
  return manager.listGenerations().find(item => item.source === 'installed') || null;
}

/** 一个够真的假 webServer：重复路径抛错（与宿主 dsh-host-webserver 的行为一致）。 */
function createFakeWebServer(port = 4321) {
  const routes = new Map();
  const upgrades = new Map();
  return {
    port,
    routes,
    upgrades,
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route ${route.path}`);
      upgrades.set(route.path, route);
      return () => upgrades.delete(route.path);
    },
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

/**
 * 起一个装了外壳的根上下文。
 *
 * `ctx.provide`（而不是在子插件里 `reflect.provide`）是必须的：外壳要用 `inject` 声明
 * 依赖，而 inject 只在**父上下文已经提供该服务**时才解析得出来。
 *
 * `extra` 用来模拟「运行时自带某个服务」——旧 DSH（≤0.1.x）自带 `apiProxy`，0.2.0 没有。
 */
async function bootShell(extra = {}, webServerPort = undefined) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { shell } = await loadShellModules();
  const ctx = new Context();
  const server = createFakeWebServer(webServerPort);
  ctx.provide('webServer', server);
  ctx.provide('sessions', { list: () => [] });
  for (const [name, value] of Object.entries(extra)) ctx.provide(name, value);
  const fiber = await ctx.plugin({ inject: shell.inject, apply: shell.apply });
  const runtime = ctx.get('dshMobilePluginRuntime');
  assert.ok(runtime, '外壳应该 provide dshMobilePluginRuntime 服务');
  // 外壳的 start() 是 fire-and-forget，apply 不 await 它。
  return { ctx, server, fiber, runtime };
}

/** 等外壳把某一代装上去（装载完成前 `status().version` 是 null）。 */
function waitForStatus(runtime, timeoutMs = 5000) {
  return waitFor(() => {
    const status = runtime.status();
    return status.version ? status : null;
  }, timeoutMs);
}

/** 直接调一条已注册路由的 handler，拿它写出来的响应体。 */
async function routeReply(server, routePath) {
  const route = server.routes.get(routePath);
  assert.ok(route, `路由 ${routePath} 应该已经注册`);
  let body = null;
  await route.handler({}, { end: value => { body = value; } });
  return body;
}

/** 一个正常的代：声明 inject、注册一条路由、回一个标记（标记用来证明跑的是哪一代的代码）。 */
const goodGeneration = mark => `
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/gen', handler: async (req, res) => { res.end('${mark}') } }), 'gen route')
}
`;

/**
 * 带**裸包名** import 的一代：这个包只在 profile 的 `node_modules` 里。
 *
 * OTA 路径（`<home>/plugin-ota/<version>/`）上没有任何 `node_modules`，所以这一代能不能
 * 装载，直接取决于外壳有没有把 profile 那一份接进它的祖先目录。
 */
const FIXTURE_GENERATION = mark => `
import { mark as fixtureMark } from '${FIXTURE_PKG}'
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/fixture', handler: async (req, res) => { res.end('${mark}:' + fixtureMark) } }), 'fixture route')
}
`;

const BROKEN = `
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply() {
  throw new Error('这一代故意炸了')
}
`;

/**
 * 声明了 `apiProxy`（旧运行时自带）的一代。
 *
 * 它同时记两样东西：读得到的 `ctx.apiProxy.who`（宿主提供的那份真被取到了），以及自己
 * fiber 上生效的 inject 集合（声明真被转交了）。
 */
const API_PROXY_GEN = `
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'apiProxy', 'sessions']
export function apply(ctx) {
  globalThis.__seenApiProxy = ctx.apiProxy.who
  globalThis.__seenInject = Object.keys(ctx.fiber.inject).sort()
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/apiproxy', handler: async (req, res) => { res.end('ok') } }), 'apiproxy route')
}
`;

/** 完全不声明 inject 的一代：外壳必须退回自己的默认集合。 */
const NO_INJECT = `
export const name = 'dsh-mobile-plugin'
export function apply(ctx) {
  globalThis.__seenDefaultInject = Object.keys(ctx.fiber.inject).sort()
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/noinject', handler: async (req, res) => { res.end('ok') } }), 'noinject route')
}
`;

test('换代：启动时激活版本最高的那一代（profile 里那份压过随包发布的）', async t => {
  await resetProfile();
  const { manager } = await loadShellModules();
  // 随包发布的那一代也在候选里，但它的版本更低，不该被选中。
  assert.ok(manager.compareVersion('0.9.1', BUNDLED_VERSION) > 0, `这一代要真的比随包发布的 ${BUNDLED_VERSION} 新，测试才有意义`);

  const dir = makeGeneration('boot', '0.9.1', goodGeneration('boot-0.9.1'));
  install(dir);
  assert.equal(fs.realpathSync(PLUGIN_LINK), fs.realpathSync(pkgDirOf(dir)), '链接应该指向这一代的 store 目录');

  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.version, '0.9.1', '应该激活 profile 里那一代');
  assert.equal(status.source, 'installed', '这一代是从 profile 装进来的，不是随包发布的');
  assert.ok(status.activatedAt, '应记录激活时间');
  assert.equal(status.profileNodeModules, PROFILE_NODE_MODULES, '外层应该按逃生口找到 profile 的 node_modules');

  // 选代规则本身的旁证：两代都在候选里，解析出来的是版本更高的那个。
  const bundled = manager.listGenerations().find(item => item.source === 'bundled');
  assert.ok(bundled, '随包发布的那一代也应该列出来');
  assert.equal(manager.installedVersion(), '0.9.1');
  assert.equal(manager.resolveGeneration().version, '0.9.1');

  assert.ok(server.routes.has('/api/relay/gen'), '激活之后这一代的路由应该挂上');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'boot-0.9.1');
});

/**
 * 版本号**相同**时必须是 profile 里装的那一份胜出。
 *
 * 随包发布的那一代路径是固定的（包内 `lib/impl.js`），而入口的 `?v=` 只骗得过入口本身
 * —— 一旦「包内那份旧实现」被选中，状态里会写着新版本、跑的却是旧代码（这个仓库吃过最贵
 * 的一次亏）。所以这里让装进来的那一代和随包发布的**同版本号**：选出来的必须是 installed，
 * 而且注册上路由的必须真是它的代码。
 */
test('换代：版本号相同时选 profile 里那一份，不能回落到包内那份固定路径的实现', async t => {
  await resetProfile();
  const { manager } = await loadShellModules();
  install(makeGeneration('same-version', BUNDLED_VERSION, goodGeneration('same-version')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.version, BUNDLED_VERSION);
  assert.equal(status.source, 'installed', '同版本号时 profile 里那一份必须胜出');
  assert.equal(manager.resolveGeneration().source, 'installed');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'same-version', '跑起来的必须是装进来的那一代的代码');
});

test('OTA 代：裸包名沿 profile 的 node_modules 解析（真机 home 形状）', async t => {
  await resetProfile();
  const version = '9.9.20';
  makeOtaGeneration(version, FIXTURE_GENERATION('ota-fixture'));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.source, 'ota', `OTA 代必须装载成功，失败原因：${status.lastError}`);
  assert.equal(status.version, version);
  assert.equal(
    await routeReply(server, '/api/relay/fixture'),
    'ota-fixture:fixture-ok',
    'OTA 代里的裸包名必须解析到 profile 那一份依赖',
  );
  assert.equal(
    fs.readlinkSync(path.join(OTA_ROOT, version, 'node_modules')),
    PROFILE_NODE_MODULES,
    '版本目录要有一条指向 profile node_modules 的软链',
  );
});

test('正式 npm 同号到盘后，运行中的 OTA 代切到 npm 并清理 OTA 目录', async t => {
  await resetProfile();
  const { manager } = await loadShellModules();
  const version = '9.9.9';
  makeOtaGeneration(version, goodGeneration('ota-same-version'));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const before = await waitForStatus(runtime);
  assert.equal(before.version, version);
  assert.equal(before.source, 'ota');
  assert.equal(runtime.deviceOta.status().absorbed, false, 'npm 文件虽同号，活动仍是 OTA 时不能误报已吸收');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'ota-same-version');

  install(makeGeneration('official-same-version', version, goodGeneration('official-same-version')));
  const reconciled = await runtime.deviceOta.reconcileOfficial();
  assert.equal(reconciled.switched, true);
  const after = runtime.status();
  assert.equal(after.version, version);
  assert.equal(after.source, 'installed');
  assert.equal(manager.resolveGeneration().source, 'installed');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'official-same-version');
  assert.equal(fs.existsSync(path.join(OTA_ROOT, version)), false, '正式版接管后 OTA 目录应被清理');
  assert.equal(runtime.deviceOta.status().otaVersion, null);
});

test('正式版换代失败时保留 OTA 目录并回滚正在运行的旧代', async t => {
  await resetProfile();
  const version = '9.9.7';
  makeOtaGeneration(version, goodGeneration('ota-survives-failure'));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);

  install(makeGeneration('broken-official-switch', version, "throw new Error('official switch failed')"));
  await assert.rejects(runtime.deviceOta.reconcileOfficial(), /official switch failed/);
  assert.equal(runtime.status().source, 'ota');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'ota-survives-failure');
  assert.equal(fs.existsSync(path.join(OTA_ROOT, version, PLUGIN_PKG, 'package.json')), true, '失败的正式版不能删除磁盘回退包');
});

test('启动时正式包装载失败，保留的 OTA 代可作为回退继续运行', async t => {
  await resetProfile();
  const version = '9.9.8';
  makeOtaGeneration(version, goodGeneration('ota-fallback'));
  install(makeGeneration('broken-official', version, "throw new Error('official start failed')"));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.version, version);
  assert.equal(status.source, 'ota');
  assert.match(status.lastError, /official start failed/);
  assert.equal(await routeReply(server, '/api/relay/gen'), 'ota-fallback');
  assert.equal(fs.existsSync(path.join(OTA_ROOT, version, PLUGIN_PKG, 'package.json')), true, '正式版失败时不能提前删除 OTA 回退包');
});

test('换代：装进来的新代可以顶上，不必重启进程，旧代的路由被摘干净', async t => {
  await resetProfile();
  install(makeGeneration('swap-a', '0.9.2', goodGeneration('a-0.9.2')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.2');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'a-0.9.2');

  // 「市场装上了 0.9.3」：新目录 + 重指链接，然后不重启进程直接换代。
  install(makeGeneration('swap-b', '0.9.3', goodGeneration('b-0.9.3')));
  const after = await runtime.reload();
  assert.equal(after.version, '0.9.3', '应该换到新代');
  assert.equal(after.previousVersion, '0.9.2', '旧代应被记成上一代，供回滚');
  assert.equal(after.lastError, null);

  // 假 webServer 撞重复路径会抛：新代能注册同一条路径，本身就证明旧代已经摘干净。
  // 外壳自己那两条自检口（host-half / host-half/reload）是常驻的，不算换代叠加 ——
  // 这里数的是**实现**注册的路由。
  const implRoutes = [...server.routes.keys()].filter((p) => !p.startsWith('/api/relay/host-half'));
  assert.deepEqual(implRoutes, ['/api/relay/gen'], '换代替换而不是叠加：实现的路由不该增长');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'b-0.9.3', '换完跑的必须真是新代那一段代码');
});

test('换代：新代模块 import 就失败时，旧代毫发无损（预加载在卸载之前）', async t => {
  await resetProfile();
  install(makeGeneration('preimport-a', '0.9.6', goodGeneration('a-0.9.6')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.6');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'a-0.9.6');

  // 版本更高，但模块在 import 阶段就炸（缺文件）：预加载在卸载旧代之前，所以旧代不能被动到。
  const BAD_IMPORT = `
import './definitely-missing-module.js'
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/bad', handler: async (req, res) => { res.end('bad') } }), 'bad route')
}
`;
  install(makeGeneration('preimport-b', '0.9.7', BAD_IMPORT));
  await assert.rejects(() => runtime.reload());

  const status = runtime.status();
  assert.equal(status.version, '0.9.6', 'import 失败不得动旧代');
  assert.equal(status.lastRollback ?? null, null, '预加载失败根本没进换代，不该留下回滚记录');
  assert.ok(server.routes.has('/api/relay/gen'), '旧代路由必须还在（预加载失败没进换代）');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'a-0.9.6', '旧代仍在正常服务');
  assert.ok(!server.routes.has('/api/relay/bad'), '坏的那一代一条路由都不该挂上');
});

test('换代：新代装载失败时回滚到旧代，错误被记在状态里', async t => {
  await resetProfile();
  install(makeGeneration('rollback-a', '0.9.4', goodGeneration('a-0.9.4')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.4');

  // 版本更高但 apply 直接抛错：必须回滚，不能让插件整体消失。
  install(makeGeneration('rollback-b', '0.9.5', BROKEN));
  await assert.rejects(() => runtime.reload(), /这一代故意炸了/);

  const status = runtime.status();
  assert.equal(status.version, '0.9.4', '应该回滚回上一代');
  assert.match(status.lastError, /装载 0\.9\.5 失败/, '错误要留在状态里给人看');
  assert.match(status.lastError, /这一代故意炸了/);
  assert.equal(status.source, 'installed');
  assert.ok(server.routes.has('/api/relay/gen'), '回滚之后旧代的路由必须还在');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'a-0.9.4', '回滚装回去的必须真是旧代那段代码');
});

/**
 * 装上了、但新版没通过自检 → 外壳自己退回去。
 *
 * 这一条是「装坏了 App 就连不上，你怎么回滚」的答案：装坏的后果正是手机连不上，那时手机上
 * 任何按钮都发不出去。所以退回必须由宿主做完，手机只在**下一次连上之后**读到
 * `lastRollback`（`lastApply.rolledBack` 就是从它来的）。
 *
 * 造现场的办法：让宿主自称的端口上真起一个 HTTP 服务，但它回的不是本插件 —— 等价于
 * 「新版起来了，可手机要打的那批路由没挂上」。
 */
test('换代自检：新版装起来了但接口答不对，自动退回上一代并记账', async t => {
  await resetProfile();
  install(makeGeneration('selfcheck-a', '0.9.6', goodGeneration('a-0.9.6')));

  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'someone-else' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const { fiber, runtime } = await bootShell({}, port);
  t.after(async () => { await fiber.dispose(); });

  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.6');

  install(makeGeneration('selfcheck-b', '0.9.7', goodGeneration('b-0.9.7')));
  await assert.rejects(() => runtime.reload(), /自检/, '自检没过必须当作换代失败抛出去');

  const status = runtime.status();
  assert.equal(status.version, '0.9.6', '必须退回上一代继续跑');
  assert.equal(status.lastRollback?.ok, true, '退成功要记下来（手机读的就是它）');
  assert.equal(status.lastRollback?.toVersion, '0.9.6');
  assert.match(String(status.lastRollback?.reason), /someone-else|自检/);
});

/**
 * 这一条钉的是**外壳有没有把代自己声明的 `inject` 转交给 cordis**。
 *
 * 服务器那台无头宿主跑的是旧 DSH（≤0.1.x），它自带 `apiProxy` 服务，而读这个服务的前提
 * 是声明过 inject —— 否则 cordis 的 get trap 直接抛
 * `cannot get property "apiProxy" without inject`（服务器上 mirror 推送整条挂掉就是它）。
 * 外壳早期写死了 `inject: ['webServer','sessions']`，正好把这个声明吞掉，本地还测不出来。
 *
 * 光断言「`ctx.apiProxy.who` 读得到」是不够的：这份 cordis 里**根上下文**提供的服务
 * 不声明 inject 也读得到（取值会沿 fiber 链走到根），所以写死 inject 也照样绿。真正钉住
 * 转交的是代 fiber 上生效的那份 inject 集合本身，两条一起断言才算数。
 */
test('换代：代自己声明的 inject 必须被转交（旧运行时的 apiProxy 靠它）', async t => {
  await resetProfile();
  install(makeGeneration('apiproxy', '0.9.7', API_PROXY_GEN));
  const { server, fiber, runtime } = await bootShell({ apiProxy: { who: 'host-apiproxy' } });
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.version, '0.9.7', '声明了宿主也提供的服务时，这一代必须能激活');
  assert.deepEqual(globalThis.__seenInject, ['apiProxy', 'sessions', 'webServer'], '代声明的 inject 必须原样转交给 cordis，不能换成外壳那份默认集合');
  assert.equal(globalThis.__seenApiProxy, 'host-apiproxy', '代里的 ctx.apiProxy 必须拿到宿主提供的那份');
  assert.ok(server.routes.has('/api/relay/apiproxy'), '这一代的路由必须注册上');
  delete globalThis.__seenApiProxy;
  delete globalThis.__seenInject;
});

/** 代没声明 `inject` 时（只有测试会这么干）退回外壳默认值，不能因此装不上。 */
test('换代：代不声明 inject 时退回外壳默认的依赖集合', async t => {
  await resetProfile();
  install(makeGeneration('noinject', '0.9.8', NO_INJECT));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });

  const status = await waitForStatus(runtime);
  assert.equal(status.version, '0.9.8');
  assert.deepEqual(globalThis.__seenDefaultInject, ['webServer'], '没声明就退回外壳默认的 webServer（兜底值也不许挂在不存在的服务上）');
  assert.ok(server.routes.has('/api/relay/noinject'), '退回默认 inject 之后这一代必须能注册路由');
  delete globalThis.__seenDefaultInject;
});

/**
 * 这一条钉的是**路径算术**，不是运行时而恰好没有的东西。
 *
 * `lib/impl.js` 里写死了 `require('../dsh-mobile-credentials/lib/credentials.js')`。
 * 一代的 impl 在 `<代>/dsh-mobile-plugin/lib/`，`../` 落在包根，凭据包正好嵌在包内 ——
 * 这正是「一代必须自包含」的意思：回滚旧代时凭据版本跟着一起回滚。代际目录（store 里
 * 那一份）必须复刻这层关系，否则新代一加载就 MODULE_NOT_FOUND，而这个错误只在
 * 「真的装了一代并加载」时才暴露。所以这里直接按同样的相对路径解析一次。
 */
test('自包含：代内的实现能按写死的相对路径找到嵌在包里的凭据包', async () => {
  await resetProfile();
  const dir = makeGeneration('credentials', '0.9.6', goodGeneration('credentials-0.9.6'));
  const anchored = createRequire(path.join(pkgDirOf(dir), 'lib', 'impl.js'));
  assert.equal(anchored('../dsh-mobile-credentials/lib/credentials.js').mark, 'credentials-ok');
});

/**
 * 换代的**第二个半场**：入口换了，入口内部 require 出来的子模块也必须换。
 *
 * 起因是一次真实事故：profile 里的插件包在宿主运行期间被 pnpm 换成了新版本，但入口内部
 * `require('./relay/…')` 那些 CJS 子模块按**解析后的真实路径**命中缓存（`?v=` 只挂在入口
 * 上，传不下去），于是这一代跑的是上一版的子模块：新路由没注册、`appVersion` 报旧版本号，
 * 而状态里写着新版本。
 *
 * 现在的模型下这件事有两个面，都要钉住：
 *   · 市场装新版 = **新 store 目录**（新 realpath = 新 URL），整棵树必然读到新代码；
 *   · 同一个路径下把子模块换掉时，只能靠 `evictCommonJsTree` 清 CJS 缓存，否则拿到旧值。
 */
test('换代：新目录里的新代码会被读到，同一路径换掉的子模块也不能吃旧缓存', async () => {
  await resetProfile();
  const { manager } = await loadShellModules();
  const LEAF_GEN = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const leaf = require('./relay/leaf.js')
export const name = 'dsh-mobile-plugin'
export function apply() {
  return leaf.value
}
`;

  const dirA = makeGeneration('leaf-a', '1.0.0', LEAF_GEN);
  writeLeaf(dirA, 'v1');
  install(dirA);
  const first = await manager.importGeneration(installedGeneration(manager));
  assert.equal(first.apply(), 'v1');

  // 「市场装上了同一个版本号的另一份」：新目录、新 realpath，链接重指过去。
  const dirB = makeGeneration('leaf-b', '1.0.0', LEAF_GEN);
  writeLeaf(dirB, 'v2');
  install(dirB);
  assert.notEqual(fs.realpathSync(dirB), fs.realpathSync(dirA), '两代的 realpath 必须不同，pnpm 换 store 目录就是这个效果');
  assert.equal(installedGeneration(manager).pkgDir, fs.realpathSync(pkgDirOf(dirB)), 'listGenerations 必须给出 pkgDir（清缓存要靠它）');

  // 版本号相同 = `imported` 里还是上一份，得显式作废才会重新读盘。
  manager.invalidateGeneration('1.0.0');
  const second = await manager.importGeneration(installedGeneration(manager));
  assert.equal(second.apply(), 'v2', '换成新目录的那一代必须跑新代码');

  // 同一个 realpath 下把子模块换掉：入口靠 `?v=` 能换，子模块只能靠清 CJS 缓存。
  writeLeaf(dirB, 'v3');
  manager.invalidateGeneration('1.0.0');
  const third = await manager.importGeneration(installedGeneration(manager));
  assert.equal(third.apply(), 'v3', '同一路径换掉子模块之后必须读到新值，不能吃 CJS 旧缓存');
});

/**
 * 开发机回路：**版本号没变、只改了盘上那几个文件**，也要能就地重新装载。
 *
 * 这条与「市场装新版」是两件事：那边每次都是新目录（新 realpath），天然绕开全部缓存；
 * 开发机是在**同一个目录**里改文件。默认的换代判据看到「版本身份一致」就直接返回
 * （那段早返回本来是为了省掉一次无意义的装卸），于是改完代码再触发一次什么都不会发生 ——
 * 现场表现就是「我改了、也触发了，还是旧行为」。
 *
 * `runtime.reload(undefined, { reread: true })` 先把这一代从 `imported` 里作废，再让
 * `importGeneration` 清掉 CJS 子树，强制重新读盘。这里钉两件事：不带 reread 时**确实
 * 什么都不换**（说明默认行为没被这次改动带偏），带了就**必须**读到新代码。
 */
test('开发机：同一目录里改了文件，reread 能就地换上新代码（版本号不变）', async t => {
  await resetProfile();
  const { manager } = await loadShellModules();
  const LEAF_GEN = `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const leaf = require('./relay/leaf.js')
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/leaf', handler: async (req, res) => { res.end(leaf.value) } }), 'leaf route')
}
`;
  const dir = makeGeneration('devloop', '2.0.0', LEAF_GEN);
  writeLeaf(dir, 'disk-v1');
  install(dir);

  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  const before = await waitForStatus(runtime);
  assert.equal(before.version, '2.0.0');
  assert.equal(await routeReply(server, '/api/relay/leaf'), 'disk-v1');

  // 原地改文件（版本号、目录都不动）——这就是开发机改完代码的样子。
  writeLeaf(dir, 'disk-v2');

  // 先确认默认行为没变：身份一致就不装卸，仍是旧代码。
  const same = await runtime.reload();
  assert.equal(same.version, '2.0.0');
  assert.equal(await routeReply(server, '/api/relay/leaf'), 'disk-v1', '不带 reread 的 reload 不该换代码：它只负责「换一代」');

  // reread：作废缓存 + 清 CJS 子树，重新读盘。走外壳暴露的那个服务方法 —— 路由
  // (`/api/relay/reload-implementation`) 调的也是它，测试与真实入口必须同一条路。
  assert.equal(typeof runtime.reread, 'function', '外壳服务要暴露 reread（路由就调它）');
  const reread = await runtime.reread();
  assert.equal(reread.version, '2.0.0', '版本号没变，换的是同一份目录里的新代码');
  assert.equal(reread.lastError, null);
  assert.equal(await routeReply(server, '/api/relay/leaf'), 'disk-v2', 'reread 之后必须读到盘上新写的那份');
  const implRoutes = [...server.routes.keys()].filter((p) => !p.startsWith('/api/relay/host-half'));
  assert.deepEqual(implRoutes, ['/api/relay/leaf'], '换代替换而不是叠加：实现的路由不该增长');
  assert.equal(manager.installedVersion(), '2.0.0');
});

/**
 * 外壳变了**不再阻止**换代，只如实上报。
 *
 * 「外壳同源才放行、否则要求完整重启」那套已经不存在了：外壳换不掉（它在进程启动时被
 * Node 缓存），所以新版本连外壳一起改了这件事**不会**在这次更新里生效 —— 但实现该换还是
 * 换，代价只是「装载它的那层还是旧的」。用户有权知道，于是 `status()` 里报三个字段：
 * 跑着的外壳指纹、盘上那份的指纹、以及两者是否不同。
 *
 * 「盘上那份和跑着的一致」用常驻文件的**逐字节副本**构造，包含外壳和它持有的 Tailcat
 * 静态依赖；漏一个就会在「新版本只改了那个文件」时谎报没变。
 */
test('换代：外壳指纹如实上报，盘上外壳与跑着的一致时不报「外壳变了」', async t => {
  await resetProfile();
  const { manager, updater } = await loadShellModules();
  const dir = makeGeneration('shellhash', '0.9.9', goodGeneration('shell-0.9.9'));
  const pkgDir = pkgDirOf(dir);
  for (const rel of updater.shellFiles(PKG_DIR)) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, rel)), { recursive: true });
    fs.copyFileSync(path.join(PKG_DIR, rel), path.join(pkgDir, rel));
  }
  install(dir);

  const { fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);

  const status = runtime.status();
  assert.match(status.runningShellHash, /^[a-f0-9]{16}$/, '应该算得出一条外壳指纹');
  assert.equal(status.installedShellHash, updater.shellFingerprint(pkgDir), '盘上那份的指纹应该来自 profile 里装着的那一代');
  assert.equal(status.runningShellHash, status.installedShellHash, '逐字节副本的指纹必须和跑着的那份一样');
  assert.equal(status.shellChanged, false, '外壳一致时不该报「外壳变了」');

  // 盘上那份外壳被动过（新版本连外壳一起改了）：如实上报，而不是拒绝换代。
  fs.appendFileSync(path.join(pkgDir, 'lib', 'shell', 'manager.js'), '\n// 市场这次连外壳一起改了\n');
  const changed = runtime.status();
  assert.equal(changed.shellChanged, true, '盘上外壳变了必须报出来（不然用户永远不知道要重启一次）');
  assert.equal(changed.version, '0.9.9', '报「外壳变了」不影响当前这一代继续跑');
  assert.equal(manager.installedVersion(), '0.9.9');
});

/**
 * 指纹必须覆盖外壳真正加载的每一个文件。
 *
 * 漏掉的那几个同样在进程启动时被 Node 缓存、同样换不掉；只改它们时如果不报「外壳变了」，
 * 就是用户在界面上看着「更新成功」、跑的却是旧代码 —— 静默失效是最贵的失效。
 *
 * 清单本身由外壳顺着入口的引用算（手写一份必然落后），所以这里钉的是三件别的事：清单确实
 * 走到了 CJS 与多级引用（中转客户端、sidecar facade 那几份都在）、`lib/shell` 下没有逃过指纹的孤立
 * 文件、以及逐个改一个字节指纹都会变。
 */
test('换代：指纹盖住外壳实际加载的每个文件（漏一个就必须报「外壳变了」）', async () => {
  await resetProfile();
  const { updater } = await loadShellModules();
  const shellFiles = updater.shellFiles(PKG_DIR);
  assert.ok(shellFiles.length >= 8, `外壳文件数不对，引用走查可能坏了：${shellFiles.length}`);
  for (const rel of ['lib/index.js', 'lib/shell/transport-host.js', 'lib/http/routing.js', 'lib/shared/http-util.js', 'lib/shell/manager.js']) {
    assert.ok(shellFiles.includes(rel), `清单没走到 ${rel}：多级引用或 CJS 的 require 没跟上`);
  }
  for (const name of fs.readdirSync(path.join(PKG_DIR, 'lib', 'shell'))) {
    if (name.endsWith('.js')) assert.ok(shellFiles.includes(`lib/shell/${name}`), `lib/shell/${name} 不在清单里：它要么被入口引用，要么该删`);
  }
  const copyShell = () => {
    const dir = fs.mkdtempSync(path.join(HOME_ROOT, 'shell-fingerprint-'));
    for (const rel of shellFiles) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(path.join(PKG_DIR, rel), path.join(dir, rel));
    }
    return dir;
  };
  const base = updater.shellFingerprint(copyShell());
  assert.match(base, /^[a-f0-9]{16}$/);
  for (const rel of shellFiles) {
    const dir = copyShell();
    fs.appendFileSync(path.join(dir, rel), '\n// 这一版只动了它\n');
    assert.notEqual(updater.shellFingerprint(dir), base, `指纹漏了 ${rel}：只改它却没报「外壳变了」`);
  }
});

/**
 * 换代保险：装之前把正在跑的那一代备份进回退目录。
 *
 * 真正要证明的是「备份件是一份**装得起来的一代**」—— 落到 OTA 那个位置之后，启动时的候选
 * 列表里就有它，最高代装载失败时按优先级轮到它（那条回退路径本身由「启动时正式包装载失败，
 * 保留的 OTA 代可作为回退继续运行」钉着）。
 */
test('换代保险：把正在跑的那一代备份进回退目录，它是一份装得起来的一代', async t => {
  await resetProfile();
  const { manager } = await loadShellModules();
  const dir = makeGeneration('fallback-src', '0.7.7', goodGeneration('fallback-0.7.7'));
  install(dir);

  const running = manager.listGenerations().find(item => item.source === 'installed');
  const result = manager.snapshotRunningGeneration(running);
  assert.equal(result.created, true, '装之前应当备份成功');

  const fallback = manager.listGenerations().find(item => item.source === 'ota');
  assert.ok(fallback, '备份要出现在候选列表里，否则启动时根本不会去试它');
  assert.equal(fallback.version, '0.7.7');
  assert.equal(fs.existsSync(path.join(fallback.pkgDir, 'dsh-mobile-credentials', 'lib', 'credentials.js')), true, '一代是自包含的：凭据包得跟着走');
  assert.equal(fs.existsSync(path.join(OTA_ROOT, '0.7.7', 'node_modules')), false, '依赖树不复制（那不是这一代的私有件）');
  // 真的装载得起来（缺依赖的一代在这里就会抛）。
  const loaded = await manager.importGeneration(fallback);
  assert.equal(typeof loaded.apply, 'function');
  t.diagnostic(`回退副本：${result.dir}`);
});

test('传输归外壳：FRP 进程管理器跨代存活（换代不换一份）', async t => {
  await resetProfile();
  install(makeGeneration('frp-host-a', '0.9.8', goodGeneration('a-0.9.8')));
  const { ctx, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);

  const host = ctx.get('dshMobileTransportFrp');
  assert.ok(host, '外壳应 provide dshMobileTransportFrp 服务');
  // 2026-11-24：frpc 实现搬进「代」，外壳不再自己建 runner；改成当前这一代 `adopt` 交进来，
  // 外壳按实现指纹持有。守卫随之改钉「addopt 契约」——同一指纹跨代必须是同一个 runner。
  assert.equal(typeof host.adopt, 'function', '实现由当前这一代 adopt 交给外壳');
  assert.equal(typeof host.setPortProvider, 'function', '端口来源要能被当前这一代注入');

  const made = [];
  const create = () => {
    const r = { portOf: () => 0, shouldAutoStart: () => false, start() {}, status: () => ({ running: false }), dispose() {} };
    made.push(r);
    return r;
  };
  const beforeRunner = host.adopt({ fingerprint: 'same', create });
  assert.equal(typeof beforeRunner.status, 'function', 'runner 应是 frpc 进程管理器');

  install(makeGeneration('frp-host-b', '0.9.9', goodGeneration('b-0.9.9')));
  const after = await runtime.reload();
  assert.equal(after.version, '0.9.9');

  const hostAfter = ctx.get('dshMobileTransportFrp');
  const reused = hostAfter.adopt({ fingerprint: 'same', create });
  assert.equal(reused, beforeRunner, '指纹不变时 frpc 进程管理器必须跨代是同一份（否则换代就重启了直连）');
  assert.equal(made.length, 1, '指纹不变不得重建 runner');
});

test('传输归外壳：总控上报客户端跨代存活（换代不断开上报）', async t => {
  await resetProfile();
  install(makeGeneration('ctl-host-a', '0.9.10', goodGeneration('a-0.9.10')));
  const { ctx, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);

  const host = ctx.get('dshMobileTransportControl');
  assert.ok(host && host.client, '外壳应 provide dshMobileTransportControl 服务');
  assert.equal(typeof host.setProviders, 'function', '来源要能被当前这一代注入');
  assert.equal(typeof host.client.sync, 'function', '应拿到控制客户端');
  const beforeClient = host.client;

  install(makeGeneration('ctl-host-b', '0.9.11', goodGeneration('b-0.9.11')));
  await runtime.reload();
  assert.equal(ctx.get('dshMobileTransportControl').client, beforeClient, '换代不得重建总控上报客户端（否则上报连接要断一次）');
});

test('传输归外壳：隧道助手服务存在、可惰性注入来源', async t => {
  await resetProfile();
  install(makeGeneration('tc-svc', '0.9.12', goodGeneration('a-0.9.12')));
  const { ctx, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);
  const host = ctx.get('dshMobileTransportTailcat');
  assert.ok(host && typeof host.ensure === 'function', '外壳应 provide dshMobileTransportTailcat（惰性 ensure）');
  const p2pHost = ctx.get('dshMobileTransportP2P');
  assert.ok(p2pHost && typeof p2pHost.ensure === 'function', '外壳应 provide dshMobileTransportP2P（惰性 ensure）');
  const muxHost = ctx.get('dshMobileTransportMux');
  assert.ok(muxHost && muxHost.service && typeof muxHost.setProviders === 'function', '外壳应 provide dshMobileTransportMux（长连接归外壳）');

  // 传输进程管理器跨代必须是同一份（换代不重启、不重建）。
  const sidecarBefore = ctx.get('dshMobileSidecarHost');
  assert.ok(sidecarBefore, '外壳应 provide dshMobileSidecarHost');
  install(makeGeneration('tc-svc2', '0.9.13', goodGeneration('b-0.9.13')));
  await runtime.reload();
  assert.equal(ctx.get('dshMobileSidecarHost'), sidecarBefore, 'sidecar 传输进程管理器跨代是同一份');
});

test('蓝绿：新代不再注册的旧路由，提交后被摘掉（不留残影）', async t => {
  await resetProfile();
  const TWO = mark => `
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/gen', handler: async (req, res) => { res.end('${mark}') } }), 'gen')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/oldonly', handler: async (req, res) => { res.end('old') } }), 'oldonly')
}
`;
  install(makeGeneration('bg-a', '0.9.20', TWO('a-0.9.20')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.20');
  assert.ok(server.routes.has('/api/relay/oldonly'), '旧代的老路由先要在');

  install(makeGeneration('bg-b', '0.9.21', goodGeneration('b-0.9.21')));
  const after = await runtime.reload();
  assert.equal(after.version, '0.9.21');
  const implRoutes = [...server.routes.keys()].filter((p) => !p.startsWith('/api/relay/host-half'));
  assert.deepEqual(implRoutes, ['/api/relay/gen'], '新代不注册的旧路由，提交后必须被摘掉');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'b-0.9.21');
});

test('蓝绿：新代装载期间（提交前）旧代仍在服务，没有空窗', async t => {
  await resetProfile();
  install(makeGeneration('bgprobe-a', '0.9.21', goodGeneration('a-0.9.21')));
  const { server, fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);
  assert.equal(await routeReply(server, '/api/relay/gen'), 'a-0.9.21');

  // B 在自己的 apply 里（已被装载、但还没提交 live）去调一次接口：此刻必须仍打到旧代。
  const B_PROBE = `
export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/gen', handler: async (req, res) => { res.end('b-0.9.22') } }), 'gen')
  const route = globalThis.__bgServer && globalThis.__bgServer.routes.get('/api/relay/gen')
  if (route) route.handler({}, { end: (v) => { globalThis.__bgSeen = v } })
}
`;
  globalThis.__bgServer = server;
  globalThis.__bgSeen = null;
  try {
    install(makeGeneration('bgprobe-b', '0.9.22', B_PROBE));
    const after = await runtime.reload();
    assert.equal(after.version, '0.9.22');
    assert.equal(globalThis.__bgSeen, 'a-0.9.21', '新代 apply 期间（提交前）旧代必须仍在服务，不能空窗');
    assert.equal(await routeReply(server, '/api/relay/gen'), 'b-0.9.22', '提交后新代接管');
  } finally {
    delete globalThis.__bgServer;
    delete globalThis.__bgSeen;
  }
});

test('停用外壳：分派器与路由撤干净，不再转给已卸载的实现；再启用挂的是新一代', async t => {
  await resetProfile();
  install(makeGeneration('unload-a', '0.9.30', goodGeneration('unload-a')));
  const { server, fiber, runtime } = await bootShell();
  const before = await waitForStatus(runtime);
  assert.equal(before.version, '0.9.30');
  assert.ok(server.routes.has('/api/relay/gen'), '装载后这一代的路由应在');
  assert.ok(server.routes.has('/api/relay/host-half'), '外壳自检口也应在');

  // 停用/卸载外壳这一层：实现路由与外壳自检口都要撤掉，宿主上一条插件路由都不该剩。
  await fiber.dispose();
  await waitFor(() => server.routes.size === 0);
  assert.equal(server.routes.size, 0, '停用后不应再有插件路由挂在宿主上');
  assert.equal(server.routes.has('/api/relay/gen'), false, '已卸载实现的路由必须撤掉');
  assert.equal(server.routes.has('/api/relay/host-half'), false, '外壳自检口也必须撤掉');

  // 再启用：若旧分派器没撤，这里会因路由撞名抛错；新装上的实现要能真接管请求。
  install(makeGeneration('unload-b', '0.9.31', goodGeneration('unload-b')));
  const { Context } = await import('@deepseek-ai/cordis');
  const { shell } = await loadShellModules();
  const ctx2 = new Context();
  ctx2.provide('webServer', server);
  ctx2.provide('sessions', { list: () => [] });
  const fiber2 = await ctx2.plugin({ inject: shell.inject, apply: shell.apply });
  t.after(async () => { await fiber2.dispose(); });
  const runtime2 = ctx2.get('dshMobilePluginRuntime');
  const after = await waitForStatus(runtime2);
  assert.equal(after.version, '0.9.31', '再启用应激活新装的那一代');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'unload-b', '再启用后请求应由新一代处理');
});

for (const tracked of [false, true]) {
  test(`第三方路由在 AI-HUB 装载期间注册，换代与卸载后仍保留（tracked=${tracked}）`, async t => {
    await resetProfile();
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.__routeOwnershipGate = { gate, started };
    t.after(() => { delete globalThis.__routeOwnershipGate; });
    install(makeGeneration(`ownership-a-${tracked}`, '0.9.50', `
export const inject = ['webServer']
export async function apply(ctx) {
  globalThis.__routeOwnershipGate.started()
  await globalThis.__routeOwnershipGate.gate
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/relay/gen', handler: (_req, res) => res.end('a') }))
  await ctx.plugin({ inject: ['webServer'], apply(child) {
    child.effect(() => child.webServer.registerUpgrade({ path: '/api/relay/generation-ws', handler: (_req, socket) => { socket.generation = 'a'; } }))
  } })
}
`));
    // 零端口明确表示内存服务器；换代自检不访问机器上任何已有监听。
    const { ctx, server, fiber, runtime } = await bootShell({}, 0);
    t.after(async () => { release(); await fiber.dispose(); });
    if (tracked) {
      server.ctx = ctx;
      server[Symbol.for('cordis.tracker')] = { property: 'ctx', associate: 'webServer' };
    }
    await ready;
    const outer = server.register;
    const thirdPartyWrapper = function (route) { return outer.call(this, route); };
    server.register = thirdPartyWrapper;
    const third = await ctx.plugin({
      inject: ['webServer'],
      apply(other) {
        other.effect(() => other.webServer.register({ kind: 'exact', path: '/third/http', auth: 'anonymous', handler: (_req, res, peer) => res.end(peer || 'third') }));
        other.effect(() => other.webServer.registerUpgrade({ path: '/third/ws', auth: 'anonymous', handler: (_req, socket, _head, peer) => { socket.peer = peer; } }));
      },
    });
    t.after(async () => { await third.dispose(); });
    release();
    await waitForStatus(runtime);
    const httpRoute = server.routes.get('/third/http');
    const wsRoute = server.upgrades.get('/third/ws');
    assert.equal(await routeReply(server, '/third/http'), 'third');
    const generationSocket = {};
    server.upgrades.get('/api/relay/generation-ws').handler({}, generationSocket);
    assert.equal(generationSocket.generation, 'a', '实现代的子插件继承 staging 注册器');
    install(makeGeneration(`ownership-b-${tracked}`, '0.9.51', goodGeneration('b')));
    await runtime.reload();
    assert.equal(server.routes.get('/third/http'), httpRoute, '第三方 HTTP 直接注册在真实服务器，不能被换代摘掉');
    assert.equal(server.upgrades.get('/third/ws'), wsRoute, '第三方 WebSocket 不能被换代摘掉');
    assert.equal(httpRoute.auth, 'anonymous');
    const peer = { id: 'synthetic-peer' };
    let reply;
    await httpRoute.handler({}, { end: value => { reply = value; } }, peer);
    assert.equal(reply, peer, '保留 HTTP peer 参数');
    const socket = {};
    wsRoute.handler({}, socket, Buffer.alloc(0), peer);
    assert.equal(socket.peer, peer, '保留升级路由参数');
    assert.equal(await routeReply(server, '/api/relay/gen'), 'b', 'AI-HUB 自己的路由仍须换代');
    assert.equal(server.upgrades.has('/api/relay/generation-ws'), false, '新代不再提供的 AI-HUB 升级路由须移除');
    await fiber.dispose();
    assert.equal(server.register, thirdPartyWrapper, '卸载不能摘掉别的插件后来安装的包装');
    assert.ok(server.routes.has('/third/http'));
    assert.ok(server.upgrades.has('/third/ws'));
    await third.dispose();
    assert.equal(server.routes.has('/third/http'), false, '第三方自己的注销函数继续有效');
    assert.equal(server.upgrades.has('/third/ws'), false);
  });
}

test('实现代内的子插件调用 Service 时保留自己的 Context 与 effect 归属', async t => {
  await resetProfile();
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const { shell } = await loadShellModules();
  const ctx = new Context();
  class Server extends Service {
    port = 0;
    routes = new Map();
    caller() { return this.ctx.fiber.uid; }
    register(route) {
      return this.ctx.effect(() => {
        this.routes.set(route.path, route);
        return () => this.routes.delete(route.path);
      });
    }
  }
  const server = new Server(ctx, 'webServer');
  ctx.provide('sessions', { list: () => [] });
  install(makeGeneration('service-context', '0.9.52', `
export const inject = ['webServer']
export async function apply(ctx) {
  globalThis.__routeChild = await ctx.plugin({ inject: ['webServer'], apply(child) {
    globalThis.__routeChildUid = child.fiber.uid
    globalThis.__routeCallerUid = child.webServer.caller()
  } })
}
`));
  const fiber = await ctx.plugin({ inject: shell.inject, apply: shell.apply });
  t.after(async () => {
    await fiber.dispose();
    delete globalThis.__routeChild;
    delete globalThis.__routeChildUid;
    delete globalThis.__routeCallerUid;
  });
  await waitForStatus(ctx.get('dshMobilePluginRuntime'));
  assert.equal(globalThis.__routeCallerUid, globalThis.__routeChildUid, 'Service 方法必须看到调用子插件的 Context');
  globalThis.__routeChild.ctx.webServer.register({ kind: 'exact', path: '/child-after-activation', handler() {} });
  assert.ok(server.routes.has('/child-after-activation'));
  await globalThis.__routeChild.dispose();
  assert.equal(server.routes.has('/child-after-activation'), false, 'Service 自己创建的 effect 必须随子插件清理');
});

test('外壳对外报出能力契约：status 里带接口版本与能力名', async t => {
  await resetProfile();
  install(makeGeneration('compat', '0.9.40', goodGeneration('compat')));
  const { fiber, runtime } = await bootShell();
  t.after(async () => { await fiber.dispose(); });
  await waitForStatus(runtime);
  const status = runtime.status();
  assert.ok(Number.isInteger(status.shellApiVersion) && status.shellApiVersion >= 1, '外壳要报一个 ≥1 的接口版本');
  assert.ok(Array.isArray(status.shellCapabilities), '外壳要报能力清单');
  for (const cap of ['route-dispatch', 'transport-hosts', 'update-orchestration']) {
    assert.ok(status.shellCapabilities.includes(cap), `能力清单该含 ${cap}`);
  }
});

/** 轮询等待条件成立（外壳的 start() 是 fire-and-forget，测试必须等它落定）。 */async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

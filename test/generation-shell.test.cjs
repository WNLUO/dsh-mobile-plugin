'use strict';

/**
 * 自更新的**机制**测试：外壳能不能在不重启进程的前提下换掉实现。
 *
 * ## 2026-10 新模型：npm 正式代与设备 OTA 代
 *
 * 正式 npm 包由 DSH 市场装进 profile，紧急完整包落在 `$DSH_HOME/plugin-ota/`。稳定外壳 `lib/index.js`
 * （导出 `name` / `inject` / `apply`，内部 import `lib/shell/{runtime,updater,manager}.js`）从这两个来源
 * 装载完整包目录；profile 中的 npm 包通过以下链接定位：
 *
 *   <PROFILE_NODE_MODULES>/dsh-mobile-plugin  --symlink-->  <store>/<id>/dsh-mobile-plugin
 *
 * 市场在 profile 里跑 pnpm：新版装进**一个新的 store 目录**，装完把上面那条链接指过去。
 * 「新目录 = 新 realpath = 新 URL」，这正是当年非得靠 `.live/<releaseId>` 才能拿到的东西
 * （同一路径换代码骗不过 ESM 缓存），所以市场更新正式包只需「重指链接 + 重新 import 一代」；
 * 紧急 OTA 则下载完整包到独立目录。
 *
 * 测试照这个形状造：每一代写在自己的目录里，**换版本 = 写新目录 + 重指链接**。
 * `DSH_MOBILE_PROFILE_NODE_MODULES` 是给测试用的逃生口（指到临时 profile），必须在
 * require/import 外壳**之前**设好 —— `manager.js` 在模块顶层就读它。
 *
 * 这里刻意用**真的 cordis 根上下文**（不是假 ctx）：`ctx.effect` 的清理时机、路由注册的
 * 去重规则、dispose 的串行化都是被测对象本身。假 webServer 保留「重复路径抛错」的行为，
 * 于是「新代能注册同一条路径」本身就证明旧代的注册被摘干净了。
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
// `DSH_HOME/plugin-ota/`。从前这两者共用一个根目录，于是 OTA 代**顺手**就能沿祖先目录
// 解析到 profile 的 node_modules —— 「OTA 包在真实 home 里 import 不到依赖」这个真机
// 故障（`Cannot find package '@deepseek-ai/schemastery'`）在测试里一次都复现不出来。
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

/** 写一代里的 CJS 子模块 `lib/relay/leaf.js`（`lib/relay` 是 commonjs 子包）。 */
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
function createFakeWebServer() {
  const routes = new Map();
  return {
    port: 4321,
    routes,
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
async function bootShell(extra = {}) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { shell } = await loadShellModules();
  const ctx = new Context();
  const server = createFakeWebServer();
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
  assert.equal(server.routes.size, 1, '换代替换而不是叠加：路由数不应增长');
  assert.equal(await routeReply(server, '/api/relay/gen'), 'b-0.9.3', '换完跑的必须真是新代那一段代码');
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
  assert.deepEqual(globalThis.__seenDefaultInject, ['sessions', 'webServer'], '没声明就退回外壳默认的 webServer + sessions');
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
  assert.equal(server.routes.size, 1, '换代替换而不是叠加：路由数不应增长');
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
 * 「盘上那份和跑着的一致」用真外壳文件的**逐字节副本**构造（指纹算的是 lib/index.js 与
 * lib/shell 下三个文件的内容）。
 */
test('换代：外壳指纹如实上报，盘上外壳与跑着的一致时不报「外壳变了」', async t => {
  await resetProfile();
  const { manager, updater } = await loadShellModules();
  const SHELL_FILES = [
    ['lib', 'index.js'],
    ['lib', 'shell', 'runtime.js'],
    ['lib', 'shell', 'manager.js'],
    ['lib', 'shell', 'updater.js'],
  ];

  const dir = makeGeneration('shellhash', '0.9.9', goodGeneration('shell-0.9.9'));
  const pkgDir = pkgDirOf(dir);
  for (const parts of SHELL_FILES) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, ...parts)), { recursive: true });
    fs.copyFileSync(path.join(PKG_DIR, ...parts), path.join(pkgDir, ...parts));
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

/** 轮询等待条件成立（外壳的 start() 是 fire-and-forget，测试必须等它落定）。 */
async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// 使用真实上下文验证兼容桥交接、宿主服务延迟就绪与卸载时取消延迟装配。
'use strict';

/**
 * 无头宿主装载前的两处运行时兼容修正（不做，服务器宿主起不来）。
 *
 * 本包的代码是照 DSH 0.2.0 写的，但同包的第二种宿主 —— `host.js` 起的无头移动宿主 —— 跑在
 * 一份**更老的 DSH** 上（服务器那份是 0.1.1-rc.2，插件直接跑在包目录里）。两处差异都会让
 * 整棵树加载失败：
 *
 *  1. `cordis.patch.yml` 里那行「按裸包名挂载本插件」在无头宿主下解析不到包名，而 loader 对
 *     解析失败是**致命**的。那一行必须留给桌面（桌面把包装进 profile 的 node_modules，裸名
 *     解析得到），所以只在无头宿主的内存里摘掉。见 lib/host-patches.cjs。
 *  2. 老运行时自带 `apiProxy`，插件再 provide 一次会 `service "apiProxy" has been registered`。
 *     0.2.0 删掉了那个服务，兼容桥只在这时才该装。见 lib/impl.js 的 runtimeProvidesApiProxy。
 *
 * 这里盯住「判据还在」：两个修正都容易被后来的人当成多余删掉，删了不会立刻有测试红，只会
 * 在服务器上表现为「插件根本载不进来」。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');
const yaml = require('yaml');

const { dropBareNameSelfMounts } = require('../lib/host-patches.cjs');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const HOST = readSource('host.js');
const IMPL = readSource('lib/impl.js');
const BRIDGE = readSource('lib/mobile/host-bridge.js');

const BIN = 'dsh-mobile-plugin';

// ---------------------------------------------------------------------------
// 一、摘掉裸包名自挂载行
// ---------------------------------------------------------------------------

test('cordis.patch.yml 仍然留着裸包名那一行（桌面端要靠它）', () => {
  const rows = yaml.parse(readSource('cordis.patch.yml'));
  const inserted = rows.flatMap((row) => (row && Array.isArray(row.insert) ? row.insert : []));
  const self = inserted.find((row) => row && row.name === BIN);
  assert.ok(self, '删了它桌面端装完插件也不会被载入：不报错，只是没有 /api/mobile/v1');
  assert.equal(self.id, 'dsh-mobile');
});

test('host.js 装的是 cordis.patch.yml，且过了摘除那一步', () => {
  assert.match(
    HOST,
    /const selfPatches = loadOverlayPatches\(BIN_NAME, join\(PACKAGE_DIR, 'cordis\.patch\.yml'\)\)/,
    'host.js 必须加载 cordis.patch.yml 这一层',
  );
  assert.match(
    HOST,
    /dropBareNameSelfMounts\(\s*selfPatches,\s*BIN_NAME\s*\)/,
    'host.js 必须对 cordis.patch.yml 这一层调用 dropBareNameSelfMounts，否则裸名那行会带着整棵树失败',
  );
  assert.match(HOST, /import \{ dropBareNameSelfMounts \} from '\.\/lib\/host-patches\.cjs'/);
});

test('挂哪一份由「profile 里装没装」决定，但两处都必须是绝对路径', () => {
  // 2026-10-11：无头宿主也能「走 npm 安装」——插件装进 profile 之后挂的是那份的
  // `lib/index.js`（带稳定外壳，面板里能自更新）；没装才退回随包发布的 `lib/impl.js`。
  // **两处都写绝对路径**：裸包名在无头宿主里解析不到，loader 是从**它自己所在的位置**解析的
  // （实测 `Cannot find package 'dsh-mobile-plugin' imported from
  // <…>/@deepseek-ai/cordis-plugin-loader/lib/index.js`），而它在宿主自己的依赖树里，
  // profile 里那份它看不见 —— 挂裸名就是整棵树加载失败。
  assert.match(HOST, /join\(installedDir, 'lib', 'index\.js'\)/, '装了 profile 就挂那份的外壳（绝对路径）');
  assert.match(HOST, /join\(PACKAGE_DIR, 'lib\/impl\.js'\)/, '没装就退回随包发布的那份实现（绝对路径）');
  assert.match(
    HOST,
    /existsSync\(join\(installedDir, 'package\.json'\)\)/,
    '判据是「profile 里有没有这个包」这个事实，不是环境变量或目录名',
  );
  assert.ok(!/name:\s*BIN_NAME/.test(HOST), 'host.js 不许按裸包名挂载：无头宿主里那一定解析不到');
});

test('摘掉后的层里不再有这一行，其它行原样保留', () => {
  const patches = [
    { id: 'some-plugin', config: { a: 1 } },
    { insert: [{ id: 'other', name: '@scope/other' }, { id: 'dsh-mobile', name: BIN }] },
    { insert: [{ id: 'keep', name: 'kept' }] },
  ];
  const out = dropBareNameSelfMounts(patches, BIN);
  assert.deepEqual(out, [
    { id: 'some-plugin', config: { a: 1 } },
    { insert: [{ id: 'other', name: '@scope/other' }] },
    { insert: [{ id: 'keep', name: 'kept' }] },
  ]);
  // 不改原数组（宿主可能还要把同一份层交给别处看）
  assert.equal(patches[1].insert.length, 2);
});

test('整条 patch 只有这一行时连壳一起去掉（不留空 insert）', () => {
  const out = dropBareNameSelfMounts([{ insert: [{ id: 'dsh-mobile', name: BIN }] }], BIN);
  assert.deepEqual(out, []);
});

test('只摘 name 完全相等的行，不碰同前缀或其它包名', () => {
  const keep = [
    { id: 'a', name: `${BIN}-extra` },
    { id: 'b', name: 'dsh-mobile-credentials' },
    { id: 'c' },
  ];
  assert.deepEqual(dropBareNameSelfMounts([{ insert: keep }], BIN), [{ insert: keep }]);
});

test('没有 insert 的层原样穿过（web-runtime 的 config 行那种）', () => {
  const row = { id: 'web-runtime', config: { openBrowser: false } };
  assert.deepEqual(dropBareNameSelfMounts([row], BIN), [row]);
});

// ---------------------------------------------------------------------------
// 二、apiProxy 兼容桥只在没有宿主服务时才装
// ---------------------------------------------------------------------------

test('impl.js 按运行时有没有 @deepseek-ai/dsh-host-apiproxy 决定装不装桥', () => {
  // 判据只许有一条（`hasHostApiProxy`），兼容桥与审批桥共用它：写成两处各调一次
  // `runtimeProvidesApiProxy()` 迟早分叉，而分叉的代价是「老运行时多 provide 一次」
  // （整棵树加载失败）或「0.2.x 少装审批桥」（手机上看不到审批卡）。
  assert.match(
    IMPL,
    /const hasHostApiProxy = runtimeProvidesApiProxy\(\)/,
    '判据必须来自 runtimeProvidesApiProxy()，不能写死',
  );
  assert.match(
    IMPL,
    /mount\('apiProxy 兼容桥', \(\) => ctx\.reflect\.provide\('apiProxy', createApiProxy\(ctx\)\)\)/,
    '兼容桥必须注册在本代的隔离上下文，不能借用其它代即将卸载的服务',
  );
  assert.match(
    BRIDGE,
    /require\.resolve\('@deepseek-ai\/dsh-host-apiproxy\/package\.json'\)/,
    '判据是「解析得到这个包」——不能只看包名或版本号；桌面端插件装在 profile 里，够不到 asar',
  );
  assert.match(BRIDGE, /function runtimeProvidesApiProxy\(\)/);
  assert.match(IMPL, /const \{ createApiProxy, runtimeProvidesApiProxy \} = require\('\.\/mobile\/host-bridge\.js'\)/);
  // 光不 provide 还不够：旧运行时上读宿主的 apiProxy **必须声明 inject**，否则 cordis 的
  // get trap 抛 "cannot get property ... without inject"。
  //
  // 但**解析得到那个包不等于宿主一定会提供这个服务**（2026-11-02 反馈 #11）：新版宿主上
  // 包名还在、服务已经没了，把 apiProxy 写进 inject 就是「整行永远 pending」—— apply 不跑、
  // 一条路由都没注册，手机上连「装了但连不上」都看不到。所以 inject 只剩 `webServer`，
  // 旧宿主那条路由改成「等宽限期、等不到就自己兜兼容桥」。
  assert.match(
    IMPL,
    /export const inject = \['webServer'\]/,
    'inject 只许等 webServer：解析得到包不代表服务会出现，挂上去就是整行 pending',
  );
  assert.ok(!/export const inject = [^\n]*'apiProxy'/.test(IMPL), 'apiProxy 不许再写进 inject');
  assert.ok(!/typertGateway'\]/.test(IMPL), '0.2.0 那一支不许再把 typertGateway 写进 inject');
  // 宽限期之后仍没有真服务 → 按新版宿主装配（兼容桥 + 审批桥 + 提问桥一起）。
  assert.match(
    IMPL,
    /const hostProxy = hostContext\.get\('apiProxy'\)[\s\S]{0,180}ctx\.reflect\.provide\('apiProxy', hostProxy\)[\s\S]{0,140}warn\('等不到宿主的 apiProxy[\s\S]{0,120}installCompatBridges\(\)/,
    '解析到包但服务一直不来的那支必须自己兜桥，否则这一代静默空转',
  );
});

/** 执行生产装配段，Context 来自真实 cordis，网关业务与帧桥用最小假体。 */
function compatAssembly({ hasHostPackage = false, mutate = source => source } = {}) {
  const start = IMPL.indexOf('function apply(ctx) {');
  const end = IMPL.indexOf('  const state = core.loadState()', start);
  assert.ok(start >= 0 && end > start, '应能定位兼容桥装配段');
  const timers = [];
  const factory = new Function('deps', `
    const { runtimeProvidesApiProxy, createApiProxy, installApprovalBridge, installQuestionBridge, setApprovalPushNotifier, setQuestionPushNotifier, setTimeout, clearTimeout, name, API_PROXY_GRACE_MS } = deps;
    ${mutate(IMPL.slice(start, end))}
      return ctx;
    }
    return apply;
  `);
  const apply = factory({
    runtimeProvidesApiProxy: () => hasHostPackage,
    createApiProxy: ctx => ({ ctx }),
    installApprovalBridge: () => {}, installQuestionBridge: () => {},
    setApprovalPushNotifier: () => {}, setQuestionPushNotifier: () => {},
    setTimeout: callback => {
      const timer = { cleared: false, unref() {} };
      timers.push(() => { if (!timer.cleared) callback(); });
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
    name: 'compat-test', API_PROXY_GRACE_MS: 3000,
  });
  return {
    timers,
    mount: async root => {
      let ctx;
      const fiber = await root.plugin({ apply: source => { ctx = apply(source); } });
      return { ctx, fiber };
    },
  };
}

test('蓝绿换代：新旧兼容桥各自可用，卸旧代不影响新代', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  const assembly = compatAssembly();
  const old = await assembly.mount(root);
  const next = await assembly.mount(root);
  t.after(() => next.fiber.dispose());
  const oldProxy = old.ctx.apiProxy;
  assert.notEqual(next.ctx.apiProxy, oldProxy, '新代不能借用会被卸掉的旧代服务');
  await old.fiber.dispose();
  assert.equal(next.ctx.apiProxy.ctx.fiber, next.ctx.fiber);
  assert.equal(root.get('apiProxy'), undefined, '兼容服务不应占用全局服务名');
});

test('兼容桥隔离变异：移除代际隔离就能抓住同名服务冲突', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const marker = "ctx = ctx.isolate('apiProxy')";
  assert.ok(IMPL.includes(marker), '兼容桥应使用原生服务隔离');
  const assembly = compatAssembly({ mutate: source => source.replace(marker, 'ctx = ctx') });
  const root = new Context();
  const old = await assembly.mount(root);
  const next = await assembly.mount(root);
  t.after(() => next.fiber.dispose());
  await old.fiber.dispose();
  assert.throws(() => next.ctx.apiProxy, /without inject/);
});

test('宿主包还在但服务没出现：宽限期后两代分别装桥', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  const assembly = compatAssembly({ hasHostPackage: true });
  const old = await assembly.mount(root);
  const next = await assembly.mount(root);
  assembly.timers.forEach(callback => callback());
  t.after(() => next.fiber.dispose());
  assert.notEqual(old.ctx.apiProxy, next.ctx.apiProxy);
  await old.fiber.dispose();
  assert.equal(next.ctx.apiProxy.ctx.fiber, next.ctx.fiber);
});

test('旧宿主服务延迟出现：宽限期后本代使用宿主服务', async t => {
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  const assembly = compatAssembly({ hasHostPackage: true });
  const generation = await assembly.mount(root);
  t.after(() => generation.fiber.dispose());
  root.provide('apiProxy', { who: 'host' });
  assembly.timers.forEach(callback => callback());
  assert.equal(generation.ctx.apiProxy.who, 'host');
});

test('旧宿主宽限期内卸载：取消延迟装配，不再向失效上下文注册服务', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  root.provide('apiProxy', { who: 'host' });
  const assembly = compatAssembly({ hasHostPackage: true });
  const generation = await assembly.mount(root);
  assert.equal(assembly.timers.length, 1, '装配应安排一次宽限期检查');
  await generation.fiber.dispose();
  assert.doesNotThrow(() => assembly.timers.forEach(callback => callback()));
  assert.equal(root.get('apiProxy').who, 'host', '卸载本代不应影响宿主服务');
});

test('宽限期清理变异：移除取消定时器后能抓住卸载后的服务注册', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const marker = 'ctx.effect(() => () => clearTimeout(timer), `${name}: host apiProxy grace timer`)';
  assert.ok(IMPL.includes(marker), '宽限期定时器应随本代卸载清理');
  const assembly = compatAssembly({ hasHostPackage: true, mutate: source => source.replace(marker, '') });
  const root = new Context();
  root.provide('apiProxy', { who: 'host' });
  const generation = await assembly.mount(root);
  await generation.fiber.dispose();
  assert.throws(() => assembly.timers.forEach(callback => callback()), /cannot create effect on inactive context/);
});

test('解析不动就是「没有」：不能把插件带崩', () => {
  // 判据本身的行为：装着的包解析得到，没装的解析不到 —— 后者正是桌面端 profile 里
  // 那份安装的处境（profile 里只有本插件，够不到宿主那套 @deepseek-ai/*）。
  //
  // 正分支刻意不拿 @deepseek-ai/dsh-host-apiproxy 当探针：它由宿主的 dsh-web-app 供给，
  // **不在本包的锁文件里**，CI 的 --frozen-lockfile 树里解析不到（实测：干净树里拿它
  // 当正分支，这条断言直接红）。它作为探针名本身已由上面那条源码断言钉住；这里要验的
  // 只是 require.resolve 的语义，所以用锁文件里必然存在的 ws。
  const here = createRequire(path.join(ROOT, 'lib', 'impl.js'));
  assert.equal(typeof here.resolve('ws/package.json'), 'string');

  const elsewhere = createRequire(path.join(os.tmpdir(), 'not-installed', 'impl.js'));
  assert.throws(() => elsewhere.resolve('ws/package.json'));
  // 同一个判据落在宿主供给的包上同样必须抛（这就是 profile 里的处境），不能返回 undefined。
  assert.throws(() => elsewhere.resolve('@deepseek-ai/dsh-host-apiproxy/package.json'));
});

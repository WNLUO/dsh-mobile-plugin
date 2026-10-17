'use strict';

/**
 * 无头宿主装载前的两处运行时兼容修正（都实测过：不做，服务器宿主起不来）。
 *
 * 背景：本包的代码是照 DSH 0.2.0 写的，但同一个包还有第二种宿主 ——
 * `host.js` 起的无头移动宿主，跑在一份**更老的 DSH** 上（服务器上那份是 0.1.1-rc.2，
 * 插件直接跑在包目录里，依赖树是整套 `@deepseek-ai/*`）。两处差异都会让整棵树加载失败：
 *
 *  1. `cordis.patch.yml` 里那行「按裸包名挂载本插件」在无头宿主下解析不到包名，
 *     而 loader 对解析失败是**致命**的（`Cannot find package 'dsh-mobile-plugin'`）。
 *     那一行必须留给桌面（桌面把包装进 profile 的 node_modules，裸名解析得到），
 *     所以只在无头宿主的内存里摘掉。见 lib/host-patches.cjs。
 *  2. 老运行时自带 `apiProxy`（`@deepseek-ai/dsh-host-apiproxy`），插件再 provide 一次
 *     会 `service "apiProxy" has been registered`。0.2.0 删掉了那个服务，兼容桥只在这时
 *     才该装。见 lib/impl.js 的 runtimeProvidesApiProxy。
 *
 * 这里盯住「判据还在」：两个修正都容易被后来的人当成多余而删掉，删了不会立刻有测试红，
 * 只会在服务器上表现为「插件根本载不进来」。
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
  assert.match(
    IMPL,
    /if \(!runtimeProvidesApiProxy\(\)\) ctx\.reflect\.provide\('apiProxy', createApiProxy\(ctx\)\)/,
    '无条件 provide 会在老运行时撞上宿主的 apiProxy，整棵树加载失败',
  );
  assert.match(
    IMPL,
    /require\.resolve\('@deepseek-ai\/dsh-host-apiproxy\/package\.json'\)/,
    '判据是「解析得到这个包」——不能只看包名或版本号；桌面端插件装在 profile 里，够不到 asar',
  );
  assert.match(IMPL, /function runtimeProvidesApiProxy\(\)/);
  // 光不 provide 还不够：旧运行时上读宿主的 apiProxy **必须声明 inject**，否则 cordis 的
  // get trap 抛 "cannot get property ... without inject"。所以 inject 也得是二选一的。
  assert.match(
    IMPL,
    /export const inject = runtimeProvidesApiProxy\(\)\s*\?\s*\['webServer', 'apiProxy', 'sessions'\]\s*:\s*\['webServer', 'sessions', 'typertGateway'\]/,
    'inject 必须按运行时二选一：旧运行时要 apiProxy，0.2.0 要 typertGateway（事件流全靠它派发）',
  );
  // 不注入 `typertGateway` 的后果不是报错而是**静默降级**：`ctx.get('typertGateway')` 在
  // 装载那一刻取到空值（它是后装载的服务），每条事件流都抛「宿主版本没有提供该能力」。
  // 收发消息与会话列表走普通请求因而照常工作，看着只像「刷新不实时」——服务器宿主上
  // 就这么躺了很久。所以这条与上面二分的是同一件事的两半，别只改一半。
  assert.match(
    IMPL,
    /\['webServer', 'sessions', 'typertGateway'\]/,
    '0.2.0 这一支必须注入 typertGateway，否则实时推送整条挂掉而其它功能正常',
  );
  // 从前这两条钉的是「外壳要把实现自己声明的 inject 带出来」。2026-10 拆掉外壳与代机制之后
  // `lib/impl.js` 直接就是入口，cordis 拿到的是它自己 `export` 的 inject —— 那层转交没有了，
  // 于是这条留在实现侧：谁把 inject 改回写死的集合，上面那条断言会红。
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

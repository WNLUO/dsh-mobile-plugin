'use strict';

/**
 * 守卫：开发机同步脚本（`scripts/reload-dev.mjs`）到底把哪些文件装进 profile。
 *
 * 起因有两层。第一层（2026-10-20）：脚本原来只收 `lib/` 下的 js/cjs/mjs，于是**面板产物**
 * （`lib/panel/index.html`）、`lib` 各子目录里的 `package.json`（那几个目录的 `"type":
 * "commonjs"` 声明）、`config/agent-presets` 的 preset、`cordis.mobile-host.yml`、`host.js`、
 * 内联的凭据包全都推不过去，改完这些再跑一次同步界面一点变化都没有，而脚本还报「已就地
 * 重新装载」。第二层（2026-10-23）：装进去的东西**不是 profile 声明的产物**，重启 DSH 时
 * 宿主按声明重装一遍，装回来的又是旧快照 —— 表现是「热重载过了，重启又是旧版」。
 *
 * 现在默认那条路的判据是**包自己的 `files` 白名单**（`npm pack --dry-run` 说了算），所以
 * 这里钉三件事：
 *   1. 包清单必须收住运行时要读的每一类文件（实现、面板产物、子目录声明、preset、yml、
 *      凭据库、`host.js`）；
 *   2. 包清单必须排掉构建源码、测试、脚本、依赖、tgz 与锁文件；
 *   3. 脚本必须真的走「打包 + 依赖声明改写 + 运行时 pnpm install」这套动作，不能悄悄退回
 *      逐文件拷贝 —— 退回就又是那个重启就回退的 bug。
 *
 * 运行：node --test test/reload-dev-scope.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'reload-dev.mjs');

/** 脚本是 ESM、且只在跑 `main()` 时才有副作用；读源码取常量比 import 它更稳。 */
const source = fs.readFileSync(SCRIPT, 'utf8');

/** 包清单：直接问 npm，别在这里再抄一份 `files` 规则（抄一份就是第二份实现）。 */
function packedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
  assert.ok(Array.isArray(list), 'npm pack --dry-run --json 没给出文件清单');
  return list.map(item => item.path);
}

const FILES = packedFiles();
const has = rel => FILES.includes(rel);

test('包清单收住了实现、面板产物与子目录声明', () => {
  for (const rel of ['lib/impl.js', 'lib/panel/index.html', 'lib/routes/package.json']) {
    assert.ok(has(rel), `${rel} 必须在包里`);
  }
});

test('宿主运行时要读的那些非 js 文件也在包里（缺了就是「改了没生效」）', () => {
  for (const rel of [
    'cordis.patch.yml',
    'cordis.mobile-host.yml',
    'config/agent-presets/standard/agent.cordis.yml',
    'config/agent-presets/standard/preset.yml',
    'host.js',
    'package.json',
    'dsh-mobile-credentials/lib/credentials.js',
    'dsh-mobile-credentials/package.json',
  ]) {
    assert.ok(has(rel), `${rel} 必须在包里`);
  }
});

test('构建源码、测试、脚本、依赖与打包产物不进包', () => {
  assert.ok(!FILES.some(rel => rel.startsWith('React/')), 'React/ 是构建源码，不随实现走');
  assert.ok(!FILES.some(rel => rel.startsWith('test/')), 'test/ 不进包');
  assert.ok(!FILES.some(rel => rel.startsWith('scripts/')), 'scripts/ 不进包');
  assert.ok(!FILES.some(rel => rel.includes('node_modules')), '依赖不进包');
  assert.ok(!FILES.some(rel => rel.endsWith('.tgz')), '打包产物不进包');
  assert.ok(!has('pnpm-lock.yaml'), 'profile 有自己的锁文件，别覆盖它');
});

test('包清单里不存在会跳出包根的意外路径', () => {
  const dangerous = FILES.filter(rel => rel.startsWith('..') || path.isAbsolute(rel));
  assert.deepEqual(dangerous, [], '包清单里不许出现跳出包根的路径');
});

test('默认那条路必须走打包 + 改依赖声明 + 运行时 pnpm 安装', () => {
  // 这三样缺一条，重启就会退回旧快照：只拷文件 → 安装不是声明的产物；不打进 profile →
  // 安装读不到那一份；不用运行时 pnpm → 布局与锁文件格式对不上。
  assert.match(source, /execFileSync\('npm', \['pack', '--pack-destination'/, '默认路要真的打包');
  assert.match(source, /pointDeclarationAt/, '默认路要把依赖声明指到刚打出来的那一份');
  assert.match(source, /'install', '--no-frozen-lockfile'/, '默认路要用 pnpm 更新锁文件后安装');
  assert.match(source, /runtimePnpm\(\)/, '默认路要用运行时自带那个 pnpm');
  assert.match(source, /reload-implementation/, '两条路都要触发就地重载');
});

test('前端源码比面板产物新时必须先重建，再打包安装（别把旧页面装进 profile）', () => {
  // 判据是修改时间而不是「调用方有没有提醒」：React/src 比 lib/panel/index.html 新就重建。
  assert.match(source, /function panelIsStale\(\)/, '没有「产物是否比源码旧」的判据');
  assert.match(source, /newestMtime/, '没有按前端源码的修改时间判');
  assert.match(source, /'run', 'build'/, '没有自动重建面板');
  assert.match(source, /面板构建失败/, '构建失败必须停下，不能把旧产物装进去');

  // 顺序也是契约：重建 → 打包 → 安装 → 重载。反了就等于拿上一份产物去装。
  const main = source.slice(source.indexOf('async function main()'));
  const staleAt = main.indexOf('panelIsStale()');
  const installAt = main.indexOf('installPackedPackage()');
  assert.ok(staleAt > 0, 'main 里没用陈旧判据');
  assert.ok(installAt > 0, 'main 里没走默认安装路');
  assert.ok(staleAt < installAt, '必须先判断（必要时重建）面板，再打包安装');
});

test('--only 只收包白名单里的路径：构建源码 / 测试 / 包外的东西当场拒掉', () => {
  // 真的跑一次脚本（对着一个临时 DSH_HOME 里的假 profile），断言的是一条真实行为：
  // 不在包白名单里的路径（这里是 React 构建源码）必须以非零退出，且把原因说出来。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reload-scope-'));
  const profile = path.join(home, 'profiles', 'desktop');
  const target = path.join(profile, 'node_modules', 'dsh-mobile-plugin');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(PLUGIN_ROOT, target, {
    recursive: true,
    filter: source => !source.includes(`${path.sep}node_modules`),
  });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-desktop', dependencies: { 'dsh-mobile-plugin': 'file:dsh-mobile-plugin-0.0.0.tgz' } }, null, 2)}\n`,
  );

  const runScript = extra => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...extra], {
        cwd: PLUGIN_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: home },
      });
      return { code: 0, out: stdout };
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };

  try {
    const outside = runScript(['--only', 'React/src/demo/host.ts', '--dry-run']);
    assert.notEqual(outside.code, 0, 'React/ 里的文件不在包白名单里，必须拒掉');
    assert.match(outside.out, /白名单/, '拒掉时要说明原因（不在包白名单里）');

    const missing = runScript(['--only', 'lib/pack-excludes-me.js', '--dry-run']);
    assert.notEqual(missing.code, 0, '仓库里没有的路径必须拒掉');
    assert.match(missing.out, /仓库里没有这个文件/);

    const inside = runScript(['--only', 'lib/impl.js', '--dry-run']);
    assert.equal(inside.code, 0, '包里有的文件要能走这条快路');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

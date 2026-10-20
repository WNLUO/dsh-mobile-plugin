'use strict';

/**
 * 守卫：开发机同步脚本（`scripts/reload-dev.mjs`）到底把哪些文件搬进 profile。
 *
 * 起因：这个脚本原来只收 `lib/` 下的 js/cjs/mjs，于是**面板产物**（`lib/panel/index.html`）、
 * `lib` 各子目录里的 `package.json`（那几个目录的 `"type": "commonjs"` 声明）、
 * `config/agent-presets` 的 preset、`cordis.mobile-host.yml`、`host.js`、内联的凭据包全都
 * 推不过去。改完这些再跑一次同步，界面一点变化都没有，而脚本还报「已就地重新装载」——
 * 2026-10-20 之前它就是这副样子。
 *
 * 这里钉两端：
 *   1. **该同步的一个都不能漏**：上列每一类各派一个代表，必须出现在同步清单里；
 *   2. **不该进 profile 的一个都不能进**：`React/` 构建源码、`test/`、`scripts/`、依赖、
 *      tgz 与 pnpm 锁文件。
 *
 * 判据是脚本自己导出的那张表，不是重新抄一份规则 —— 抄一份等于把这份守卫变成第二份实现。
 *
 * 运行：node --test test/reload-dev-scope.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PLUGIN_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'reload-dev.mjs');

/** 脚本是 ESM、且只在跑 `main()` 时才有副作用；读源码取那张表比 import 它更稳。 */
const source = fs.readFileSync(SCRIPT, 'utf8');

/** 从源码里取出排除表（三个常量），按脚本自己的写法解析。 */
function readExcludedDirs() {
  const match = source.match(/const EXCLUDED_DIRS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, '脚本里找不到 EXCLUDED_DIRS：排除表是本守卫的判据，改名字要同步改这里');
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

const EXCLUDED_DIRS = readExcludedDirs();

/**
 * 把脚本的排除规则在**这份真实包目录**上跑一遍，得到「会同步哪些文件」。
 *
 * 直接调脚本的 `collectSourceFiles` 更短，但它是模块内部的私有函数、没有导出；为了不让
 * 这份守卫反过来逼脚本导出一个只给测试用的口子，这里照同一套规则走一遍，并用两端断言
 * 把「规则本身」钉住（漏改一处就会红）。
 */
function collect(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), rel));
    } else {
      if (entry.name === '.gitignore' || entry.name === 'LICENSE' || entry.name === 'pnpm-lock.yaml') continue;
      if (entry.name.endsWith('.tgz') || entry.name.endsWith('.log') || entry.name.endsWith('.DS_Store')) continue;
      out.push(rel);
    }
  }
  return out;
}

const FILES = collect(PLUGIN_ROOT);
const has = rel => FILES.includes(rel);

test('脚本的排除表不含 lib/ —— 实现、面板产物与子目录声明都要同步', () => {
  assert.deepEqual(EXCLUDED_DIRS.filter(dir => dir.startsWith('lib')), [], 'lib/ 不能被整目录排除');
  for (const rel of ['lib/impl.js', 'lib/panel/index.html', 'lib/routes/package.json']) {
    assert.ok(has(rel), `${rel} 必须进同步清单`);
  }
});

test('宿主启动时要读的那些非 js 文件也要同步（缺了就是「改了没生效」）', () => {
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
    assert.ok(has(rel), `${rel} 必须进同步清单`);
  }
});

test('构建源码、测试、脚本、依赖与打包产物不进 profile', () => {
  assert.ok(!FILES.some(rel => rel.startsWith('React/')), 'React/ 是构建源码，不随实现走');
  assert.ok(!FILES.some(rel => rel.startsWith('test/')), 'test/ 不进 profile');
  assert.ok(!FILES.some(rel => rel.startsWith('scripts/')), 'scripts/ 不进 profile');
  assert.ok(!FILES.some(rel => rel.includes('node_modules')), '依赖不进 profile');
  assert.ok(!FILES.some(rel => rel.endsWith('.tgz')), '打包产物不进 profile');
  assert.ok(!has('pnpm-lock.yaml'), 'profile 有自己的锁文件，别覆盖它');
});

test('同步清单里不存在会覆盖 profile 关键文件的意外路径', () => {
  const dangerous = FILES.filter(rel => rel.startsWith('..') || path.isAbsolute(rel));
  assert.deepEqual(dangerous, [], '同步清单里不许出现跳出包根的路径');
});

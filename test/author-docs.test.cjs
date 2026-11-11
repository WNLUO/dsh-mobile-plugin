'use strict';

/**
 * 守卫：写扩展的人拿到的那份文档，真的在这条 npm 发布链上。
 *
 * 起因：作者文档与样例原本放在**仓库根的 `docs/`**，而 `files` 白名单只收插件包内的东西 ——
 * 于是文档在仓库里写得再全，`npm install dsh-mobile-plugin` 之后一个字都看不到，作者只能去
 * 翻 GitHub。2026-11-11 有人在 issue 里问到「npm 包里找不到第 8 节」才发现。
 *
 * 这类错误在仓库里全都测不出来：文件在、内容对、文档之间互相引用得也对，只有装上之后才
 * 现形。所以这里钉三件事，任何一条松了都意味着某个作者又拿不到文档：
 *
 *  1. 文档与样例**住在插件包里**（不在仓库根的 `docs/`）；
 *  2. `package.json` 的 `files` 白名单把它们收住，且 `npm pack` 出来的清单里真有它们；
 *  3. 发版预检的 `REQUIRED_FILES` 也列着它们 —— 那条是真打一次包再比对，漏了当场停。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PKG_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(PKG_DIR, '..');
const DOC = path.join(PKG_DIR, 'docs', 'extension-authoring.md');
const SAMPLE_DIR = path.join(PKG_DIR, 'docs', 'extension-sample');

/** 包清单里必须出现的作者文档与样例文件。 */
const MUST_SHIP = [
  'docs/extension-authoring.md',
  'docs/extension-sample/README.md',
  'docs/extension-sample/manifest.json',
  'docs/extension-sample/index.html',
];

/** 问 npm 要这份包会收哪些文件 —— 与 `npm publish` 收的完全同一份。 */
function packedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [info] = JSON.parse(raw);
  assert.ok(Array.isArray(info?.files), 'npm pack --dry-run --json 没给出文件清单');
  return info.files.map((file) => file.path);
}

test('文档与样例住在插件包里，不在仓库根的 docs/', () => {
  assert.ok(fs.existsSync(DOC), '作者文档必须在 dsh-mobile-plugin/docs/ 下');
  assert.ok(fs.existsSync(SAMPLE_DIR), '样例目录必须在 dsh-mobile-plugin/docs/ 下');
  // 仓库根那份是**老位置**：留一份拷贝就会出现「改了一处、发的还是另一处」，
  // 而作者读到的是错的。宁可这里红，让人决定往哪儿搬。
  assert.equal(fs.existsSync(path.join(REPO_DIR, 'docs', 'extension-authoring.md')), false,
    '仓库根的 docs/extension-authoring.md 是旧位置，别留拷贝');
  assert.equal(fs.existsSync(path.join(REPO_DIR, 'docs', 'extension-sample')), false,
    '仓库根的 docs/extension-sample 是旧位置，别留拷贝');
});

test('文档自己没写死仓库根路径（作者手上没有那个目录）', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  // 指向另一个只在仓库里存在的文件会让作者按图索骥失败。
  const dangling = [...text.matchAll(/`(docs\/[^`\s]+)`/g)]
    .map((m) => m[1])
    .filter((rel) => !fs.existsSync(path.join(PKG_DIR, rel)));
  assert.deepEqual(dangling, [], `文档里指向了包里不存在的路径：${dangling.join('、')}`);
});

test('npm 包清单真的收住作者文档与样例', () => {
  const files = packedFiles();
  const missing = MUST_SHIP.filter((rel) => !files.includes(rel));
  assert.deepEqual(missing, [], `npm 包里缺：${missing.join('、')}`);
  // 反方向：文档不该把插件的源码 / 测试 / 脚本一起拖进包。
  const leaked = files.filter((rel) => /^(React|test|scripts)\/|node_modules/.test(rel));
  assert.deepEqual(leaked, [], `包里混进了不该发的东西：${leaked.slice(0, 5).join('、')}`);
});

test('发版预检的必需清单里也列着它们', () => {
  const source = fs.readFileSync(path.join(PKG_DIR, 'scripts', 'preflight-release.mjs'), 'utf8');
  for (const rel of MUST_SHIP) {
    assert.ok(source.includes(`'${rel}'`), `preflight-release.mjs 的 REQUIRED_FILES 漏了 ${rel}`);
  }
});

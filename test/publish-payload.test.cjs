'use strict';

/**
 * 守卫：npm 包里到底带了什么。
 *
 * 起因：2026-10 插件改从 npm 分发（更新交给 DSH 的插件市场），`files` 白名单从
 * 「打 tgz 给安装器用」变成**唯一的发布清单**。这类错误在仓库里全都测不出来，只在
 * 别人装完之后才现形，而且症状离原因很远：
 *   - 入口（`main` / `exports`）没被白名单收住 → 宿主拿到一个没有 `apply` 的模块，
 *     表现为「插件装了但没有任何路由」，日志一行都没有；
 *   - 凭据库（`dsh-mobile-credentials/`）没被收住 → 启动即 `Cannot find module`
 *     （它靠包内相对路径被引用，见 lib/shared/credentials-entry.js）；
 *   - `dsh.bundle.patch` 指向的叠加层文件没被收住 → 装了不会成为叠加层，静默无效果；
 *   - 网页版面板产物（`lib/panel/index.html`）没被收住 → 设置菜单那个链接点开 404。
 *
 * 所以这里不问「白名单写得好不好看」，只问一件事：**每个会被加载的东西，都在包里**。
 * 白名单是 glob，所以先把它按 npm 的语义展开成「这个相对路径会不会被打进去」再断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PKG_DIR = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const PATTERNS = pkg.files ?? [];

/** npm 的 `files` 语义：裸目录名连子树一起收，`*` 不跨目录，`**` 跨目录。 */
function matchesGlob(rel, pattern) {
  const hasMagic = /[*?]/.test(pattern);
  if (!hasMagic) return rel === pattern || rel.startsWith(`${pattern}/`);
  const rx = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '(?:[^/]+/)*')
      .replace(/\u0001/g, '.*')}$`,
  );
  return rx.test(rel);
}

// npm 恒定包含这几个，不管 `files` 写了什么。
const ALWAYS_SHIPPED = new Set(['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md']);
const shipped = (rel) =>
  ALWAYS_SHIPPED.has(rel) || PATTERNS.some((pattern) => matchesGlob(rel, pattern));

/** 入口声明里常见的 `./` 前缀，比对前统一去掉。 */
const normalize = (rel) => rel.replace(/^\.\//, '');

test('发布元数据是「能发出去」的形态', () => {
  // `private: true` 会让 npm 直接拒绝发布；这条防的是有人为了「先别发」把它加回来之后忘了删。
  assert.equal(pkg.private, undefined, 'private 会让 npm publish 直接失败，发布包不能带它');
  assert.equal(pkg.name, 'dsh-mobile-plugin', '包名是装载契约（客户端半边按包名解析），改名要同步改宿主');
  assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org/', '必须发到官方源：镜像只是缓存，不接收发布');
  assert.equal(pkg.publishConfig?.access, 'public', '非 scope 包也要显式 public，否则会被当成私有包');
  // 版本坐标是仓库硬约束：App 的构建号按 major*1_000_000 + minor*1_000 + patch 拼。
  const segments = pkg.version.split(/[.-]/).slice(0, 3);
  assert.equal(segments.length, 3, `版本号必须是三段：${pkg.version}`);
  segments.forEach((segment, index) => {
    const label = ['major', 'minor', 'patch'][index];
    assert.ok(
      Number.isInteger(Number(segment)) && Number(segment) >= 0 && Number(segment) <= 999,
      `${label} 必须在 0..999：${pkg.version}`,
    );
  });
});

test('每个入口都真实存在，而且都被 files 白名单收住', () => {
  const entries = [
    ['main', pkg.main],
    ...Object.entries(pkg.exports ?? {}).map(([key, value]) => [`exports['${key}']`, value]),
    ['bin', typeof pkg.bin === 'string' ? pkg.bin : null],
  ].filter(([, value]) => typeof value === 'string');

  assert.ok(entries.length > 0, '一个入口都没有的包发出去没有意义');
  for (const [label, rel] of entries) {
    const clean = normalize(rel);
    // 入口可以是 glob（`./locale/*.json` 那种）：目录要在、要匹配到文件、匹配到的每一条都要进包。
    if (clean.includes('*')) {
      const dir = path.dirname(clean);
      const base = path.basename(clean);
      const abs = path.join(PKG_DIR, dir);
      assert.ok(fs.existsSync(abs), `${label} = ${rel} 的目录不存在`);
      const rx = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      const hits = fs.readdirSync(abs).filter((name) => rx.test(name));
      assert.ok(hits.length > 0, `${label} = ${rel} 一个文件都没匹配到`);
      hits.forEach((name) => {
        const rel2 = path.posix.join(dir, name);
        assert.ok(shipped(rel2), `${label} = ${rel} 匹配到的 ${rel2} 没被 files 白名单收住`);
      });
      continue;
    }
    assert.ok(fs.existsSync(path.join(PKG_DIR, clean)), `${label} = ${rel} 在仓库里不存在`);
    assert.ok(shipped(clean), `${label} = ${rel} 没被 files 白名单收住：装上去之后这个入口是空文件`);
  }
});

test('凭据库随包走：它靠包内相对路径被引用，漏收就是启动即崩', () => {
  const nested = 'dsh-mobile-credentials/lib/credentials.js';
  assert.ok(
    fs.existsSync(path.join(PKG_DIR, nested)),
    '凭据库不在包内：它是被 lib/shared/credentials-entry.js 按包内相对路径找的，别把它挪出去',
  );
  assert.ok(shipped(nested), `${nested} 没被 files 白名单收住：装上会 Cannot find module`);
  // 反过来说：包内那份的 package.json 也要在，否则 node 解析不到它的 exports。
  assert.ok(shipped('dsh-mobile-credentials/package.json'), '凭据库的 package.json 必须一起进包');
});

test('叠加层与网页版面板产物都在包里', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert.ok(typeof patch === 'string', '插件必须声明 dsh.bundle.patch，否则装了不会成为叠加层');
  assert.ok(shipped(normalize(patch)), `${patch} 没被 files 白名单收住：装了不生效，而且不报错`);

  const panel = 'lib/panel/index.html';
  assert.ok(fs.existsSync(path.join(PKG_DIR, panel)), '网页版面板产物不在仓库里（React/ 改了要重新构建）');
  assert.ok(shipped(panel), `${panel} 没被 files 白名单收住：设置菜单那个链接点开会 404`);
});

test('白名单不许把开发目录也发出去', () => {
  // 这些目录进了包只会让包变大、并且把「仓库里的东西」和「别人装到的东西」混为一谈。
  const devOnly = ['React', 'test', 'scripts', 'dist', '.live', 'node_modules'];
  for (const pattern of PATTERNS) {
    const head = pattern.split('/')[0];
    assert.ok(!devOnly.includes(head), `files 白名单里有开发目录：${pattern}`);
    // 通配本身没问题（`lib/**/*.js` 是刻意的：只收代码，不收同目录里的杂项）；
    // 有问题的是**第一段就通配**——那等于把仓库根目录整个发出去。
    assert.ok(!/[*?]/.test(head), `files 白名单第一段不许通配（会把开发文件一起发）：${pattern}`);
  }
});

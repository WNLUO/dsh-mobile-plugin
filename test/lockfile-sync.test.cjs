'use strict';

/**
 * 守卫：dsh-mobile-plugin 的依赖锁。
 *
 * 起因是一次「以为锁住了、其实没锁」的状态：`pnpm-lock.yaml` 在库里，但三处文档
 * （README.md、dsh-mobile-plugin/README.md、README 的 rsync 部署段）教的都是
 * `npm install --legacy-peer-deps`。npm 不读 pnpm-lock，仓库里又没有 package-lock.json，
 * 于是每次干净安装解析出的依赖树都可能不同——锁文件在那儿躺着，从没被用过。
 *
 * 这里钉三件事：
 *   1. 锁文件存在，且 package.json 的每个依赖/peer/dev 在锁的 importers['.'] 里都有同 specifier；
 *   2. 文档与 CI 教的是 pnpm，且不再教 --legacy-peer-deps；
 *   3. cordis 的 peer 约束真的被解掉了（否则文档改成 pnpm 也没用，装不上）。
 *
 * 第 1 条等价于 `pnpm install --frozen-lockfile` 的前置检查，但它不需要网络、不需要
 * node_modules 存在，所以能在沙箱里跑。真正的解析是否仍然成立，要靠 CI 里那一次
 * `pnpm install --frozen-lockfile` 来兜。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..');
const ROOT = path.join(PLUGIN, '..');
// 两种检出：整仓（插件在 dsh-mobile-plugin/ 子目录里）与单独 clone 出来的公开发布仓库。
// 后者没有主仓的 README / ci.yml，那几份文档不在场时不比对，而不是把断言整组跳过。
//
// 判据是「父目录里有主仓的 app/」，不是「父目录里有个 dsh-mobile-plugin/」——GitHub Actions
// 检出的路径是 `<工作区>/dsh-mobile-plugin/dsh-mobile-plugin`，仓库名出现两次，按后者判会把
// 单独检出误认成整仓，然后去读一个不存在的 README 崩掉。
const MONOREPO = fs.existsSync(path.join(ROOT, 'app', 'package.json'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const pkg = JSON.parse(read(PLUGIN, 'package.json'));

test('锁文件与 package.json 同步：每个依赖在锁里都有同一个 specifier', () => {
  const lock = read(PLUGIN, 'pnpm-lock.yaml');
  assert.ok(/^lockfileVersion:/m.test(lock), 'pnpm-lock.yaml 不在库里？CI 的 --frozen-lockfile 会失败');

  // 只取 importers['.'] 段——packages 段里的 key 是「包名@版本」形态，名字会撞。
  const start = lock.indexOf('importers:');
  assert.ok(start > 0, 'pnpm-lock.yaml 缺 importers 段');
  const end = lock.indexOf('\npackages:', start);
  const importer = lock.slice(start, end > start ? end : undefined);

  const specs = new Map(
    [...importer.matchAll(/^ {6}'?([^'\n:]+)'?:\n {8}specifier: '?([^'\n]+)'?$/gm)].map((m) => [m[1], m[2]]),
  );

  const declared = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, range] of Object.entries(declared)) {
    assert.ok(specs.has(name), `${name}（${range}）不在 pnpm-lock.yaml 里——跑一次 pnpm install 更新锁`);
    assert.equal(specs.get(name), range, `${name} 的 specifier 对不上：package.json 写 ${range}，锁里写 ${specs.get(name)}`);
  }
  for (const name of specs.keys()) {
    assert.ok(declared[name] !== undefined, `锁里有 ${name}，但 package.json 没声明`);
  }
});

test('文档与 CI 教 pnpm，不再教 --legacy-peer-deps', () => {
  const docs = [['README.md', read(PLUGIN, 'README.md')]];
  if (MONOREPO) {
    docs.push(
      ['dsh-mobile-plugin/README.md', read(PLUGIN, 'README.md')],
      ['.github/workflows/ci.yml', read(ROOT, '.github', 'workflows', 'ci.yml')],
      // 根 package.json 的 comment 块也在教人怎么装插件，一样要跟着改。
      ['package.json', read(ROOT, 'package.json')],
    );
  }
  // 发布流水线自己也是一处「安装命令」的产地，装法写错就在发版那一刻才炸。
  const publishWorkflow = path.join(PLUGIN, '.github', 'workflows', 'publish.yml');
  if (fs.existsSync(publishWorkflow)) docs.push(['.github/workflows/publish.yml', read(publishWorkflow)]);
  for (const [name, text] of docs) {
    // 散文里解释「为什么以前要那个参数」是允许的；命令里再写就不允许。所以先剔掉
    // markdown 引用块与注释行，剩下的每一行只要提到 install 就必须是 pnpm + frozen。
    const commandLines = text
      .split('\n')
      .filter((line) => !/^\s*(>|#|\/\/)/.test(line) && /install/.test(line));
    for (const line of commandLines) {
      assert.doesNotMatch(line, /legacy-peer-deps/, `${name} 的安装命令里还带着 --legacy-peer-deps：${line.trim()}`);
    }
    // README 与 CI 必须给出可复制的命令；package.json 只做编排，不该出现安装命令。
    if (name === 'package.json') {
      assert.doesNotMatch(
        text,
        /legacy-peer-deps/,
        'package.json 的注释里还在教人用 --legacy-peer-deps（它没装任何东西，纯编排）',
      );
    } else {
      assert.ok(commandLines.length > 0, `${name} 里一条安装命令都没有，这测试没意义`);
      assert.match(text, /pnpm install --frozen-lockfile/, `${name} 没有给出 --frozen-lockfile 的安装命令`);
    }
  }
});

test('cordis 的 peer 约束被解掉了（否则文档改成 pnpm 也没用）', () => {
  // cordis-plugin-hmr@1.0.19 要求 cordis ~4.0.4；锁里若解析到别的版本，干净环境装不上。
  const lock = read(PLUGIN, 'pnpm-lock.yaml');
  const resolved = lock.match(/^ {6}'@deepseek-ai\/cordis':\n {8}specifier:[^\n]*\n {8}version: ([^\n]+)$/m);
  assert.ok(resolved, '锁的 importers 里找不到 @deepseek-ai/cordis');
  assert.match(
    resolved[1],
    /^4\.0\.4/,
    `@deepseek-ai/cordis 解析到了 ${resolved[1]}，但 cordis-plugin-hmr@1.0.19 要求 ~4.0.4`,
  );
});
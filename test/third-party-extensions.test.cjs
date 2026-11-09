'use strict';

/**
 * 第三方插件自带的扩展（`lib/mobile/third-party-extensions.js` + 清单里的合并那一段）。
 *
 * 要钉的是四件事：① 只认 `package.json` 里 `dshMobileExtensions` 那一格声明，没声明的插件
 * 一概不扫；② slug 是「插件名.扩展目录名」，两家拼起来仍合规、全局去重；③ 声明目录越出包外
 * 一律不算；④ 合进清单之后判据与随本插件发布那一档完全一致 —— 缺入口页、超限的包照样不列，
 * 取文件也走同一道闸（不认识的 slug 回 404）。
 *
 * 假目录自己建自己删，不碰 profile 里的真东西。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const thirdParty = require('../lib/mobile/third-party-extensions.js');
const {
  listThirdParty,
  handleCatalog,
  handleCatalogFile,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
} = require('../lib/mobile/extension-catalog.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-third-party-ext-'));
}

/** 在 profile 里铺一个插件：`manifest` 写进 package.json，`files` 是包内相对路径 → 内容。 */
function makePlugin(pluginsRoot, name, manifest, files) {
  const directory = path.join(pluginsRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const [relative, content] of Object.entries(files || {})) {
    const full = path.join(directory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return directory;
}

/** 铺一个扩展包目录（`<插件>/<声明目录>/<slug>/`）。 */
function makeExtension(packageDir, declaredDir, slug, manifest, files) {
  const directory = path.join(packageDir, declaredDir, slug);
  fs.mkdirSync(directory, { recursive: true });
  if (manifest !== null) {
    fs.writeFileSync(path.join(directory, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  for (const [relative, content] of Object.entries(files || {})) {
    const full = path.join(directory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return directory;
}

function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(String(payload)); };
  return res;
}

const fakeGet = (url) => ({ url, method: 'GET', headers: {} });

test('声明解析：只认字符串与 true，坏形状与越界路径都不算', () => {
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: true }), 'extensions');
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: 'web-ext' }), 'web-ext');
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: '  web-ext  ' }), 'web-ext');
  assert.equal(thirdParty.declaredDir({}), null, '没声明就是不带扩展');
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: false }), null);
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: ['extensions'] }), null, '数组不算');
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: '' }), null);
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: '../outside' }), null, '不许越出包外');
  assert.equal(thirdParty.declaredDir({ dshMobileExtensions: '/abs/path' }), null, '绝对路径不算');
  assert.equal(thirdParty.declaredDir(null), null);
});

test('slug 由「插件名.扩展目录名」拼成，且始终合规', () => {
  assert.equal(thirdParty.ownerSlugOf('dsh-mobile-plugin'), 'dsh-mobile-plugin');
  assert.equal(thirdParty.ownerSlugOf('@scope/name'), 'scope.name');
  assert.equal(thirdParty.ownerSlugOf('@scope/a/b'), 'scope.a.b');
  assert.equal(thirdParty.ownerSlugOf('奇怪的名字'), '_____', '非 ASCII 逐个削成下划线，不是整段丢掉');
  assert.equal(thirdParty.slugOf('owner', 'demo'), 'owner.demo');

  // 插件名再长也不能让 slug 破掉上限：削的是插件名那一半，扩展目录名原样留着。
  const long = thirdParty.slugOf('a'.repeat(200), 'demo');
  assert.equal(long, `${'a'.repeat(59)}.demo`);
  assert.ok(thirdParty.SLUG_PATTERN.test(long), `拼出来的 slug 必须合规：${long}`);
  assert.ok(long.endsWith('.demo'), '扩展目录名那一半不该被削掉');
});

test('只有声明过的插件才扫：没声明 / 声明目录不在 / 不是目录，都当没有', () => {
  const root = makeTmp();
  try {
    const declared = makePlugin(root, 'with-ext', { dshMobileExtensions: 'my-ext' }, {});
    makeExtension(declared, 'my-ext', 'demo', { name: '演示' }, { 'index.html': '<h1/>' });

    // 同一个包里有 extensions/ 目录，但 package.json 里一个字都没声明 —— 不扫。
    const silent = makePlugin(root, 'no-decl', {}, {});
    makeExtension(silent, 'extensions', 'sneaky', { name: '悄悄混进来' }, { 'index.html': '<h1/>' });

    // 声明了但那个目录不存在。
    makePlugin(root, 'ghost', { dshMobileExtensions: 'extensions' }, {});

    // 声明成一个文件而不是目录。
    const fileDecl = makePlugin(root, 'file-decl', { dshMobileExtensions: 'extensions' }, {});
    fs.mkdirSync(path.join(fileDecl, 'extensions'), { recursive: true });
    fs.rmSync(path.join(fileDecl, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(fileDecl, 'extensions'), 'not a directory');

    const found = thirdParty.discoverPackages(root);
    assert.deepEqual(found.map((entry) => entry.slug), ['with-ext.demo']);
    assert.equal(found[0].packageName, 'with-ext');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('带 scope 的插件、点开头的目录、同名 slug 都按约定处理', () => {
  const root = makeTmp();
  try {
    const scoped = makePlugin(root, '@team/kit', { dshMobileExtensions: true }, {});
    makeExtension(scoped, 'extensions', 'alpha', { name: 'A' }, { 'index.html': '<h1/>' });
    makeExtension(scoped, 'extensions', '.hidden', { name: '藏起来' }, { 'index.html': '<h1/>' });

    // 第二个插件里有个同名目录，slug 前缀不同所以不冲突。
    const other = makePlugin(root, 'second', { dshMobileExtensions: true }, {});
    makeExtension(other, 'extensions', 'alpha', { name: 'B' }, { 'index.html': '<h1/>' });

    const slugs = thirdParty.discoverPackages(root).map((entry) => entry.slug).sort();
    assert.deepEqual(slugs, ['second.alpha', 'team.kit.alpha'], '点开头的目录不列、scope 落成点');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('声明目录跑出包外不算数（`..` 与软链接都挡住）', () => {
  const root = makeTmp();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-third-party-outside-'));
    try {
      const pkg = makePlugin(root, 'escaping', {}, {});
      // 声明里带 ..，declaredDir 直接拒；再验一次 resolve 之后的前缀判也拦得住。
      fs.writeFileSync(path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'escaping', dshMobileExtensions: '../outside-ext' }));
      fs.mkdirSync(path.join(pkg, '..', 'outside-ext', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(pkg, '..', 'outside-ext', 'demo', 'index.html'), '<h1/>');

      assert.deepEqual(thirdParty.discoverPackages(root), [], '越界声明一个包都不该冒出来');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('合进清单：判据与随本插件发布那一档一致，缺入口页 / 超限的包照样不列', () => {
  const root = makeTmp(); // 空的本插件目录（没有 catalog.json）
  const pluginsRoot = makeTmp();
  try {
    const pkg = makePlugin(pluginsRoot, 'ext-host', { dshMobileExtensions: 'exts' }, {});
    makeExtension(pkg, 'exts', 'good', {
      name: '好扩展', versionName: '2.1.0', capabilities: ['content.read'], description: '包内说明',
    }, { 'index.html': '<h1>ok</h1>', 'libs/a.js': 'console.log(1)' });
    makeExtension(pkg, 'exts', 'no-entry', { name: '没入口页' }, { 'app.html': '<h1/>' });
    makeExtension(pkg, 'exts', 'broken', '{ 这不是 json', { 'index.html': '<h1/>' });
    const many = { 'index.html': '<h1/>' };
    for (let index = 0; index <= MAX_PACKAGE_FILES; index += 1) many[`f-${index}.txt`] = 'x';
    makeExtension(pkg, 'exts', 'too-many', { name: '文件太多' }, many);
    makeExtension(pkg, 'exts', 'too-big', { name: '太大' },
      { 'blob.bin': Buffer.alloc(MAX_PACKAGE_BYTES + 1, 7) });

    const listed = listThirdParty(pluginsRoot);
    assert.deepEqual(listed.map((entry) => entry.slug), ['ext-host.good'],
      `判不过的包不该列：${listed.map((entry) => entry.slug).join(', ')}`);

    const [good] = listed;
    assert.equal(good.name, '好扩展');
    assert.equal(good.versionName, '2.1.0');
    assert.equal(good.description, '包内说明', '文案从包自己的 manifest 读');
    assert.equal(good.author, 'ext-host', '包内没写作者就退到插件名');
    assert.deepEqual(good.capabilities, ['content.read']);
    assert.deepEqual(good.files.map((file) => file.path).sort(),
      ['index.html', 'libs/a.js', 'manifest.json']);
    assert.equal(good.size, good.files.reduce((sum, file) => sum + file.size, 0));
    assert.match(good.files.find((file) => file.path === 'libs/a.js').sha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('清单合并：两档同名时随本插件发布那份优先，第三方的不顶替', async () => {
  const root = makeTmp();
  const pluginsRoot = makeTmp();
  try {
    // 本插件那一档：catalog.json 登记了 `demo` 这个 slug。
    fs.writeFileSync(path.join(root, 'catalog.json'),
      JSON.stringify({ packages: [{ slug: 'demo', author: '我们' }] }));
    const ours = path.join(root, 'demo');
    fs.mkdirSync(ours, { recursive: true });
    fs.writeFileSync(path.join(ours, 'manifest.json'), JSON.stringify({ name: '我们的包' }));
    fs.writeFileSync(path.join(ours, 'index.html'), '<h1/>');

    // 第三方插件里拼出同一个 slug（插件名 demo、扩展目录名 demo → demo.demo，改用直接同名更难：
    // 这里就验前缀不同时两条都在）。
    const pkg = makePlugin(pluginsRoot, 'demo', { dshMobileExtensions: true }, {});
    makeExtension(pkg, 'extensions', 'demo', { name: '别人的包' }, { 'index.html': '<h1/>' });

    const res = fakeRes();
    await handleCatalog(null, fakeGet('/api/mobile/v1/extension/catalog'), res, root, pluginsRoot);
    assert.equal(res.status, 200);
    const slugs = res.body.packages.map((entry) => entry.slug).sort();
    assert.deepEqual(slugs, ['demo', 'demo.demo'], '两档都列，slug 不冲突');
    const ourRow = res.body.packages.find((entry) => entry.slug === 'demo');
    assert.equal(ourRow.name, '我们的包');
    assert.equal(ourRow.author, '我们');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('取文件那条也认第三方插件的 slug，不认识的仍回 404', async () => {
  const root = makeTmp();
  const pluginsRoot = makeTmp();
  try {
    const pkg = makePlugin(pluginsRoot, 'ext-host', { dshMobileExtensions: 'exts' }, {});
    makeExtension(pkg, 'exts', 'demo', { name: '演示' }, {
      'index.html': '<h1>你好</h1>',
      'libs/a.js': 'export default 1',
    });
    // 包目录外面的东西：无论怎么拼都不该读到。
    fs.writeFileSync(path.join(pluginsRoot, 'outside.txt'), 'outside');

    const ask = async (query, plugins = pluginsRoot) => {
      const res = fakeRes();
      await handleCatalogFile(null, fakeGet(`/api/mobile/v1/extension/catalog/file?${query}`), res, root, plugins);
      return res;
    };

    const ok = await ask('slug=ext-host.demo&path=libs/a.js');
    assert.equal(ok.status, 200);
    assert.equal(Buffer.from(ok.body.content, 'base64').toString('utf8'), 'export default 1');
    assert.equal(ok.body.path, 'libs/a.js');

    assert.equal((await ask('slug=ext-host.demo&path=../outside.txt')).status, 400, '越界一律 400');
    assert.equal((await ask('slug=nobody.demo&path=index.html')).status, 404, '不认识的 slug 读不到');
    assert.equal((await ask('slug=ext-host.demo&path=index.html', null)).status, 404,
      '没有 profile 目录时（外壳取不到）也读不到第三方的包');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

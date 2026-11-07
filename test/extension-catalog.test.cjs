'use strict';

/**
 * 已审核扩展清单的宿主侧（`lib/mobile/extension-catalog.js`）。
 *
 * 真正要钉的是三件事：① 审核闸门 —— 只有 catalog.json 里登记的 slug 才出现，目录里有但没
 * 登记的、登记了但目录不在的一律没有，取文件同样过这道闸；② 文件清单的 size / sha256 由
 * 宿主扫目录现算，不信 catalog.json 里写的数字；③ 取文件被锁在包目录里，越界一律 400。
 *
 * 假目录走 listPackages(root) 与两个 handler 的可选 root 参数，不碰包里那份真 extensions/。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  catalogRoot,
  listPackages,
  handleCatalog,
  handleCatalogFile,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_FILE_BYTES,
} = require('../lib/mobile/extension-catalog.js');
const { readRouteTable } = require('./lib/wiring.cjs');

/** 一个假根目录；每个用例自己建、自己删。 */
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extension-catalog-'));
}

function writeCatalog(root, content) {
  fs.writeFileSync(path.join(root, 'catalog.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

/** 铺一个包：`files` 是「相对路径 → 内容」，manifest 为 null 时不写 manifest.json。 */
function makePackage(root, slug, manifest, files) {
  const directory = path.join(root, slug);
  fs.mkdirSync(directory, { recursive: true });
  if (manifest !== null) {
    const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(directory, 'manifest.json'), text);
  }
  for (const [relative, content] of Object.entries(files || {})) {
    const full = path.join(directory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return directory;
}

const sha256Of = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** 假 ServerResponse：与 extension-dev.test.cjs 同一形状，只记最后一次回包。 */
function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(String(payload)); };
  return res;
}

const fakeGet = (url) => ({ url, method: 'GET', headers: {} });

test('根目录固定在插件包内，不随 cwd 拼出来', () => {
  const root = catalogRoot();
  assert.ok(path.isAbsolute(root), '包内目录必须是绝对路径');
  assert.equal(root, path.join(path.dirname(__dirname), 'extensions'));
  assert.equal(path.basename(root), 'extensions');
});

test('catalog.json 不在 / 坏 / packages 不是数组，都回空表，不抛', async () => {
  const root = makeRoot();
  try {
    assert.deepEqual(listPackages(root), [], '没有 catalog.json 就是空清单');
    const res = fakeRes();
    await handleCatalog(null, fakeGet('/api/mobile/v1/extension/catalog'), res, root);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.packages, []);

    writeCatalog(root, '{ 这不是 json');
    assert.deepEqual(listPackages(root), [], '坏 JSON 当空清单');

    writeCatalog(root, { packages: 'x' });
    assert.deepEqual(listPackages(root), [], 'packages 不是数组也当空清单');

    writeCatalog(root, { packages: [] });
    assert.deepEqual(listPackages(root), [], '空清单就是空清单');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('只列 catalog.json 里登记的：没登记的目录、登记了但没目录的都不出现', async () => {
  const root = makeRoot();
  try {
    makePackage(root, 'approved', {
      name: '审过的', versionName: '1.2.0', apiVersion: '1', capabilities: ['content.read'],
    }, { 'index.html': '<h1>ok</h1>' });
    makePackage(root, 'orphan', { name: '没登记' }, { 'index.html': 'x' });
    writeCatalog(root, { packages: [
      { slug: 'approved', description: '一句说明', author: '作者', releaseNotes: '第一版' },
      { slug: 'ghost' },
    ] });

    const listed = listPackages(root);
    assert.deepEqual(listed.map((entry) => entry.slug), ['approved']);
    const pkg = listed[0];
    assert.equal(pkg.name, '审过的');
    assert.equal(pkg.description, '一句说明');
    assert.equal(pkg.author, '作者');
    assert.equal(pkg.releaseNotes, '第一版');
    assert.equal(pkg.versionName, '1.2.0');
    assert.equal(pkg.apiVersion, '1');
    assert.deepEqual(pkg.capabilities, ['content.read']);

    const res = fakeRes();
    await handleCatalog(null, fakeGet('/api/mobile/v1/extension/catalog'), res, root);
    assert.deepEqual(res.body.packages.map((entry) => entry.slug), ['approved']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('字段收窄：可选文案不是字符串就 null、能力只认字符串；size/sha256 由扫目录算，不信清单里的数字', () => {
  const root = makeRoot();
  try {
    makePackage(root, 'pkg', {
      name: '包', version: '2.0.0', api_version: '1',
      capabilities: ['content.read', 42, '', 'card.write', 'content.read'],
    }, {
      'index.html': '<h1>hi</h1>',
      'libs/a.js': 'console.log(1)',
      '.env': 'SECRET=1',
      '.git/config': 'gitconfig',
    });
    writeCatalog(root, { packages: [{
      slug: 'pkg', description: 12, author: null, releaseNotes: '',
      // 清单里塞的这些一概不认：文件事实由宿主现算，名字与能力从包里读。
      size: 99999999, sha256: 'deadbeef', files: [{ path: 'invented.js', size: 1, sha256: 'x' }],
      name: '假名字', capabilities: ['host.action'],
    }] });

    const [pkg] = listPackages(root);
    assert.ok(pkg);
    assert.equal(pkg.name, '包', 'name 从包自己的 manifest 读，不信清单');
    assert.equal(pkg.description, null);
    assert.equal(pkg.author, null);
    assert.equal(pkg.releaseNotes, null);
    assert.equal(pkg.versionName, '2.0.0', 'versionName 缺了读 version');
    assert.equal(pkg.apiVersion, '1', 'apiVersion 缺了读 api_version');
    assert.deepEqual(pkg.capabilities, ['content.read', 'card.write'], '能力只从 manifest 收窄，重复去掉');
    assert.equal(pkg.fileCount, 3, 'manifest.json 与两个正文文件；点开头的不算');
    assert.deepEqual(pkg.files.map((file) => file.path).sort(), ['index.html', 'libs/a.js', 'manifest.json']);
    assert.equal(pkg.size, pkg.files.reduce((sum, file) => sum + file.size, 0));
    assert.notEqual(pkg.size, 99999999, '清单里写的 size 不该被采信');
    const lib = pkg.files.find((file) => file.path === 'libs/a.js');
    assert.equal(lib.size, Buffer.byteLength('console.log(1)'));
    assert.equal(lib.sha256, sha256Of('console.log(1)'));
    assert.match(lib.sha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('坏包、不合规 slug、超限包都静默跳过，好包照列', () => {
  const root = makeRoot();
  try {
    makePackage(root, 'good', { name: '好包' }, { 'index.html': '<h1/>', 'a.txt': 'a' });
    makePackage(root, 'broken', '{ 这不是 json', { 'index.html': '<h1/>' });
    makePackage(root, 'no-manifest', null, { 'index.html': '<h1/>' });
    makePackage(root, 'no-entry', { name: '缺入口页' }, { 'app.html': '<h1/>', 'a.txt': 'a' });
    makePackage(root, 'bad slug', { name: '不该出现' }, { 'index.html': '<h1/>' });

    // 文件数超限：正好 200 个能过，201 个整包不要。
    const many = { 'index.html': '<h1/>' };
    for (let index = 0; index <= MAX_PACKAGE_FILES; index += 1) many[`f-${index}.txt`] = 'x';
    makePackage(root, 'too-many', { name: '文件太多' }, many);
    const exact = { 'index.html': '<h1/>' };
    for (let index = 0; index < MAX_PACKAGE_FILES - 2; index += 1) exact[`f-${index}.txt`] = 'x';
    makePackage(root, 'exact-count', { name: '刚好' }, exact);

    // 单个大文件把整包顶过 20MB。
    makePackage(root, 'too-big', { name: '太大' }, {
      'blob.bin': Buffer.alloc(MAX_PACKAGE_BYTES + 1, 7),
    });

    writeCatalog(root, { packages: [
      'good', 'broken', 'no-manifest', 'no-entry', 'bad slug',
      'too-many', 'exact-count', 'too-big', 'ghost', 'good',
    ].map((slug) => ({ slug })) });

    const listed = listPackages(root);
    assert.deepEqual(listed.map((entry) => entry.slug).sort(), ['exact-count', 'good'].sort(),
      `坏包不该出现在列表里：${listed.map((entry) => entry.slug).join(', ')}`);
    assert.ok(!listed.some((entry) => entry.slug === 'no-entry'),
      '缺 index.html 的包会被跳过：装到手机上才报「需要重新安装」更难查');
    const exactCount = listed.find((entry) => entry.slug === 'exact-count');
    assert.equal(exactCount.fileCount, MAX_PACKAGE_FILES, 'manifest + 入口页 + 198 个文件正好到上限，要留下');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('入口页固定叫 index.html：manifest 里的 main 不生效，只有 app.html 的包不列', () => {
  const root = makeRoot();
  try {
    makePackage(root, 'with-main', { name: '写了 main', main: 'app.html' },
      { 'app.html': '<h1/>' });
    makePackage(root, 'fixed-entry', { name: '标准入口', main: 'app.html' },
      { 'index.html': '<h1/>' });
    writeCatalog(root, { packages: [{ slug: 'with-main' }, { slug: 'fixed-entry' }] });

    const listed = listPackages(root);
    assert.deepEqual(listed.map((entry) => entry.slug), ['fixed-entry'],
      'App 侧 extensionEntryPath 只找 index.html，写了 main 指向别的名字也打不开');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('取文件：回 base64 与 sha256，且跟列表里那份是同一个值', async () => {
  const root = makeRoot();
  try {
    makePackage(root, 'demo', { name: '演示' }, { 'index.html': '<h1>你好</h1>', 'libs/a.js': 'export default 1' });
    writeCatalog(root, { packages: [{ slug: 'demo' }] });
    const [listed] = listPackages(root);

    const res = fakeRes();
    await handleCatalogFile(null, fakeGet('/api/mobile/v1/extension/catalog/file?slug=demo&path=libs/a.js'), res, root);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.path, 'libs/a.js');
    assert.equal(res.body.size, Buffer.byteLength('export default 1'));
    assert.equal(Buffer.from(res.body.content, 'base64').toString('utf8'), 'export default 1');
    assert.equal(res.body.sha256, sha256Of('export default 1'));
    assert.equal(
      res.body.sha256,
      listed.files.find((file) => file.path === 'libs/a.js').sha256,
      '同一份字节，列表与取文件给的 sha256 必须一样',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('取文件的拒绝口径：越界一律 400、没登记/包没了 404、文件没了 404、超 8MB 413', async () => {
  const root = makeRoot();
  try {
    makePackage(root, 'demo', { name: '演示' }, { 'index.html': 'hi', 'libs/a.js': 'a' });
    // 包目录外面的东西：无论怎么拼路径都不该读到它。
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    // 前缀相同但不是子目录的兄弟目录（demo-evil 以 demo 开头）。
    makePackage(root, 'demo-evil', { name: '隔壁' }, { 'x.txt': 'evil' });
    makePackage(root, 'huge', { name: '大文件' }, { 'big.bin': Buffer.alloc(MAX_FILE_BYTES + 1, 3) });
    makePackage(root, 'no-manifest', null, { 'a.txt': 'a' });
    writeCatalog(root, { packages: [
      { slug: 'demo' }, { slug: 'demo-evil' }, { slug: 'huge' }, { slug: 'no-manifest' },
    ] });

    const ask = async (query) => {
      const res = fakeRes();
      await handleCatalogFile(null, fakeGet(`/api/mobile/v1/extension/catalog/file?${query}`), res, root);
      return res;
    };

    assert.equal((await ask('slug=demo&path=../outside.txt')).status, 400);
    assert.equal((await ask('slug=demo&path=../outside.txt')).body.error.code, 'bad-request');
    assert.equal((await ask('slug=demo&path=../demo-evil/x.txt')).status, 400, '兄弟目录同样越界');
    assert.equal((await ask(`slug=demo&path=${encodeURIComponent(path.join(root, 'outside.txt'))}`)).status, 400, '绝对路径不接受');
    assert.equal((await ask('slug=demo&path=..%2Fdemo-evil%2Fx.txt')).status, 400, '编码过的 .. 也算越界');

    assert.equal((await ask('slug=demo')).body.error.code, 'bad-request', '缺 path 回 400');
    assert.equal((await ask('path=index.html')).body.error.code, 'bad-request', '缺 slug 回 400');
    assert.equal((await ask('slug=demo%20x&path=index.html')).body.error.code, 'bad-request', '坏 slug 回 400');

    const notRegistered = await ask('slug=orphan&path=index.html');
    assert.equal(notRegistered.status, 404);
    assert.equal(notRegistered.body.error.code, 'package-missing', '没登记的 slug 一个字节都读不到');

    const noManifest = await ask('slug=no-manifest&path=a.txt');
    assert.equal(noManifest.status, 404);
    assert.equal(noManifest.body.error.code, 'package-missing');

    const missingFile = await ask('slug=demo&path=libs/none.js');
    assert.equal(missingFile.status, 404);
    assert.equal(missingFile.body.error.code, 'file-missing');

    const tooLarge = await ask('slug=huge&path=big.bin');
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error.code, 'file-too-large');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('包内 catalog.json 登记的都下发给手机（handler 走真目录）', async () => {
  // 2026-11-08：这里不再是「空清单」——首批真实扩展（magpie）已随插件发布。判据改成
  // 「登记即下发」：catalog.json 里登记的每个 slug，若目录里有 manifest.json 与 index.html，
  // 就必须出现在列表里；没登记的一个都不能冒出来。少登记/缺入口页由 preflight 拦，这里只对账。
  const declared = JSON.parse(fs.readFileSync(path.join(catalogRoot(), 'catalog.json'), 'utf8'));
  const res = fakeRes();
  await handleCatalog(null, fakeGet('/api/mobile/v1/extension/catalog'), res);
  assert.equal(res.status, 200);
  const declaredSlugs = declared.packages.map((row) => row.slug).sort();
  const servedSlugs = res.body.packages.map((row) => row.slug).sort();
  assert.deepEqual(servedSlugs, declaredSlugs, '登记即下发：登记的 slug 都该在，未登记的不出现');
});

test('两条路由紧跟扩展 dev 那两条之后注册', () => {
  const table = readRouteTable();
  const devPackages = table.indexOf("'/api/mobile/v1/extension/dev/packages'");
  const devFile = table.indexOf("'/api/mobile/v1/extension/dev/file'");
  const catalog = table.indexOf("'/api/mobile/v1/extension/catalog'");
  const catalogFile = table.indexOf("'/api/mobile/v1/extension/catalog/file'");
  assert.ok(devPackages > 0 && devFile > 0, 'dev 那两条要注册着');
  assert.ok(catalog > 0 && catalogFile > 0, '两条清单路由都要注册');
  assert.ok(devFile > devPackages, 'dev：list 在前、取文件在后');
  assert.ok(catalog > devFile, '清单两条紧跟在 dev 两条之后');
  assert.ok(catalogFile > catalog, '清单：list 在前、取文件在后');
});

test('发版预检会拦下缺入口页的包，并要求清单文件真的进包', () => {
  const preflight = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'preflight-release.mjs'), 'utf8');
  assert.match(preflight, /'extensions\/catalog\.json'/,
    'REQUIRED_FILES 要含扩展清单，漏了就是发出去的包里没有清单');
  assert.match(preflight, /extensions\/\$\{slug\}\/index\.html|'index\.html'/,
    '打包那一步要逐个验登记包带 index.html');
  assert.match(preflight, /badPackages\.length/,
    '缺文件的登记包要抛 Stop 挡住发版，不能只打一行日志');
});

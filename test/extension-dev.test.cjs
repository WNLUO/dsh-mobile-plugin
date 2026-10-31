'use strict';

/**
 * 扩展开发包的宿主侧（`lib/mobile/extension-dev.js`）。
 *
 * 这条通道把作者电脑上那个固定目录原样交给手机，所以真正要钉的是「给出去的是什么」：
 * 列出来的包必须带着完整的 per-file 大小与 sha256（App 拿它判断手机上是同一版）；坏包与
 * 超限包必须**静默消失**而不是让整张列表变红；取文件必须被锁在包目录里 —— 越界一律 400，
 * 且不是靠字符串判断，而是 resolve 之后判前缀。
 *
 * 整套用临时目录顶着 DSH_HOME 跑，不碰本机真的那份 `~/.dsh/extension-dev`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  devRoot,
  listPackages,
  handleDevPackages,
  handleDevFile,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_FILE_BYTES,
} = require('../lib/mobile/extension-dev.js');
const { readRouteTable } = require('./lib/wiring.cjs');

/** 一个临时 DSH_HOME；每个用例自己建、自己删。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extension-dev-'));
  process.env.DSH_HOME = home;
  return home;
}

function restoreHome(previous, home) {
  if (previous === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
}

/** 假 ServerResponse：与 extensions.test.cjs 同一形状，只记最后一次回包。 */
function fakeRes() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(String(payload)); };
  return res;
}

const fakeGet = (url) => ({ url, method: 'GET', headers: {} });

/** 铺一个包：`files` 是「相对路径 → 内容」，内容为 undefined 时只建目录。 */
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

test('根目录不存在时列包会把它建出来，并回空列表', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const res = fakeRes();
    await handleDevPackages(null, fakeGet('/api/mobile/v1/extension/dev/packages'), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.root, path.join(home, 'extension-dev'));
    assert.deepEqual(res.body.packages, [], '空根目录是空列表，不是错误');
    assert.ok(fs.existsSync(devRoot()), '根目录要按需建出来，作者才好往里放东西');
  } finally {
    restoreHome(previous, home);
  }
});

test('列一个包：slug / manifest 字段回退 / 递归文件与 sha256 / 点开头的东西不算', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const root = devRoot();
    makePackage(root, 'demo', { name: '演示扩展', version: '1.2.3', api_version: '2' }, {
      'index.html': '<h1>hi</h1>',
      'libs/a.js': 'console.log(1)',
      '.env': 'SECRET=1',
      '.git/config': 'gitconfig',
    });
    // 第二个包什么字段都不给：name 退回 slug，版本 0.0.0，接口版本 1。
    makePackage(root, 'bare', {}, { 'main.js': 'export default 1' });

    const res = fakeRes();
    await handleDevPackages(null, fakeGet('/api/mobile/v1/extension/dev/packages'), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.packages.length, 2);
    const demo = res.body.packages.find((entry) => entry.slug === 'demo');
    const bare = res.body.packages.find((entry) => entry.slug === 'bare');
    assert.ok(demo && bare);

    assert.equal(demo.slug, 'demo');
    assert.equal(demo.name, '演示扩展');
    assert.equal(demo.versionName, '1.2.3', 'versionName 缺了要读 version');
    assert.equal(demo.apiVersion, '2', 'apiVersion 缺了要读 api_version');
    assert.equal(demo.fileCount, 3, 'manifest.json 与两个正文文件；.env 与 .git/ 不算');
    const listed = demo.files.map((file) => file.path).sort();
    assert.deepEqual(listed, ['index.html', 'libs/a.js', 'manifest.json']);
    assert.equal(demo.size, demo.files.reduce((sum, file) => sum + file.size, 0), 'size 是整包合计');
    const entry = demo.files.find((file) => file.path === 'libs/a.js');
    assert.equal(entry.size, Buffer.byteLength('console.log(1)'));
    assert.equal(entry.sha256, sha256Of('console.log(1)'), 'sha256 必须是文件字节的十六进制小写');
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);

    assert.equal(bare.name, 'bare', 'manifest 没给 name 就用 slug');
    assert.equal(bare.versionName, '0.0.0');
    assert.equal(bare.apiVersion, '1');
  } finally {
    restoreHome(previous, home);
  }
});

test('坏 manifest、不合规目录名、超限包都静默跳过，好包照列', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const root = devRoot();
    makePackage(root, 'good', { name: '好包' }, { 'a.txt': 'a' });
    makePackage(root, 'broken', '{ 这不是 json', { 'a.txt': 'a' });
    makePackage(root, 'no-manifest', null, { 'a.txt': 'a' });
    // 名字里带空格 / 中文的目录不是 slug，连读都不读。
    makePackage(root, 'bad slug', { name: '不该出现' }, { 'a.txt': 'a' });

    // 文件数超限：正好 200 个能过，201 个整包不要。
    const many = {};
    for (let index = 0; index <= MAX_PACKAGE_FILES; index += 1) many[`f-${index}.txt`] = 'x';
    makePackage(root, 'too-many', { name: '文件太多' }, many);
    const exact = {};
    for (let index = 0; index < MAX_PACKAGE_FILES - 1; index += 1) exact[`f-${index}.txt`] = 'x';
    makePackage(root, 'exact-count', { name: '刚好' }, exact);

    // 单个大文件把整包顶过 20MB。
    makePackage(root, 'too-big', { name: '太大' }, {
      'blob.bin': Buffer.alloc(MAX_PACKAGE_BYTES + 1, 7),
    });

    const packages = listPackages(root);
    const slugs = packages.map((entry) => entry.slug).sort();
    assert.deepEqual(slugs, ['exact-count', 'good'].sort(), `坏包不该出现在列表里：${slugs.join(', ')}`);
    const exactCount = packages.find((entry) => entry.slug === 'exact-count');
    assert.equal(exactCount.fileCount, MAX_PACKAGE_FILES, 'manifest + 199 个文件正好到上限，要留下');
  } finally {
    restoreHome(previous, home);
  }
});

test('取文件：回 base64 与 sha256，且跟列表里那份是同一个值', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const root = devRoot();
    makePackage(root, 'demo', { name: '演示' }, { 'index.html': '<h1>你好</h1>', 'libs/a.js': 'export default 1' });
    const [listed] = listPackages(root);

    const res = fakeRes();
    await handleDevFile(null, fakeGet('/api/mobile/v1/extension/dev/file?slug=demo&path=libs/a.js'), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.path, 'libs/a.js');
    assert.equal(res.body.size, Buffer.byteLength('export default 1'));
    assert.equal(res.body.sha256, sha256Of('export default 1'));
    assert.equal(Buffer.from(res.body.content, 'base64').toString('utf8'), 'export default 1');
    assert.equal(
      res.body.sha256,
      listed.files.find((file) => file.path === 'libs/a.js').sha256,
      '同一份字节，列表与取文件给的 sha256 必须一样',
    );
  } finally {
    restoreHome(previous, home);
  }
});

test('取文件的拒绝口径：越界一律 400，包没了 404，文件没了 404，超 8MB 413', async () => {
  const previous = process.env.DSH_HOME;
  const home = makeHome();
  try {
    const root = devRoot();
    makePackage(root, 'demo', { name: '演示' }, { 'index.html': 'hi', 'libs/a.js': 'a' });
    // 包目录外面的东西：无论怎么拼路径都不该读到它。
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    // 前缀相同但不是子目录的兄弟目录（`demo-evil` 以 `demo` 开头）。
    makePackage(root, 'demo-evil', { name: '隔壁' }, { 'x.txt': 'evil' });
    makePackage(root, 'huge', { name: '大文件' }, { 'big.bin': Buffer.alloc(MAX_FILE_BYTES + 1, 3) });

    const ask = async (query) => {
      const res = fakeRes();
      await handleDevFile(null, fakeGet(`/api/mobile/v1/extension/dev/file?${query}`), res);
      return res;
    };

    const escape = await ask('slug=demo&path=../outside.txt');
    assert.equal(escape.status, 400);
    assert.equal(escape.body.error.code, 'bad-request');

    const sibling = await ask('slug=demo&path=../demo-evil/x.txt');
    assert.equal(sibling.status, 400, '`..` 拼出来的兄弟目录同样越界');
    assert.equal(sibling.body.error.code, 'bad-request');

    const absolute = await ask(`slug=demo&path=${encodeURIComponent(path.join(root, 'outside.txt'))}`);
    assert.equal(absolute.status, 400, '绝对路径不接受');
    assert.equal(absolute.body.error.code, 'bad-request');

    const prefixTrick = await ask('slug=demo&path=..%2Fdemo-evil%2Fx.txt');
    assert.equal(prefixTrick.status, 400, '前缀相同不等于在包内');

    assert.equal((await ask('slug=demo')).body.error.code, 'bad-request', '缺 path 回 400');
    assert.equal((await ask('path=index.html')).body.error.code, 'bad-request', '缺 slug 回 400');
    assert.equal((await ask('slug=demo%20x&path=index.html')).body.error.code, 'bad-request', 'slug 不合规回 400');

    const missingPackage = await ask('slug=nope&path=index.html');
    assert.equal(missingPackage.status, 404);
    assert.equal(missingPackage.body.error.code, 'dev-package-missing');

    const missingFile = await ask('slug=demo&path=libs/none.js');
    assert.equal(missingFile.status, 404);
    assert.equal(missingFile.body.error.code, 'file-missing');

    const tooLarge = await ask('slug=huge&path=big.bin');
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error.code, 'file-too-large');
  } finally {
    restoreHome(previous, home);
  }
});

test('路由表里紧跟扩展那三条之后，挂着这两条', () => {
  const table = readRouteTable();
  const devIndex = table.indexOf("'/api/mobile/v1/extension/dev/packages'");
  const fileIndex = table.indexOf("'/api/mobile/v1/extension/dev/file'");
  const actionIndex = table.indexOf("'/api/mobile/v1/extension/action'");
  assert.ok(actionIndex > 0 && devIndex > 0 && fileIndex > 0, '两条开发包路由都要注册');
  assert.ok(devIndex > actionIndex && fileIndex > actionIndex, '注册位置要紧跟扩展那三条');
  assert.ok(fileIndex > devIndex, 'list 在前、取文件在后');
});

'use strict';

/**
 * 手机端右栏文件浏览器的目录列表：`GET /api/mobile/v1/directory/listing`。
 *
 * 与 `/directory/list` 的分工、以及为什么这条走宿主自己的文件系统而不经 directoryPicker
 * 网关，见 lib/mobile/directory-listing.js 的文件头。这里只钉契约，且**整条经真路由表驱动**：
 * 造的是真临时目录树（多文件、隐藏项、指向目录的软链、断链），打的是注册进
 * registerMobileRoutes 之后那条 handler —— 「App 会打的那个地址真的注册了」本身就是契约的
 * 一半，只调模块里那个函数是测不到的。
 *
 * 运行：node --test test/directory-listing.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const { registerMobileRoutes } = require(path.join(ROOT, 'lib', 'routes', 'mobile-api.js'));
// 上限必须复用 directory-browse.js 的导出（它是与宿主 browse 后端对齐的那一份）。
const { DEFAULT_MAX_ENTRIES } = require(path.join(ROOT, 'lib', 'mobile', 'directory-browse.js'));

const LISTING = '/api/mobile/v1/directory/listing';
const LEGACY = '/api/mobile/v1/directory/list';

/** 假 ServerResponse：只记账，够 `sendJson` 用。 */
function fakeRes() {
  const res = {
    status: 0,
    raw: '',
    headersSent: false,
    writableEnded: false,
  };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (chunk) => {
    res.raw = String(chunk == null ? '' : chunk);
    res.writableEnded = true;
  };
  return res;
}

/**
 * 装一次真路由表。宿主依赖给最小可用值 —— 这里要的不是它们的真身，而是「这条路径有没有
 * 挂上 handler」。鉴权（guarded）另有 test/mobile-routes.test.cjs 逐条钉，这里直接驱动
 * handler 本体。
 */
function mountRoutes() {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    guarded: (handler) => handler,
    state: {},
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({}),
    safeLanCandidates: () => [],
    safeIpv6Candidates: () => [],
    lanPortInUse: () => 0,
    preview: { handleUpgrade() {} },
    core: {},
    pairingApproval: null,
  });
  return routes;
}

/** 发一次列表请求（query 原样拼在路径后，含前导 `?`），回状态码与解析后的 body。 */
async function listing(query = '') {
  const routes = mountRoutes();
  const route = routes.find((item) => item.path === LISTING);
  assert.ok(route, `路由表里没有 ${LISTING}`);
  const res = fakeRes();
  const req = {
    url: `${LISTING}${query}`,
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  await route.handler({}, req, res);
  return { status: res.status, body: JSON.parse(res.raw) };
}

/** 一棵含各种边角的真树：文件夹、多文件、隐藏项、指向目录的软链、断链。 */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-'));
  fs.mkdirSync(path.join(root, 'Alpha folder'));
  fs.mkdirSync(path.join(root, 'zeta'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'Bravo.txt'), 'hello');
  fs.writeFileSync(path.join(root, '.hidden.txt'), 'x');
  fs.writeFileSync(path.join(root, 'apple.md'), 'y');
  fs.symlinkSync(path.join(root, 'zeta'), path.join(root, 'link-to-dir'), 'dir');
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'broken-link'));
  return root;
}

const rowOf = (body, name) => body.listing.entries.find((entry) => entry.name === name);

test('文件与文件夹都在，名字升序（大小写不敏感），kind 由 stat 得出', async () => {
  const root = makeTree();
  try {
    const { status, body } = await listing(`?path=${encodeURIComponent(root)}`);
    assert.equal(status, 200, JSON.stringify(body));

    assert.deepEqual(Object.keys(body).sort(), ['listing', 'ok']);
    // 形状漂了 App 就解析不了：与选目录那条（directory-browse.js 的 listDirectory）同形状。
    assert.deepEqual(Object.keys(body.listing).sort(), ['crumbs', 'entries', 'home', 'path', 'truncated']);
    // resolve 而**不是** realpath（macOS 上 /var 是 /private/var 的软链，realpath 会让面包屑
    // 和客户端手里的路径对不上）。
    assert.equal(body.listing.path, path.resolve(root));
    assert.equal(typeof body.listing.home, 'string');
    assert.equal(body.listing.truncated, false);

    // 顺序就是契约的一半：升序、大小写不敏感、文件与文件夹混在一份里。
    // 注意 'apple.md' 排在 'Bravo.txt' 前面 —— 按码位比是 'B'(66) < 'a'(97)，反的。
    assert.deepEqual(body.listing.entries.map((entry) => entry.name), [
      '.git',
      '.hidden.txt',
      'Alpha folder',
      'apple.md',
      'Bravo.txt',
      'broken-link',
      'link-to-dir',
      'zeta',
    ]);

    // 两组齐全：文件夹在前端怎么分组、怎么排是 App 的事，这里只保证两边都在。
    const folders = body.listing.entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.name);
    const files = body.listing.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name);
    assert.deepEqual(folders, ['.git', 'Alpha folder', 'link-to-dir', 'zeta']);
    assert.deepEqual(files, ['.hidden.txt', 'apple.md', 'Bravo.txt', 'broken-link']);

    // 隐藏项标记但返回（过滤交给客户端），而且路径与名字是拼出来的真路径。
    assert.deepEqual(rowOf(body, '.git').hidden, true);
    assert.deepEqual(rowOf(body, '.hidden.txt').hidden, true);
    assert.equal(rowOf(body, 'Bravo.txt').hidden, false);
    assert.equal(rowOf(body, 'Bravo.txt').path, path.join(root, 'Bravo.txt'));

    // 面包屑：根 → 当前，最后一节是目标自己（App 靠它显示当前目录名、并逐级上跳）。
    const crumbs = body.listing.crumbs;
    assert.ok(Array.isArray(crumbs) && crumbs.length > 0);
    assert.equal(crumbs[crumbs.length - 1].path, path.resolve(root));
    assert.equal(crumbs[0].path, '/');
    assert.deepEqual(Object.keys(crumbs[0]).sort(), ['hidden', 'name', 'path']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('指向目录的符号链接算 folder；断链不炸整条（按 file、不带 size/modified）', async () => {
  const root = makeTree();
  try {
    const { status, body } = await listing(`?path=${encodeURIComponent(root)}`);
    assert.equal(status, 200, '一个断链不许把整条列表带走');

    const link = rowOf(body, 'link-to-dir');
    assert.equal(link.kind, 'folder', '链接跟到目录上就是 folder');
    assert.equal(link.size, undefined, '文件夹不给 size');
    assert.equal(link.modified, undefined, '文件夹不给 modified');

    const broken = rowOf(body, 'broken-link');
    assert.equal(broken.kind, 'file', 'stat 失败的条目按 file 返回');
    assert.equal('size' in broken, false, 'stat 失败就没拿到 size，不给这一格');
    assert.equal('modified' in broken, false, 'stat 失败就没拿到 modified，不给这一格');

    // 其它条目一个都没少 —— 失败被收敛在这一条上。
    assert.equal(body.listing.entries.length, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('size（字节）与 modified（epoch 毫秒）只对文件给', async () => {
  const root = makeTree();
  try {
    const before = Date.now();
    fs.writeFileSync(path.join(root, 'Bravo.txt'), 'hello');
    const { body } = await listing(`?path=${encodeURIComponent(root)}`);

    const file = rowOf(body, 'Bravo.txt');
    assert.equal(file.kind, 'file');
    assert.equal(file.size, 5, 'size 是字节数');
    assert.equal(typeof file.modified, 'number');
    assert.ok(Number.isInteger(file.modified), 'epoch 毫秒必须是整数，别把小数甩给 App');
    const onDisk = fs.statSync(path.join(root, 'Bravo.txt')).mtimeMs;
    assert.ok(Math.abs(file.modified - Math.round(onDisk)) < 1000, 'modified 取的就是那个文件的 mtime');
    assert.ok(file.modified <= Date.now() + 1000 && file.modified >= before - 60000, 'modified 是 epoch 毫秒，不是秒');

    for (const name of ['.git', 'Alpha folder', 'zeta', 'link-to-dir']) {
      const row = rowOf(body, name);
      assert.equal(row.kind, 'folder', `${name} 是文件夹`);
      assert.equal('size' in row, false, `${name} 不该有 size`);
      assert.equal('modified' in row, false, `${name} 不该有 modified`);
    }
    // 行的键集合：文件夹五个，文件七个 —— 字段名与契约逐字一致。
    assert.deepEqual(Object.keys(rowOf(body, 'zeta')).sort(), ['hidden', 'kind', 'name', 'path']);
    assert.deepEqual(Object.keys(rowOf(body, 'Bravo.txt')).sort(),
      ['hidden', 'kind', 'modified', 'name', 'path', 'size']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('缺 path / 空串 / 全空白 = 被控端主目录', async () => {
  const home = path.resolve(os.homedir());
  for (const query of ['', '?path=', '?path=%20']) {
    const { status, body } = await listing(query);
    assert.equal(status, 200, `${query} → ${JSON.stringify(body)}`);
    assert.equal(body.listing.path, home, `${query} 该落在被控端主目录上`);
    assert.equal(body.listing.home, os.homedir());
    assert.equal(body.listing.crumbs[body.listing.crumbs.length - 1].path, home);
    assert.ok(Array.isArray(body.listing.entries));
  }
});

test('相对路径 400 bad-request（不拿宿主进程的当前目录去猜）', async () => {
  for (const bad of ['relative/dir', 'foo.txt', './x', '~']) {
    const { status, body } = await listing(`?path=${encodeURIComponent(bad)}`);
    assert.equal(status, 400, `${bad} 该被拒`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad-request', `${bad} → ${JSON.stringify(body.error)}`);
    assert.equal(typeof body.error.message, 'string');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  }
});

test('不存在的目录 400 not-found', async () => {
  const root = makeTree();
  try {
    for (const gone of [path.join(root, 'nope'), path.join(root, 'Bravo.txt', 'inside-a-file')]) {
      const { status, body } = await listing(`?path=${encodeURIComponent(gone)}`);
      assert.equal(status, 400, `${gone} 该被拒`);
      assert.equal(body.error.code, 'not-found', `${gone} → ${JSON.stringify(body.error)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('指到文件上 400 not-directory', async () => {
  const root = makeTree();
  try {
    const { status, body } = await listing(`?path=${encodeURIComponent(path.join(root, 'Bravo.txt'))}`);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'not-directory', JSON.stringify(body.error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('读不了的目录 400 permission', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root 不受目录权限约束' : false }, async () => {
  const root = makeTree();
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    const { status, body } = await listing(`?path=${encodeURIComponent(locked)}`);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'permission', JSON.stringify(body.error));
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('上限复用 DEFAULT_MAX_ENTRIES，超了截断并置 truncated', async () => {
  assert.equal(DEFAULT_MAX_ENTRIES, 1000, '上限是 directory-browse.js 那份导出的值，不是这里另写的数');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-many-'));
  try {
    // 补零命名，好让「按名字升序取前 N」在码位上也是确定的。
    const total = DEFAULT_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i += 1) fs.writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}`), '');
    const { status, body } = await listing(`?path=${encodeURIComponent(root)}`);
    assert.equal(status, 200);
    assert.equal(body.listing.entries.length, DEFAULT_MAX_ENTRIES, '只物化 DEFAULT_MAX_ENTRIES 行');
    assert.equal(body.listing.truncated, true, '截断了要说出来');
    assert.equal(body.listing.entries[0].name, 'f0000');
    assert.equal(body.listing.entries[DEFAULT_MAX_ENTRIES - 1].name, 'f0999');
    assert.equal(rowOf(body, 'f1004'), undefined, '窗口外的条目不下发');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空目录回空 entries、truncated false（不是报错）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-listing-empty-'));
  try {
    const { status, body } = await listing(`?path=${encodeURIComponent(root)}`);
    assert.equal(status, 200);
    assert.deepEqual(body.listing.entries, []);
    assert.equal(body.listing.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('老那条 /directory/list 还在，且没有被这条顶掉（选目录不许受影响）', () => {
  const routes = mountRoutes();
  const legacy = routes.find((item) => item.path === LEGACY);
  const listingRoute = routes.find((item) => item.path === LISTING);
  assert.ok(legacy, `${LEGACY} 必须还在：DirectoryBrowser 选工作区在用`);
  assert.ok(listingRoute, `${LISTING} 必须注册`);
  assert.notEqual(listingRoute.handler, legacy.handler, '两条是不同的 handler，别把新列表接到老路由上');
  // 老那条走的是透传宿主 directoryPicker 的实现，只列目录、每条只有 name/path/hidden。
  assert.equal(legacy.handler, require(path.join(ROOT, 'lib', 'mobile', 'workspaces.js')).handleListDirectory);
});

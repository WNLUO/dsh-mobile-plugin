// 目录末尾空格回归：经过真实移动路由及宿主桥，浏览、建子目录和工作区登记保持原路径。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { registerMobileRoutes } = require('../lib/routes/mobile-api.js');
const { createApiProxy } = require('../lib/mobile/host-bridge.js');
const { listDirectory, createDirectory } = require('../lib/mobile/directory-browse.js');
const workspaces = require('../lib/mobile/workspaces.js');
const { localListDirectory } = require('../lib/mobile/host-bridge/endpoints.js');
const { handleDirectoryListing } = require('../lib/mobile/directory-listing.js');

function makeContext(kind) {
  const calls = [];
  const ctx = { calls, logger: { warn() {} }, get: (key) => {
    if (key === 'directoryPicker') return { capability: () => ({ kind }) };
    if (key !== 'typertGateway') return undefined;
    return { async invoke({ namespace, method, args, signal }) {
      calls.push({ namespace, method, args });
      if (namespace === 'directoryPicker' && method === 'list') return listDirectory(args.path, { signal });
      if (namespace === 'directoryPicker' && method === 'createDirectory') return createDirectory(args.path, args.name);
      if (namespace === 'workspace' && method === 'create') {
        const canonical = fs.realpathSync(args.request.path);
        return { workspace: { workspaceId: 'space', path: canonical }, created: true };
      }
      throw new Error(`Unexpected gateway call: ${namespace}.${method}`);
    } };
  } };
  ctx.apiProxy = createApiProxy(ctx);
  return ctx;
}
function routes() {
  const result = [];
  registerMobileRoutes({ registerRoute: (route) => result.push(route), registerUpgradeRoute() {},
    guarded: (handler) => handler, state: {}, hostMetadata: () => ({}), getSidecarSnapshot: () => ({}),
    safeLanCandidates: () => [], safeIpv6Candidates: () => [], lanPortInUse: () => 0,
    preview: { handleUpgrade() {} }, core: {}, pairingApproval: null });
  return result;
}
async function request(handler, ctx, url, body) {
  const res = { headersSent: false, writableEnded: false, writeHead(status) { this.status = status; },
    end(raw) { this.raw = String(raw); this.writableEnded = true; } };
  await handler(ctx, { url, body, headers: {}, method: body ? 'POST' : 'GET' }, res);
  return { status: res.status, body: JSON.parse(res.raw) };
}
function compile(relative, from, to) {
  const filename = path.join(__dirname, '..', relative);
  const source = fs.readFileSync(filename, 'utf8');
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, '变异必须命中当前实现');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(changed, filename);
  return mod.exports;
}

for (const kind of ['native', 'browse']) {
  test(`${kind}：列表中带空格的目录能进入、建子目录并登记成工作区`, { skip: process.platform === 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-directory-spaces-'));
    try {
      const target = path.join(root, ' 项目 ');
      fs.mkdirSync(target);
      const ctx = makeContext(kind);
      const table = routes();
      const handler = (name) => {
        const route = table.find((row) => row.path === `/api/mobile/v1/${name}`);
        assert.ok(route, name);
        return route.handler;
      };
      const parent = await request(handler('directory/list'), ctx, `/?path=${encodeURIComponent(root)}`);
      assert.equal(parent.status, 200);
      assert.equal(parent.body.listing.entries[0].path, target);
      const opened = await request(handler('directory/list'), ctx, `/?path=${encodeURIComponent(target)}`);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.listing.path, target);
      const child = await request(handler('directory/create'), ctx, '/', { path: target, name: 'child' });
      assert.equal(child.status, 200, JSON.stringify(child.body));
      assert.equal(fs.statSync(path.join(target, 'child')).isDirectory(), true);
      const adopted = await request(handler('workspace/create'), ctx, '/', { path: target });
      assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
      assert.equal(adopted.body.workspace.path, fs.realpathSync(target));
      assert.equal(ctx.calls.find((call) => call.namespace === 'workspace').args.request.path, target);
      const files = await request(handler('directory/listing'), ctx, `/?path=${encodeURIComponent(target)}`);
      assert.equal(files.status, 200, JSON.stringify(files.body));
      assert.equal(files.body.listing.path, target);
      assert.equal(files.body.listing.entries[0].name, 'child');
      assert.equal(fs.existsSync(target.trim()), false, '去掉空格是另一个不存在的目录');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('缺省及全空白浏览路径仍使用主目录，空白登记仍拒绝', async () => {
  const ctx = makeContext('native');
  for (const query of ['', '?path=', '?path=%20%20']) {
    const response = await request(workspaces.handleListDirectory, ctx, `/${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.listing.path, path.resolve(os.homedir()));
  }
  assert.equal((await request(workspaces.handleCreateWorkspace, ctx, '/', { path: '   ' })).status, 400);
  assert.equal((await request(workspaces.handleCreateDirectory, ctx, '/', { path: '   ', name: 'child' })).status, 400);
});

test('变异：任一路径处理重新删尾空格，真实目录判据均失败', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-directory-mutations-'));
  try {
    const target = path.join(root, '项目 ');
    fs.mkdirSync(target);
    const query = `/?path=${encodeURIComponent(target)}`;
    const ctx = makeContext('native');
    const trimmedList = compile('lib/mobile/workspaces.js', '{ path } : {};', '{ path: path.trim() } : {};');
    assert.equal((await request(workspaces.handleListDirectory, ctx, query)).status, 200);
    assert.equal((await request(trimmedList.handleListDirectory, ctx, query)).status, 400);
    const trimmedBody = compile('lib/mobile/workspaces.js', "typeof body.path === 'string' ? body.path : '';", "typeof body.path === 'string' ? body.path.trim() : '';");
    assert.equal((await request(trimmedBody.handleCreateDirectory, ctx, '/', { path: target, name: 'child' })).status, 400);
    const trimmedWorkspace = compile('lib/mobile/workspaces.js', "const path = body && typeof body.path === 'string' ? body.path : '';\n  if (!path.trim())", "const path = body && typeof body.path === 'string' ? body.path.trim() : '';\n  if (!path.trim())");
    assert.equal((await request(trimmedWorkspace.handleCreateWorkspace, ctx, '/', { path: target })).status, 400);
    const trimmedLocal = compile('lib/mobile/host-bridge/endpoints.js', '? payload.path : undefined;', '? payload.path.trim() : undefined;');
    assert.equal((await localListDirectory(ctx, { path: target })).result.ok, true);
    assert.equal((await trimmedLocal.localListDirectory(ctx, { path: target })).result.ok, false);
    const trimmedListing = compile('lib/mobile/directory-listing.js', "rawPath.trim() ? rawPath : '';", "rawPath.trim();");
    assert.equal((await request(handleDirectoryListing, ctx, query)).status, 200);
    assert.equal((await request(trimmedListing.handleDirectoryListing, ctx, query)).status, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

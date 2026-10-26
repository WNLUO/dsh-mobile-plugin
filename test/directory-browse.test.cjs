'use strict';

/**
 * 手机端目录浏览的回落实现 + 路由选择。
 *
 * 根因不只在无头宿主：`dsh-host-directory-picker-auto` 启动时二选一，只有「宿主 web 服务绑到
 * 非 127.0.0.1」或「平台不是 darwin/win32」才挂 browse。无头移动宿主被本包的
 * cordis.mobile-host.yml 钉成 browse，但**桌面 profile 宿主 + 手机远程连**这一格两边都不满足，
 * 于是恒为 native，手机上一个条目都列不出来。把那一行钉进 bundle 层对桌面操作者是纯粹的
 * 退步（见 test/directory-picker.test.cjs），所以这里修的是另一头：插件自带一份 browse 原语，
 * 只在宿主**不服务 browse** 时接手。
 *
 * 本文件钉两件事：**路由**（宿主服务 browse 就整条走网关；服务 native 或查不到选择器时用
 * 本地实现，且**一次网关都不打**，否则每次翻目录都白挨一趟失败往返）；**本地实现的行为**
 * （形状必须与宿主 browse 后端逐条一致，客户端分不出来）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');

const { createApiProxy } = require('../lib/mobile/host-bridge.js');
const {
  DirectoryBrowseError,
  WIRE_CODES,
  ancestryCrumbs,
  boundedInsert,
  createDirectory,
  fullyQualified,
  hostServesBrowse,
  listDirectory,
  wireError,
} = require('../lib/mobile/directory-browse.js');

const BROWSE = { capability: () => ({ kind: 'browse', list() {}, createDirectory() {} }) };
const NATIVE = { capability: () => ({ kind: 'native', pick() {} }) };

/** 带假网关的 ctx：记录每次网关调用。`picker` 决定 host.* 两个动词走哪条路由。 */
function makeCtx(picker) {
  const calls = [];
  const ctx = {
    calls,
    get: (key) => {
      if (key === 'typertGateway') {
        return {
          async invoke({ namespace, method, args }) {
            calls.push({ namespace, method, args });
            return { fromGateway: true, namespace, method, args };
          },
          async stream() { return Readable.from([]); },
        };
      }
      return key === 'directoryPicker' ? picker : undefined;
    },
    logger: { warn() {} },
  };
  return ctx;
}

const makeRoot = (prefix = 'dsh-browse-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

test('宿主服务 browse：host.listDirectory 整条走网关，不碰本地实现', async () => {
  const ctx = makeCtx(BROWSE);
  const api = createApiProxy(ctx);
  const envelope = await api.host.listDirectory({ rpcId: 'mobile', payload: { path: '/tmp/does-not-matter' } });
  assert.equal(envelope.result.ok, true);
  assert.deepEqual(ctx.calls.map((call) => `${call.namespace}/${call.method}`), ['directoryPicker/list']);
  assert.deepEqual(ctx.calls[0].args, { path: '/tmp/does-not-matter' });
});

test('宿主只服务 native：host.listDirectory 用本地实现，一次网关都不打', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, '子目录'));
    const ctx = makeCtx(NATIVE);
    const api = createApiProxy(ctx);
    const envelope = await api.host.listDirectory({ rpcId: 'mobile', payload: { path: root } });
    assert.equal(envelope.result.ok, true, '不再把宿主的 browse 拒绝原样透给手机');
    assert.deepEqual(ctx.calls, [], 'native 路由下不该打网关');
    assert.equal(envelope.result.value.path, path.resolve(root));
    assert.deepEqual(envelope.result.value.entries.map((entry) => entry.name), ['子目录']);
  } finally {
    cleanup(root);
  }
});

test('查不到 directoryPicker 时也走本地实现（查不到 ≠ 宿主服务 browse）', async () => {
  const root = makeRoot();
  try {
    const ctx = makeCtx(undefined);
    const api = createApiProxy(ctx);
    const envelope = await api.host.listDirectory({ rpcId: 'mobile', payload: { path: root } });
    assert.equal(envelope.result.ok, true);
    assert.deepEqual(ctx.calls, []);
  } finally {
    cleanup(root);
  }
});

test('宿主只服务 native：host.createDirectory 用本地实现，真的在磁盘上建出目录', async () => {
  const root = makeRoot();
  try {
    const ctx = makeCtx(NATIVE);
    const api = createApiProxy(ctx);
    const envelope = await api.host.createDirectory({ rpcId: 'mobile', payload: { path: root, name: '新建工作目录' } });
    assert.equal(envelope.result.ok, true);
    assert.deepEqual(ctx.calls, []);
    assert.equal(envelope.result.value.path, path.join(root, '新建工作目录'));
    assert.equal(fs.statSync(envelope.result.value.path).isDirectory(), true);
  } finally {
    cleanup(root);
  }
});

test('宿主服务 browse：host.createDirectory 仍整条走网关（策略单一真源）', async () => {
  const ctx = makeCtx(BROWSE);
  const api = createApiProxy(ctx);
  const envelope = await api.host.createDirectory({ rpcId: 'mobile', payload: { path: '/tmp/p', name: 'n' } });
  assert.equal(envelope.result.ok, true);
  assert.deepEqual(ctx.calls.map((call) => `${call.namespace}/${call.method}`), ['directoryPicker/createDirectory']);
  assert.deepEqual(ctx.calls[0].args, { path: '/tmp/p', name: 'n' });
});

test('hostServesBrowse 只认明确的 browse 能力对象', () => {
  assert.equal(hostServesBrowse(makeCtx(BROWSE)), true);
  assert.equal(hostServesBrowse(makeCtx(NATIVE)), false);
  assert.equal(hostServesBrowse(makeCtx(undefined)), false);
  // capability() 自己炸掉也不能把请求带下水
  assert.equal(hostServesBrowse({ get: () => ({ capability() { throw new Error('boom'); } }) }), false);
  assert.equal(hostServesBrowse({ get: () => ({}) }), false);
  assert.equal(hostServesBrowse(undefined), false);
});

// ---------------------------------------------------------------------------
// 本地实现：形状与宿主 browse 后端逐条对齐
// ---------------------------------------------------------------------------

test('listDirectory：只列目录（隐藏项标记但返回），path 是 resolve 不是 realpath', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'visible'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const listing = await listDirectory(root);
    // macOS 上 /var 是 /private/var 的软链：回 realpath 会让面包屑和客户端手里的路径对不上。
    assert.equal(listing.path, path.resolve(root));
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['.hidden', 'visible'], '名字升序，普通文件不列');
    assert.deepEqual(listing.entries.map((entry) => entry.hidden), [true, false], '隐藏项只标记，不过滤');
    assert.equal(typeof listing.home, 'string');
    assert.ok(Array.isArray(listing.crumbs) && listing.crumbs.length > 0);
    assert.equal(listing.crumbs[listing.crumbs.length - 1].path, listing.path, '最后一节就是当前层');
    assert.equal(listing.truncated, false);
  } finally {
    cleanup(root);
  }
});

test('listDirectory：path 缺省 = 被控端主目录', async () => {
  const listing = await listDirectory();
  assert.equal(listing.path, path.resolve(os.homedir()));
});

test('listDirectory：maxEntries 真的截断，并按名字升序取前 N', async () => {
  const root = makeRoot();
  try {
    for (const name of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(root, name));
    const listing = await listDirectory(root, { maxEntries: 2 });
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['a', 'b']);
    assert.equal(listing.truncated, true, '截断了要说出来');
  } finally {
    cleanup(root);
  }
});

test('listDirectory：跟随符号链接，断链与文件静静跳过', async () => {
  const root = makeRoot();
  const outside = makeRoot('dsh-browse-target-');
  try {
    fs.symlinkSync(outside, path.join(root, 'link-to-dir'));
    fs.symlinkSync(path.join(root, 'nope'), path.join(root, 'broken'));
    fs.symlinkSync(path.join(root, 'file.txt'), path.join(root, 'link-to-file'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const listing = await listDirectory(root);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['link-to-dir'], '能进入的链接才列');
    assert.equal(listing.entries[0].path, path.join(root, 'link-to-dir'), '链接本身是跳转目标，不解析成真身');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('listDirectory：相对路径与不存在的目录都报 directory-unreadable', async () => {
  await assert.rejects(() => listDirectory('relative/dir'), (error) => {
    assert.ok(error instanceof DirectoryBrowseError);
    assert.equal(error.code, 'directory-unreadable');
    return true;
  });
  const root = makeRoot();
  const missing = path.join(root, 'nope');
  cleanup(root);
  await assert.rejects(() => listDirectory(missing), (error) => {
    assert.equal(error.code, 'directory-unreadable');
    assert.match(error.message, /^cannot list /);
    return true;
  });
});

test('createDirectory：建目录、同名报 directory-exists', async () => {
  const root = makeRoot();
  try {
    const created = await createDirectory(root, '新建工作目录');
    assert.equal(created, path.join(root, '新建工作目录'));
    assert.equal(fs.statSync(created).isDirectory(), true);
    await assert.rejects(() => createDirectory(root, '新建工作目录'), (error) => {
      assert.equal(error.code, 'directory-exists');
      return true;
    });
  } finally {
    cleanup(root);
  }
});

test('createDirectory：name 只能是单个非空路径段，父路径必须完全限定', async () => {
  const root = makeRoot();
  try {
    for (const bad of ['../escape', 'a/b', 'a\\b', '', '   ', '.', '..']) {
      await assert.rejects(() => createDirectory(root, bad), (error) => {
        assert.equal(error.code, 'directory-create-failed', `name=${JSON.stringify(bad)}`);
        return true;
      });
    }
    assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false, '不能真的跑出去');
    await assert.rejects(() => createDirectory('relative/dir', 'x'), (error) => {
      assert.equal(error.code, 'directory-create-failed');
      return true;
    });
  } finally {
    cleanup(root);
  }
});

test('错误码翻成宿主那套 wire 码（App 的文案按这几个码写的）', () => {
  assert.deepEqual(WIRE_CODES, {
    'directory-unreadable': 'directory-picker/unreadable',
    'directory-exists': 'directory-picker/exists',
    'directory-create-failed': 'directory-picker/create-failed',
  });
  const wire = wireError(new DirectoryBrowseError('directory-unreadable', '/x', 'cannot list /x: nope'));
  assert.equal(wire.code, 'directory-picker/unreadable');
  assert.equal(wire.message, 'cannot list /x: nope');
  assert.equal(wire.path, '/x');
  // 本地实现把失败以封包回给 App：宿主那条路的形状是 { ok:false, error:{ code, message } }
  return createApiProxy(makeCtx(NATIVE)).host.listDirectory({ rpcId: 'mobile', payload: { path: 'relative/dir' } })
    .then((envelope) => {
      assert.equal(envelope.result.ok, false);
      assert.equal(envelope.result.error.code, 'directory-picker/unreadable');
    });
});

// ---------------------------------------------------------------------------
// 纯函数：与宿主 browse 后端同语义
// ---------------------------------------------------------------------------

test('fullyQualified 认绝对路径，拒相对路径', () => {
  assert.equal(fullyQualified('/usr/local'), true);
  assert.equal(fullyQualified('relative/dir'), false);
  assert.equal(fullyQualified('C:\\Users\\x', 'win32'), true);
  assert.equal(fullyQualified('\\\\server\\share\\x', 'win32'), true);
  assert.equal(fullyQualified('\\foo', 'win32'), false, '无盘符的根路径会随当前盘符漂移');
  assert.equal(fullyQualified('\\\\server', 'win32'), false, '残缺 UNC');
});

test('ancestryCrumbs 从根串到 target（含），根那节的名字就是根自己', () => {
  const crumbs = ancestryCrumbs('/a/b/c');
  assert.deepEqual(crumbs.map((crumb) => crumb.path), ['/', '/a', '/a/b', '/a/b/c']);
  assert.deepEqual(crumbs.map((crumb) => crumb.name), ['/', 'a', 'b', 'c']);
  assert.deepEqual(crumbs.map((crumb) => crumb.hidden), [false, false, false, false]);
});

test('boundedInsert 维持名字升序的有界窗口，并在淘汰时报 true', () => {
  const window = [];
  assert.equal(boundedInsert(window, { name: 'b' }, 2), false);
  assert.equal(boundedInsert(window, { name: 'a' }, 2), false);
  assert.deepEqual(window.map((entry) => entry.name), ['a', 'b']);
  assert.equal(boundedInsert(window, { name: 'c' }, 2), true, 'c 挤掉 b');
  assert.deepEqual(window.map((entry) => entry.name), ['a', 'b']);
  assert.equal(boundedInsert(window, { name: 'a' }, 2), true, '重复名也算超出窗口');
});

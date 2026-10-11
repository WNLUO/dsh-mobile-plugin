'use strict';

/**
 * 移动端「添加工作区」的目录选择器：宿主必须挂 browse 后端。
 *
 * 现象：手机上点抽屉里的「为设备 X 添加工作区」，浮层只显示
 * `host.listDirectory needs the browse capability; the composed picker serves "native"`，
 * 一个条目都列不出来，连「新建文件夹」也是灰的 —— 也就是说「新建工作目录」这条
 * 流程在手机端根本走不通，只能登记一个恰好已经存在的目录。
 *
 * 根因：目录选择器由 dsh-host-directory-picker-auto 在启动时二选一
 * （`resolveDirectoryPickerBackend`）。它只在「宿主 web 服务绑定到非 127.0.0.1」时才
 * 认为存在远程客户端从而挂 browse；而 host.js 让移动宿主故意留在回环（web-runtime 的
 * trustedHosts: []，手机是从 sidecar/中转进来的），darwin/win32 于是必定解析成 native。
 * native 后端要弹被控端的系统对话框，手机是远程客户端，看不到也点不到。
 * 而 host.listDirectory 和 host.createDirectory 是**同一道闸**：
 * dsh-host-apiproxy/lib/types/api-proxy.js 里两处都先检查
 * `ctx.directoryPicker.capability().kind !== 'browse'` 才放行。
 *
 * 修复：upstream 那行自己写了出口 —— 「Mount -native or -browse directly in an overlay
 * to pin the interaction.」所以本包的 cordis.mobile-host.yml 按它说的把这一行钉成 browse。
 *
 * 注意这一层落在**哪个文件**里：钉 browse 是**无头宿主专属**的。桌面 GUI 把本包装成
 * bundle 时 cordis.patch.yml 会落到桌面 profile 的层栈上，如果把这两行留在那层，桌面
 * 自己的「选择目录」也会从原生对话框换成 browse —— 桌面不需要，它的使用者就坐在机器前。
 * 两层分工见 cordis.mobile-host.yml 头部注释：cordis.patch.yml 只留「挂载本插件自己」。
 *
 * 这里要盯住两件容易再犯的事：
 *
 *  1. **patch 里的 `name` 是断言，不是改写**。cordis-plugin-include 的
 *     applyEntryPatches 会把 `name` 从覆盖字段里摘出去，并且
 *     `if (name && name !== target.name) { warn(...); continue; }` —— 于是
 *     「`- id: directory-picker` + 新 `name:`」不会换掉插件，只会被静默跳过
 *     （仅留一行 loader 警告），现场表现就是「改了没效果」。换挂载必须
 *     `disabled: true` 关掉原行 + `insert` 自己的行，且关行上**不能写 name**。
 *  2. **修的是宿主，不是 App**。App 侧只能把英文原因翻成人话。
 *
 * 另外验证 browse 后端本身的行为（真正创建目录、拒绝越权名字），驱动的是真模块。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('yaml');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

const AUTO = '@deepseek-ai/dsh-host-directory-picker-auto';
const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse';

const parseRows = (relative) => {
  const parsed = yaml.parse(readSource(relative));
  return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [];
};

// 宿主专属层由 host.js 显式加载；cordis.patch.yml 只负责「挂载本插件自己」。
const rows = parseRows('cordis.mobile-host.yml');
const bundleRows = parseRows('cordis.patch.yml');

const disableRow = rows.find((row) => row.id === 'directory-picker' && !row.insert);
const insertedRows = rows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
  .filter((row) => row && typeof row === 'object');
const browseRow = insertedRows.find((row) => row.id === 'directory-picker-browse');

// ---------------------------------------------------------------------------
// cordis.mobile-host.yml：把 directory-picker 钉成 browse
// ---------------------------------------------------------------------------

test('cordis.mobile-host.yml 关掉了 directory-picker-auto 那一行', () => {
  assert.ok(disableRow, '要找得到 id: directory-picker 的覆盖行（auto 那行是 web-app insert 进来的）');
  assert.equal(disableRow.disabled, true, '必须 disabled: true，否则 auto 仍然会挂 native');
});

test('关行上不写 name（patch 的 name 是断言，不同名会被静默跳过）', () => {
  assert.ok(disableRow);
  assert.equal('name' in disableRow, false,
    '写 name 会让整行 patch 被 applyEntryPatches 跳过：name 不参与覆盖，只做同名断言');
  assert.equal('config' in disableRow, false, '关行只需要 disabled，不覆盖 config');
});

test('insert 了一行 dsh-host-directory-picker-browse', () => {
  assert.ok(browseRow, '要用 insert 挂 browse 后端');
  assert.equal(browseRow.name, BROWSE);
});

test('钉 browse 的行没有漏回 cordis.patch.yml（那层桌面也会加载）', () => {
  // 桌面 GUI 经 DSH 内置插件管理器把本包装成 bundle，cordis.patch.yml 会作为一层落到
  // 桌面 profile 的树上。directory-picker 的两行一旦留在那层，桌面的原生选择框会被
  // 换成 browse —— 而桌面使用者就坐在机器前，browse 对它是纯粹的退步。
  const leaked = bundleRows.some((row) => row.id === 'directory-picker' && !row.insert);
  assert.equal(leaked, false, '关行必须在 cordis.mobile-host.yml，不在 bundle 层');
  const leakedInsert = bundleRows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
    .some((row) => row && row.id === 'directory-picker-browse');
  assert.equal(leakedInsert, false, 'insert browse 同样只能在宿主专属层');
});

test('cordis.patch.yml 仍然挂载本插件自己', () => {
  // 没有这一行插件装了也不会被载入：不报错，只是没有 /api/mobile/v1，也没有 sidecar。
  const self = bundleRows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
    .find((row) => row && row.id === 'dsh-mobile');
  assert.ok(self, 'bundle 层要 insert 一行 dsh-mobile');
  assert.equal(self.name, 'dsh-mobile-plugin');
});

test('没有任何一行还直接把 auto 挂起来', () => {
  const stillAuto = rows.some((row) => row.name === AUTO && row.disabled !== true);
  assert.equal(stillAuto, false, 'auto 会解析成 native，远程客户端用不了');
});

test('web-runtime 那行没被这次改动碰掉', () => {
  const webRuntime = rows.find((row) => row.id === 'web-runtime');
  assert.ok(webRuntime, 'web-runtime 行还在');
  assert.equal(webRuntime.config?.printUrl, false);
  assert.equal(webRuntime.config?.surfaceContext, false);
  assert.deepEqual(webRuntime.config?.trustedHosts, []);
});

// ---------------------------------------------------------------------------
// package.json：browse / auto 由宿主的 dsh-web-app 供给，本包不重复声明
// ---------------------------------------------------------------------------

test('package.json 不再重复声明 browse / auto 依赖（由 dsh-web-app 供给）', () => {
  const manifest = JSON.parse(readSource('package.json') || '{}');
  // dsh-web-app 的 dependencies 里带着 dsh-host-directory-picker-{browse,auto,native}，
  // 而每个部署本插件的宿主都必然带着 dsh-web-app（它就是宿主 UI）。本包再声明一遍
  // 只会有两个坏处：版本各自漂移，以及让 pnpm 把同一份 UI 装出第二份副本。
  assert.equal(manifest.dependencies?.[BROWSE], undefined,
    `browse 由 dsh-web-app 提供；本包再钉一份等于制造版本漂移（请检查 ${BROWSE}）`);
  assert.equal(manifest.dependencies?.[AUTO], undefined,
    `auto 同理由 dsh-web-app 提供（请检查 ${AUTO}）`);
});

test('被测模块真的存在，且不依赖本机显示会话', () => {
  const entry = require.resolve(`${BROWSE}/package.json`, { paths: [ROOT] });
  const manifest = JSON.parse(fs.readFileSync(entry, 'utf8'));
  assert.equal(manifest.name, BROWSE);
  const source = readSource(`node_modules/${BROWSE}/lib/index.js`);
  assert.ok(source.includes('kind: "browse"'), '能力对象必须报 browse');
  assert.equal(source.includes('electron'), false, 'browse 后端不该拖起任何显示会话依赖');
});

// ---------------------------------------------------------------------------
// 透传面：插件那两条路由还在，且走的是宿主的 listDirectory / createDirectory
// ---------------------------------------------------------------------------

test('workspaces.js 仍透传 host.listDirectory / host.createDirectory', () => {
  const source = readSource('lib/mobile/workspaces.js');
  assert.ok(source.includes("callHost(ctx, 'listDirectory'"), '列目录透传还在');
  assert.ok(source.includes("callHost(ctx, 'createDirectory'"), '建目录透传还在');
  assert.ok(source.includes("sendJson(res, 200, { ok: true, listing: value })"), '列表按 listing 字段回');
  assert.ok(source.includes("sendJson(res, 200, { ok: true, path: value && value.path })"), '建目录回创建出来的 path');
});

// ---------------------------------------------------------------------------
// browse 后端真实行为
// ---------------------------------------------------------------------------

// BrowseDirectoryPicker 的 list/createDirectory 只用 this.config 与 node stdlib，所以
// 用 Object.create 绕过 cordis Service 的构造即可驱动真实现（比起转写一遍，这才有意义）。
async function makePicker(maxEntries = 1000) {
  const mod = await import(BROWSE);
  const picker = Object.create(mod.default.prototype);
  picker.config = { maxEntries };
  return picker;
}

test('browse 后端真的能在被控端建出目录', async () => {
  const picker = await makePicker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-'));
  try {
    const created = await picker.createDirectory(root, '新建工作目录');
    assert.equal(created, path.join(root, '新建工作目录'));
    assert.equal(fs.statSync(created).isDirectory(), true, '被控端磁盘上真的多了这个目录');

    const listing = await picker.list(root, new AbortController().signal);
    // 注意：list() 回的是 path.resolve(入参)，**不是** realpath —— macOS 上 /var 是
    // /private/var 的软链接，拿 realpathSync 去比只会测出这层软链接。
    assert.equal(listing.path, path.resolve(root));
    assert.equal(fs.statSync(listing.path).isDirectory(), true);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['新建工作目录']);
    assert.equal(listing.entries[0].path, created);
    assert.equal(listing.entries[0].hidden, false);
    assert.equal(listing.truncated, false);
    assert.ok(Array.isArray(listing.crumbs) && listing.crumbs.length > 0, '面包屑要能上跳');
    assert.equal(typeof listing.home, 'string');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同名目录报 directory-exists，而不是静默成功', async () => {
  const picker = await makePicker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-'));
  try {
    await picker.createDirectory(root, 'again');
    await assert.rejects(() => picker.createDirectory(root, 'again'), (error) => {
      assert.equal(error.code, 'directory-exists');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('名字只能是单个路径段，越权与相对路径都拒绝', async () => {
  const picker = await makePicker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-'));
  try {
    for (const bad of ['../escape', 'a/b', 'a\\b', '', '   ', '.', '..']) {
      await assert.rejects(() => picker.createDirectory(root, bad), (error) => {
        assert.equal(error.code, 'directory-create-failed', `name=${JSON.stringify(bad)}`);
        return true;
      });
    }
    assert.equal(fs.existsSync(path.join(root, '..', 'escape')), false, '不能真的跑出去');
    await assert.rejects(() => picker.createDirectory('relative/dir', 'x'), (error) => {
      assert.equal(error.code, 'directory-create-failed');
      return true;
    });
    await assert.rejects(() => picker.list('relative/dir', new AbortController().signal), (error) => {
      assert.equal(error.code, 'directory-unreadable');
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maxEntries 真的截断，并把 truncated 标出来', async () => {
  const picker = await makePicker(2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-'));
  try {
    for (const name of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(root, name));
    const listing = await picker.list(root, new AbortController().signal);
    assert.equal(listing.entries.length, 2, '只物化 maxEntries 行');
    assert.equal(listing.truncated, true, '截断了要说出来');
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['a', 'b'], '按名字升序取前 N');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

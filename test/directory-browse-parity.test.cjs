'use strict';

/**
 * 插件自带的目录浏览原语与宿主 browse 后端之间的**防漂移测试**。
 *
 * 为什么会有两份实现：宿主那套选择器由 `dsh-host-directory-picker-auto` 启动时二选一，
 * 「桌面 profile 宿主 + 手机远程连」这一格没人盖（详见 lib/mobile/directory-browse.js
 * 的头注释）。修在 bundle 层会把桌面操作者面前的原生选择框换成 browse，所以只能由插件
 * 自带一份原语兜底。上游那份**没法直接 require**：`@deepseek-ai/dsh-host-directory-picker-browse`
 * 是 ESM 的 Cordis 插件，`ancestryCrumbs` / `directoryRow` 这类纯函数没有导出，
 * `src/` 也没随包发布（`files` 里只有 lib）。所以只能复制，而复制的唯一防线就是这份测试。
 *
 * 两档强度：
 *
 *  1. **永远跑**（不依赖上游在场）—— 钉住本地实现自己的契约：策略常量、错误码集合、
 *     `wireError` 的值域、`hostServesBrowse` 的判定、`listDirectory` 的返回形状，
 *     以及 endpoints.js 的路由分支。这一档在 CI 里也生效。
 *  2. **上游在场才跑** —— 逐条对齐上游源码与行为：`ancestryCrumbs` / `fullyQualified` /
 *     `boundedInsert` / `raceAbort` 的行为等价，加上四条策略断言（隐藏项标记但返回、
 *     跟随符号链接、`resolve` 而非 realpath、错误码同名）。
 *
 * 第 2 档需要上游包在场。它**已进 devDependencies**（0.1.35 起）：此前只有本机那份被
 * npm 装脏的 node_modules 里有它，CI 的 `pnpm install --frozen-lockfile` 树里没有，
 * 于是这一档在 CI 里静默 skip —— 一份不在 CI 里跑的防漂移测试等于没有。现在干净树实测
 * 608 tests / 0 skipped，两档都真跑。`skip` 分支仍然保留：树里真没有上游包时（例如把
 * 插件目录单独拷出去跑）它会带理由 skip，并在 `skipped` 计数里看得见，不会变成假绿。
 *
 * 运行：node --test test/directory-browse-parity.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const BROWSE = '@deepseek-ai/dsh-host-directory-picker-browse';

/** 这份副本对齐的上游版本。上游抬版后这里会红，提示重新逐条核对语义。 */
const UPSTREAM_ALIGNED_VERSION = '0.1.1-rc.2';

const local = require('../lib/mobile/directory-browse.js');

const readSource = (absolute) => {
  try { return fs.readFileSync(absolute, 'utf8'); } catch { return ''; }
};

const LOCAL_SRC = readSource(path.join(ROOT, 'lib', 'mobile', 'directory-browse.js'));
const ENDPOINTS_SRC = readSource(path.join(ROOT, 'lib', 'mobile', 'host-bridge', 'endpoints.js'));

/** 上游包在不在。不在不是错误 —— CI 的锁文件树里就是没有它。 */
function resolveUpstream() {
  try {
    const manifestPath = require.resolve(`${BROWSE}/package.json`, { paths: [ROOT] });
    return {
      manifestPath,
      version: JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version,
      source: readSource(path.join(path.dirname(manifestPath), 'lib', 'index.js')),
    };
  } catch {
    return null;
  }
}

const upstream = resolveUpstream();
const SKIP_UPSTREAM = upstream
  ? false
  : `上游 ${BROWSE} 不可解析（本包不声明它，锁文件里也没有；CI 树里就没有）`;

/**
 * 去掉注释再比源码文本 —— 本地那份的头注释里就写着「**不是 realpath**」这句解释，
 * 不剥注释的话 `/realpath/` 会被自己的说明文字命中。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 按花括号配对取出 `function <name>(...) { ... }` 的完整源码。 */
function extractFunction(source, name, file) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${file} 里找不到 function ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.ok(i > from, `${file} 的 function ${name} 花括号未闭合`);
  return source.slice(start, i + 1);
}

/**
 * 从源码里取出 `function <name>` 并求值成真函数 —— 上游只导出 boundedInsert /
 * fullyQualified / raceAbort，ancestryCrumbs 只能这样拿到，而且拿到的是**行为**而不是
 * 文本，比逐字节比源码更耐得住排版差异。
 */
function evaluateFunction(source, name, file, params, args) {
  const body = extractFunction(source, name, file);
  // eslint-disable-next-line no-new-func
  return new Function(...params, `${body}\nreturn ${name};`)(...args);
}

// ---------------------------------------------------------------------------
// 第一档：本地实现自己的契约（永远跑）
// ---------------------------------------------------------------------------

test('maxEntries 默认值与宿主 browse 后端同口径（1000）', () => {
  assert.equal(local.DEFAULT_MAX_ENTRIES, 1000, '宿主 browse 的 Config 默认是 1e3，截断口径必须一致');
  assert.match(LOCAL_SRC, /const DEFAULT_MAX_ENTRIES = 1000;/);
});

test('本地实现抛出的每个 code 都在 WIRE_CODES 里，且不多不少', () => {
  const thrown = [...LOCAL_SRC.matchAll(/new DirectoryBrowseError\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(thrown)].sort(),
    ['directory-create-failed', 'directory-exists', 'directory-unreadable'],
    '本地实现只该抛这三个 code（与宿主 DirectoryPickerError 同名）',
  );
  assert.deepEqual(Object.keys(local.WIRE_CODES).sort(), [...new Set(thrown)].sort(),
    'WIRE_CODES 的键必须恰好覆盖本地实现会抛的 code');
  assert.deepEqual(local.WIRE_CODES, {
    'directory-unreadable': 'directory-picker/unreadable',
    'directory-exists': 'directory-picker/exists',
    'directory-create-failed': 'directory-picker/create-failed',
  });
});

test('wireError 的值域只有三种 wire 码，任何抛出值都不会漏出第四个', () => {
  const allowed = new Set([
    'directory-picker/unreadable',
    'directory-picker/exists',
    'directory-picker/create-failed',
  ]);
  const cases = [
    new local.DirectoryBrowseError('directory-unreadable', '/x', '列不出来'),
    new local.DirectoryBrowseError('directory-exists', '/x', '已存在'),
    new local.DirectoryBrowseError('directory-create-failed', '/x', '建不了'),
    new Error('随便一个普通错误'),
    '字符串抛出值',
    undefined,
    null,
  ];
  for (const thrown of cases) {
    const wire = local.wireError(thrown);
    assert.ok(allowed.has(wire.code), `${wire.code} 不在 App 认得的那三种里`);
    assert.equal(typeof wire.message, 'string', 'message 必须是字符串，App 要拿它匹配文案');
  }
  // 未知抛出值按「建目录失败」兜底 —— 与宿主那条路的兜底码同名。
  assert.equal(local.wireError(new Error('x')).code, 'directory-picker/create-failed');
  // path 原样带出去，App 用它提示是哪个目录出的问题。
  assert.equal(local.wireError(new local.DirectoryBrowseError('directory-exists', '/tmp/a', 'm')).path, '/tmp/a');
});

test('hostServesBrowse 只认 capability().kind === "browse" 这一种肯定答案', () => {
  const ctxWith = (picker) => ({ get: (key) => (key === 'directoryPicker' ? picker : null) });
  assert.equal(local.hostServesBrowse(ctxWith({ capability: () => ({ kind: 'browse' }) })), true);
  assert.equal(local.hostServesBrowse(ctxWith({ capability: () => ({ kind: 'native' }) })), false);
  assert.equal(local.hostServesBrowse(ctxWith({ capability: () => null })), false);
  assert.equal(local.hostServesBrowse(ctxWith({})), false, '没有 capability 函数');
  assert.equal(local.hostServesBrowse(ctxWith(null)), false);
  assert.equal(local.hostServesBrowse({}), false, 'ctx 没有 get');
  assert.equal(local.hostServesBrowse(null), false);
  assert.equal(local.hostServesBrowse(undefined), false);
  assert.equal(local.hostServesBrowse(ctxWith({ capability: () => { throw new Error('boom'); } })), false,
    '查询抛错必须兜成 false（宁可用自己那份，也不要整条路挂掉）');
  assert.equal(local.hostServesBrowse(undefined, { capability: () => ({ kind: 'browse' }) }), true,
    '显式传入的 picker 优先于 ctx.get');
  assert.equal(local.hostServesBrowse(undefined, { capability: () => ({ kind: 'native' }) }), false);
});

test('listDirectory 的返回形状与宿主 browse 后端逐字段同名', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browse-parity-'));
  try {
    fs.mkdirSync(path.join(root, 'child'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const listing = await local.listDirectory(root);
    assert.deepEqual(Object.keys(listing).sort(), ['crumbs', 'entries', 'home', 'path', 'truncated'],
      '形状漂了 App 就解析不了');
    // resolve 而**不是** realpath：macOS 上 /var 是 /private/var 的软链，回 realpath 会让
    // 面包屑和客户端手里的路径对不上（同一断言在 directory-picker.test.cjs 里对着宿主也钉过）。
    assert.equal(listing.path, path.resolve(root));
    assert.equal(typeof listing.home, 'string');
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['child'], '只列得进去的目录，文件不列');
    assert.deepEqual(Object.keys(listing.entries[0]).sort(), ['hidden', 'name', 'path']);
    assert.ok(Array.isArray(listing.crumbs) && listing.crumbs.length > 0, '面包屑要能上跳');
    assert.equal(listing.crumbs[listing.crumbs.length - 1].path, path.resolve(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('endpoints.js 只在宿主不服务 browse 时才回落到本地实现', () => {
  assert.match(ENDPOINTS_SRC, /require\('\.\.\/directory-browse\.js'\)/, 'endpoints.js 要引这份原语');
  for (const name of ['localListDirectory', 'localCreateDirectory']) {
    assert.ok(ENDPOINTS_SRC.includes(`function ${name}(`), `${name} 必须真的存在`);
  }
  assert.match(
    ENDPOINTS_SRC,
    /'host\.listDirectory': \(ctx, payload, signal\) => \(hostServesBrowse\(ctx\)[\s\S]{0,160}?localListDirectory\(ctx, payload, signal\)\)/,
    'listDirectory 的分支必须由 hostServesBrowse 决定',
  );
  assert.match(
    ENDPOINTS_SRC,
    /'host\.createDirectory': \(ctx, payload, signal\) => \(hostServesBrowse\(ctx\)[\s\S]{0,260}?localCreateDirectory\(ctx, payload, signal\)\)/,
    'createDirectory 的分支必须由 hostServesBrowse 决定',
  );
  // 宿主服务 browse 时整条走网关 —— 策略与 maxEntries 保持单一真源，不要在这里「优化」成
  // 「本地实现更快」。本地那份只在宿主明确不服务 browse 时才该出现。
  assert.ok(
    ENDPOINTS_SRC.indexOf("invokeEnvelope(ctx, 'directoryPicker', 'list'") <
      ENDPOINTS_SRC.indexOf('localListDirectory(ctx, payload, signal)'),
    '网关那条路必须写在回落前面（先问 hostServesBrowse，再决定走哪条）',
  );
});

// ---------------------------------------------------------------------------
// 第二档：与上游逐条对齐（上游在场才跑）
// ---------------------------------------------------------------------------

test('上游包在场时：版本仍是这份副本对齐的那一版', { skip: SKIP_UPSTREAM }, () => {
  assert.equal(upstream.version, UPSTREAM_ALIGNED_VERSION,
    `上游已从 ${UPSTREAM_ALIGNED_VERSION} 变成 ${upstream.version}：请逐条重读 lib/index.js，`
    + '确认策略没变，再把 UPSTREAM_ALIGNED_VERSION 抬上去');
});

test('上游在场时：ancestryCrumbs 行为一致（面包屑是 App 的上跳路径）', { skip: SKIP_UPSTREAM }, () => {
  const mine = local.ancestryCrumbs;
  const theirs = evaluateFunction(upstream.source, 'ancestryCrumbs', BROWSE,
    ['dirname', 'basename'], [path.dirname, path.basename]);
  for (const target of ['/a/b/c', '/', '/Volumes/移动硬盘/code/项目', path.resolve(os.tmpdir()), 'C:\\Users\\x']) {
    assert.deepEqual(mine(target), theirs(target), `ancestryCrumbs(${target}) 两侧不同`);
  }
  // 面包屑最后一节必须是目标自己（App 靠它显示当前目录名）。
  const crumbs = mine('/a/b/c');
  assert.equal(crumbs[crumbs.length - 1].path, '/a/b/c');
  assert.equal(crumbs[0].path, '/');
  assert.equal(crumbs[0].hidden, false, '面包屑一律不标隐藏');
});

test('上游在场时：fullyQualified 行为一致（它决定「相对路径直接拒绝」）', { skip: SKIP_UPSTREAM }, async () => {
  const mod = await import(BROWSE);
  const cases = ['/a', '/', 'relative/dir', '', 'C:\\Users', 'C:/Users', '\\foo', '/foo', '\\\\server\\share', '\\\\server'];
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const candidate of cases) {
      assert.equal(
        local.fullyQualified(candidate, platform),
        mod.fullyQualified(candidate, platform),
        `fullyQualified(${JSON.stringify(candidate)}, ${platform}) 两侧不同`,
      );
    }
  }
});

test('上游在场时：boundedInsert 行为一致（有界窗口决定截断）', { skip: SKIP_UPSTREAM }, async () => {
  const mod = await import(BROWSE);
  const run = (insert, keep, names) => {
    const window = [];
    let evicted = false;
    for (const name of names) {
      if (insert(window, { name }, keep)) evicted = true;
    }
    return { names: window.map((entry) => entry.name), evicted };
  };
  const levels = [
    ['a', 'b', 'c', 'd', 'e'],
    ['e', 'd', 'c', 'b', 'a'],
    ['m', 'a', 'z', 'b', 'y'],
    ['同名', '同b', '同a'],
    [],
  ];
  for (const keep of [1, 2, 3, 6]) {
    for (const names of levels) {
      assert.deepEqual(
        run(local.boundedInsert, keep, names),
        run(mod.boundedInsert, keep, names),
        `boundedInsert(keep=${keep}, ${names.join(',')}) 两侧不同`,
      );
    }
  }
});

test('上游在场时：raceAbort 行为一致（被放弃的读不能变成 unhandled rejection）', { skip: SKIP_UPSTREAM }, async () => {
  const mod = await import(BROWSE);
  const drive = async (raceAbort, abortFirst) => {
    const controller = new AbortController();
    let settled = 'pending';
    const operation = abortFirst
      ? new Promise(() => {}) // 永不 settle：只有 abort 能收场
      : Promise.resolve('value');
    const pending = raceAbort(operation, controller.signal)
      .then((value) => { settled = `ok:${value}`; }, (error) => { settled = `err:${error && error.message}`; });
    if (abortFirst) controller.abort(new Error('取消'));
    await pending;
    return settled;
  };
  for (const abortFirst of [false, true]) {
    assert.equal(
      await drive(local.raceAbort, abortFirst),
      await drive(mod.raceAbort, abortFirst),
      `raceAbort(abortFirst=${abortFirst}) 两侧不同`,
    );
  }
  // signal 缺省时就是普通 await（不能因为多包一层就改变 settle 时机）。
  assert.equal(await local.raceAbort(Promise.resolve('v'), undefined), 'v');
});

test('上游在场时：四条策略仍与上游一致', { skip: SKIP_UPSTREAM }, () => {
  const upstreamSource = stripComments(upstream.source);
  const mine = stripComments(LOCAL_SRC);
  // ① 隐藏项**标记但返回**，过滤交给客户端（不是直接丢掉）。
  assert.match(upstreamSource, /hidden: name\.startsWith\("\."\)/, '上游改了隐藏项的标法');
  assert.match(mine, /hidden: name\.startsWith\('\.'\)/, '本地那份没跟上');
  // ② 回 resolve，不是 realpath。
  assert.equal(/realpath/.test(upstreamSource), false, '上游开始用 realpath 了？那面包屑语义变了');
  assert.equal(/realpath/.test(mine), false, '本地那份不许引入 realpath');
  assert.match(upstreamSource, /resolve\(path \?\? home\)/);
  assert.match(mine, /resolve\(/);
  // ③ 越权名字必须拒绝（单个路径段）。用 String.raw 写字面量，避免正则里数不清的反斜杠。
  assert.ok(
    upstreamSource.includes(String.raw`name.trim() === "" || name === "." || name === ".." || /[/\\]/.test(name)`),
    '上游的越权名判定变了',
  );
  assert.ok(
    mine.includes(String.raw`name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)`),
    '本地那份的越权名判定与上游不同形',
  );
  // ④ 错误码同名同集合 —— 这是「两条路对客户端不可区分」的前提。
  const upstreamCodes = [...upstreamSource.matchAll(/new DirectoryPickerError\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(upstreamCodes)].sort(),
    Object.keys(local.WIRE_CODES).sort(),
    '上游的 code 集合与本地那份不再一致',
  );
  // ⑤ 能力对象的 kind 两边都必须是 browse。
  assert.match(upstreamSource, /kind: "browse"/);
  assert.match(mine, /capability\.kind === 'browse'/);
  // ⑥ maxEntries 默认值两边同口径。
  assert.match(upstreamSource, /maxEntries: z\.natural\(\)\.min\(1\)\.default\(1e3\)/);
  assert.equal(Number('1e3'), local.DEFAULT_MAX_ENTRIES);
});

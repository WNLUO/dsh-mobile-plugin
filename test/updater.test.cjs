'use strict';

/**
 * 更新编排的守卫：外壳那套「问市场 → 装 → 就地换代」的判定逻辑。
 *
 * 这块以前没有测试（更新只有一条「市场装 + 重启」的路，插件侧没逻辑）。搬回自更新之后，
 * 插件侧多出一串**必须判对**的判断，而且它们判错的后果都很安静：
 *
 *   · **来源不是 npm**（本地 link / `file:` tgz）→ 市场一律拒绝更新。这时必须**不去试**、
 *     并把原因说出来，否则用户开了自动更新开关等一晚上，界面上一句解释都没有。
 *   · **装成功**的判据是「盘上的版本真的变了」，不是「市场说 succeeded」。市场读盘得到
 *     `installedVersion`，但那是它的视角；插件的换代判据必须是自己的眼睛。
 *   · `OPERATION_BUSY` / `AGENTS_RUNNING` 这类失败是「现在不行」而不是「坏了」：自动更新
 *     要下个 tick 再试，不能当故障喊，更不能把开关关掉。
 *
 * 这里用**真的 HTTP 服务**（node:http，随机端口）+ 临时 profile：路径、请求形状、轮询节奏
 * 都是被测对象。环境变量必须在 import 之前设好 —— `manager.js` 的 profile 路径是导入时算的。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-updater-'));
const PROFILE_NM = path.join(TMP, 'profiles', 'desktop', 'node_modules');
const STORE = path.join(TMP, 'store');
const DSH_HOME = path.join(TMP, 'dsh-home');
process.env.DSH_MOBILE_PROFILE_NODE_MODULES = PROFILE_NM;
process.env.DSH_HOME = DSH_HOME;

const PLUGIN = 'dsh-mobile-plugin';

/** 造一代（自包含：package.json + lib/impl.js），并把它接到 profile 的链接上。 */
function install(version) {
  const pkgDir = path.join(STORE, `v${version}`, PLUGIN);
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN, version, type: 'module' }));
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'export function apply() {}\n');
  fs.mkdirSync(PROFILE_NM, { recursive: true });
  const link = path.join(PROFILE_NM, PLUGIN);
  try {
    fs.unlinkSync(link);
  } catch {}
  fs.symlinkSync(pkgDir, link, 'dir');
  return pkgDir;
}

/** 一个只够用的假市场。`script` 决定每次 `/operations` 怎么答。 */
async function startMarket(script, check = { installedVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true, source: 'npm' }) {
  const seen = { posts: [], operations: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname.endsWith('/updates')) {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        seen.posts.push(JSON.parse(raw || '{}'));
        send(202, { operation: { operationId: 'op-1', state: 'running' } });
      });
      return;
    }
    if (url.pathname.endsWith('/operations')) {
      seen.operations += 1;
      return send(200, { operation: script(seen.operations) });
    }
    if (url.pathname.endsWith('/updates')) {
      return send(200, { package: check });
    }
    send(404, { error: 'nope' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, seen };
}

async function loadUpdater() {
  return import(pathToFileURL(path.join(__dirname, '..', 'lib', 'shell', 'updater.js')).href);
}

test('来源是本地 link / tgz 时：不去试、不写盘，并如实说出原因', async t => {
  install('0.1.0');
  // 本地 tgz / link 装法：市场在 check 里就把它报成 `linked`。
  const market = await startMarket(() => ({ state: 'succeeded' }), { installedVersion: '0.1.0', latestVersion: null, updateAvailable: false, source: 'linked' });
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const base = updater.marketBase(market.port);
  // 市场的 check 会说 linked —— 这正是本地 tgz 装法的样子。
  const outcome = await updater.installIfNeeded(base, {});
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.installed, false);
  assert.equal(outcome.reason, 'linked-source', 'linked 来源必须在**问更新之前**就判死，不能靠市场报错');
  assert.equal(market.seen.posts.length, 0, '不该发起安装请求');
  assert.match(outcome.detail, /npm 来源/, '要告诉人怎么才能用上自动更新');
});

test('装成功后判定靠自己的眼睛：盘上版本变了才算装上了', async t => {
  install('0.1.0');
  const market = await startMarket(() => {
    // 市场在第一次被问询时就「装完」了：把链接换到新一代（真实世界由 pnpm 做）。
    install('0.2.0');
    return { state: 'succeeded', beforeVersion: '0.1.0', installedVersion: '0.2.0' };
  });
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const outcome = await updater.installIfNeeded(updater.marketBase(market.port), {});
  assert.equal(market.seen.posts.length, 1, '要请市场装一次');
  assert.deepEqual(market.seen.posts[0], { packageName: PLUGIN }, '请求体形状是市场的契约');
  assert.equal(outcome.installed, true);
  assert.equal(outcome.installedVersion, '0.2.0');
  assert.equal(outcome.beforeVersion, '0.1.0', 'beforeVersion 取市场的回报（它读的是装之前那份盘）');
  install('0.1.0'); // 还原，免得影响后面的用例
});

test('市场报 succeeded 但盘上没变：installed 必须是 false（不许谎报换过代码）', async t => {
  install('0.1.0');
  const market = await startMarket(() => ({ state: 'succeeded', installedVersion: '0.2.0' }));
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const outcome = await updater.installIfNeeded(updater.marketBase(market.port), {});
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.installed, false, '「状态说成功、代码没换」是这个仓库吃过最贵的一次亏');
});

test('OPERATION_BUSY / AGENTS_RUNNING 这类失败标成可重试，不当故障', async t => {
  install('0.1.0');
  const market = await startMarket(() => ({ state: 'failed', failure: { code: 'AGENTS_RUNNING', message: '有 agent 在跑', retryable: true } }));
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const outcome = await updater.installIfNeeded(updater.marketBase(market.port), {});
  assert.equal(outcome.installed, false);
  assert.equal(outcome.retryable, true, '「现在不行」和「坏了」要分开：自动更新下个 tick 再试');
  assert.equal(outcome.failure.code, 'AGENTS_RUNNING');
});

test('自动更新未设置时默认开启，显式关闭与坏配置仍不自动安装', async () => {
  const updater = await loadUpdater();
  assert.equal(updater.autoUpdateEnabled(), true, '未设置时自动安装正式版');
  assert.equal(updater.autoUpdateFilePath(), path.join(DSH_HOME, 'storages', 'mobile-plugin', 'auto-update.json'));
  assert.equal(updater.setAutoUpdate(true), true);
  assert.equal(updater.autoUpdateEnabled(), true);
  assert.equal(updater.setAutoUpdate(false), false);
  assert.equal(updater.autoUpdateEnabled(), false, '用户明确关闭后保持关闭');
  fs.writeFileSync(updater.autoUpdateFilePath(), '{ 坏 json');
  assert.equal(updater.autoUpdateEnabled(), false, '配置损坏时不自动安装');
});

// ── 一次完整更新：装 → 换代 → 落账（成功失败都要落） ────────────────────────────

test('装上了但换不过来：账要落、也要抛给路由（不许静默少一代）', async t => {
  install('0.3.0');
  const market = await startMarket(() => {
    install('0.4.0');
    return { state: 'succeeded', beforeVersion: '0.3.0', installedVersion: '0.4.0' };
  });
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const updateState = { lastApply: null, appliedAt: null, lastError: null };
  const runtime = { status: () => ({ version: '0.3.0', source: 'installed' }), reload: async () => { throw new Error('这一代起不来') } };
  await assert.rejects(updater.performUpdate({ runtime, base: updater.marketBase(market.port), updateState, auto: true }), /换代码没成/);
  assert.equal(updateState.lastApply.installed, true, '盘上确实装上了，这要如实说');
  assert.equal(updateState.lastApply.swapped, false);
  assert.equal(updateState.lastApply.state, 'installed-not-swapped');
  assert.equal(updateState.lastApply.failure.code, 'swap_failed');
  assert.ok(updateState.appliedAt, 'appliedAt 不动的话，手机那边只能等到超时才说得出「没成」');
});

test('换不过来之后：自动不再反复抖同一个版本，手按一次才重试', async t => {
  // 盘上已经装着 0.8.0（上次装上了没换过来），跑着的还是 0.7.0。
  install('0.8.0');
  let reloads = 0;
  const runtime = { status: () => ({ version: '0.7.0', source: 'installed' }), reload: async () => { reloads += 1; throw new Error('起不来') } };
  const market = await startMarket(() => ({ state: 'succeeded' }), { installedVersion: '0.8.0', latestVersion: '0.8.0', updateAvailable: false, source: 'npm' });
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const updateState = { lastApply: null, appliedAt: null, lastError: null };
  const base = updater.marketBase(market.port);

  // 自动那一轮：第一次会真去换（盘上确实更新），失败。
  await assert.rejects(updater.performUpdate({ runtime, base, updateState, auto: true }));
  assert.equal(reloads, 1);
  // 下一个 tick 还是同一版：不该再抖一次。
  await updater.performUpdate({ runtime, base, updateState, auto: true });
  assert.equal(reloads, 1, '一个起不来的版本不该每一轮把手机抖一下');
  assert.equal(updateState.lastApply.failure.code, 'swap_deferred', '要如实说「自动已经试过了」');
  // 人按了一次：那是「我知道，再来一次」的出口。
  await assert.rejects(updater.performUpdate({ runtime, base, updateState, auto: false }));
  assert.equal(reloads, 2);
});

test('装那步就炸：账也要落，不能只留一句「最近一次更新」还是上一轮', async () => {
  install('0.1.0');
  const updater = await loadUpdater();
  const updateState = { lastApply: null, appliedAt: null, lastError: null };
  const runtime = { status: () => ({ version: '0.1.0', source: 'installed' }) };
  await assert.rejects(updater.performUpdate({ runtime, base: null, updateState }));
  assert.equal(updateState.lastApply.state, 'failed');
  assert.equal(updateState.lastApply.failure.code, 'install_failed');
  assert.ok(updateState.appliedAt);
  assert.ok(updateState.lastError);
});

test('自动轮询与手按按钮撞一起：只跑一次安装，第二个等第一次的结果', async t => {
  install('0.5.0');
  const market = await startMarket(() => {
    install('0.6.0');
    return { state: 'succeeded', beforeVersion: '0.5.0', installedVersion: '0.6.0' };
  });
  t.after(() => market.server.close());
  const updater = await loadUpdater();
  const updateState = { lastApply: null, appliedAt: null, lastError: null };
  const runtime = { status: () => ({ version: '0.5.0', source: 'installed' }), reload: async () => ({ version: '0.6.0', source: 'installed' }) };
  const base = updater.marketBase(market.port);
  const first = updater.performUpdate({ runtime, base, updateState, auto: true });
  const second = updater.performUpdate({ runtime, base, updateState, force: true });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(market.seen.posts.length, 1, '两个包管理器同时往一个 profile 里装 = 装出半个包');
  assert.equal(a.swapped, true);
  assert.equal(b.swapped, true);
});

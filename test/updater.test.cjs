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

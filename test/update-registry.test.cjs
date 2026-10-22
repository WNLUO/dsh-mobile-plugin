'use strict';

/**
 * 「检查更新」自己问 npm 这条路的守卫。
 *
 * 这一格的判错全都很安静：报「没有新版」而其实有，用户就永远停在旧版本上；报「有新版」而
 * 其实盘上更新（回滚、本地构建跑在发布前面），用户会点一次什么都没变的更新；注册表挂了
 * 却当成「已经是最新版」，那更糟 —— 界面上一片祥和，插件却再也不会更新。
 *
 * 所以这里用**真的 HTTP 服务**（node:http，随机端口）当注册表：路径、取哪一格字段、超时、
 * 错误怎么带出来，全是被测对象。
 *
 * 另一条是**源码契约**：`/api/relay/update/check` 不许再转调外壳的 `runtime.check()`
 * （那会绕回插件市场），也不许在外壳不在时回「办不了」——查不需要外壳，装才需要。
 *
 * 「装」那条（`/api/relay/update/apply`）从 2026-10-12 起只委托外壳的 `apply`，因此它的守卫
 * 钉的是**委托关系**与响应形状：判定、装、换代、落账（`lastApply`）都必须发生在同一层，
 * 路由自己去装一遍，手动（含强制）更新的结果就没人记 —— 那正是这个文件同一天补的缺口。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const PKG_DIR = path.join(__dirname, '..');
const { checkForUpdate, compareVersion, latestVersion, registryBase } = require('../lib/update-registry.cjs');

const PLUGIN = 'dsh-mobile-plugin';

/** 一个只回答 `/<name>/latest` 的假注册表。`answer` 决定它怎么答。 */
async function startRegistry(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    answer(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    seen,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** 正常的注册表：`/<name>/latest` 回一个版本号，其它路径 404。 */
function serving(version) {
  return (req, res) => {
    if (req.url === `/${PLUGIN}/latest`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: PLUGIN, version }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

test('线上比盘上新：如实报有新版，并带上两边版本号', async () => {
  const registry = await startRegistry(serving('0.2.0'));
  try {
    const result = await checkForUpdate({ base: registry.base, installedVersion: '0.1.60', source: 'npm' });
    assert.equal(result.latestVersion, '0.2.0');
    assert.equal(result.installedVersion, '0.1.60');
    assert.equal(result.updateAvailable, true);
    assert.equal(result.source, 'npm');
    assert.equal(typeof result.checkedAt, 'string', '要带一次查询时间，面板那一行才有得显示');
    assert.deepEqual(registry.seen, [`/${PLUGIN}/latest`], '只该问 /latest 这一格，别把整份 packument 拉下来');
  } finally {
    await registry.close();
  }
});

test('盘上就是最新的：不许因为「两个号不一样」就喊有新版', async () => {
  const registry = await startRegistry(serving('0.1.60'));
  try {
    const result = await checkForUpdate({ base: registry.base, installedVersion: '0.1.60' });
    assert.equal(result.updateAvailable, false);
  } finally {
    await registry.close();
  }
});

test('线上比盘上旧（回滚 / 本地构建跑在前面）：报没有新版，绝不引导降级', async () => {
  const registry = await startRegistry(serving('0.1.59'));
  try {
    const result = await checkForUpdate({ base: registry.base, installedVersion: '0.1.60' });
    assert.equal(result.updateAvailable, false, '「更新会降级」必须由版本比较判定');
  } finally {
    await registry.close();
  }
});

test('盘上版本取不到：如实报 null 且不喊有新版（比不出来就别把人引去装）', async () => {
  const registry = await startRegistry(serving('0.2.0'));
  try {
    const result = await checkForUpdate({ base: registry.base, installedVersion: null });
    assert.equal(result.latestVersion, '0.2.0', '线上是几仍然要报出来');
    assert.equal(result.installedVersion, null);
    assert.equal(result.updateAvailable, false);
  } finally {
    await registry.close();
  }
});

test('注册表 404 / 500 / 响应不可读：抛错并带上原因，不许当成「已经是最新版」', async () => {
  const missing = await startRegistry(serving('0.2.0'));
  try {
    await assert.rejects(
      () => latestVersion({ base: missing.base, name: 'nope' }),
      error => /404/.test(error.message) && /nope/.test(error.message),
      '找不到包要把 404 与包名一起说出来',
    );
  } finally {
    await missing.close();
  }

  const broken = await startRegistry((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  try {
    await assert.rejects(() => latestVersion({ base: broken.base }), error => /500/.test(error.message));
  } finally {
    await broken.close();
  }

  const notJson = await startRegistry((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>反机器人拦截页</html>');
  });
  try {
    await assert.rejects(() => latestVersion({ base: notJson.base }), error => /版本号/.test(error.message));
  } finally {
    await notJson.close();
  }
});

test('连不上 / 不回答：按超时如实报「连不上」，不挂住面板', async () => {
  // 收下请求但永不回：只能靠 timeout 收场（面板那颗按钮不能就这么转下去）。
  const silent = await startRegistry(() => {});
  try {
    await assert.rejects(
      () => latestVersion({ base: silent.base, timeoutMs: 60 }),
      error => /连不上/.test(error.message),
    );
  } finally {
    await silent.close();
  }

  // 端口没人听：连 TCP 都建不起来，同样要落成一句人话，而不是一个裸的 ECONNREFUSED。
  await assert.rejects(
    () => latestVersion({ base: 'http://127.0.0.1:1', timeoutMs: 200 }),
    error => /连不上/.test(error.message),
  );
});

test('注册表地址：默认官方源，DSHM_NPM_REGISTRY 可覆盖（末尾斜杠不留）', () => {
  assert.equal(registryBase({}), 'https://registry.npmjs.org');
  assert.equal(registryBase({ DSHM_NPM_REGISTRY: '  ' }), 'https://registry.npmjs.org');
  assert.equal(registryBase({ DSHM_NPM_REGISTRY: 'http://127.0.0.1:4873/' }), 'http://127.0.0.1:4873');
});

test('版本比较：按数字段比（0.1.10 比 0.1.9 新），预发布按主段', () => {
  assert.ok(compareVersion('0.1.10', '0.1.9') > 0, '字符串比较会把这个判反');
  assert.ok(compareVersion('0.1.60', '0.1.60') === 0);
  assert.ok(compareVersion('1.0.0', '0.999.999') > 0);
  assert.ok(compareVersion('0.1.61-rc.1', '0.1.60') > 0, '预发布后缀按主段比');
  assert.ok(compareVersion('0.2', '0.1.99') > 0, '缺段补 0');
});

test('源码契约：检查更新走插件自己那条路，不回头问外壳 / 市场', () => {
  const source = fs.readFileSync(path.join(PKG_DIR, 'lib', 'routes', 'control-plane.js'), 'utf8');
  assert.match(source, /require\('\.\.\/update-registry\.cjs'\)/, '控制面要接上自己那份注册表查询');
  const start = source.indexOf("'/api/relay/update/check'");
  assert.ok(start > 0, '这条路由必须还在');
  const route = source.slice(start, source.indexOf('registerRoute(', start));
  assert.match(route, /checkForUpdate\(/, '这条要走插件自己的注册表查询');
  assert.equal(/runtime\.check\(/.test(route), false, '不许再转调外壳去问市场：那正是「一个插件得另一个插件在场」的来源');
  assert.equal(/runtimeUnavailable/.test(route), false, '查不需要外壳在场（装才需要），不许再回「办不了」');
});

/**
 * 把控制面注册一遍，只留「路径 → handler」这张表。
 *
 * 依赖全给最小假体：真正被调用到的只有更新那两条路由，其余 handler 只登记、不执行。
 * `body` 是喂给 `readJson` 的请求体（apply 那条从 body 里读 `force`）。
 */
function routeTable({ runtime = null, services = {}, body = {} } = {}) {
  const table = new Map();
  require('../lib/routes/control-plane.js').registerControlPlaneRoutes({
    registerRoute: (route) => table.set(route.path, route.handler),
    localOnly: (_method, handler) => handler,
    trustedLocalUi: () => true,
    sendJson: (res, status, payload) => {
      res.status = status;
      res.body = payload;
    },
    readJson: async () => body,
    getPluginRuntime: () => runtime,
    // 控制面其余路由（清未读那条）要从插件 ctx 里取宿主服务，给个最小假体。
    ctx: { get: (key) => services[key] ?? null },
  });
  return table;
}

test('行为：没有外壳也答得出来（退回这一代自己的版本号），不再回「办不了」', async () => {
  const registry = await startRegistry(serving('0.9.9'));
  const previous = process.env.DSHM_NPM_REGISTRY;
  process.env.DSHM_NPM_REGISTRY = registry.base;
  try {
    const res = {};
    await routeTable().get('/api/relay/update/check')({ method: 'POST' }, res);
    assert.equal(res.status, 200, '查不需要外壳，这里不该是 409');
    assert.equal(res.body.data.update.latestVersion, '0.9.9');
    assert.equal(res.body.data.update.installedVersion, require('../package.json').version, '拿不到盘上版本就报这一代的版本号');
    assert.equal(res.body.data.update.updateAvailable, true);
    assert.equal(res.body.data.status, null, '没有外壳就没有状态快照，如实为空');
  } finally {
    if (previous === undefined) delete process.env.DSHM_NPM_REGISTRY;
    else process.env.DSHM_NPM_REGISTRY = previous;
    await registry.close();
  }
});

test('行为：有外壳时盘上版本取外壳那份，来源（只有市场知道）照抄它的记忆', async () => {
  const registry = await startRegistry(serving('0.2.0'));
  const previous = process.env.DSHM_NPM_REGISTRY;
  process.env.DSHM_NPM_REGISTRY = registry.base;
  try {
    const runtime = {
      status: () => ({
        installedVersion: '0.1.60',
        version: '0.1.60',
        marketResult: { installedVersion: '0.1.60', latestVersion: '0.1.60', updateAvailable: false, source: 'linked' },
      }),
    };
    const res = {};
    await routeTable({ runtime }).get('/api/relay/update/check')({ method: 'POST' }, res);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.update.installedVersion, '0.1.60');
    assert.equal(res.body.data.update.latestVersion, '0.2.0');
    assert.equal(res.body.data.update.updateAvailable, true);
    assert.equal(res.body.data.update.source, 'linked', '来源照抄外壳上次问市场的结果，本模块不为它敲市场');
  } finally {
    if (previous === undefined) delete process.env.DSHM_NPM_REGISTRY;
    else process.env.DSHM_NPM_REGISTRY = previous;
    await registry.close();
  }
});

test('行为：注册表挂了要如实报错，不许回一句「已经是最新版」', async () => {
  const registry = await startRegistry((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'registry down' }));
  });
  const previous = process.env.DSHM_NPM_REGISTRY;
  process.env.DSHM_NPM_REGISTRY = registry.base;
  try {
    const res = {};
    await routeTable().get('/api/relay/update/check')({ method: 'POST' }, res);
    assert.equal(res.status, 500);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error.message, /503/);
  } finally {
    if (previous === undefined) delete process.env.DSHM_NPM_REGISTRY;
    else process.env.DSHM_NPM_REGISTRY = previous;
    await registry.close();
  }
});

/**
 * 「装」那条路由的守卫。
 *
 * 2026-10-12 起这条路由**只委托**外壳的 `apply`：判定、装、换代，以及把结果写进外壳那本
 * `lastApply` 账，都在那一层 —— 面板「最近一次更新」那一行与「上次没装成」那个判据读的都是
 * 这本账。所以这里钉的是**委托关系**与响应形状：路由只要自己去装一次，手动更新的结果就没人
 * 落账（正是 2026-10-12 修掉的那个缺口）。装本身的判定另在 `test/update-install.test.cjs`。
 */
function fakeShell({ outcome, version = '0.1.60' }) {
  const calls = [];
  const state = { lastApply: null, appliedAt: null };
  const shell = {
    calls,
    status: () => ({
      available: true,
      installedVersion: version,
      version,
      lastApply: state.lastApply,
      appliedAt: state.appliedAt,
    }),
    apply: async (options) => {
      calls.push(options);
      const applied = typeof outcome === 'function' ? outcome(options) : outcome;
      // 照外壳那样记账：这本账只有外壳能写（见 `lib/index.js` 的 `applyUpdate`）。
      state.lastApply = { ...applied, swapped: applied.swapped === true };
      state.appliedAt = new Date().toISOString();
      return { ...applied, status: shell.status() };
    },
  };
  return shell;
}

test('行为：已经是最新时 apply 如实报「没动过」，不是失败', async () => {
  const shell = fakeShell({
    version: '0.1.61',
    outcome: { installed: false, skipped: true, state: 'succeeded', beforeVersion: '0.1.61', installedVersion: '0.1.61', swapped: false, failure: null },
  });
  const res = {};
  await routeTable({ runtime: shell }).get('/api/relay/update/apply')({ method: 'POST' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, '已经是最新不该报成失败');
  assert.equal(res.body.data.skipped, true, '这一格丢了，面板就会说「装了但版本没变」');
  assert.equal(res.body.data.state, 'succeeded');
  assert.equal(res.body.data.installed, false);
  assert.equal(res.body.data.failure, null);
  assert.equal(shell.calls.length, 1, '装必须走外壳的 apply —— 路由自己去装一遍，手动的结果就没人落账');
  assert.equal(res.body.data.status.lastApply.skipped, true, '回给面板的状态必须是 apply **之后**的账，拿之前的快照等于没落账');
  assert.ok(res.body.data.status.appliedAt, '「最近一次更新」那一行的时间就从这里来');
});

test('行为：有对话在跑时外壳报的 AGENTS_RUNNING 原样透传（可再试），不算故障', async () => {
  const shell = fakeShell({
    version: '0.1.60',
    outcome: {
      installed: false,
      skipped: false,
      state: 'failed',
      beforeVersion: '0.1.60',
      installedVersion: '0.1.60',
      swapped: false,
      failure: { code: 'AGENTS_RUNNING', message: '有 1 个 agent 正在运行，等它完成再更新。' },
      retryable: true,
    },
  });
  const res = {};
  await routeTable({ runtime: shell }).get('/api/relay/update/apply')({ method: 'POST' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, '没装成还回 ok:true，面板会把失败说成成功');
  assert.equal(res.body.data.failure.code, 'AGENTS_RUNNING');
  assert.equal(res.body.data.retryable, true);
  assert.equal(res.body.data.installed, false);
});

test('行为：点「强制更新」要把 force 一路透到外壳（那是这道闸唯一的出口）', async () => {
  const shell = fakeShell({ outcome: { installed: false, skipped: true, state: 'succeeded', swapped: false, failure: null } });
  const res = {};
  await routeTable({ runtime: shell, body: { force: true } }).get('/api/relay/update/apply')({ method: 'POST' }, res);
  assert.deepEqual(shell.calls, [{ force: true }], '不带 force，面板上那颗「强制更新」就只是个摆设');
  assert.equal(res.status, 200);
});

test('行为：没外壳（或外壳没有 apply）回 409，不许路由自己硬装', async () => {
  const noApply = {};
  const res1 = {};
  await routeTable({ runtime: null }).get('/api/relay/update/apply')({ method: 'POST' }, res1);
  assert.equal(res1.status, 409);
  assert.equal(res1.body.error.code, 'update_unavailable');
  const res2 = {};
  await routeTable({ runtime: noApply }).get('/api/relay/update/apply')({ method: 'POST' }, res2);
  assert.equal(res2.status, 409, '没有 apply 的外壳装完也换不了代，回 409 比装一半强');
  assert.equal(res2.body.error.code, 'update_unavailable');
});

test('源码契约：手动更新的结果只能由外壳落账，路由不许绕开它自己去装', () => {
  const shellFiles = ['index.js', 'shell/updater.js', 'shell/runtime.js', 'shell/manager.js', 'shell/device-ota.js'];
  for (const file of shellFiles) {
    const source = fs.readFileSync(path.join(PKG_DIR, 'lib', file), 'utf8');
    const writes = (source.match(/updateState\.lastApply\s*=/g) || []).length;
    if (file === 'shell/updater.js') assert.ok(writes >= 1, '落账点必须还在（面板「最近一次更新」与「上次没装成」读的都是它）');
    else assert.equal(writes, 0, `${file} 不许自己记那本账：落账只在 shell/updater.js 一处`);
  }
  const shell = fs.readFileSync(path.join(PKG_DIR, 'lib', 'index.js'), 'utf8');
  assert.match(shell, /apply:\s*applyUpdate/, '外壳必须把 apply 暴露给控制面');
  assert.match(shell, /updater\.performUpdate\(/, '入口只许转交：装 / 换代 / 落账都在 shell/updater.js 里做');
  const route = fs.readFileSync(path.join(PKG_DIR, 'lib', 'routes', 'control-plane.js'), 'utf8');
  const start = route.indexOf("'/api/relay/update/apply'");
  assert.ok(start > 0, '这条路由必须还在');
  const body = route.slice(start, route.indexOf('registerRoute(', start));
  assert.match(body, /await runtime\.apply\(\{ force \}\)/, '路由只负责传参和说人话，自己去装一遍就没人落账');
});

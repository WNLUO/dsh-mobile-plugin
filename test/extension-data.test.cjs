'use strict';

/**
 * 扩展页「读宿主数据」那条通道的服务登记（`lib/mobile/extension-data.js`）。
 *
 * 这一节钉的是**第三方插件能不能把自己的接口登记给宿主代取**：服务查表只看插件自己
 * `package.json` 里的 `dshMobileDataServices`。判据是「声明能查到、没声明就是 404」，
 * 以及声明服务的目标确实是宿主自己那个端口。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionData = require('../lib/mobile/extension-data.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ext-data-'));
}

function makePlugin(pluginsRoot, name, manifest) {
  const directory = path.join(pluginsRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
}

/** 一个只有「运行时快照」与「web 端口 / launch token」的假 ctx。 */
function fakeCtx(pluginsRoot, { port = 51234, token = 'tok' } = {}) {
  return {
    webServer: { port },
    get(name) {
      if (name === 'dshMobilePluginRuntime') return { status: () => ({ profileNodeModules: pluginsRoot }) };
      if (name === 'connection') return { browserAuth: { launchToken: token } };
      return null;
    },
  };
}

test('第三方声明的服务能查到，allow 取它自己声明的', () => {
  const pluginsRoot = makeTmp();
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    const spec = extensionData.specOf(fakeCtx(pluginsRoot), 'dsh-email');
    assert.ok(spec, '声明过的服务应当查得到');
    assert.deepEqual(spec.allow, ['/api/dsh-email/']);
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('没声明过的服务查不到（调用方回 404 service-unknown）', () => {
  const pluginsRoot = makeTmp();
  try {
    makePlugin(pluginsRoot, 'some-plugin', {});
    assert.equal(extensionData.specOf(fakeCtx(pluginsRoot), 'nope'), null);
    assert.equal(extensionData.specOf(fakeCtx(null), 'dsh-email'), null, '取不到 profile 目录时也没有');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('声明服务的目标是宿主自己的 web 端口，凭据用 launch token', async () => {
  const pluginsRoot = makeTmp();
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    const spec = extensionData.specOf(fakeCtx(pluginsRoot, { port: 59999, token: 'abc' }), 'dsh-email');
    const target = await spec.resolve();
    assert.equal(target.port, 59999, '目标必须是宿主自己那个 web 端口');
    assert.equal(target.key, 'abc', '凭据取 launch token');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('新宿主没有 browserAuth 时，服务凭据从 entry-url 兜底取到', async () => {
  const pluginsRoot = makeTmp();
  const port = 59876;
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    const ctx = {
      webServer: { port },
      get(name) {
        // 新宿主：连接服务里已经没有 browserAuth，更没有 launchToken。
        if (name === 'dshMobilePluginRuntime') return { status: () => ({ profileNodeModules: pluginsRoot }) };
        return null;
      },
      emit(thisArg, name, baseUrl, entries) {
        assert.equal(name, 'webserver/entry-url');
        assert.equal(baseUrl, `http://127.0.0.1:${port}`);
        entries.push({ url: `http://127.0.0.1:${port}/?token=entry-token` });
      },
    };
    const spec = extensionData.specOf(ctx, 'dsh-email');
    const target = await spec.resolve();
    assert.equal(target.port, port);
    assert.equal(target.key, 'entry-token', '取数换票的 key 不能是 null，否则裸请求会被宿主认证打回 401');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

test('没有 web 端口时 resolve 抛 service-unavailable（调用方回 503）', async () => {
  const pluginsRoot = makeTmp();
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    const spec = extensionData.specOf(fakeCtx(pluginsRoot, { port: 0 }), 'dsh-email');
    await assert.rejects(() => spec.resolve());
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

/**
 * 取数通道的现场记录（`~/.dsh/mobile-extension-data.log`）。
 *
 * 加它是因为真机上「前端出来了、取数全失败」这一类现象，从手机屏幕上只能看到一句
 * `failed to fetch`：断在 App 根本没发过来、服务没登记、路径不在 allow、还是目标服务自己
 * 回了 4xx/5xx，全分不出来。每一发落一行之后，看一眼日志就知道断在哪一格。
 */
function readLog(home) {
  const file = path.join(home, 'mobile-extension-data.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function fakeRes() {
  const res = { status: 0, text: '' };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.text = String(payload); };
  return res;
}

/** 跑一发 handler，全程把 DSH_HOME 指到临时目录，好读回那行记录。 */
async function withHome(home, run) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test('没登记的服务：回 404，并落一行 service-unknown（带服务名、路径、设备）', async () => {
  const pluginsRoot = makeTmp();
  const home = makeTmp();
  try {
    makePlugin(pluginsRoot, 'some-plugin', {});
    const res = fakeRes();
    await withHome(home, () => extensionData.handleExtensionData(
      fakeCtx(pluginsRoot),
      { body: { service: 'nope', path: '/api/nope/state' }, __dshRecord: { deviceId: 'd1' } },
      res,
    ));
    assert.equal(res.status, 200, '回包形状固定是 200（失败信息在正文里）');
    assert.equal(JSON.parse(res.text).code, 'service-unknown');
    const lines = readLog(home);
    assert.equal(lines.length, 1, '一发一行');
    assert.equal(lines[0].code, 'service-unknown');
    assert.equal(lines[0].service, 'nope');
    assert.equal(lines[0].path, '/api/nope/state', '拒绝也要记下页面想打哪儿');
    assert.equal(lines[0].device, 'd1');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('路径不在 allow 里：回 403 path-not-allowed，日志同样落一行', async () => {
  const pluginsRoot = makeTmp();
  const home = makeTmp();
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    const res = fakeRes();
    await withHome(home, () => extensionData.handleExtensionData(
      fakeCtx(pluginsRoot),
      { body: { service: 'dsh-email', path: '/api/other/x' } },
      res,
    ));
    assert.equal(JSON.parse(res.text).code, 'path-not-allowed');
    assert.equal(readLog(home)[0].code, 'path-not-allowed');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('请求走到了目标服务那一步：日志带 upstream 状态码（目标连不上记 0）', async () => {
  const pluginsRoot = makeTmp();
  const home = makeTmp();
  try {
    makePlugin(pluginsRoot, 'dsh-email-plugin', {
      dshMobileDataServices: [{ service: 'dsh-email', allow: ['/api/dsh-email/'] }],
    });
    // 端口 1 一定没人监听：这就是「插件路由没响应 / 目标服务不在」那一格。
    const res = fakeRes();
    await withHome(home, () => extensionData.handleExtensionData(
      fakeCtx(pluginsRoot, { port: 1 }),
      { body: { service: 'dsh-email', path: '/api/dsh-email/state' } },
      res,
    ));
    const lines = readLog(home);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].upstream, 0, '连不上目标时记 0，而不是假装成功');
    assert.equal(lines[0].code, 'upstream-unreachable');
    assert.equal(lines[0].method, 'GET');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

'use strict';

/**
 * 扩展页「读宿主数据」那条通道的服务登记（`lib/mobile/extension-data.js`）。
 *
 * 这一节钉的是**第三方插件能不能把自己的接口登记给宿主代取**：服务查表分两处 ——
 * 内置静态表（magpie）与插件自己 `package.json` 里的 `dshMobileDataServices`。判据是
 * 「静态优先、声明能查到、没声明就是 404」，以及声明服务的目标确实是宿主自己那个端口。
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

test('内置服务优先于第三方声明：同名声明顶不掉 magpie', () => {
  const pluginsRoot = makeTmp();
  try {
    makePlugin(pluginsRoot, 'evil', { dshMobileDataServices: [{ service: 'magpie', allow: ['/private/'] }] });
    const spec = extensionData.specOf(fakeCtx(pluginsRoot), 'magpie');
    assert.ok(spec, '应当查到 magpie');
    // 静态那份 allow 只有 /api/，第三方那份是 /private/ —— 若被顶掉这里会变成 /private/。
    assert.deepEqual(spec.allow, ['/api/'], '内置服务的 allow 不该被第三方声明改掉');
  } finally {
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  }
});

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

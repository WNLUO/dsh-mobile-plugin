/** 面板启动回执、状态与二维码请求时限，以及旧内核构建的回归与变异检查。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.join(__dirname, '..', 'React');
const appManifest = path.join(root, '..', '..', 'app', 'package.json');
const requireApp = createRequire(appManifest);
// 与跨端用例一致：独立检出插件时保留静态检查，需 App 转译器的行为用例注明跳过。
const runtimeOptions = { skip: fs.existsSync(appManifest) ? false : '主仓 app/ 不在场，缺少 TS 测试转译器' };
const babel = runtimeOptions.skip ? null : requireApp('@babel/core');
const preset = runtimeOptions.skip ? null : requireApp.resolve('@react-native/babel-preset');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, context = {}, mutate = (source) => source) {
  const module = { exports: {} };
  const code = babel.transformSync(mutate(read(file)), {
    filename: file, presets: [preset], configFile: false, babelrc: false,
  }).code;
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, ...context,
    require: (name) => name === './i18n/index.ts' ? { t: (key) => key } : requireApp(name) });
  return module.exports;
}

function requests(fetch, mutate) {
  const timers = new Map();
  let id = 0;
  const api = load('src/lib/api.ts', { fetch, window: {
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { timers.delete(key); },
  } }, mutate);
  return { api, timers, expire() { for (const { fn } of [...timers.values()]) fn(); } };
}

test('状态读取超时会终止挂起请求并给出可读错误，随后可重试', runtimeOptions, async () => {
  let attempt = 0;
  const env = requests((_url, { signal }) => {
    if (++attempt > 1) return Promise.resolve({ ok: true, json: async () => ({ enabled: true }) });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const first = env.api.apiGet('/api/relay/status');
  assert.equal([...env.timers.values()][0].ms, 12000);
  env.expire();
  await assert.rejects(first, (error) => error.code === 'status_timeout' && error.message === 'panel.console.statusTimeout');
  assert.equal(env.timers.size, 0);
  assert.equal((await env.api.apiGet('/api/relay/status')).enabled, true);
  assert.equal(env.timers.size, 0);
});

test('超时覆盖响应体读取，配对与管理写请求不受首屏时限影响', runtimeOptions, async () => {
  let signal;
  const env = requests(async (_url, init) => {
    signal = init.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')))) };
  });
  const request = env.api.apiGet('/api/relay/status');
  await new Promise((resolve) => setImmediate(resolve));
  env.expire();
  await assert.rejects(request, (error) => error.code === 'status_timeout');
  const other = requests(async (_url, init) => {
    assert.equal(init.signal, undefined);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await other.api.apiGet('/api/relay/addresses');
  await other.api.apiPost('/api/relay/config', {});
  assert.equal(other.timers.size, 0);
});

test('二维码请求有独立时限，超时能结束并且下一次成功', runtimeOptions, async () => {
  let count = 0;
  const env = requests((_url, { signal }) => {
    if (++count === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, svg: '<svg></svg>' }) });
  });
  const request = env.api.apiGet('/api/relay/pairing');
  assert.equal([...env.timers.values()][0].ms, 30000);
  env.expire();
  await assert.rejects(request, (error) => error.code === 'pairing_timeout' && error.message === 'panel.console.pairingTimeout');
  assert.equal((await env.api.apiGet('/api/relay/pairing')).svg, '<svg></svg>');
  assert.equal(env.timers.size, 0);
});

test('二维码成功响应必须真有 SVG，失败或空回包不能一直显示没取到', runtimeOptions, async () => {
  for (const payload of [{ ok: false }, { ok: true }, { ok: true, svg: '' }, { ok: true, svg: 'http://127.0.0.1/qr' }]) {
    const env = requests(async () => ({ ok: true, status: 200, json: async () => payload }));
    await assert.rejects(env.api.apiGet('/api/relay/pairing?relayUrl=preview'), (error) => error.code === 'pairing_invalid');
    assert.equal(env.timers.size, 0);
  }
});

test('二维码错误就地显示并可重取，两个入口共用同一卡片', () => {
  const card = read('src/components/PairingCard.tsx');
  assert.match(card, /error \? \([\s\S]{0,400}onClick=\{onRetryPairing\}/);
  assert.match(card, /panel\.console\.retryPairing/);
  for (const file of ['src/App.tsx', 'src/Console.tsx']) {
    assert.match(read(file), /onRetryPairing=\{\(\) => void loadPairing\(\)\}/);
  }
  const onboarding = read('src/Onboarding.tsx');
  assert.match(onboarding, /setPairingError\(errorText\(error\)\)/);
  assert.match(onboarding, /onClick=\{\(\) => void loadPairing\(\)\}/);
});

test('启动状态同时写入文档标记并报告父窗口，独立打开不发回执', runtimeOptions, () => {
  const attributes = new Map();
  const messages = [];
  const window = { parent: { postMessage: (data) => messages.push(data) } };
  const document = { documentElement: {
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: (key) => attributes.delete(key),
  } };
  const { reportPanelState } = load('src/lib/panel-load.ts', { window, document });
  reportPanelState('error', 'status timeout');
  assert.equal(attributes.get('data-dshm-panel-state'), 'error');
  assert.equal(attributes.get('data-dshm-panel-error'), 'status timeout');
  assert.equal(messages[0].state, 'error');
  reportPanelState('ready');
  assert.equal(attributes.get('data-dshm-panel-state'), 'ready');
  assert.equal(attributes.has('data-dshm-panel-error'), false);
  assert.equal(messages[1].type, 'dsh-mobile-plugin:panel-state');
  window.parent = window;
  reportPanelState('ready');
  assert.equal(messages.length, 2);
});

test('页面接线：状态返回后才确认就绪，首屏与 React 异常均报告失败', () => {
  const source = read('src/Root.tsx');
  assert.match(source, /configured !== null && !\(forcedConsole && configured\)/);
  assert.match(read('src/Console.tsx'), /if \(status\) reportPanelState\('ready'\)/);
  assert.match(read('src/Console.tsx'), /else if \(fatal\) reportPanelState\('error', fatal\)/);
  assert.match(source, /setStartupError\(errorText\(error\)\)/);
  assert.match(source, /reportPanelState\('error', startupError\)/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(read('src/main.tsx'), /onUncaughtError:.*reportPanelState\('error'/);
});

test('变异：移除超时中止后，挂起请求不能被终止', runtimeOptions, () => {
  let signal;
  const env = requests((_url, init) => { signal = init.signal; return new Promise(() => {}); },
    (source) => source.replace('() => controller.abort()', '() => {}'));
  void env.api.apiGet('/api/relay/status');
  env.expire();
  assert.throws(() => assert.equal(signal.aborted, true), assert.AssertionError);
});

test('兼容构建：脚本与样式目标覆盖 iOS 15.1，层叠样式经过转换', () => {
  const config = read('vite.config.ts');
  assert.match(config, /target: \['ios15\.1', 'chrome99'\]/);
  assert.match(config, /cssTarget: \['ios15\.1', 'chrome99'\]/);
  assert.match(config, /cascadeLayers\(\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.devDependencies['@csstools/postcss-cascade-layers'], '5.0.2');
});

test('正式产物：旧内核不会整层丢掉样式，明暗底色都有普通颜色后备', () => {
  const html = fs.readFileSync(path.join(root, '..', 'lib', 'panel', 'index.html'), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const backgrounds = [...css.matchAll(/([^{}]+)\{[^{}]*--background:(#[\da-f]+)(?:;|})/gi)]
    .map((match) => ({ selector: match[1], value: match[2] }));
  assert.doesNotMatch(css, /@layer(?:\s|[;{])/, 'iOS 15.1 不能把整份样式留在 @layer 内');
  assert.ok(backgrounds.some(({ selector }) => selector.includes(':root')), '浅色主题缺少 RGB 后备');
  assert.ok(backgrounds.some(({ selector }) => selector.includes('.dark')), '深色主题缺少 RGB 后备');
  assert.match(html, /data-dshm-panel-state/);
});

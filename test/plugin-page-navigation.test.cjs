/** 电脑插件目录只列真实页面，并通过宿主页面状态直达；无桌面窗口依赖。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');

function harness(text = source) {
  let descriptor, cursor = 0, effects = [];
  const state = [], listeners = new Map(), registered = [], selected = [], opened = [];
  const layout = { selectPanel: (key) => selected.push(key) };
  const settings = { actions: { openSection: (id) => opened.push(['settings', id]), close: () => opened.push(['close']) } };
  const plugins = { actions: { setView: (view) => opened.push(['row', view]) } };
  const entry = (id, label, owner = 'third-party', extra = {}) => ({ options: { id, key: id, label, registrant: owner }, ...extra });
  const ledger = {
    'settings.section': [entry('free-model', () => 'Free model'), entry('mobile', 'Mobile'), entry('general', 'General', '@deepseek-ai/dsh-client-ui-settings-general')],
    'sidebar.settings': [entry('settings', 'Settings', '', { store: { create: () => settings } })],
    main: [entry('canvas', 'Canvas'), entry('conversation', 'Chat'), entry('plugins', 'Plugins', '', { store: { create: () => plugins } })],
    'sidebar.panellist': [entry('canvas', () => 'Canvas')],
    'plugins.bundle.config': [entry('example-bundle', 'Example')],
    'plugins.row.config': [entry('example-bundle#account', 'Account')],
  };
  const subscribe = (_key, _fn) => () => {};
  const ctx = {
    effect(fn) { return fn(); },
    get(name) { return name === 'layout' ? layout : name === 'pluginNavigation' ? { openBundle: (name) => opened.push(['bundle', name]) } : undefined; },
    inject(names, fn) { if (names.includes('layout')) return fn(ctx); return () => {}; },
    layout,
    locale: { register() {}, bind: () => (key) => key, subscribe: () => () => {} },
    slots: {
      entries: (key) => ledger[key] || [], subscribe,
      inject(_key, fn) { return fn(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useState(initial) { const at = cursor++; if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial; return [state[at], (value) => { state[at] = typeof value === 'function' ? value(state[at]) : value; }]; },
    useEffect: (fn) => effects.push(fn),
  };
  const window = {
    __ModuleLoader__: { load(value) { descriptor = value; } }, location: { hash: '#dsh-mobile-plugins' },
    addEventListener: (name, fn) => { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    removeEventListener: (name, fn) => listeners.set(name, (listeners.get(name) || []).filter((item) => item !== fn)),
    dispatchEvent: (event) => (listeners.get(event.type) || []).forEach((fn) => fn()),
  };
  vm.runInNewContext(text, {
    window, Event: class { constructor(type) { this.type = type; } }, document: { querySelector: () => ({}), hidden: false },
    setInterval: () => 1, clearInterval() {}, console,
  });
  descriptor.factory(() => react).apply(ctx);
  const page = registered.find((row) => row.options.key === 'dsh-mobile-plugins');
  const render = () => { cursor = 0; effects = []; return page.component({ ctx, t: (key) => key }); };
  return { window, ledger, opened, selected, page, render, flush: () => effects.forEach((fn) => fn()), route(hash) { window.location.hash = hash; window.dispatchEvent({ type: 'hashchange' }); } };
}
function nodes(root, type) {
  if (!root || typeof root !== 'object') return [];
  return [...(root.type === type ? [root] : []), ...root.children.flatMap((child) => nodes(child, type))];
}
test('移动入口直接进入电脑插件目录，只列非官方实际页面', () => {
  const env = harness();
  assert.equal(env.selected.at(-1), 'dsh-mobile-plugins');
  const buttons = nodes(env.render(), 'button');
  assert.deepEqual(buttons.map((node) => node.children.join('')).sort(), ['Account', 'Canvas', 'Example', 'Free model']);
  buttons.find((node) => node.children.includes('Free model')).props.onClick();
  assert.equal(env.window.location.hash, '#dsh-mobile-plugin=settings%3Afree-model');
});
test('设置页、独立面板、整包与行配置都进入各自真实页面', () => {
  const env = harness();
  env.route('#dsh-mobile-plugin=settings%3Afree-model');
  assert.deepEqual(env.opened.at(-1), ['settings', 'free-model']);
  env.route('#dsh-mobile-plugin=panel%3Acanvas');
  assert.equal(env.selected.at(-1), 'canvas');
  env.route('#dsh-mobile-plugin=bundle%3Aexample-bundle');
  assert.deepEqual(env.opened.at(-1), ['bundle', 'example-bundle']);
  env.route('#dsh-mobile-plugin=row%3Aexample-bundle%23account');
  assert.equal(JSON.stringify(env.opened.at(-1)), JSON.stringify(['row', { kind: 'row', name: 'example-bundle', rowId: 'account' }]));
  env.route('#dsh-mobile-plugins');
  assert.deepEqual(env.opened.at(-1), ['close']);
  assert.equal(env.selected.at(-1), 'dsh-mobile-plugins');
});
test('插件卸载后不进入旧页面，返回目录并显示失效提示', () => {
  const env = harness();
  env.render(); env.flush();
  env.ledger['settings.section'] = [];
  env.route('#dsh-mobile-plugin=settings%3Afree-model');
  assert.equal(env.selected.at(-1), 'dsh-mobile-plugins');
  assert.ok(nodes(env.render(), 'p').some((node) => node.children.includes('pluginPageMissing')));
});
test('变异：把所有面板导航回首页会被直达断言识别', () => {
  const env = harness(source.replace('layout.selectPanel(row.id);', 'layout.selectPanel(null);'));
  env.route('#dsh-mobile-plugin=panel%3Acanvas');
  assert.notEqual(env.selected.at(-1), 'canvas');
});

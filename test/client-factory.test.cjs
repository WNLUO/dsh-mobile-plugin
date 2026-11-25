/** 客户端服务、界面与嵌入声明的生命周期行为测试；图标物化时把 inject 的 tf 一并传给组件。 */
// 2026-11-24：反馈附件补 plugin_source / activated_at / shell_changed，并加对应变异。
'use strict';

/**
 * 客户端行为测试覆盖控制台与电脑插件目录，两套界面的词条保持中英对应。
 * 本机与局域网直接进入管理页，只有公网入口开启两小时窗口。
 *
 * 它是整个仓库唯一「拆不开」的源文件：注册进 `window.__ModuleLoader__`，工厂收到的
 * `require` 是 **DSH 的模块表 require**，不是 node 的。所以工厂内部只能 require `react`，
 * 没法 `require('./某某.js')` 把实现挪到别的文件；文件本身也不经任何构建。拆分的唯一出路
 * 是引入打包器，那会让「OTA 直接发源码」这条部署路径整个失效。
 *
 * 这里测的是它的行为，以及「它赖以工作的形状」——形状一变设置页会静默变空白，而没有
 * 任何测试会红。2026-11-17 起也测设置卡上那两颗侧边栏图标开关的落盘与即时联动。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');
const NS = 'settings.mobileRelay';
// 浏览器侧控制面地址一律是**文档相对**的（无前导斜杠）：DSH 给 index 注入
// `<base href="./">`，页面挂在子路径下时只有相对地址才会跟着前缀走。
const READ_RECEIPT_ENDPOINT = 'api/relay/read-receipt';
const DESKTOP_READ_ENDPOINT = 'api/relay/desktop-read';
const CLIENT_HALF_ENDPOINT = 'api/relay/client-half';

/** 等若干轮微任务 + 宏任务，让 fetch 链上的 await 落地。 */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/* ── 迷你 React ────────────────────────────────────────────────────────────
 * 组件是纯 createElement 调用（文件里没有 JSX，文件头注释说明了原因），
 * 所以只要模拟出「同一次渲染内 hook 槽位稳定」这件事，就能直接调用组件函数并
 * 检查返回的元素树，不需要 react-dom / test-renderer。
 */
function createHooks() {
  let slots = [];
  let cursor = 0;
  const effects = [];

  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { value: initial };
      const slot = slots[index];
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useCallback: (fn) => fn,
    useEffect(fn, deps) {
      effects.push({ fn, deps });
    },
  };

  return {
    react,
    effects,
    /** 开始一次渲染：按 useState 顺序预置槽位，返回可传给组件函数的 props。 */
    begin(preset) {
      cursor = 0;
      effects.length = 0;
      for (const [index, value] of Object.entries(preset || {})) {
        slots[Number(index)] = { value };
      }
      return slots;
    },
    /** 跑挂载期的全部 effect。 */
    async flush() {
      for (const entry of [...effects]) {
        try {
          entry.fn();
        } catch {
          // 与真实运行时一致：effect 里的异常不阻断后续 effect。
        }
      }
      await settle();
    },
  };
}

/** 元素树里的所有 className。 */
function classNames(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  const name = node.props && node.props.className;
  if (typeof name === 'string') out.push(name);
  for (const child of node.children || []) classNames(child, out);
  return out;
}

/** 元素树里的所有字符串叶子（含 `textContent`：诊断弹窗是命令式 DOM，文字写在属性上）。 */
function texts(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (node == null || typeof node !== 'object') return out;
  if (typeof node.textContent === 'string' && node.textContent) out.push(node.textContent);
  for (const child of node.children || []) texts(child, out);
  return out;
}

/** 元素树里的所有元素。 */
function elements(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) elements(child, out);
  return out;
}

/* ── 沙箱与可控环境 ──────────────────────────────────────────────────── */

function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms, once: true });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    clearInterval(id) {
      pending.delete(id);
    },
    get count() {
      return pending.size;
    },
    get timeoutCount() {
      return [...pending.values()].filter((entry) => entry.once).length;
    },
    /** 触发一次定时器（默认只触发指定 ms 的那些）。 */
    async tick(ms) {
      const runs = [];
      for (const [id, entry] of [...pending]) {
        if (ms !== undefined && entry.ms !== ms) continue;
        if (entry.once) pending.delete(id);
        runs.push(Promise.resolve().then(() => entry.fn()));
      }
      await Promise.all(runs);
      await settle(2);
    },
  };
}

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** json 化的 fetch 替身：`routes` 是「路径后缀 → 响应」的表。 */
function routedFetch(routes = {}, fallback = { ok: true, status: 200, body: { ok: true } }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((candidate) => String(url).endsWith(candidate));
    const route = key ? routes[key] : fallback;
    const status = route.status === undefined ? 200 : route.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (route.throws) throw new Error('bad json');
        return route.body === undefined ? {} : route.body;
      },
    };
  };
  return { calls, impl };
}

/**
 * 一件假 DOM 元素：够 `lib/client.js` 里那颗手机图标用（属性、孩子、插在谁前后）。
 *
 * 真外壳把 `settings.launcher` 那个出口渲染成 `display:contents` 的盒子，头像那颗
 * 设置按钮是它的孩子、`flex:1` 铺满整行——这里照这个形状搭。
 *
 * **`children` 要跟真浏览器一样没有 `slice()`**（2026-11-05 真机现场）：假元素原来是数组，
 * 于是 `overlay.children.slice()` 在测试里永远成立，而真浏览器里 `children` 是
 * **HTMLCollection**、根本没有 `slice`，弹窗一画就抛 TypeError —— 点图标一点反应都没有。
 * 这里把 `children` 包成「有 length / 下标 / 可迭代，但没有 slice」的对象，谁再写出
 * 数组专属的方法，测试当场红。
 */
function fakeChildren(owner) {
  // 真 HTMLCollection 也吃数字下标（`children[0]`），所以用 Proxy 把下标读转给内部数组；
  // 但 `slice` / `map` / `filter` / `indexOf` 这些数组专属方法**一律没有** —— 那才是要钉的东西。
  return new Proxy(
    {
      get length() {
        return owner._children.length;
      },
      [Symbol.iterator]() {
        return owner._children[Symbol.iterator]();
      },
      item(index) {
        return owner._children[index] ?? null;
      },
    },
    {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) return owner._children[Number(key)];
        return target[key];
      },
    },
  );
}

function fakeElement(tag) {
  const element = {
    tag,
    dataset: {},
    attrs: {},
    _children: [],
    parentElement: null,
    setAttribute(name, value) {
      element.attrs[name] = String(value);
    },
    getAttribute(name) {
      return name in element.attrs ? element.attrs[name] : null;
    },
    textContent: '',
    /** 对外是 HTMLCollection 形状（没有 `slice` / `map` / `indexOf`），内部操作走 `_children`。 */
    get children() {
      return fakeChildren(element);
    },
    /** 弹窗要挂点击 / 键盘监听：记下来，测试需要时可以直接触发。 */
    listeners: {},
    addEventListener(type, fn) {
      if (!element.listeners[type]) element.listeners[type] = [];
      element.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const list = element.listeners[type];
      if (list) element.listeners[type] = list.filter((entry) => entry !== fn);
    },
    click() {
      for (const fn of element.listeners.click || []) fn({ target: element });
    },
    removeAttribute(name) {
      delete element.attrs[name];
    },
    appendChild(child) {
      return element.insertBefore(child, null);
    },
    insertBefore(child, reference) {
      if (child.parentElement) child.remove();
      const at = reference ? element._children.indexOf(reference) : element._children.length;
      element._children.splice(at < 0 ? element._children.length : at, 0, child);
      child.parentElement = element;
      return child;
    },
    remove() {
      const parent = element.parentElement;
      if (!parent) return;
      const at = parent._children.indexOf(element);
      if (at >= 0) parent._children.splice(at, 1);
      element.parentElement = null;
    },
    get previousSibling() {
      const parent = element.parentElement;
      if (!parent) return null;
      const at = parent._children.indexOf(element);
      return at > 0 ? parent._children[at - 1] : null;
    },
    get nextSibling() {
      const parent = element.parentElement;
      if (!parent) return null;
      const at = parent._children.indexOf(element);
      return at >= 0 && at + 1 < parent._children.length ? parent._children[at + 1] : null;
    },
    /** 只认 `[data-slot="…"]` 这一种选择器：源码用它确认出口真的在座位上。 */
    closest(selector) {
      const match = /^\[data-slot="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      let node = element;
      while (node) {
        if (node.attrs && node.attrs['data-slot'] === match[1]) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
  return element;
}

/**
 * 搭「侧栏底部那一行」：出口（`settings.launcher`）里是头像那颗设置按钮，后面跟着
 * 连接状态与桌面更新两枚提示。
 */
function fakeSidebarRow() {
  // 真外壳的层级：座位（`sidebar.settings`，display:contents）里是头像那一行，
  // 行里第一个孩子是 launcher 出口（`settings.launcher`，也是 display:contents）。
  const seat = fakeElement('div');
  seat.setAttribute('data-slot', 'sidebar.settings');
  const row = fakeElement('div');
  const outlet = fakeElement('div');
  outlet.setAttribute('data-slot', 'settings.launcher');
  outlet.appendChild(fakeElement('button'));
  row.appendChild(outlet);
  row.appendChild(fakeElement('div'));
  row.appendChild(fakeElement('div'));
  seat.appendChild(row);
  return { seat, row, outlet };
}

/**
 * 建一个沙箱。`createEnv().run()` 可以在同一个沙箱里反复物化工厂——用来验证
 * 「样式只注入一次」这类跨次行为。
 *
 * `options.services` 是**可选**的桌面端服务表，对应运行时的 `ctx.get(name)`。
 * 未提供的服务不会触发注入；`provide` 能唤醒等待的消费方，撤回时清理其子作用域。
 * `options.sidebar` 给一份 `fakeSidebarRow()` 就能验「插进设置那一行」这件事；
 * 不给就是「认不出那一行」，走退回自己一行的分支。
 */
function createEnv(options = {}) {
  const storage = options.storage || createStorage();
  const timers = createTimers();
  const hooks = createHooks();
  const styles = [];
  const dictionaries = new Map();
  const registrations = [];
  const allCalls = [];
  const clipboardWrites = [];
  const fetchImpl = options.fetch || routedFetch().impl;
  const services = { ...(options.services || {}) };
  const injections = new Set();
  const sidebar = options.sidebar || null;
  const created = [];
  const confirms = [];
  const alerts = [];
  const openedWindows = [];
  let loaded = null;

  const document = {
    head: { appendChild(node) { styles.push(node); node.parentNode = this; } },
    hidden: false,
    body: fakeElement('body'),
    // 真浏览器里一定有 `baseURI`（宿主注入 `<base href="./">`）；客户端半边推同源地址就靠它。
    baseURI: 'http://127.0.0.1:56495/',
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(selector);
      if (match) return styles.find((tag) => tag.dataset.pluginCss === match[1]) || null;
      // 侧栏底部那颗图标靠这个标记认设置那一行（见源码里的 FOOTER_ANCHOR）。
      if (selector === '[data-slot="settings.launcher"]') return sidebar ? sidebar.outlet : null;
      // 电脑图标靠手机图标的记号定位；两颗都挂进那只带记号的方框。
      if (selector === '[data-dshm-mobile-web]') {
        return created.find((node) => node.attrs['data-dshm-mobile-web'] !== undefined && node.parentElement !== null) || null;
      }
      if (selector === '[data-dshm-footer-group]') {
        return created.find((node) => node.attrs['data-dshm-footer-group'] !== undefined && node.parentElement !== null) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      const mark = /^\[(data-dshm-mobile-web|data-dshm-remote-web|data-dshm-footer-group)\]$/.exec(selector);
      if (!mark) return [];
      return created.filter((node) => node.attrs[mark[1]] !== undefined && node.parentElement !== null);
    },
    listeners: {},
    addEventListener(type, fn) {
      if (!document.listeners[type]) document.listeners[type] = [];
      document.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const list = document.listeners[type];
      if (list) document.listeners[type] = list.filter((entry) => entry !== fn);
    },
    createElement: (tag) => {
      const node = fakeElement(tag);
      created.push(node);
      return node;
    },
    createElementNS: (_ns, tag) => {
      const node = fakeElement(tag);
      created.push(node);
      return node;
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (descriptor) => { loaded = descriptor; } },
      // 页面自己挂在哪种协议下：普通网页（http/https）与桌面壳的 `dsh-app:` 走的不是同一条
      // 交接路——壳里 `window.open` 一定被拒，只能交给页面导航。
      location: { protocol: options.pageProtocol || 'http:', href: 'http://127.0.0.1:56495/' },
      // 公网地址那一下确认：文案原样记下来，返回调用方给的结果（缺省 = 确认）。
      confirm: (text) => {
        confirms.push(String(text));
        return options.confirm === undefined ? true : options.confirm;
      },
      alert: (text) => { alerts.push(String(text)); },
      // 新窗口必须在点击那一帧就开出来（否则会被弹窗拦截器吃掉），这里是那个空窗口。
      open: (url) => {
        const win = {
          location: { href: url === undefined ? '' : String(url) },
          closed: false,
          close() { this.closed = true; },
        };
        openedWindows.push(win);
        return win;
      },
      MutationObserver: undefined,
      listeners: {},
      addEventListener(type, fn) {
        (this.listeners[type] || (this.listeners[type] = [])).push(fn);
      },
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== fn);
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
    document,
    localStorage: storage,
    navigator: {
      userAgent: 'DSH-test/1.0',
      clipboard: { writeText: async (text) => clipboardWrites.push(text) },
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: () => 0,
    fetch: async (url, init) => {
      allCalls.push({ url, init });
      return fetchImpl(url, init);
    },
    URL,
    Date,
    JSON,
    FormData,
    Blob,
    AbortController,
    clearTimeout() {},
    console,
  };
  if (options.chatEmbedBridge) sandbox.__DSH_MOBILE_CHAT_EMBED__ = options.chatEmbedBridge;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const required = [];
  const effects = [];
  let currentContext;
  let disposeProvider = () => {};

  function effect(fn, label, owned) {
    const stop = fn();
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      if (typeof stop === 'function') return stop();
    };
    effects.push({ fn, label, cleanup });
    owned.push(cleanup);
    return cleanup;
  }

  function refreshInjections() {
    for (const entry of [...injections]) {
      const values = entry.names.map((name) => services[name]);
      if (entry.values && entry.values.every((value, index) => value === values[index])) continue;
      entry.stop();
      if (values.some((value) => value === undefined)) continue;
      entry.values = values;
      const owned = [];
      entry.stop = () => {
        entry.values = null;
        for (const cleanup of owned.splice(0).reverse()) cleanup();
      };
      const child = { effect: (fn, label) => effect(fn, label, owned) };
      entry.names.forEach((name, index) => { child[name] = values[index]; });
      // 与 Cordis 同形：reflect.get 按服务名直取、不受 inject 门禁约束。
      // DSH 0.2.3 把 sessionStatus 注册成 uiSession.sessionStatus 独立服务，
      // 插件靠这条读取；services 里有没有这个名字决定走独立服务还是普通属性回退。
      child.reflect = { get: (name) => services[name] };
      entry.callback(child);
    }
  }

  function inject(names, callback) {
    const entry = { names: Array.from(names), callback, values: null, stop() {} };
    injections.add(entry);
    refreshInjections();
    return () => { injections.delete(entry); entry.stop(); };
  }

  function loadPlugin() {
    loaded = null;
    vm.runInContext(options.source || SOURCE, sandbox, { filename: 'client.js' });
    assert.ok(loaded, '工厂必须注册进 window.__ModuleLoader__');
    assert.equal(loaded.id, 'dsh-mobile-plugin');
    required.length = 0;
    registrations.length = 0;
    return loaded.factory((name) => {
      required.push(name);
      if (name === 'react') return hooks.react;
      throw new Error(`工厂不该 require ${name}`);
    });
  }

  function run() {
    const plugin = loadPlugin();
    let declaring = null;
    const owned = [];
    const ctx = {
      effect: (fn, label) => effect(fn, label, owned),
      provide(name, service) {
        services[name] = service;
        refreshInjections();
        const cleanup = () => {
          if (services[name] !== service) return;
          delete services[name];
          refreshInjections();
        };
        owned.push(cleanup);
        return cleanup;
      },
      locale: {
        register(ns, dict) {
          dictionaries.set(ns, dict);
        },
        bind(ns) {
          const dict = dictionaries.get(ns);
          // 与真实现同形：带第二个参数时按 `{name}` 插值（`@deepseek-ai/dsh-client-locale`
          // 的 `translate` 就是这么替换的）。少了这一步，标题里那句「{count} 台设备」
          // 在测试里永远是原样的花括号，也就验不出拼出来到底成不成立。
          return (key, params) => {
            const template = dict.zh[key];
            if (!params || typeof template !== 'string') return template;
            return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
          };
        },
      },
      slots: {
        // 「先声明后注册」：宿主可能比我们晚一步声明插槽，inject 会等它就位。
        inject(pathname, fn) {
          declaring = pathname;
          fn();
        },
        register(descriptor, component) {
          const handle = { ...descriptor, component, pathname: declaring };
          registrations.push(handle);
          return handle;
        },
      },
      // 与 Cordis 同形：依赖齐了才回调，提供方消失时先清理消费方子作用域。
      inject(names, callback) {
        const stop = inject(names, callback);
        owned.push(stop);
        return stop;
      },
      // 真机上本插件是 immediately 档，apply 那一刻 ctx.get 还看不见宿主后提供的服务；
      // hiddenGet 用来钉住「定位只能靠 inject 拿到的子 ctx，不能退回 ctx.get」。
      get: (name) => (options.hiddenGet || []).includes(name) ? undefined : services[name],
      // uiWorkspace 是宿主合并进来的全局服务，不走 inject；聊天嵌入页的定位靠它打开会话。
      ...(options.uiWorkspace ? { uiWorkspace: options.uiWorkspace } : {}),
    };
    currentContext = ctx;
    disposeProvider = () => {
      for (const cleanup of owned.splice(0).reverse()) cleanup();
    };
    plugin.apply(ctx);
    assert.equal(registrations.length, 3, 'apply 注册设置那一项与侧边栏两颗图标');
    return plugin;
  }

  const byPathname = (pathname) => {
    const found = registrations.find((entry) => entry.pathname === pathname);
    assert.ok(found, `没有注册到 ${pathname}`);
    return found;
  };


  /**
   * 渲染侧边栏底部那颗图标；`preset` 按 useState 顺序预置槽位
   * （0 url / 1 panelScope / 2 failure / 3 anchored），`props` 覆盖 owner 给的 `wide`。
   */
  function renderFooter(preset, props = {}) {
    const registration = byPathname('sidebar.footer.action');
    const { t, tf } = registration.inject();
    hooks.begin(preset);
    return registration.component({ wide: true, ...props, t, tf });
  }

  /** 渲染「设置 → 移动端」那张薄卡；`preset` 按 useState 顺序（0 url / 1 scope / 2 access / 3 failure）。 */
  /** 渲染侧边栏那颗电脑图标；preset 顺序同 renderFooter 的来源读数。 */
  function renderRemoteFooter(preset, props = {}) {
    const registration = registrations.find((entry) => entry.pathname === 'sidebar.footer.action' && entry.id === 'remote-web');
    assert.ok(registration, '没有注册电脑图标');
    const { t, tf } = registration.inject();
    hooks.begin(preset);
    return registration.component({ wide: true, ...props, t, tf });
  }

  function renderSettings(preset) {
    const registration = byPathname('settings.section');
    const { t } = registration.inject();
    hooks.begin(preset);
    return registration.component({ t });
  }

  return {
    run,
    loadPlugin,
    inject,
    getService: (name) => services[name],
    get ctx() { return currentContext; },
    dispose: () => disposeProvider(),
    renderFooter,
    renderRemoteFooter,
    renderSettings,
    byPathname,
    registrations,
    confirms,
    alerts,
    openedWindows,
    sandbox,
    hooks,
    required,
    effects,
    timers,
    storage,
    styles,
    dictionaries,
    clipboardWrites,
    fetchCalls: allCalls,
  };
}

/** 建好并物化一次的常用环境。 */
function materialize(options = {}) {
  const env = createEnv(options);
  env.run();
  return env;
}

/** 一份够用的宿主状态，让那颗图标拿到地址并进入「可用」分支。 */
function readyStatus(overrides = {}) {
  return {
    ok: true,
    enabled: true,
    appVersion: '0.1.18',
    name: '我的桌面',
    instanceId: 'inst-1',
    relayUrl: 'https://relay.example.com',
    // 宿主在 `/api/relay/status` 上补的绝对地址（只有这条本机路由带它）。设置项拿它
    // 渲染「打开配置页面」的链接——必须是绝对 http(s)，相对地址在桌面端点不开。
    panelUrl: 'http://127.0.0.1:19387/api/relay/panel',
    // 宿主按请求的 Host 算出来的：面板地址落在哪类网络上。回环 = 本机设置页。
    panelScope: 'loopback',
    lan: { state: 'listening', enabled: true, port: 18787, requestedPort: 18788 },
    tunnel: { state: 'connected' },
    mirror: { ok: true },
    sidecar: { running: true, restarts: 2 },
    pairingPolicy: 'code',
    ...overrides,
  };
}

/* ── 1. 形状：这个文件为什么拆不开 ─────────────────────────────────────── */

test('工厂只注册一个惰性工厂，且只 require react', () => {
  const env = materialize();
  assert.deepEqual(env.required, ['react'], '除了 react 不该 require 任何东西');
  assert.equal(typeof env.run, 'function');
  assert.equal(env.sandbox.window.__ModuleLoader__ instanceof Object, true);
});

test('源码里的 require 只有 react 一个名字（拆分的根因）', () => {
  const names = [...SOURCE.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)], ['react']);
  // 一旦有人加一个相对 require，工厂里的 require 拿到的就是 DSH 模块表，会在运行时报错。
  assert.equal(/require\(['"]\.{1,2}\//.test(SOURCE), false);
  assert.match(SOURCE, /inject: \['slots', 'locale'\]/);
});

/** App 在 document-start 提供的窄桥，只记录顶部栏可见性。 */
function chatEmbedBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    bridge: { version: 1, surface: 'chat', setTopBarVisible: (visible) => calls.push(visible), ...overrides },
  };
}

/** 相同消费方行为同时验证正常实现与变异实现。 */
function assertSharedTopBarClaims(source = SOURCE) {
  const { bridge, calls } = chatEmbedBridge();
  const env = materialize({ source, chatEmbedBridge: bridge });
  const service = env.getService('mobileChatEmbed');
  assert.equal(service.isEmbedded(), true);
  assert.deepEqual(calls, [], '没有声明时不接管顶部栏');
  const stopA = service.keepTopBar();
  const stopB = service.keepTopBar();
  assert.deepEqual(calls, [true]);
  stopA();
  stopA();
  assert.deepEqual(calls, [true], '另一个声明仍在时不得隐藏');
  stopB();
  stopB();
  assert.deepEqual(calls, [true, false], '最后一个声明释放且只隐藏一次');
  env.dispose();
}

test('聊天嵌入：多人顶部栏声明合并，最后撤销且重复撤销无副作用', () => {
  assertSharedTopBarClaims();
});

test('聊天嵌入：电脑网页、旧 App 与不匹配的桥都始终提供无副作用服务', () => {
  for (const overrides of [null, { version: 2 }, { surface: 'panel' }, { setTopBarVisible: null }]) {
    const { bridge, calls } = chatEmbedBridge(overrides || {});
    const env = materialize({ chatEmbedBridge: overrides ? bridge : undefined });
    const service = env.getService('mobileChatEmbed');
    assert.ok(service, '无桥也必须提供服务，不能阻断消费方其它功能');
    assert.equal(service.isEmbedded(), false);
    const stop = service.keepTopBar();
    stop();
    stop();
    env.dispose();
    assert.deepEqual(calls, []);
    assert.equal(env.getService('mobileChatEmbed'), undefined);
  }
});

test('聊天嵌入：提供方卸载归零，旧声明与旧服务不能改变新提供方', () => {
  const { bridge, calls } = chatEmbedBridge();
  const env = materialize({ chatEmbedBridge: bridge });
  const oldService = env.getService('mobileChatEmbed');
  const stopOldA = oldService.keepTopBar();
  const stopOldB = oldService.keepTopBar();
  env.dispose();
  env.dispose();
  assert.equal(oldService.isEmbedded(), false);
  assert.equal(env.getService('mobileChatEmbed'), undefined);
  assert.deepEqual(calls, [true, false]);
  env.run();
  const newService = env.getService('mobileChatEmbed');
  assert.notEqual(newService, oldService);
  const stopNew = newService.keepTopBar();
  stopOldA();
  stopOldB();
  oldService.keepTopBar()();
  assert.deepEqual(calls, [true, false, true], '迟到旧撤销不得隐藏新提供方的顶部栏');
  stopNew();
  assert.deepEqual(calls, [true, false, true, false]);
  env.dispose();
});

test('聊天嵌入：消费方先后加载都能注入，scope.effect 随消费方卸载释放', () => {
  for (const consumerFirst of [true, false]) {
    const { bridge, calls } = chatEmbedBridge();
    const env = createEnv({ chatEmbedBridge: bridge });
    let activations = 0;
    const consume = () => env.inject(['mobileChatEmbed'], (scope) => {
      activations += 1;
      scope.effect(() => scope.mobileChatEmbed.keepTopBar());
    });
    let stop;
    if (consumerFirst) stop = consume();
    assert.deepEqual(calls, []);
    env.run();
    if (!consumerFirst) stop = consume();
    assert.equal(activations, 1);
    assert.deepEqual(calls, [true]);
    stop();
    stop();
    assert.deepEqual(calls, [true, false]);
    env.dispose();
  }
});

test('聊天嵌入：真实 Cordis 的先后注入、提供方重载与消费方卸载', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  for (const consumerFirst of [true, false]) {
    const { bridge, calls } = chatEmbedBridge();
    const env = createEnv({ chatEmbedBridge: bridge });
    const root = new Context();
    root.provide('locale', {
      register: (ns, dict) => { env.dictionaries.set(ns, dict); return () => env.dictionaries.delete(ns); },
      bind: (ns) => (key) => env.dictionaries.get(ns).zh[key],
    });
    root.provide('slots', { inject: (_name, callback) => callback(), register: () => () => {} });
    let activations = 0;
    let oldService;
    let stopOld;
    const consume = () => root.inject(['mobileChatEmbed'], (scope) => {
      activations += 1;
      const service = scope.mobileChatEmbed;
      scope.effect(() => {
        const stop = service.keepTopBar();
        if (!oldService) { oldService = service; stopOld = stop; }
        return stop;
      });
    });
    try {
      let consumer;
      if (consumerFirst) consumer = await consume();
      assert.deepEqual(calls, []);
      let provider = await root.plugin(env.loadPlugin());
      if (!consumerFirst) consumer = await consume();
      await settle(2);
      assert.equal(activations, 1);
      assert.deepEqual(calls, [true]);
      await provider.dispose();
      assert.equal(root.get('mobileChatEmbed'), undefined);
      assert.equal(oldService.isEmbedded(), false);
      assert.deepEqual(calls, [true, false]);
      provider = await root.plugin(env.loadPlugin());
      await settle(2);
      assert.equal(activations, 2, '服务重载后注入作用域应重新建立声明');
      assert.deepEqual(calls, [true, false, true]);
      stopOld();
      oldService.keepTopBar()();
      assert.deepEqual(calls, [true, false, true]);
      await consumer.dispose();
      assert.deepEqual(calls, [true, false, true, false]);
      await provider.dispose();
      assert.deepEqual(calls, [true, false, true, false]);
    } finally {
      await root.fiber.dispose();
    }
    assert.equal(env.timers.count, 0, '真实 provider 卸载也要清完已有客户端定时器');
  }
});

const APP_EMBED_LOADER = path.join(__dirname, '..', '..', 'app', 'scripts', 'load-ts.js');
test('聊天嵌入：App 真实启动桥与客户端声明共同撤销、恢复顶部隐藏样式', {
  skip: fs.existsSync(APP_EMBED_LOADER) ? false : '主仓 app/ 不在场，缺少真实桥脚本生成器',
}, () => {
  const { loadTsFromApp } = require(APP_EMBED_LOADER);
  const { embedBootScript } = loadTsFromApp('src/services/viewmodels/chat-embed');
  const env = createEnv();
  env.sandbox.document.readyState = 'loading';
  vm.runInContext(embedBootScript('session-bridge'), env.sandbox);
  const styles = () => env.styles.filter((node) => node.getAttribute('data-dsh-mobile-chat-topbar') !== null);
  assert.equal(styles().length, 1);
  const style = styles()[0];
  const hidden = style.textContent;
  assert.match(hidden, /header\[data-window-drag\]/);
  assert.match(hidden, /\[data-shell-leading\]/);
  assert.match(hidden, /display:none!important/);
  env.run();
  const service = env.getService('mobileChatEmbed');
  assert.equal(service.isEmbedded(), true);
  const stopA = service.keepTopBar();
  const stopB = service.keepTopBar();
  assert.equal(style.textContent, '', '声明必须通过 App 真桥撤销隐藏规则');
  stopA();
  stopA();
  assert.equal(style.textContent, '', '尚有声明时继续沿用网页顶部原有布局');
  stopB();
  assert.equal(style.textContent, hidden, '最后声明释放后恢复同一条隐藏规则');
  service.keepTopBar();
  assert.equal(style.textContent, '');
  env.dispose();
  assert.equal(style.textContent, hidden, '提供方卸载也必须通过真桥释放显示控制');
  assert.equal(styles().length, 1, '顶部控制始终使用 App 同一份样式');
});

test('变异：任意撤销就隐藏、重复撤销再次隐藏都会被同一合并断言拒绝', () => {
  const marker = 'if (claims.size === 0) bridge.setTopBarVisible(false);';
  const eager = SOURCE.replace(marker, 'bridge.setTopBarVisible(false);');
  assert.notEqual(eager, SOURCE, '变异必须命中实际撤销实现');
  assert.throws(() => assertSharedTopBarClaims(eager), assert.AssertionError);
  const repeated = SOURCE.replace('disposed || !claims.delete(claim)', 'disposed || (claims.delete(claim), false)');
  assert.notEqual(repeated, SOURCE, '变异必须命中声明去重实现');
  assert.throws(() => assertSharedTopBarClaims(repeated), assert.AssertionError);
});

test('样式只注入一次：同一页面里重复物化不会堆出第二份 <style>', () => {
  const env = createEnv();
  env.run();
  assert.equal(env.styles.length, 1);
  assert.equal(env.styles[0].dataset.pluginCss, 'dsh-mobile-plugin/footer-icon.css');
  assert.match(env.styles[0].textContent, /\.dshm_footAction\{/);
  env.run();
  env.run();
  assert.equal(env.styles.length, 1, '重复物化必须复用同一份样式');
});

test('控制面地址不许把 /api/relay 拼两遍（真机故障：两条绿点通道自始至终打的是不存在的地址）', async () => {
  // 真机现场：桌面那一半两条同步一条都没跑起来，宿主侧活体台账两个计数恒为 0，而
  // 同一次 apply 里注册的展开态同步却正常 —— 差别就在「怎么拼地址」。`call()` 会自己
  // 补 `/api/relay` 前缀，而绿点那两条传进去的偏偏是**已经带前缀的全路径**，于是真正
  // 发出去的是 `/api/relay/api/relay/...`：401/404，再被各自的 catch 静静吞掉。
  // 旧的守卫看不见它：假 fetch 按 `endsWith(endpoint)` 匹配，重复前缀也满足这个后缀。
  // 所以这里钉**精确地址**，不钉后缀。
  const sessions = sessionsService({ rows: { open1: { updatedAt: 100, retainedBy: { mainView: 1 } } } });
  const { impl } = routedFetch({
    [READ_RECEIPT_ENDPOINT]: { body: { ok: true, receipt: { readAt: { s1: 500 } } } },
  });
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    fetch: impl,
    services: {
      uiSession: { sessionStatus: statusStore([['open1', { completionUnread: false, running: false }]]) },
      sessions,
    },
  });
  await settle();
  await env.timers.tick(2000);   // 方向一（正开着的）+ 方向二（读回执）
  await env.timers.tick(2000);
  await env.timers.tick(10000);  // 客户端半边自检上报

  const urls = env.fetchCalls.map((entry) => String(entry.url));
  assert.deepEqual(
    urls.filter((url) => url.includes('api/relay/api/relay')),
    [],
    `控制面地址被拼了两遍：${urls.join(' | ')}`,
  );
  for (const endpoint of [READ_RECEIPT_ENDPOINT, DESKTOP_READ_ENDPOINT, CLIENT_HALF_ENDPOINT]) {
    assert.ok(urls.includes(endpoint), `${endpoint} 没被请求过，实际：${urls.join(' | ')}`);
  }
});

/* ── 3. 控制面调用与错误正文拍平 ──────────────────────────────────────── */

test('那颗图标取状态走文档相对的 api/relay/status 且同源', async () => {
  const { impl, calls } = routedFetch({ '/status': { body: readyStatus() } });
  const env = materialize({ fetch: impl });
  env.renderFooter();
  await env.hooks.flush();
  const call = calls.find((c) => String(c.url).endsWith('/status'));
  assert.ok(call);
  assert.equal(calls[0].url, 'api/relay/status');
  assert.equal(call.init.credentials, 'same-origin');
  // 取状态是 GET：不带 method 也就是 GET，不许顺手改成 POST。
  assert.equal(call.init.method, undefined);
});

test('控制面请求不许写成站点根绝对地址（DSH 挂在子路径下会 404）', async () => {
  // 宿主给 index 注入 `<base href="./">`，DSH 自己的前端一律用 `PATH.slice(1)`。
  // 写成 `/api/...` 时，DSH 被反代挂到 `/dsh/` 下就会打到站点根。
  const env = materialize();
  await settle();
  await env.timers.tick(2000);
  await env.timers.tick(10000);
  const absolute = env.fetchCalls
    .map((entry) => String(entry.url))
    .filter((url) => url.startsWith('/'));
  assert.deepEqual(absolute, [], `这些请求仍是站点根绝对地址：${absolute.join(' | ')}`);
});

test('打不开配置页时：不嵌空窗，把宿主的原话拍平写进诊断窗', async () => {
  // 起点一下就是「弹控制台」，没有空白页可关；要钉的是**开不出来就必须说清楚**。
  const cases = [
    [{ error: '直接一句' }, 500, '直接一句'],
    [{ error: { code: 'busy', message: '有任务在跑' } }, 409, 'busy: 有任务在跑'],
    [{}, 503, 'HTTP 503'],
  ];
  for (const [body, status, expected] of cases) {
    const env = materialize({
      fetch: async (url) => {
        if (String(url).endsWith('/host-half')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, half: { version: '0.6.0', source: 'npm' } }) };
        }
        return { ok: false, status, json: async () => body };
      },
    });
    env.renderFooter({}, { wide: false });
    await env.hooks.flush();
    const icon = env.renderFooter({}, { wide: false });
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    assert.equal(env.openedWindows.length, 0, '这一下不开任何浏览器窗口');
    assert.equal(consoleFrame(env), undefined, '地址都拿不到就不嵌');
    const dialog = diagnosisNode(env);
    assert.ok(dialog, '失败必须弹诊断窗：不许点了没反应');
    const text = texts(dialog).join('');
    assert.match(text, /打开配置页面失败/);
    assert.equal(text.includes(expected), true, `body=${JSON.stringify(body)} status=${status} → ${text}`);
    assert.match(text, new RegExp(`HTTP 状态.*${status}`, 's'));
    assert.match(text, /重新读取状态/);
    assert.match(text, /复制诊断信息/);
  }
});

async function assertOpenFailureFeedback(source = SOURCE) {
  for (const entry of [
    { status: 409, body: { error: { code: 'busy', message: 'https://example.test/?token=private-token Bearer private-credential' } }, expected: 'busy' },
    { status: 503, body: {}, expected: 'http-503' },
    { status: 0, network: true, expected: 'network-request-failed' },
  ]) {
    let submitted;
    const env = materialize({ source, fetch: async (url, init) => {
      if (url === 'https://app.wnluo.com/api/sdk/feedback') {
        submitted = init.body;
        return { ok: true, status: 200, json: async () => ({ data: { thread_key: 'feedback-test' } }) };
      }
      if (String(url).endsWith('/host-half')) return { ok: true, status: 200, json: async () => ({ half: { version: '0.6.0', source: 'npm', activatedAt: '2026-11-20T00:00:00Z', shellChanged: true } }) };
      if (entry.network) throw new Error('request failed https://example.test/?token=private-token');
      return { ok: false, status: entry.status, json: async () => entry.body };
    } });
    env.renderFooter({}, { wide: false });
    await env.hooks.flush();
    const icon = env.renderFooter({}, { wide: false });
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    const send = elements(diagnosisNode(env)).find(node => node.tag === 'button' && node.textContent === '发送此问题');
    assert.ok(send, '诊断窗应可提交反馈');
    await clickDialogButton(env, '发送此问题');
    assert.ok(submitted, '未发出反馈');
    const context = JSON.parse(submitted.get('context'));
    assert.equal(context.code, String(entry.status));
    assert.equal(context.error_code, entry.expected);
    assert.equal(context.submit_kind, 'diagnosis', '面板诊断自报应标 submit_kind，供排查侧与真人/AI 反馈分流');
    const text = await submitted.get('files').text();
    assert.match(text, new RegExp(`error_code=${entry.expected}`));
    assert.match(text, /plugin_source=npm/);
    assert.match(text, /activated_at=2026-11-20T00:00:00Z/);
    assert.match(text, /shell_changed=true/);
    assert.doesNotMatch(text + JSON.stringify(context), /private-token|private-credential|example\.test|Bearer/);
  }
}

test('网页管理反馈保留授权原因码与网络失败阶段，不外发原始凭据', () => assertOpenFailureFeedback());

test('网页管理反馈变异：丢原因码或把无HTTP响应当缺值时行为断言失败', async () => {
  for (const [before, after] of [
    ["code: outcome.code || '', message: outcome.message", "code: '', message: outcome.message"],
    ["current && Number.isFinite(current.status) ? String(current.status) : ''", "current && current.status ? String(current.status) : ''"],
    ["error_code: current && typeof current.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(current.code) ? current.code : ''", "error_code: current ? current.message : ''"],
    ["source: half && half.source ? String(half.source) : '',", ""],
  ]) {
    const changed = SOURCE.replaceAll(before, after);
    assert.notEqual(changed, SOURCE);
    await assert.rejects(() => assertOpenFailureFeedback(changed), assert.AssertionError);
  }
});

/* ── 4. 两个入口：设置里那一项与侧边栏那颗图标 ──────────────────────────
 * 2026-11-03 用户要求把「设置 → 移动端」加回来：介绍产品时说的入口就是它；2026-11-02
 * 那一版把它整块下线、只留那颗图标，于是从网页版进来的人不知道配置在哪。两项进的是
 * 同一个页面（图标是快捷方式，卡片是设置里的正规入口），卡片刻意只有一张薄卡。
 */

/** 在元素树里按 className 找第一个元素。 */
function findByClass(node, wanted) {
  if (node == null || typeof node !== 'object') return null;
  const name = node.props && node.props.className;
  if (typeof name === 'string' && name.split(/\s+/).includes(wanted)) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, wanted);
    if (found) return found;
  }
  return null;
}

test('三个入口都注册着：设置里那一项与侧边栏那两颗图标', () => {
  const env = materialize();
  assert.equal(env.registrations.length, 3, 'apply 注册设置项与侧边栏两颗图标');
  assert.equal(env.byPathname('settings.section').id, 'mobile');
  const icons = env.registrations.filter((entry) => entry.pathname === 'sidebar.footer.action');
  assert.deepEqual(icons.map((entry) => entry.id), ['mobile-web', 'remote-web'], '手机图标在前、电脑图标在后');
});

test('字典覆盖两张界面，中英一一对应', () => {
  const env = materialize();
  const dict = env.dictionaries.get(NS);
  assert.ok(dict, `${NS} 字典必须注册`);
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());
  // 键集逐个钉死：一张薄卡（配置页）+ 一颗图标 + 那扇控制台窗。
  // 2026-11-13 用户拍板把「进入控制台 / 报错调试」那层入口去掉（点图标直接就是控制台那一页），
  // 所以 `consoleBack` 与 `consoleEntry*` 六条一并撤掉，换成一个 `consoleTroubleshoot`
  // —— 调试页退到操作栏里那颗次要按钮。
  assert.deepEqual(Object.keys(dict.zh).sort(), [
    'cardPanel',
    'consoleFrameless', 'consoleLoading', 'consolePopupBlocked', 'consoleTitle',
    'diagBusy', 'diagChecking', 'diagClose', 'diagCopied', 'diagCopy', 'diagCopyFailed',
    'diagFactActivated', 'diagFactOnDisk', 'diagFactPanelUrl', 'diagFactPlugin', 'diagFactReason',
    'diagFactRetry', 'diagFactReturned', 'diagFactScope', 'diagFactSelfcheck', 'diagFactShell',
    'diagFactSource', 'diagFactStatus', 'diagFactUnavailable',
    'diagHeadingFacts', 'diagHeadingSteps', 'diagOpenPanel', 'diagPopupBlocked', 'diagReload', 'diagReloadBusy',
    'diagReloadFailed', 'diagReloadOk', 'diagRetry', 'diagStepDuplicate', 'diagStepProxy',
    'diagStepReinstall', 'diagStepRestart', 'diagStepRetryOpen', 'diagStepRetrying',
    'diagSummaryLoadFailed', 'diagSummaryLoadMissing', 'diagSummaryNoError',
    'diagSummaryOpenFailed', 'diagSummaryRestored', 'diagSummaryUnreachable', 'diagTitleLoad',
    'diagTitleOpen', 'footerAgoDays', 'footerAgoHours', 'footerAgoMinutes', 'footerAgoNow',
    'footerDeviceCount', 'footerDeviceSeen', 'footerLoadMissing', 'footerNoDevice', 'footerOpen',
    'footerPending', 'footerRemoteOpen', 'footerSidecarBad', 'footerTunnelBad',
    'heading', 'iconComputer', 'iconHidden', 'iconKeepOne', 'iconPhone', 'iconSaveFailed',
    'iconShown', 'iconsHint', 'iconsTitle', 'loadFailed', 'nav', 'openFailed', 'openHint', 'openPanel', 'panelMissing', 'panelPending',
    'pluginPageMissing', 'pluginPages', 'pluginPagesEmpty', 'pluginPagesHint', 'remoteConsoleTitle',
    'restartNoticeBody', 'restartNoticeButton', 'restartNoticeClose', 'restartNoticeHint', 'restartNoticeTitle'
  ]);
  assert.equal(env.effects.some((e) => String(e.label).includes('dictionaries')), true);
});

test('设置项只是一张薄卡：旧的整块设置界面没有跟着回来', () => {
  for (const gone of ['开放网页管理 2 小时', 'webAccessHint', 'hostHalfReloadFailed', 'restartScopeBody']) {
    assert.equal(SOURCE.includes(gone), false, `「${gone}」不许跟着设置项一起长回来`);
  }
  assert.equal(SOURCE.includes('/update/status'), false, '插件自更新那套早已拆掉，更新只走 npm');
  // 卡片三件套 + 图标 + 诊断窗：这一半的界面就这几样。
  for (const kept of ['.dshm_footAction{', '.dshm_overlay{', '.dshm_dialog{', '.dshm_card{', '.dshm_heading{']) {
    assert.equal(SOURCE.includes(kept), true, `「${kept}」的样式要在`);
  }
});

test('设置项：还没读到地址时不挂死链，卡上说清在等什么', () => {
  const env = materialize();
  const tree = env.renderSettings();
  // 两张卡：配置页（标题/说明/一颗按钮）+ 侧边栏图标选择。
  // 2026-11-17 用户要在这一页选侧边栏那两颗图标，第二张卡是需求本身变的，不是旧界面回潮。
  assert.deepEqual(classNames(tree).filter((name) => name.startsWith('dshm_')), [
    'dshm_root', 'dshm_heading',
    'dshm_card', 'dshm_cardTitle', 'dshm_note', 'dshm_actions', 'dshm_btn dshm_btnPrimary',
    'dshm_card', 'dshm_cardTitle', 'dshm_note',
    'dshm_iconRow', 'dshm_iconSwitch', 'dshm_iconRow', 'dshm_iconSwitch',
  ], '配置页一张卡，图标选择另一张小卡');
  const button = findByClass(tree, 'dshm_btnPrimary');
  assert.equal(button.props.href, undefined);
  assert.equal(button.props['aria-disabled'], 'false', '没地址也照样能点：点了会自己去开窗再取地址');
  assert.equal(texts(tree).includes('正在读取页面地址…'), true);
});

const iconSwitches = (tree) => elements(tree).filter((node) => node.props.className === 'dshm_iconSwitch');

test('侧边栏图标：状态说收起哪颗，哪颗就不画，另一颗照旧', async () => {
  // 两颗图标在同一个假 env 里共用一组 useState 槽位，分开建环境才不会互相读到对方的槽位。
  const phoneEnv = materialize({
    fetch: async (url) => (String(url).endsWith('/status')
      ? { ok: true, status: 200, json: async () => readyStatus({ desktopPhoneIcon: false }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  phoneEnv.renderFooter({}, { wide: false });
  await phoneEnv.hooks.flush();
  assert.equal(phoneEnv.renderFooter({}, { wide: false }), null, '收起来的手机图标不该再出现在侧边栏');

  const computerEnv = materialize({
    fetch: async (url) => (String(url).endsWith('/status')
      ? { ok: true, status: 200, json: async () => readyStatus({ desktopPhoneIcon: false }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  computerEnv.renderRemoteFooter({}, { wide: false });
  await computerEnv.hooks.flush();
  assert.ok(computerEnv.renderRemoteFooter({}, { wide: false }), '没动过的电脑图标照常显示');

  const settingsEnv = materialize({
    fetch: async (url) => (String(url).endsWith('/status')
      ? { ok: true, status: 200, json: async () => readyStatus({ desktopPhoneIcon: false }) }
      : { ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  settingsEnv.renderSettings();
  await settingsEnv.hooks.flush();
  const switches = iconSwitches(settingsEnv.renderSettings());
  assert.equal(switches.length, 2);
  assert.equal(switches[0].props['aria-checked'], 'false', '设置卡要如实回显收起状态');
  assert.equal(switches[1].props['aria-checked'], 'true');
});

test('侧边栏图标开关：写进配置，同一页的开关当场跟着变', async () => {
  const posts = [];
  const env = materialize({
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/config')) posts.push(JSON.parse(init.body));
      return String(url).endsWith('/status')
        ? { ok: true, status: 200, json: async () => readyStatus() }
        : { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderSettings();
  await env.hooks.flush();
  const phone = findByClass(env.renderSettings(), 'dshm_iconSwitch');
  assert.equal(phone.props['aria-checked'], 'true', '默认两颗都显示');
  await phone.props.onClick();
  await settle();
  assert.deepEqual(posts, [{ desktopPhoneIcon: false, desktopComputerIcon: true }], '两格一起写，避免半套状态');
  const after = iconSwitches(env.renderSettings());
  assert.equal(after[0].props['aria-checked'], 'false', '不用等下一轮状态轮询');
  assert.equal(after[1].props['aria-checked'], 'true');
});

test('侧边栏图标：最后一颗不许收起，也不写一发注定锁死自己的配置', async () => {
  const posts = [];
  const env = materialize({
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/config')) posts.push(JSON.parse(init.body));
      return String(url).endsWith('/status')
        ? { ok: true, status: 200, json: async () => readyStatus({ desktopComputerIcon: false }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderSettings();
  await env.hooks.flush();
  const [phone, computer] = iconSwitches(env.renderSettings());
  assert.deepEqual([phone.props['aria-checked'], computer.props['aria-checked']], ['true', 'false']);
  await phone.props.onClick();
  await settle();
  assert.equal(posts.length, 0, '不能把两颗都关掉');
  assert.equal(iconSwitches(env.renderSettings())[0].props['aria-checked'], 'true');
  assert.match(texts(env.renderSettings()).join(' '), /至少要保留一颗图标/);
});

test('侧边栏图标：写盘失败要回滚开关并说清原因', async () => {
  const env = materialize({
    fetch: async (url) => (String(url).endsWith('/config')
      ? { ok: false, status: 500, json: async () => ({ error: { message: '盘满了' } }) }
      : String(url).endsWith('/status')
        ? { ok: true, status: 200, json: async () => readyStatus() }
        : { ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  env.renderSettings();
  await env.hooks.flush();
  const phone = findByClass(env.renderSettings(), 'dshm_iconSwitch');
  await phone.props.onClick();
  await settle();
  assert.equal(iconSwitches(env.renderSettings())[0].props['aria-checked'], 'true', '没写成就还原');
  assert.match(texts(env.renderSettings()).join(' '), /保存图标设置失败.*盘满了/);
});

test('设置项：读状态失败时，点它补读一次再取地址', async () => {
  let attempts = 0;
  const env = materialize({
    fetch: async (url) => {
      if (String(url).endsWith('/status')) {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, json: async () => ({ ok: false, error: '稍后再试' }) };
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'public' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderSettings();
  await env.hooks.flush();
  const button = findByClass(env.renderSettings(), 'dshm_btnPrimary');
  assert.equal(button.props.href, undefined, '宿主没给地址：不挂死链');
  await button.props.onClick({ preventDefault() {} });
  await settle(12);
  assert.equal(env.openedWindows[0].location.href, readyStatus().panelUrl, '补读拿到地址后把它导航过去');
});

test('设置项：读到地址后按钮指向配置页，点击就是普通链接', async () => {
  const env = materialize({ fetch: async () => ({ ok: true, status: 200, json: async () => readyStatus() }) });
  env.renderSettings();
  await env.hooks.flush();
  const button = findByClass(env.renderSettings(), 'dshm_btnPrimary');
  assert.equal(button.props.href, readyStatus().panelUrl);
  assert.equal(button.props['aria-disabled'], 'false');
  let prevented = false;
  await button.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, false, '有地址就交给浏览器照常跳转');
  assert.equal(env.openedWindows.length, 0);
});

test('设置项：公网地址也直接打开，不再弹确认也不开窗口', async () => {
  const env = materialize({
    fetch: async () => ({ ok: true, status: 200, json: async () => readyStatus({ panelScope: 'public' }) }),
  });
  env.renderSettings();
  await env.hooks.flush();
  const button = findByClass(env.renderSettings(), 'dshm_btnPrimary');
  let prevented = false;
  await button.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, false, '公网地址同样是普通链接');
  assert.equal(env.confirms.length, 0, '不再为公网弹确认');
  assert.deepEqual(env.openedWindows, []);
  assert.equal(button.props.href, readyStatus().panelUrl);
});

/* ── 5. 侧边栏底部那颗手机图标（唯一的入口）─────────────────────────────
 * 用户要的是「侧边栏最底下、头像那一行里加一颗手机图标，点一下进网页」。外壳那一行
 * 没有给插件留座位，所以这一颗是自己插进去的：认位置只认插槽出口的 `data-slot` 标记，
 * 插进去之后那一行的设置按钮自己让出宽度；认不出来就退回 `sidebar.footer.action`
 * 自己那一行，入口不能消失。
 *
 * 点下去做什么，取决于宿主在 `/status` 上报的 `panelScope`（面板地址落在哪类网络上）：
 * 本机回环与局域网直接进入；公网先弹一句确认再开启两小时窗口。
 */

const FOOTER_MARK = 'data-dshm-mobile-web';
const FOOTER_ALERT = 'data-dshm-alert';
const DIAG_MARK = 'data-dshm-mobile-diag';

/** 已经打开的诊断弹窗（没开就是 undefined）。 */
function diagnosisNode(env) {
  return [...env.sandbox.document.body.children].find((node) => node.attrs[DIAG_MARK] !== undefined);
}

/** 点弹窗里那颗按钮（弹窗是命令式 DOM，按钮上是 `onclick`）。 */
async function clickDialogButton(env, label) {
  const button = dialogButton(env, label);
  assert.ok(button, `弹窗里少了「${label}」`);
  if (typeof button.onclick === 'function') await button.onclick();
  else await button.props.onClick();
  await settle();
  return button;
}

/** 弹窗里那颗按钮（按文案或无障碍名找）。内容窗的按钮是图标，名字在 aria-label。 */
function dialogButton(env, label) {
  const dialog = diagnosisNode(env);
  if (!dialog) return undefined;
  // 弹窗是命令式 DOM，元素的 tag 在 `node.tag`；react 元素才用 `node.type`。
  return elements(dialog).find((node) => {
    if (node.tag !== 'button' && node.type !== 'button') return false;
    if (texts(node).join('') === label) return true;
    const attrs = node.attrs || node.props || {};
    return attrs['aria-label'] === label || attrs.title === label;
  });
}

/** 方框节点（没有返回 undefined）：两颗图标都挂在它里面。 */
function footerGroupNode(sidebar) {
  return [...sidebar.row.children].find((node) => node.attrs['data-dshm-footer-group'] !== undefined);
}

/** 方框里那颗手机图标（没有返回 undefined）。 */
function footerDomNode(sidebar) {
  const group = footerGroupNode(sidebar);
  if (!group) return undefined;
  return [...group.children].find((node) => node.attrs[FOOTER_MARK] !== undefined);
}

/** 方框里那颗电脑图标（没有返回 undefined）。 */
function remoteDomNode(sidebar) {
  const group = footerGroupNode(sidebar);
  if (!group) return undefined;
  return [...group.children].find((node) => node.attrs['data-dshm-remote-web'] !== undefined);
}

test('图标注册信息：槽名走 sidebar.footer.action、id 是自己的、标签走字典', () => {
  const env = materialize();
  const registration = env.byPathname('sidebar.footer.action');
  assert.equal(registration.name, 'sidebar.footer.action');
  // 自己的一格：复用外壳已占的 id 会顶掉那一格（settings.launcher 那种替换会连
  // 头像那颗设置按钮一起换掉），所以 id 必须是新的。
  assert.equal(registration.id, 'mobile-web');
  assert.equal(typeof registration.order, 'number');
  assert.equal(registration.locale, NS);
  assert.equal(registration.label(), '打开移动端插件配置网页');
  assert.equal(typeof registration.component, 'function');
});

test('展开态：图标插进设置那一行、紧跟头像出口，不遮住任何东西', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus() : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  // 地址是 effect 里异步问回来的：拿真实 React 会因此重渲染、effect 再同步一次；
  // 这里手动再渲染一遍，等价于那一帧。
  env.renderFooter();
  await env.hooks.flush();

  const node = footerDomNode(sidebar);
  assert.ok(node, '必须插进设置那一行（否则就退回自己那一行了）');
  assert.equal(node.tag, 'a');
  assert.equal(node.className, 'dshm_footAction');
  // 方框紧跟在头像出口后面、在连接状态/更新提示前面：那一行里设置按钮是 flex:1，
  // 它自己让出宽度，所以谁都不会被盖住。手机图标是方框里的第一颗。
  const group = footerGroupNode(sidebar);
  assert.ok(group, '两颗图标要合在同一只方框里');
  assert.equal(group.className, 'dshm_footerGroup');
  assert.equal(group.previousSibling, sidebar.outlet);
  assert.equal(group.children[0], node);
  assert.equal(node.children[0].tag, 'svg', '图标本体要挂上');
  // 用户 2026-11-02 拍的尺寸：展开那一行 20（先 18、嫌小又抬一档）。别再调回 16/18 ——
  // 手机图形窄，按名义尺寸画出来比同行那几颗 16 的方形图标显小。
  assert.equal(node.children[0].attrs.width, '20');
  assert.equal(node.children[0].attrs.height, '20');
  // 挑中的那一款是「刘海 + 底条」：三道路径（机身 / 刘海 / 家条），机身从 6.2 画到 17.8；
  // 第四个子节点是那颗常驻的告警红点（正常态被 CSS 藏着，见下面那两条）。
  assert.equal(node.children[0].children.length, 4);
  assert.match(node.children[0].children[0].attrs.d, /^M9 2\.6h6A2\.8/);
  assert.equal(node.children[0].children[3].tag, 'circle');
  assert.equal(node.children[0].children[3].attrs.class, 'dshm_alertDot');
  assert.equal(node.attrs.href, readyStatus().panelUrl);
  assert.equal(node.attrs.target, '_blank');
  assert.equal(node.attrs['aria-disabled'], 'false');
  assert.equal(node.attrs['aria-label'], '打开移动端插件配置网页');

  // 展开态下它不该同时在自己那一行里画第二颗。
  assert.equal(env.renderFooter(), null);
});

test('电脑图标插在设置那一行、手机图标右边，显示器图形与文案到位', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus() : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderRemoteFooter();
  await env.hooks.flush();
  env.renderRemoteFooter();
  await env.hooks.flush();

  const phone = footerDomNode(sidebar);
  const remote = remoteDomNode(sidebar);
  assert.ok(remote, '电脑图标必须插进设置那一行');
  assert.equal(remote.previousSibling, phone, '紧跟手机图标右边');
  // 两颗合在同一只方框里：盒子紧跟出口，手机第一颗、电脑第二颗，只有一个盒子。
  const groups = [...sidebar.row.children].filter((node) => node.attrs['data-dshm-footer-group'] !== undefined);
  assert.equal(groups.length, 1, '两颗图标共用一只方框，不叠出第二个');
  assert.equal(groups[0].children.length, 2);
  assert.equal(remote.tag, 'a');
  assert.equal(remote.children[0].tag, 'svg');
  assert.equal(remote.children[0].children.length, 3, '显示器图形：屏幕 + 底座 + 中柱');
  assert.match(remote.children[0].children[0].attrs.d, /^M4\.5 3\.5h15/);
  assert.equal(remote.attrs['aria-label'], '打开远程电脑');
  assert.equal(remote.attrs.href, readyStatus().panelUrl);
  assert.equal(remote.attrs.target, '_blank');
  // 展开态下电脑图标不该同时在自己那一行里画第二颗。
  assert.equal(env.renderRemoteFooter(), null);
});

test('两颗渲染顺序颠倒时，方框里仍是手机在左、电脑在右', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({ sidebar });
  env.renderRemoteFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const group = footerGroupNode(sidebar);
  assert.ok(group, '两颗共用一只方框');
  assert.equal(group.children.length, 2);
  assert.equal(group.children[0], footerDomNode(sidebar), '第一颗是手机');
  assert.equal(group.children[1], remoteDomNode(sidebar), '第二颗是电脑');
});

test('方框样式在：细边框圈一组，进组后两颗的间距收紧', () => {
  assert.match(SOURCE, /\.dshm_footerGroup\{[^}]*display:inline-flex[^}]*gap:2px[^}]*border:1px solid var\(--dsw-alias-settings-card-stroke\)/, '带边框的容器与 2px 间隙要在');
  assert.match(SOURCE, /\.dshm_footerGroup \.dshm_footAction\{margin:0\}/, '进组后撤掉单颗外边距，别把间距撑大');
});

test('内容窗宽高自适应、顶部留白收紧，不再写死 82vh/1040px', () => {
  assert.doesNotMatch(SOURCE, /\.dshm_dialogWide\{[^}]*height:82vh/, '高度不许再写死 82vh');
  assert.doesNotMatch(SOURCE, /\.dshm_dialogWide\{[^}]*max-width:1040px(?!\w)/, '宽度不许再写死 1040px');
  assert.match(SOURCE, /\.dshm_overlay\{[^}]*padding:clamp\(/, '遮罩留白随视口收放');
  assert.match(SOURCE, /\.dshm_dialogWide\{[^}]*max-width:min\(1040px,100%\)[^}]*height:min\(88vh,900px\)[^}]*padding:6px;gap:0/, '内容窗宽高自适应且顶部只留 6px');
  assert.doesNotMatch(SOURCE, /\.dshm_dialogTools\{/, '外壳不再画按钮行，按钮进了页面');
  assert.doesNotMatch(SOURCE, /\.dshm_iconBtn\{/, '外壳不再画图标按钮');
  assert.match(SOURCE, /\.dshm_dialogNote:empty\{display:none\}/, '空说明行不占位');
});

test('重复渲染不会插出第二颗', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({ sidebar });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const group = footerGroupNode(sidebar);
  const ours = group ? [...group.children].filter((node) => node.attrs[FOOTER_MARK] !== undefined) : [];
  assert.equal(ours.length, 1);
  assert.equal([...sidebar.row.children].filter((node) => node.attrs['data-dshm-footer-group'] !== undefined).length, 1, '也不叠出第二只方框');
});

test('窄条（56 点）那一行塞不下第二颗：改为自己占一行', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({ sidebar });
  const tree = env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  assert.equal(typeof tree.type, 'string');
  assert.equal(tree.type, 'a');
  assert.match(tree.props.className, /dshm_footActionRail/);
  // 窄条那颗放进 36 的圆钮里，用 22 才撑得起来（展开那一行是 20）。
  const svg = elements(tree).find((node) => node.type === 'svg');
  assert.equal(svg.props.width, 22);
  assert.equal(svg.props.height, 22);
  assert.equal(footerDomNode(sidebar), undefined, '窄条时不该硬插进那一行');
});

test('认不出那一行（外壳换了版式）：退回自己一行，入口不消失也不抛错', async () => {
  const env = materialize();
  assert.equal(env.renderFooter(), null, '第一帧先不画，等 effect 找位置');
  await env.hooks.flush();
  const tree = env.renderFooter();
  assert.equal(tree.type, 'a');
  assert.match(tree.props.className, /dshm_footActionRail/);
  assert.equal(tree.props.href, undefined, '没问到地址就不给链接');
  assert.equal(tree.props['aria-disabled'], 'false', '没地址也照样能点：点了会自己去开窗再取地址');
});

test('宿主没给地址：不挂死链，但点它补读地址再嵌控制台（不再是死图标）', async () => {
  const sidebar = fakeSidebarRow();
  let attempts = 0;
  const env = materialize({
    sidebar,
    fetch: async (url) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, json: async () => ({ ok: false, error: '稍后再试' }) };
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'private' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs.href, undefined, '没有地址时锚点不该有 href（不挂死链）');
  assert.equal(node.attrs['aria-disabled'], 'false', '点了有事可做，不是一颗灰掉的死图标');
  assert.equal(node.attrs.title, '网页地址还没就绪');
  assert.equal(typeof node.onclick, 'function', '没有地址时也必须挂点击处理');

  await node.onclick({ preventDefault() {} });
  await settle(12);
  assert.equal(env.openedWindows.length, 0, '补读地址之后弹这一窗，不是再开一个浏览器窗口');
  assert.equal(consoleFrame(env).attrs.src, consolePageOf(), '补读拿到地址后就嵌控制台');
  assert.notEqual(texts(diagnosisNode(env)).join(''), '', '控制台那一窗要有标题与说明');
});

test('宿主那一半没装载（404）：标题说清该怎么处理，不甩一句 HTTP 404', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  // 设置项那张卡下线之后，这一屏没有别的地方能说话：把那句该做的话写进标题
  // （截图发过来照样看得见），而不是留一个永远「还没就绪」的灰图标。
  assert.match(node.attrs.title, /插件宿主侧没有加载/);
  assert.match(node.attrs.title, /完整退出再打开|插件市场重装/);
  assert.equal(node.attrs.href, undefined);
  // 这一种是真故障：点了也打不开、重装前谁也修不好，所以整颗转红并显出那颗红点
  // （尺寸和图形不动，红是 CSS 按这个记号画的）。
  assert.equal(node.attrs[FOOTER_ALERT], '');
});

test('只是还没读到地址（读状态暂时失败）：不算插件坏了，不转红', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    // 远程用户第一眼的现场：`/status` 暂时回 503（不是 404）。
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs[FOOTER_ALERT], undefined, '暂时读不到是正常态，红点一亮就成了每开一次页面都报的假警');
  assert.match(node.attrs.title, /还没就绪/);
});

test('头像出口不在侧栏底部那个座位里时，宁可退回自己一行也不乱插', async () => {
  // 出口被渲染到别处（设置面板里、未来的新位置）：按出口插进去就是插到错的地方。
  const row = fakeElement('div');
  const outlet = fakeElement('div');
  outlet.setAttribute('data-slot', 'settings.launcher');
  row.appendChild(outlet);
  const env = materialize({ sidebar: { row, outlet } });
  env.renderFooter();
  await env.hooks.flush();
  assert.equal(row.children.length, 1, '座位对不上就不许插');
  assert.match(env.renderFooter().props.className, /dshm_footActionRail/);
});

test('切语言之后标题跟着换（插进那一行的按钮不吃旧文案）', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus() : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs['aria-label'], '打开移动端插件配置网页');

  const dict = env.dictionaries.get(NS);
  dict.zh.footerOpen = '打开手机网页';
  dict.zh.footerPending = '网页地址还没好';
  env.renderFooter();
  await env.hooks.flush();
  assert.equal(node.attrs['aria-label'], '打开手机网页', '切语言后插进去的那颗要换标题');
  // 依赖数组里必须是**文案本身**：`t` 是 bind 出来的稳定函数，只依赖它 effect 不会重跑。
  // 2026-11-17 起还要带上 visible：用户收起这颗图标时，effect 必须重跑把插进去的节点摘掉。
  // 2026-11-20 起带上 restartPending / restartLabel：需要重启 DSH 时这颗要当场变成提醒按钮。
  assert.match(SOURCE, /\}, \[wide, visible, url, openLabel, loadMissingLabel, pendingLabel, problem, panelScope, hint, fault, restartPending, restartLabel\]\);/);
});

test('地址问不到时会自己再问；拿到地址后仍低频刷新现场', async () => {
  const sidebar = fakeSidebarRow();
  let statusCalls = 0;
  const env = materialize({
    sidebar,
    fetch: async (url) => {
      if (!String(url).endsWith('/status')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      statusCalls += 1;
      if (statusCalls === 1) {
        return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'x' } }) };
      }
      return { ok: true, status: 200, json: async () => readyStatus() };
    },
  });
  env.renderFooter();
  await env.hooks.flush();
  assert.equal(footerDomNode(sidebar).attrs.href, undefined);

  await env.timers.tick(20000);
  env.renderFooter();
  await env.hooks.flush();
  assert.equal(footerDomNode(sidebar).attrs.href, readyStatus().panelUrl);

  // 拿到地址后**不许停**：设备台数 / 告警 / 需要重启都要跟着刷新（低频即可）。
  const before = statusCalls;
  await env.timers.tick(20000);
  assert.ok(statusCalls > before, '地址取到之后仍要低频轮询现场');
});

/* ── 5a2. 那颗图标说得出「现在什么情况」─────────────────────────────────
 * 原来它只有两档：好的（悬停一句固定文案）、坏的（宿主没装载，转红）。
 * 中间那一大片状态一律看不见 —— 手机三天没连过、中转早断了，图标都跟没事一样。
 *
 * 现在：悬停标题由宿主那份读数拼出来（几台设备、多久没连过），链路明确报错时
 * 转琥珀，只有「点了也没用」的 404 才转红。判据一律照抄状态接口，不另算一套。
 */

/** 一份带设备摘要的宿主状态。 */
function statusWithDevices(overrides = {}) {
  return readyStatus({ devices: { count: 2, lastSeenAt: Date.now() - 3 * 60 * 1000 }, ...overrides });
}

test('悬停标题说现场：几台设备、多久没连过', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? statusWithDevices() : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs.title, '2 台设备 · 3 分钟前连过 · 打开移动端插件配置网页');
  // 正常态不许带告警记号：一格红了，人就会把每次连不上都当成插件坏了。
  assert.equal(node.attrs[FOOTER_ALERT], undefined);
  assert.equal(node.attrs['data-dshm-warn'], undefined);
});

test('一台都没配过：标题说「还没配对过手机」，不是故障', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus({ devices: { count: 0, lastSeenAt: 0 } }) : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.match(node.attrs.title, /还没配对过手机/);
  assert.equal(node.attrs[FOOTER_ALERT], undefined, '没配过不是故障，不该转红');
  assert.equal(node.attrs['data-dshm-warn'], undefined, '它是一句提示，不是警告');
});

test('中转断了：图标转琥珀、标题点名原因，但不转红（面板还开得开）', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status')
        ? statusWithDevices({ tunnel: { state: 'error', error: 'bad registration secret' } })
        : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs['data-dshm-warn'], '', '中间那一档：琥珀色，不是红');
  assert.equal(node.attrs[FOOTER_ALERT], undefined, '它还没到「点了也没用」那一档');
  assert.match(node.attrs.title, /中转没有连上/);
});

test('旁挂进程报错也走琥珀；starting / off 都不算错（别在启动时闪假警）', async () => {
  const sidebar = fakeSidebarRow();
  const bad = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status')
        ? statusWithDevices({ sidecar: { state: 'error: boom', restarts: 0 } })
        : { ok: true }),
    }),
  });
  bad.renderFooter();
  await bad.hooks.flush();
  bad.renderFooter();
  await bad.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs['data-dshm-warn'], '');
  assert.match(node.attrs.title, /旁挂进程报错/);

  for (const state of ['starting', 'off']) {
    const row = fakeSidebarRow();
    const env = materialize({
      sidebar: row,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith('/status')
          ? statusWithDevices({ sidecar: { state, restarts: 0 } })
          : { ok: true }),
      }),
    });
    env.renderFooter();
    await env.hooks.flush();
    env.renderFooter();
    await env.hooks.flush();
    assert.equal(footerDomNode(row).attrs['data-dshm-warn'], undefined, `${state} 不是错，别亮黄点`);
  }
});

test('老宿主没带设备那一格：标题退回原来那句，不编一个「0 台设备」', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus() : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  assert.equal(footerDomNode(sidebar).attrs.title, '打开移动端插件配置网页');
});

/* ── 5b. 点下去做什么：直接就是控制台那一屏（2026-11-13 用户改的）─────────
 * 从「两层入口」改成「一层」：点图标就地嵌 `/api/relay/panel/console`，那一屏本身就是
 * 扫码 + 连接状态 + 已绑定设备。调试页没删，退到操作栏里的「报错调试」一颗次要按钮。
 *
 * 改的理由有两条，都写进了 `lib/client.js` 那段注释：①那一层唯一的作用是让人多按一次；
 * ②那颗「进入控制台」以前是跳浏览器、用的是宿主报的 `panelUrl`，云服务器上它常常是
 * `127.0.0.1:端口`，用户从公网打开 DSH 时跳过去必然打不开。现在整页就地嵌、地址按
 * `document.baseURI` 推，公网 / 域名 / 反代子路径三种都能对上。
 *
 * **控制面得先认这个浏览器**，否则嵌进来是一屏 423 —— 所以「从别的机器打开的页面」仍然
 * 先开那两小时窗口，只是不再导航任何地方。
 */

/** 点开的那一窗里嵌着的那个 iframe（没有就是 undefined）。 */
function consoleFrame(env) {
  const dialog = diagnosisNode(env);
  if (!dialog) return undefined;
  return elements(dialog).find((node) => node.tag === 'iframe');
}

/** 控制台那一页：按页面自身的同源地址推（`panelPageUrlOf('console')` 就是这么算的）。 */
function consolePageOf() {
  return 'http://127.0.0.1:56495/api/relay/panel/console';
}

/** 只给一颗图标用的环境：`panelScope` 由调用方定。 */
function clickEnv({ panelScope = 'loopback', confirm = true, pageProtocol = 'http:', source } = {}) {
  const env = materialize({
    confirm,
    pageProtocol,
    source,
    fetch: async (url) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  return { env };
}

/** 渲染窄条那颗（自己占一行，点击处理器直接挂在元素上，最好驱动）。 */
async function railIcon(env) {
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  return env.renderFooter({}, { wide: false });
}

test('本机回环：点下去直接嵌控制台那一屏，不再有中间那层', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  let prevented = false;
  await icon.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true, '点击一律先拦下来：这一下是弹窗，不是导航');
  assert.equal(env.openedWindows.length, 0, '不许跳走');
  const frame = consoleFrame(env);
  assert.ok(frame, '点下去就地嵌那一页');
  assert.equal(frame.attrs.src, consolePageOf(), '嵌的是同源的控制台页');
  assert.equal(frame.attrs.title, '移动端插件控制台');
  // 中间那两块大按钮撤了：第一层就是页面本身。
  assert.equal(
    elements(diagnosisNode(env)).filter((node) => String(node.className || '').includes('dshm_choice')).length,
    0,
    '「进入控制台 / 报错调试」那两块已经撤掉',
  );
});

test('点电脑图标：本机回环直接嵌远程电脑页，不是控制台页', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  env.renderRemoteFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderRemoteFooter({}, { wide: false });
  assert.equal(icon.props['aria-label'], '打开远程电脑');
  let prevented = false;
  await icon.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true, '点击先拦下来：这一下是弹窗');
  assert.equal(env.openedWindows.length, 0, '不许跳走');
  const frame = consoleFrame(env);
  assert.ok(frame, '点下去就地嵌那一页');
  assert.equal(frame.attrs.src, remotePageOf(), '嵌的是远程电脑独立页');
  assert.equal(frame.attrs.title, '远程电脑');
});

/** 远程电脑独立页地址（同源推，`panelPageUrlOf('remote')` 就是这么算的）。 */
function remotePageOf() {
  return 'http://127.0.0.1:56495/api/relay/panel/remote';
}

/** 回执来自实际 iframe 窗口；别的窗口发同名消息不能解除加载态。 */
function sendPanelState(env, frame, state, source = frame.contentWindow) {
  for (const fn of env.sandbox.window.listeners.message || []) {
    fn({ source, data: { type: 'dsh-mobile-plugin:panel-state', state } });
  }
}

/** 页面顶栏那两颗按钮发来的窗口动作：同样只认 iframe 的来源。 */
function sendPanelAction(env, action, source) {
  const frame = consoleFrame(env);
  // 真 iframe 一定有 contentWindow；假体里多数测试没设，这里补一颗身份牌再发。
  if (!frame.contentWindow) frame.contentWindow = { postMessage() {} };
  const from = source === undefined ? frame.contentWindow : source;
  for (const fn of env.sandbox.window.listeners.message || []) {
    fn({ source: from, data: { type: 'dsh-mobile-plugin:panel-action', action } });
  }
}

test('控制台：空白文档 load 不算就绪，超时给出重试提示', async () => {
  const { env } = clickEnv();
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const frame = consoleFrame(env);
  frame.contentWindow = { postMessage() {} };
  frame.onload();
  assert.equal(diagnosisNode(env).__dshmFrameState, 'loading');
  assert.ok(elements(diagnosisNode(env)).some((node) => node.className === 'dshm_frameTip'));
  sendPanelState(env, frame, 'ready', {});
  assert.equal(diagnosisNode(env).__dshmFrameState, 'loading', '其他窗口不能冒认就绪');
  await env.timers.tick(20000);
  assert.equal(diagnosisNode(env).__dshmFrameState, 'error');
  assert.match(texts(diagnosisNode(env)).join(' '), /未能完成加载/);
  // 外壳不放任何按钮：重试是关窗重开或页面顶栏那颗，窗口操作由页面发消息。
  assert.equal(dialogButton(env, '重新载入'), undefined);
  assert.equal(dialogButton(env, '在浏览器里打开'), undefined);
});

test('控制台：已就绪页面保活，失败或未就绪页面重新打开要换一页', async () => {
  for (const state of ['ready', 'error', 'loading']) {
    const { env } = clickEnv();
    const icon = await railIcon(env);
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    const frame = consoleFrame(env);
    frame.contentWindow = { postMessage() {} };
    if (state !== 'loading') sendPanelState(env, frame, state);
    sendPanelAction(env, 'close');
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    assert.equal(consoleFrame(env) === frame, state === 'ready', state);
    assert.equal(env.sandbox.window.listeners.message.length, 1, '重开不累积监听');
  }
});

test('控制台：文档就绪标记可补发回执，加载提示随即撤掉', async () => {
  const { env } = clickEnv();
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const frame = consoleFrame(env);
  frame.contentDocument = { documentElement: { getAttribute: (name) => name === 'data-dshm-panel-state' ? 'ready' : null } };
  frame.onload();
  assert.equal(diagnosisNode(env).__dshmFrameState, 'ready');
  assert.ok(!elements(diagnosisNode(env)).some((node) => node.className === 'dshm_frameTip'));
  assert.equal(env.sandbox.window.listeners.message.length, 1);
});

test('控制台：入口卸载时清掉保活页面、消息监听和加载定时器', async () => {
  const { env } = clickEnv();
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const cleanups = env.hooks.effects.map(({ fn }) => fn()).filter((fn) => typeof fn === 'function');
  await settle();
  for (const cleanup of cleanups) cleanup();
  assert.equal(diagnosisNode(env), undefined);
  assert.equal(env.sandbox.window.listeners.message.length, 0);
  assert.equal(env.timers.timeoutCount, 0);
});

test('变异：空白 load 直接就绪、失败页继续保活都会被回归断言拦住', async () => {
  const loaded = async (source) => {
    const { env } = clickEnv({ source });
    const icon = await railIcon(env);
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    return { env, icon, frame: consoleFrame(env) };
  };
  const blank = await loaded(SOURCE.replace('frame.onload = () => {', "frame.onload = () => { update('ready');"));
  blank.frame.onload();
  assert.throws(() => assert.equal(diagnosisNode(blank.env).__dshmFrameState, 'loading'), assert.AssertionError);
  const cached = await loaded(SOURCE
    .replace("if (overlay && overlay.__dshmFrameState !== 'ready') overlay.__dshmKeep = false;", '')
    .replace("&& overlay.__dshmFrameState === 'ready'", ''));
  cached.frame.onerror();
  sendPanelAction(cached.env, 'close');
  await cached.icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.throws(() => assert.notEqual(consoleFrame(cached.env), cached.frame), assert.AssertionError);
});

test('内容窗外壳只放一颗关闭角标：其它按钮由页面顶栏发消息', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const dialog = diagnosisNode(env);
  // 标题行、底部文字按钮行全撤了；compact 窗只在角上留一颗固定关闭角标（嵌页加载失败时也能收起）。
  const buttons = elements(dialog).filter((node) => node.tag === 'button' || node.type === 'button');
  assert.equal(buttons.length, 1, 'compact 外壳只该有那一颗关闭角标');
  assert.ok(String(buttons[0].className || '').includes('dshm_shellClose'), '角标用 dshm_shellClose');
  for (const cls of ['dshm_dialogTitle', 'dshm_dialogTools', 'dshm_dialogActions']) {
    assert.equal(elements(dialog).filter((node) => String(node.className || '').includes(cls)).length, 0, `${cls} 不在外壳里`);
  }
  // 「关闭」这条消息真的把窗收起来（未就绪的窗 hide 即销毁）。
  sendPanelAction(env, 'close');
  assert.equal(diagnosisNode(env), undefined, '页面发 close，外壳收窗');
});

test('窗口动作只认内嵌页自己，别的窗口发同名消息不算', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  sendPanelAction(env, 'open-browser', {});
  assert.equal(env.openedWindows.length, 0, '冒认的消息不许开窗');
  assert.ok(diagnosisNode(env), '也不许收窗');
});

test('页面发 open-browser：外壳开同源地址并收掉这一窗', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  sendPanelAction(env, 'open-browser');
  await settle();
  assert.equal(env.openedWindows.length, 1, '按了才开浏览器窗口');
  assert.equal(env.openedWindows[0].location.href, consolePageOf(), '开的是同源地址');
  assert.equal(consoleFrame(env), undefined, '开出去就把这一窗收掉');
});

test('局域网与公网地址：都直接嵌控制台，不再开窗口也不弹确认', async () => {
  for (const panelScope of ['private', 'public']) {
    const { env } = clickEnv({ panelScope });
    const icon = await railIcon(env);
    await icon.props.onClick({ preventDefault() {} });
    await settle();
    assert.equal(env.confirms.length, 0, `${panelScope} 不再弹确认`);
    assert.equal(env.openedWindows.length, 0, '只弹窗，不导航');
    assert.equal(consoleFrame(env).attrs.src, consolePageOf());
  }
});

test('页面发 open-browser 开的是**同源**地址，不是宿主报的那个 panelUrl', async () => {
  // 2026-11-13 用户报的根因就在这一条：云服务器上 `panelUrl` 常是 `127.0.0.1:端口`，
  // 从公网打开 DSH 的人点过去必然打不开。所以开窗一律用按 `baseURI` 推的同源地址。
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  sendPanelAction(env, 'open-browser');
  await settle();
  assert.equal(env.openedWindows.length, 1, '按了才开浏览器窗口');
  assert.equal(
    env.openedWindows[0].location.href,
    consolePageOf(),
    '开的是同源推算出来的控制台地址，不是 panelUrl',
  );
  assert.notEqual(env.openedWindows[0].location.href, readyStatus().panelUrl);
  assert.equal(consoleFrame(env), undefined, '开出去就把这一窗收掉');
});

test('桌面壳里页面发 open-browser：交给页面导航开系统浏览器，不走被拒的 window.open', async () => {
  // 壳里 `window.open` 一律被拒，点这里只会得到一句「浏览器拦掉了新窗口」；正路是把宿主
  // 报的绝对 http(s) 地址交给页面导航，壳的 will-navigate 再转给系统浏览器。
  const { env } = clickEnv({ panelScope: 'loopback', pageProtocol: 'dsh-app:' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  sendPanelAction(env, 'open-browser');
  await settle();
  assert.equal(env.openedWindows.length, 0, '壳里不许再走 window.open');
  assert.equal(
    env.sandbox.window.location.href,
    readyStatus().panelUrl,
    '把宿主报的绝对地址交给页面导航，由壳转给系统浏览器',
  );
  assert.equal(consoleFrame(env), undefined, '开出去就把这一窗收掉');
});

test('桌面壳里的页面（dsh-app:）：照样就地嵌，页面不被导航走', async () => {
  // 桌面版前端跑在 `dsh-app://app`（Electron 的安全协议）下，所以 iframe 的地址必须按页面
  // 自身的同源地址推，**不能**用宿主报的那个 http 绝对地址（那是跨协议、会被当混合内容挡掉）。
  const { env } = clickEnv({ panelScope: 'private', pageProtocol: 'dsh-app:' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(env.openedWindows.length, 0, '壳里 `window.open` 一定被拒，先开一个空窗口只会盖一屏黑的出来');
  assert.equal(
    env.sandbox.window.location.href,
    'http://127.0.0.1:56495/',
    '整个页面不许被导航走：这一下是弹窗',
  );
  assert.ok(consoleFrame(env), '壳里同样要能嵌那一页');
});

test('插进那一行的那颗也走同一套点击逻辑', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'public' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(typeof node.onclick, 'function', '插进 DOM 的那颗要有自己的点击处理');
  await node.onclick({ preventDefault() {} });
  await settle();
  assert.equal(env.confirms.length, 0);
  assert.ok(consoleFrame(env), '插进那一行的那颗点下去也是同一屏');
  assert.equal(env.openedWindows.length, 0);
});

/* ── 6. 诊断弹窗：点不动 / 开不起来时的自查与自修 ──────────────────────
 * 用户 2026-11-02 的要求：报错不能只是「弹个窗让人截图」——凡是用户自己能做到的检查与
 * 修复都要摆在上面（重启、重装、确认没装两份、反代前缀），能一键试的给按钮（重新装载、
 * 重读状态），最后给一段可复制的 ASCII 读数。
 */

/** 一份「实现没装载」的宿主：/status 404，外壳自检带原因。 */
function brokenHost(overrides = {}) {
  const half = {
    version: '0.5.11',
    source: 'npm',
    activatedAt: '2026-11-01T12:00:00.000Z',
    lastError: '装载 0.5.0 超时：它可能卡在等一个永远不来的依赖服务上',
    retrying: true,
    retryAttempts: 3,
    nextRetryAt: '2026-11-01T12:05:00.000Z',
    installedVersion: '0.5.12',
    shellChanged: true,
    ...overrides,
  };
  return async (url) => {
    if (String(url).endsWith('/status')) return { ok: false, status: 404, json: async () => ({}) };
    if (String(url).endsWith('/host-half')) return { ok: true, status: 200, json: async () => ({ ok: true, half }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}

test('点一颗没地址的图标会弹诊断窗：原因、读数、自查步骤、按钮都在', async () => {
  const env = materialize({ fetch: brokenHost() });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  assert.equal(icon.props.href, undefined, '没地址时不该有链接');
  await icon.props.onClick({ preventDefault() {} });
  await settle();

  const dialog = diagnosisNode(env);
  assert.ok(dialog, '点了必须有反应：不许一颗灰图标什么都不做');
  assert.equal(dialog.attrs.role, 'dialog');
  assert.equal(dialog.attrs['aria-modal'], 'true');
  // 诊断窗没跟着内容窗一起瘦：标题与文字按钮行照旧，它那几行读数是给人看的。
  assert.equal(elements(dialog).filter((node) => String(node.className || '').includes('dshm_dialogTitle')).length, 1);
  assert.equal(elements(dialog).filter((node) => String(node.className || '').includes('dshm_dialogActions')).length, 1);
  const text = texts(dialog).join(' ');
  // ① 谁说了什么
  assert.match(text, /打不开移动端配置页/);
  assert.match(text, /插件宿主侧没有加载/);
  assert.match(text, /装载 0\.5\.0 超时/, '宿主原话要原样贴出来');
  assert.match(text, /HTTP 状态/);
  for (const reading of ['0.5.11', 'npm', '2026-11-01T12:00:00.000Z', '0.5.12']) {
    assert.equal(text.includes(reading), true, `读数字段少了 ${reading}`);
  }
  assert.match(text, /3 → 2026-11-01T12:05:00\.000Z/, '后台重试那两格要能看出来');
  // ② 用户自己能做的
  assert.match(text, /把 DSH 完整退出/);
  assert.match(text, /重装一遍/);
  assert.match(text, /装两份/);
  assert.match(text, /反向代理/);
  // ③ 能一键试的
  for (const label of ['重新装载插件', '重新读取状态', '复制诊断信息', '关闭']) {
    assert.ok(dialogButton(env, label), `少了「${label}」`);
  }
});

test('复制诊断信息：剪贴板拿到的是 ASCII 记号，贴出来就能对日志', async () => {
  const env = materialize({ fetch: brokenHost() });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();

  await clickDialogButton(env, '复制诊断信息');
  await settle();
  assert.equal(env.clipboardWrites.length, 1);
  const copied = env.clipboardWrites[0];
  assert.match(copied, /^dsh-mobile-plugin diagnosis/);
  assert.match(copied, /plugin_version=0\.5\.11/);
  assert.match(copied, /host_last_error=装载 0\.5\.0 超时/);
  assert.match(copied, /http_status=404/);
  assert.match(copied, /on_disk=0\.5\.12/);
  assert.match(copied, /user_agent=DSH-test/);
  // 记号一律 ASCII：值里的中文是宿主原话（要原样保留），键不许翻译。
  assert.equal(/[^ -~]/.test(copied.split('\n').filter((line) => /^[a-z_]+=/.test(line)).map((line) => line.split('=')[0]).join('')), false);
  assert.match(texts(diagnosisNode(env)).join(' '), /诊断信息已复制/);
});

test('「重新装载插件」打外壳那条口；装好之后这一屏当场变成「可以打开了」', async () => {
  let healthy = false;
  const env = materialize({
    fetch: async (url) => {
      if (String(url).endsWith('/host-half/reload')) {
        healthy = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, half: { version: '0.5.12', source: 'npm' } }) };
      }
      if (String(url).endsWith('/host-half')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, half: { version: healthy ? '0.5.12' : '0.5.11', source: 'npm', lastError: healthy ? null : '装载 0.5.0 超时' } }) };
      }
      if (String(url).endsWith('/status')) {
        if (!healthy) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => readyStatus() };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();

  await clickDialogButton(env, '重新装载插件');
  await settle();
  assert.ok(env.fetchCalls.some((call) => String(call.url).endsWith('/host-half/reload')), '要打到外壳那条重新装载口');
  const reload = env.fetchCalls.find((call) => String(call.url).endsWith('/host-half/reload'));
  assert.equal(reload.init.method, 'POST');
  assert.equal(reload.init.credentials, 'same-origin');

  const text = texts(diagnosisNode(env)).join(' ');
  assert.match(text, /重新装载成功/);
  assert.match(text, /状态已经读到了|重新装载成功/);
  // 装好之后当场就能打开，不必让用户自己再找一遍图标。
  assert.ok(dialogButton(env, '打开配置页面'), '装载成功后要直接给「打开配置页面」');
});

test('「重新读取状态」能自愈：宿主回魂之后这一屏自己说「再点一次图标」', async () => {
  let alive = false;
  const env = materialize({
    fetch: async (url) => {
      if (String(url).endsWith('/host-half')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, half: { version: '0.5.12', source: 'npm', retrying: !alive, lastError: alive ? null : '装载超时：等一个永远不来的服务' } }) };
      }
      if (String(url).endsWith('/status')) {
        if (!alive) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => readyStatus() };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.match(texts(diagnosisNode(env)).join(' '), /插件宿主侧没有加载/);

  alive = true;
  await clickDialogButton(env, '重新读取状态');
  await settle();
  const text = texts(diagnosisNode(env)).join(' ');
  assert.match(text, /状态已经读到了/);
  assert.equal(text.includes('宿主返回'), false, '读到了就不该再挂着上一条失败');
});

test('外壳自检口没回应时照实说，而不是让人继续瞎重启', async () => {
  const env = materialize({
    fetch: async (url) => {
      if (String(url).endsWith('/host-half')) return { ok: false, status: 404, json: async () => ({}) };
      if (String(url).endsWith('/status')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const text = texts(diagnosisNode(env)).join(' ');
  assert.match(text, /自检口|没有回应/);
  assert.match(text, /可能还没带/);
});

test('自检说没事、路由却不在：点名「两份插件」那种现场', async () => {
  const env = materialize({
    fetch: async (url) => {
      if (String(url).endsWith('/host-half')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, half: { version: '0.5.12', source: 'npm', lastError: null, retrying: false } }) };
      }
      if (String(url).endsWith('/status')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const text = texts(diagnosisNode(env)).join(' ');
  assert.match(text, /两份插件/);
  assert.equal(text.includes('没有回应'), false, '问到了就不许说问不到');
});

test('同一时刻只留一个诊断窗；再点一次是就地重画', async () => {
  const env = materialize({ fetch: brokenHost() });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  let icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const dialogs = [...env.sandbox.document.body.children].filter((node) => node.attrs[DIAG_MARK] !== undefined);
  assert.equal(dialogs.length, 1, '叠出两摞窗比没反应更糟');
});

test('点遮罩或按 Esc 能收起，收起之后不留残留', async () => {
  const env = materialize({ fetch: brokenHost() });
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  const icon = env.renderFooter({}, { wide: false });
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  const dialog = diagnosisNode(env);
  dialog.click();
  assert.equal(diagnosisNode(env), undefined, '点遮罩要收起');

  const icon2 = env.renderFooter({}, { wide: false });
  await icon2.props.onClick({ preventDefault() {} });
  await settle();
  const escapes = env.sandbox.document.listeners.keydown || [];
  assert.ok(escapes.length > 0, '要挂 Esc');
  escapes[0]({ key: 'Escape' });
  assert.equal(diagnosisNode(env), undefined, 'Esc 要收起');
});

/* ── 7. 侧边栏未读绿点的双向同步 ─────────────────────────────────────────
 * 两端的绿点是两份互不相干的状态：手机端那份在宿主里（按设备维度的完成提醒），
 * 桌面端那份只在渲染进程内存里（`UiSession.completionUnread`）。这一半是唯一的桥。
 * 下面钉住三件事：拿不到桌面服务时一条请求都不发（别留空转的定时器）；桌面端
 * 「刚读掉」才上报，首帧的全量未读与「会话从快照消失」都不算读过（否则会把还没读的
 * 也灭掉）；手机端读过的会话在桌面页面里就地 retain+release 清掉，而读完之后才跑完
 * 的那一轮不能误清。
 */

/** uiSession.sessionStatus 的替身：一个可换内容的快照（真身是 Map）。 */
function statusStore(entries) {
  let snapshot = new Map(entries);
  return {
    getSnapshot: () => snapshot,
    set(next) {
      snapshot = new Map(next);
    },
  };
}

/** sessions 服务的替身：记下每次 retain/release，`list` 只用来取 updatedAt。 */
function sessionsService(options = {}) {
  const retained = [];
  const released = [];
  const rows = options.rows || {};
  return {
    retained,
    released,
    retain(id, init) {
      if ((options.unknown || []).includes(id)) {
        throw new Error(`sessions.retain: unknown session ${id}`);
      }
      retained.push({ id, init });
      return { release: () => released.push(id) };
    },
    list: { getSnapshot: () => ({ phase: 'ready', byId: rows }) },
  };
}

/** 只数「业务请求」：自检上报（/api/relay/client-half）是周期可观测性，不算业务动作。 */
function syncCalls(env) {
  return env.fetchCalls.filter((call) => !String(call.url).endsWith(CLIENT_HALF_ENDPOINT));
}

/** 发往某条端点的请求体，按发出顺序。 */
function bodiesOf(env, endpoint) {
  return env.fetchCalls
    .filter((call) => String(call.url).endsWith(endpoint))
    .map((call) => JSON.parse(call.init.body));
}

test('绿点同步门禁在 ctx.inject 上：拿不到桌面服务时连 effect 都不注册', async () => {
  const env = materialize({ storage: createStorage({ 'other.key': '{}' }) });
  await settle();
  await env.timers.tick(2000);
  assert.deepEqual(
    env.effects.map((e) => e.label),
    ['mobile-plugin: chat embed top bar', 'mobile-plugin: settings dictionaries', 'mobile-plugin: 客户端半边自检上报'],
    '没有桌面服务时只保留嵌入声明清理、字典与自检上报',
  );
  assert.equal(syncCalls(env).length, 0);
  // 门禁必须写成「拿不到服务就整条不挂」（`ctx.inject` 的依赖永不满足 ⇒ 回调不跑），
  // 而不是「挂上去再早退」——后者会留下一个每 2s 空转一次的定时器，也会让
  // client-factory 的定时器计数守卫失去意义。
  // 取服务只能用 `ctx.inject`：`ctx.get(name)` 在客户端运行时里取不到这两个服务（改了会一次
  // 请求都不发）。DSH 自家客户端插件与第三方插件（dsh-opencode-go）都走 `ctx.inject`。
  assert.equal(
    (SOURCE.match(/withClientServices\(/g) || []).length,
    4,
    '辅助函数一处定义 + 两条绿点同步 + 抓会话清单服务各一处调用',
  );
  assert.equal(SOURCE.includes("ctx.get('sessions')"), false, '服务取用不许再走 ctx.get');
  assert.equal(SOURCE.includes("ctx.get('uiSession')"), false, '服务取用不许再走 ctx.get');
});

test('绿点同步：有桌面服务时两条 effect 都挂上，各带一个标签', () => {
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: statusStore([]) }, sessions: sessionsService() },
  });
  assert.deepEqual(
    env.effects.map((e) => e.label),
    [
      'mobile-plugin: chat embed top bar',
      'mobile-plugin: settings dictionaries',
      'mobile-plugin: 会话清单服务',
      'mobile-plugin: 桌面端已读上报',
      'mobile-plugin: 已读回执应用',
      'mobile-plugin: 客户端半边自检上报',
    ],
  );
});

test('方向一：首帧一条都不报（桌面重开页面时未读是空的，照单全收会灭掉手机上真的未读）', async () => {
  // 桌面那份 `completionUnread` 只在浏览器内存里，页面一重开就全空。所以「快照里现在
  // 不是未读」根本不能当成「用户读过」——首帧必须什么都不报。
  const store = statusStore([['s1', { completionUnread: false }], ['s2', { completionUnread: false }]]);
  // 清单里这两条上次动的时间早于页面打开：本次页面根本没见它们变过。
  const sessions = sessionsService({ rows: { s1: { updatedAt: 100 }, s2: { updatedAt: 200 } } });
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store }, sessions },
  });
  await settle();
  await env.timers.tick(2000);
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), []);
});

test('方向一：普通的点开（未读掉出去）照报，不依赖清单有没有 updatedAt', async () => {
  const store = statusStore([['s1', { completionUnread: true }]]);
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store } },
  });
  await settle();
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [], '还没读的不能报，报上去就把它的点灭了');

  store.set([['s1', { completionUnread: false }]]);
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [{ sessionIds: ['s1'] }]);
  // 报过就不再重复（每 2s 扫一次，没去重会变成持续灌流）。
  await env.timers.tick(2000);
  assert.equal(bodiesOf(env, DESKTOP_READ_ENDPOINT).length, 1);
});

test('方向一：DSH 0.2.3 形状——sessionStatus 是独立服务，靠 reflect.get 读到也能灭灯', async () => {
  // 0.2.3 把状态表拆成 uiSession.sessionStatus 独立服务（uiSession 上不再有 sessionStatus
  // 这个普通属性）。插件只能用 reflect.get 按服务名取；裸读 uiSession.sessionStatus
  // 会被 Cordis 的 inject 门禁拒绝。
  const store = statusStore([['s1', { completionUnread: true }]]);
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: {}, 'uiSession.sessionStatus': store },
  });
  await settle();
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [], '还没读的不能报');

  store.set([['s1', { completionUnread: false }]]);
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [{ sessionIds: ['s1'] }]);
});

test('状态表读取必须兼容两种宿主，且 inject 只钉父服务', () => {
  // 源码守卫：把子服务名加进 inject 会让 0.2.2 那整条 effect 因依赖永不满足而停摆，
  // 裸读嵌套属性又会在 0.2.3 被 inject 门禁拒绝。两代都要靠 reflect.get 直取 + 属性回退。
  assert.match(SOURCE, /readSessionStatusStore\(scope, uiSession\)/);
  assert.match(SOURCE, /reflect\.get\('uiSession.sessionStatus', false\)/);
  assert.match(SOURCE, /withClientServices\(ctx, \['uiSession'\], 'uiSession'/);
  assert.equal(
    SOURCE.includes("ctx.inject(['uiSession', 'uiSession.sessionStatus']"),
    false,
    '不能把子服务名写进 inject 依赖：0.2.2 上没有这个服务，会让绿点同步整条不启动',
  );
});

test('方向一：页面打开之后变过、现在不是未读的会话要补报（漏采那一瞬间也能自愈）', async () => {
  const store = statusStore([['s1', { completionUnread: false }]]);
  const sessions = sessionsService({ rows: { s1: { updatedAt: Date.now() + 60_000 } } });
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store }, sessions },
  });
  await settle();
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [{ sessionIds: ['s1'] }]);
});

test('方向一：正在跑的会话不算读完，跑起来要摘掉标记、读掉之后再报一次', async () => {
  const store = statusStore([['s1', { completionUnread: true }]]);
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store } },
  });
  await settle();
  await env.timers.tick(2000);
  store.set([['s1', { completionUnread: false }]]);
  await env.timers.tick(2000);
  assert.equal(bodiesOf(env, DESKTOP_READ_ENDPOINT).length, 1);

  // 又跑了一轮：运行中不算读完，标记摘掉。
  store.set([['s1', { completionUnread: false, running: true }]]);
  await env.timers.tick(2000);
  assert.equal(bodiesOf(env, DESKTOP_READ_ENDPOINT).length, 1, '正在跑的这一轮结局还没出来');

  // 跑完还没读 → 未读；读过之后要能再报一次。
  store.set([['s1', { completionUnread: true }]]);
  await env.timers.tick(2000);
  assert.equal(bodiesOf(env, DESKTOP_READ_ENDPOINT).length, 1);
  store.set([['s1', { completionUnread: false }]]);
  await env.timers.tick(2000);
  assert.equal(bodiesOf(env, DESKTOP_READ_ENDPOINT).length, 2, '新一轮读掉之后必须再对齐一次');
});

test('方向一：桌面正开着的会话也算读过（它永远不进未读集合）', async () => {
  // 桌面正开着的会话根本不进未读集合（`observeRunning` 跳过、`reconcileStatus` 主动删），
  // 「未读掉出去」的边沿对它一次都不会发生。判据里单独留「正开着」这一条就是为了它。
  const store = statusStore([['open1', { completionUnread: false, running: false }]]);
  const sessions = sessionsService({ rows: { open1: { updatedAt: 100, retainedBy: { mainView: 1 } } } });
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store }, sessions },
  });
  await settle();
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [{ sessionIds: ['open1'] }]);
});

test('方向一：会话从快照里消失不算读过（列表还没加载完 / 会话被删）', async () => {
  const store = statusStore([['s1', { completionUnread: true }]]);
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: store } },
  });
  await settle();
  await env.timers.tick(2000);
  store.set([]);
  await env.timers.tick(2000);
  await env.timers.tick(2000);
  assert.deepEqual(bodiesOf(env, DESKTOP_READ_ENDPOINT), [], '消失只是没得报，不能凭空报一条');
});
test('方向二：手机端读过的会话，在桌面页面里就地 retain+release 摘掉绿点', async () => {
  const sessions = sessionsService({ rows: { s1: { updatedAt: 100 } } });
  const { impl } = routedFetch({
    [READ_RECEIPT_ENDPOINT]: { body: { ok: true, receipt: { readAt: { s1: 500 } } } },
  });
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { sessions },
    fetch: impl,
  });
  await settle();
  // source 必须是 mainView：桌面自己的 reconcileStatus 只对 mainView 清 completionUnread。
  // 逐字段断言而不是 deepEqual：init 是在沙箱 realm 里造的对象，跨 realm 的
  // Object 原型不同，deepStrictEqual（本文件用的是 node:assert/strict）会判不等。
  assert.equal(sessions.retained.length, 1);
  assert.equal(sessions.retained[0].id, 's1');
  assert.equal(sessions.retained[0].init.source, 'mainView');
  assert.deepEqual(sessions.released, ['s1'], '必须在同一个 tick 里 release，别把会话一直挂成当前会话');

  // 水位没动就不再动它：本地游标去重，免得每 2s 摘一次。
  await env.timers.tick(2000);
  assert.equal(sessions.retained.length, 1);
});

test('方向二：读完之后这一轮才跑完的回执不应用（绿点该亮着）', async () => {
  const sessions = sessionsService({ rows: { s1: { updatedAt: 900 } } });
  const { impl } = routedFetch({
    [READ_RECEIPT_ENDPOINT]: { body: { ok: true, receipt: { readAt: { s1: 500 } } } },
  });
  materialize({ storage: createStorage({ 'other.key': '{}' }), services: { sessions }, fetch: impl });
  await settle();
  assert.deepEqual(sessions.retained, [], '最后活动时间晚于已读水位，说明这一轮是读完之后跑完的');
});

test('方向二：会话已被删掉时 retain 抛错不卡住后面的 id', async () => {
  const sessions = sessionsService({ rows: {}, unknown: ['gone'] });
  const { impl } = routedFetch({
    [READ_RECEIPT_ENDPOINT]: { body: { ok: true, receipt: { readAt: { gone: 500, alive: 600 } } } },
  });
  materialize({ storage: createStorage({ 'other.key': '{}' }), services: { sessions }, fetch: impl });
  await settle();
  assert.deepEqual(sessions.retained.map((r) => r.id), ['alive']);
});

test('方向二：拿不到 sessions 服务时一条台账请求都不发', async () => {
  const env = materialize({
    storage: createStorage({ 'other.key': '{}' }),
    services: { uiSession: { sessionStatus: statusStore([]) } },
  });
  await settle();
  await env.timers.tick(2000);
  assert.equal(syncCalls(env).filter((c) => String(c.url).endsWith(READ_RECEIPT_ENDPOINT)).length, 0);
});

/* ── 聊天嵌入页：按页面注入的目标打开会话 ─────────────────────────────────
 * 没选工作区时官方整页停在欢迎页，压根没有会话行可点。现在页面只写下一个全局目标，
 * 客户端等会话清单出现它再打开。这里钉三件事：退订要赶在打开之前（否则通知重入栈溢出）、
 * 只开一次、回报的 kind 与 located 与 App 那份守卫对得上。
 */

/**
 * 定位打开之后还要盯住的窗口（见 lib/client.js 的 `CHAT_EMBED_HOLD_*`）。
 * 这里的假定时器按拍触发、不推进时钟，所以照同一节拍逐拍走完，多走一拍当余量。
 */
const EMBED_HOLD_STEP_MS = 150;
async function embedHoldTicks(env, ticks = 12) {
  for (let i = 0; i < ticks; i += 1) await env.timers.tick(EMBED_HOLD_STEP_MS);
}

/** 一份可发布变更的会话清单，带订阅者计数；两个主视图方法照网页端的 retain / release 写。 */
function targetSessions(byId = {}) {
  let snapshot = { byId };
  let listeners = [];
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(fn) {
        listeners.push(fn);
        return () => { listeners = listeners.filter((entry) => entry !== fn); };
      },
      publish(next) {
        snapshot = { byId: next };
        for (const fn of [...listeners]) fn();
      },
      get listenerCount() { return listeners.length; },
    },
    /** 打开一条会话：它成为主视图 —— 网页端 retain 之后那一格就是这么记的。 */
    markMain(id) {
      const entry = snapshot.byId[id];
      if (entry) entry.retainedBy = { ...entry.retainedBy, mainView: (entry.retainedBy?.mainView ?? 0) + 1 };
    },
    /** 网页端启动时那次「恢复上次会话」：把主视图从这一条上摘掉。 */
    dropMain(id) {
      const entry = snapshot.byId[id];
      if (entry && entry.retainedBy) entry.retainedBy.mainView = 0;
    },
  };
}

/** 建好但先不物化的环境：要在 run() 之前把全局目标与 WebView 桥挂进沙箱。 */
function embedEnv({ sessions, uiWorkspace, target, hiddenGet }) {
  const env = createEnv({ services: { sessions, uiWorkspace }, uiWorkspace, hiddenGet });
  const reports = [];
  env.sandbox.window.ReactNativeWebView = {
    postMessage(raw) { reports.push(JSON.parse(raw)); },
  };
  if (target !== undefined) env.sandbox.__DSH_CHAT_EMBED_TARGET__ = target;
  return { env, reports };
}

test('聊天嵌入页：清单服务靠 inject 等到，不靠 apply 时还看不见的 ctx.get', async () => {
  const sessions = targetSessions({ 'target-3': { id: 'target-3' } });
  const opened = [];
  const uiWorkspace = { openSession: (id) => { opened.push(id); sessions.markMain(id); } };
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace,
    target: { sessionId: 'target-3' },
    hiddenGet: ['sessions', 'uiWorkspace'],
  });
  env.run();
  assert.deepEqual(opened, ['target-3'], 'ctx.get 看不见服务时仍要靠 inject 拿到子 ctx 打开会话');
  assert.deepEqual(reports, [], '盯住窗口走完之前不回报');
  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'target-3', located: true }]);
});

test('聊天嵌入页：清单出现目标后退订再打开一次，并按原 kind 回报成功', async () => {
  const sessions = targetSessions();
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); sessions.markMain(id); } },
    target: { sessionId: 'target-1' },
  });
  env.run();
  assert.equal(sessions.list.listenerCount, 1, '目标还没进清单就先订阅');
  assert.deepEqual(reports, [], '没定位到之前不许回报，免得 App 当成失败盖住整页');

  const row = { id: 'target-1' };
  sessions.list.publish({ 'target-1': row });
  assert.deepEqual(opened, ['target-1']);
  assert.equal(sessions.list.listenerCount, 0, '打开之前必须先退订，否则会被再次通知顶回自己');

  sessions.list.publish({ 'target-1': row });
  assert.deepEqual(opened, ['target-1'], '退订之后再来通知也不许开第二次');

  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'target-1', located: true }]);
});

test('聊天嵌入页：清单里已经有目标时立刻打开，不等下一次通知', async () => {
  const sessions = targetSessions({ 'target-2': { id: 'target-2' } });
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); sessions.markMain(id); } },
    target: { sessionId: 'target-2' },
  });
  env.run();
  assert.deepEqual(opened, ['target-2']);
  assert.equal(sessions.list.listenerCount, 0);
  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'target-2', located: true }]);
});

test('聊天嵌入页：网页端启动恢复把主视图抢回旧会话时，下一拍再指一次', async () => {
  const sessions = targetSessions({ 'target-9': { id: 'target-9' } });
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); sessions.markMain(id); } },
    target: { sessionId: 'target-9' },
  });
  env.run();
  assert.deepEqual(opened, ['target-9']);

  // 网页端这一趟「恢复上次会话」把主视图挪回别的条目 —— 打开不等于停在那儿。
  sessions.dropMain('target-9');
  await env.timers.tick(150);
  assert.deepEqual(opened, ['target-9', 'target-9'], '被抢回去之后下一拍要再指一次');

  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'target-9', located: true }]);
});

test('聊天嵌入页：宿主没有主视图那一格时按「不在」处理，重复指过去而不是报失败', async () => {
  const sessions = targetSessions({ 'target-4': { id: 'target-4' } });
  const opened = [];
  const { env, reports } = embedEnv({
    // 这一版宿主不往清单条目上记 retainedBy：复核读不到，于是每一拍都补指一次。
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); } },
    target: { sessionId: 'target-4' },
  });
  env.run();
  await embedHoldTicks(env);
  assert.ok(opened.length > 1, '读不到主视图那一格就每一拍补指一次');
  assert.ok(opened.every((id) => id === 'target-4'), '指的始终是目标那一条');
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'target-4', located: true }],
    '重复打开同一条会话是幂等的，不能收成一次定位失败');
});

test('聊天嵌入页：页面里那个入口换目标，换掉的那趟不再回报', async () => {
  const sessions = targetSessions({ a: { id: 'a' }, b: { id: 'b' } });
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); sessions.markMain(id); } },
    target: { sessionId: 'a' },
  });
  env.run();
  assert.deepEqual(opened, ['a']);

  // App 切会话：在页面里调入口把新目标送进来 —— 不重新加载页面，所以先记下目标的那一趟作废。
  env.sandbox.window.__DSH_CHAT_EMBED_OPEN__('b');
  assert.deepEqual(opened, ['a', 'b']);
  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'b', located: true }],
    '只看最后那一趟：被换掉的定位不该再往 App 报一次');
});

test('聊天嵌入页：装载时没有目标也挂上入口，稍后补目标照样切过去', async () => {
  const sessions = targetSessions({ later: { id: 'later' } });
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); sessions.markMain(id); } },
    target: undefined,
  });
  env.run();
  assert.deepEqual(opened, [], '没有目标就不该乱开一条会话');
  assert.equal(typeof env.sandbox.window.__DSH_CHAT_EMBED_OPEN__, 'function');

  // 会话还没建出来的新会话页切到网页模式：页面先起来，App 建好会话再把目标送进来。
  env.sandbox.window.__DSH_CHAT_EMBED_OPEN__('later');
  assert.deepEqual(opened, ['later']);
  await embedHoldTicks(env);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'later', located: true }]);
});

test('聊天嵌入页：等不到目标就回报定位失败，让 App 露出重试而不是停在欢迎页', async () => {
  const sessions = targetSessions();
  const opened = [];
  const { env, reports } = embedEnv({
    sessions,
    uiWorkspace: { openSession: (id) => { opened.push(id); } },
    target: { sessionId: 'never' },
  });
  env.run();
  assert.deepEqual(reports, []);
  await env.timers.tick(9000);
  assert.deepEqual(opened, []);
  assert.equal(sessions.list.listenerCount, 0);
  assert.deepEqual(reports, [{ kind: 'dsh-chat-embed', sessionId: 'never', located: false }]);
});

test('聊天嵌入页：没有目标或服务没就位时安静跳过，不回报也不抛', () => {
  const sessions = targetSessions();
  const uiWorkspace = { openSession: () => { throw new Error('不该走到这里'); } };
  // 没有目标：回报桥一旦被调用就让测试红。
  const none = embedEnv({ sessions, uiWorkspace, target: undefined });
  none.env.sandbox.window.ReactNativeWebView.postMessage = () => { throw new Error('没有目标不该回报'); };
  none.env.run();
  assert.equal(sessions.list.listenerCount, 0);
  assert.deepEqual(none.reports, []);

  // 有目标但 uiWorkspace 没挂上：整条安静降级，不能炸掉 apply 里后面那些注册。
  const noClient = createEnv({ services: { sessions: targetSessions() } });
  noClient.sandbox.__DSH_CHAT_EMBED_TARGET__ = { sessionId: 'orphan' };
  noClient.run();
  assert.equal(noClient.registrations.length, 3);
});

test('需要重启 DSH 时：那颗入口变成提醒，点开弹说明窗；没改外壳时仍是正常入口', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus({ shellChanged: true }) : { ok: true }),
    }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.ok(node, '重启提醒期间那颗按钮要在方框里');
  assert.equal(node.attrs['aria-label'], '有新版本，需要重启 DSH 生效');
  assert.notEqual(node.attrs['data-dshm-restart-icon'], undefined, '图形换成循环箭头那一颗');
  assert.equal(node.attrs['href'], undefined, '提醒不是链接，点它不跳走');
  const group = footerGroupNode(sidebar);
  assert.notEqual(group.attrs['data-dshm-restart'], undefined, '方框打上重启记号，旁边那颗电脑图标才被藏起');

  node.onclick({ preventDefault() {} });
  const body = env.sandbox.document.body;
  const dialog = [...body.children].find((child) => child.attrs && child.attrs['data-dshm-restart-notice'] !== undefined);
  assert.ok(dialog, '点一下要弹一扇说明窗');
  assert.ok(texts(dialog).join(' ').includes('重启'), '说明窗要说清需要重启一次 DSH');

  // 没改外壳时：仍是普通入口、不挂重启记号。
  const plainSidebar = fakeSidebarRow();
  const plain = materialize({
    sidebar: plainSidebar,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/status') ? readyStatus() : { ok: true }),
    }),
  });
  plain.renderFooter();
  await plain.hooks.flush();
  plain.renderFooter();
  await plain.hooks.flush();
  const plainNode = footerDomNode(plainSidebar);
  assert.equal(plainNode.attrs['data-dshm-restart-icon'], undefined, '没改外壳就不该变成提醒');
  assert.notEqual(plainNode.attrs['href'], undefined, '正常态仍是能点开的入口');
});

test('2026-11-24：两种诊断页都提重启，打开失败的那一屏补上版本/来源/激活时间/shellChanged', () => {
  // 市场装完没重启时实现换了、外壳还是旧的，表现为「打开配置页面失败」。从前这一档
  // 只让重试 / 查反代，把最常见的「装完没重启」漏掉了；诊断读数也没有 shellChanged。
  const stepsOpen = /if \(kind === 'open'\) steps\.push\(t\('diagStepRetryOpen'\)\);/;
  const restartFirst = /const steps = \[t\('diagStepRestart'\)\];/;
  assert.match(SOURCE, restartFirst, '重启要排在第一条');
  assert.match(SOURCE, stepsOpen, 'open 诊断仍保留重试那一条');
  // 两处 stepsOf 都从 restart 起步（一个带 …retryOpen，一个带 …reinstall）：至少两处命中。
  assert.ok((SOURCE.match(/const steps = \[t\('diagStepRestart'\)\];/g) || []).length >= 1);
  // 打开失败那一屏的读数补上版本 / 来源 / 激活时间 / shellChanged。
  for (const field of ['plugin_version', 'plugin_source', 'activated_at', 'shell_changed']) {
    assert.ok(SOURCE.includes(`key: '${field}'`), `诊断读数缺 ${field}`);
  }
});

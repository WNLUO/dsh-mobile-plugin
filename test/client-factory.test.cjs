'use strict';

/**
 * `lib/client.js` 的行为测试。
 *
 * 它是整个仓库唯一「拆不开」的源文件：注册进 `window.__ModuleLoader__`，工厂收到的
 * `require` 是 **DSH 的模块表 require**，不是 node 的。所以工厂内部只能 require `react`，
 * 没法 `require('./某某.js')` 把实现挪到别的文件；文件本身也不经任何构建。拆分的唯一出路
 * 是引入打包器，那会让「OTA 直接发源码」这条部署路径整个失效。
 *
 * 这里测的是它的行为，以及「它赖以工作的形状」——形状一变设置页会静默变空白，而没有
 * 任何测试会红。
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
    clearInterval(id) {
      pending.delete(id);
    },
    get count() {
      return pending.size;
    },
    /** 触发一次定时器（默认只触发指定 ms 的那些）。 */
    async tick(ms) {
      const runs = [];
      for (const entry of [...pending.values()]) {
        if (ms !== undefined && entry.ms !== ms) continue;
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
 * 不给就没有 `ctx.get`：两条绿点同步会整条不启动（它们依赖桌面端的 uiSession /
 * sessions 服务，拿不到就是空转），于是所有既有断言维持原样。
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
  const services = options.services || null;
  const sidebar = options.sidebar || null;
  const created = [];
  const confirms = [];
  const alerts = [];
  const openedWindows = [];
  let loaded = null;

  const document = {
    head: { appendChild: (node) => styles.push(node) },
    hidden: false,
    body: fakeElement('body'),
    // 真浏览器里一定有 `baseURI`（宿主注入 `<base href="./">`）；客户端半边推同源地址就靠它。
    baseURI: 'http://127.0.0.1:56495/',
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(selector);
      if (match) return styles.find((tag) => tag.dataset.pluginCss === match[1]) || null;
      // 侧栏底部那颗图标靠这个标记认设置那一行（见源码里的 FOOTER_ANCHOR）。
      if (selector === '[data-slot="settings.launcher"]') return sidebar ? sidebar.outlet : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== '[data-dshm-mobile-web]') return [];
      return created.filter((node) => node.attrs['data-dshm-mobile-web'] !== undefined && node.parentElement !== null);
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
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const required = [];
  const effects = [];

  function run() {
    loaded = null;
    vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
    assert.ok(loaded, '工厂必须注册进 window.__ModuleLoader__');
    assert.equal(loaded.id, 'dsh-mobile-plugin');
    required.length = 0;
    registrations.length = 0;
    const plugin = loaded.factory((name) => {
      required.push(name);
      if (name === 'react') return hooks.react;
      throw new Error(`工厂不该 require ${name}`);
    });

    let declaring = null;
    const ctx = {
      effect(fn, label) {
        // 记下 effect 首次执行返回的清理函数：同一个 fn 再调一次会开新的定时器，
        // 所以清理必须取第一次的那份，不能靠「重新跑一遍再清」。
        const cleanup = fn();
        effects.push({ fn, label, cleanup });
        return cleanup;
      },
      locale: {
        register(ns, dict) {
          dictionaries.set(ns, dict);
        },
        bind(ns) {
          const dict = dictionaries.get(ns);
          return (key) => dict.zh[key];
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
      // 与 Cordis 同形：绿点同步走 `ctx.inject([...], child => …)`，依赖齐了才回调，
      // 回调拿到的是子 ctx（服务挂在它的属性上）。`get` 只留给自检上报的探测用。
      // 不给 services 就整条不挂，让「没有桌面服务时不空转」这条门禁可测。
      inject(names, callback) {
        const list = Array.isArray(names) ? names : [names];
        if (!services || list.some((name) => !services[name])) return;
        const child = { effect: this.effect };
        for (const name of list) child[name] = services[name];
        callback(child);
      },
      ...(services ? { get: (name) => services[name] } : {}),
    };
    plugin.apply(ctx);
    assert.equal(registrations.length, 2, 'apply 注册设置那一项与侧边栏那颗图标');
    return plugin;
  }

  const byPathname = (pathname) => {
    const found = registrations.find((entry) => entry.pathname === pathname);
    assert.ok(found, `没有注册到 ${pathname}`);
    return found;
  };


  /**
   * 渲染侧边栏底部那颗图标；`preset` 按 useState 顺序预置槽位
   * （0 url / 1 webAccess / 2 panelScope / 3 failure / 4 anchored），`props` 覆盖 owner 给的 `wide`。
   */
  function renderFooter(preset, props = {}) {
    const registration = byPathname('sidebar.footer.action');
    const { t } = registration.inject();
    hooks.begin(preset);
    return registration.component({ wide: true, ...props, t });
  }

  /** 渲染「设置 → 移动端」那张薄卡；`preset` 按 useState 顺序（0 url / 1 scope / 2 access / 3 failure）。 */
  function renderSettings(preset) {
    const registration = byPathname('settings.section');
    const { t } = registration.inject();
    hooks.begin(preset);
    return registration.component({ t });
  }

  return {
    run,
    renderFooter,
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
    webAccess: { enabled: false, expiresAt: 0 },
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

test('两小时窗口开不出来时：不嵌那半张窗，把宿主的原话拍平写进诊断窗', async () => {
  // 2026-11-05 起点一下是「弹控制台」而不是「开浏览器窗口」，所以这里不再有空白页可关；
  // 要钉的是同一件事：**开不出来就必须说清楚**，不许留一屏空白或点了没反应。
  const cases = [
    [{ error: '直接一句' }, 500, '直接一句'],
    [{ error: { code: 'busy', message: '有任务在跑' } }, 409, 'busy: 有任务在跑'],
    [{}, 503, 'HTTP 503'],
  ];
  for (const [body, status, expected] of cases) {
    const env = materialize({
      fetch: async (url) => {
        if (String(url).endsWith('/status')) {
          return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'private' }) };
        }
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
    assert.equal(consoleFrame(env), undefined, '窗口没开成就不嵌：嵌进去只会是一屏 423');
    const dialog = diagnosisNode(env);
    assert.ok(dialog, '失败必须弹诊断窗：不许点了没反应');
    const text = texts(dialog).join('');
    assert.match(text, /开放网页管理失败/);
    assert.equal(text.includes(expected), true, `body=${JSON.stringify(body)} status=${status} → ${text}`);
    assert.match(text, new RegExp(`HTTP 状态.*${status}`, 's'));
    assert.match(text, /重新读取状态/);
    assert.match(text, /复制诊断信息/);
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

test('两个入口都注册着：设置里那一项与侧边栏那颗图标', () => {
  const env = materialize();
  assert.equal(env.registrations.length, 2, 'apply 注册设置项与侧边栏那颗图标');
  assert.equal(env.byPathname('settings.section').id, 'mobile');
  assert.equal(env.byPathname('sidebar.footer.action').id, 'mobile-web');
});

test('字典覆盖两张界面，中英一一对应', () => {
  const env = materialize();
  const dict = env.dictionaries.get(NS);
  assert.ok(dict, `${NS} 字典必须注册`);
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());
  // 键集逐个钉死：一张薄卡（配置页）+ 一颗图标 + 那张诊断窗，不长成第二个管理面板。
  assert.deepEqual(Object.keys(dict.zh).sort(), [
    'cardPanel',
    'consoleBack', 'consoleEntryConsole', 'consoleEntryConsoleHint', 'consoleEntryDebug',
    'consoleEntryDebugHint', 'consoleEntryLead', 'consoleEntryTitle',
    'consoleFrameless', 'consoleLead', 'consoleOpenBrowser', 'consolePopupBlocked', 'consoleTitle',
    'diagBusy', 'diagChecking', 'diagClose', 'diagCopied', 'diagCopy', 'diagCopyFailed',
    'diagFactActivated', 'diagFactOnDisk', 'diagFactPanelUrl', 'diagFactPlugin', 'diagFactReason',
    'diagFactRetry', 'diagFactReturned', 'diagFactScope', 'diagFactSelfcheck', 'diagFactShell',
    'diagFactSource', 'diagFactStatus', 'diagFactUnavailable', 'diagFactWindow',
    'diagHeadingFacts', 'diagHeadingSteps', 'diagOpenPanel', 'diagPopupBlocked', 'diagReload', 'diagReloadBusy',
    'diagReloadFailed', 'diagReloadOk', 'diagRetry', 'diagStepDuplicate', 'diagStepProxy',
    'diagStepReinstall', 'diagStepRestart', 'diagStepRetryOpen', 'diagStepRetrying',
    'diagSummaryLoadFailed', 'diagSummaryLoadMissing', 'diagSummaryNoError',
    'diagSummaryOpenFailed', 'diagSummaryRestored', 'diagSummaryUnreachable', 'diagTitleLoad',
    'diagTitleOpen', 'footerLoadMissing', 'footerOpen', 'footerPending', 'footerPublicConfirm',
    'heading', 'loadFailed', 'nav', 'openFailed', 'openHint', 'openPanel', 'panelMissing', 'panelPending'
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
  // 一张薄卡：配置页（标题/说明/一颗按钮）。
  assert.deepEqual(classNames(tree).filter((name) => name.startsWith('dshm_')), [
    'dshm_root', 'dshm_heading',
    'dshm_card', 'dshm_cardTitle', 'dshm_note', 'dshm_actions', 'dshm_btn dshm_btnPrimary',
  ], '配置页一张卡，标题 / 说明 / 那一颗按钮');
  const button = findByClass(tree, 'dshm_btnPrimary');
  assert.equal(button.props.href, undefined);
  assert.equal(button.props['aria-disabled'], 'false', '没地址也照样能点：点了会自己去开窗再取地址');
  assert.equal(texts(tree).includes('正在读取页面地址…'), true);
});

test('设置项：读状态被窗口门挡住（423）时，点它先开窗再取地址', async () => {
  const posts = [];
  let accessOpen = false;
  const env = materialize({
    fetch: async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        if (!accessOpen) return { ok: false, status: 423, json: async () => ({ ok: false, error: { code: 'web_access_closed', message: '暂未开放' } }) };
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'private' }) };
      }
      if (path.endsWith('/web-access')) {
        posts.push(JSON.parse(init.body));
        accessOpen = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled: true, expiresAt: 7_200_000 } }) };
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
  assert.deepEqual(posts, [{ enabled: true }]);
  assert.equal(env.openedWindows[0].location.href, readyStatus().panelUrl);
});

test('设置项：读到地址后按钮指向配置页，本机点击不拦也不开窗口', async () => {
  const env = materialize({ fetch: async () => ({ ok: true, status: 200, json: async () => readyStatus() }) });
  env.renderSettings();
  await env.hooks.flush();
  const button = findByClass(env.renderSettings(), 'dshm_btnPrimary');
  assert.equal(button.props.href, readyStatus().panelUrl);
  assert.equal(button.props['aria-disabled'], 'false');
  let prevented = false;
  await button.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, false, '回环地址就交给浏览器照常跳转');
  assert.equal(env.openedWindows.length, 0);
});

test('设置项：从别的机器打开的浏览器也先把两小时窗口开出来再跳', async () => {
  const posts = [];
  const env = materialize({
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'private' }) };
      }
      if (String(url).endsWith('/web-access')) {
        posts.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled: true, expiresAt: 7_200_000 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.renderSettings();
  await env.hooks.flush();
  const button = findByClass(env.renderSettings(), 'dshm_btnPrimary');
  let prevented = false;
  await button.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true, '要先把默认跳转拦下来，等窗口开好再导航');
  assert.deepEqual(posts, [{ enabled: true }]);
  assert.equal(env.openedWindows[0].location.href, readyStatus().panelUrl);
});

/* ── 5. 侧边栏底部那颗手机图标（唯一的入口）─────────────────────────────
 * 用户要的是「侧边栏最底下、头像那一行里加一颗手机图标，点一下进网页」。外壳那一行
 * 没有给插件留座位，所以这一颗是自己插进去的：认位置只认插槽出口的 `data-slot` 标记，
 * 插进去之后那一行的设置按钮自己让出宽度；认不出来就退回 `sidebar.footer.action`
 * 自己那一行，入口不能消失。
 *
 * 点下去做什么，取决于宿主在 `/status` 上报的 `panelScope`（面板地址落在哪类网络上）：
 * 本机回环直接跳转；局域网静默把那两小时窗口打开；公网先弹一句确认。
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

/** 弹窗里那颗按钮（按文案找）。 */
function dialogButton(env, label) {
  const dialog = diagnosisNode(env);
  if (!dialog) return undefined;
  // 弹窗是命令式 DOM，元素的 tag 在 `node.tag`；react 元素才用 `node.type`。
  return elements(dialog).find((node) => (node.tag === 'button' || node.type === 'button') && texts(node).join('') === label);
}

/** 那一行里被我们插进去的那颗（没有返回 undefined）。 */
function footerDomNode(sidebar) {
  return [...sidebar.row.children].find((node) => node.attrs[FOOTER_MARK] !== undefined);
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
  // 紧跟在头像出口后面、在连接状态/更新提示前面：那一行里设置按钮是 flex:1，
  // 它自己让出宽度，所以谁都不会被盖住。
  assert.equal(node.previousSibling, sidebar.outlet);
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

test('重复渲染不会插出第二颗', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({ sidebar });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const ours = [...sidebar.row.children].filter((node) => node.attrs[FOOTER_MARK] !== undefined);
  assert.equal(ours.length, 1);
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

test('宿主没给地址：不挂死链，但点它自己开窗取地址再嵌控制台（不再是死图标）', async () => {
  const sidebar = fakeSidebarRow();
  const posts = [];
  let accessOpen = false;
  const env = materialize({
    sidebar,
    fetch: async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        // 窗口关着时，非本机浏览器读到的是 423（`/status` 自己也在窗口门后面）。
        if (!accessOpen) {
          return { ok: false, status: 423, json: async () => ({ ok: false, error: { code: 'web_access_closed', message: '网页管理暂未开放' } }) };
        }
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'private' }) };
      }
      if (path.endsWith('/web-access')) {
        posts.push(JSON.parse(init.body));
        accessOpen = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled: true, expiresAt: 7_200_000 } }) };
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
  assert.deepEqual(posts, [{ enabled: true }], '先开两小时窗口——这是远程用户唯一能走通的顺序');
  assert.equal(env.openedWindows.length, 0, '开完窗口是**弹这一窗**，不是再开一个浏览器窗口');
  await openDebugLayer(env);
  assert.equal(consoleFrame(env).attrs.src, debugPageOf(), '开完窗再读一次状态，地址就拿到了');
  // 一进来就嵌着控制台：这一下不是「诊断」，是那一屏本身。
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

test('只是还没读到地址、或者窗口关着被回 423：不算插件坏了，不转红', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    // 远程用户第一眼的现场：窗口关着，`/status` 回 423（不是 404）。
    fetch: async () => ({ ok: false, status: 423, json: async () => ({}) }),
  });
  env.renderFooter();
  await env.hooks.flush();
  env.renderFooter();
  await env.hooks.flush();
  const node = footerDomNode(sidebar);
  assert.equal(node.attrs[FOOTER_ALERT], undefined, '423 是正常态，红点一亮就成了每开一次页面都报的假警');
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
  assert.match(SOURCE, /\}, \[wide, url, openLabel, loadMissingLabel, pendingLabel, problem, panelScope, webAccess\]\);/);
});

test('地址问不到时会自己再问，问到了就停（不再打宿主）', async () => {
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

  // 取到地址之后定时器要收掉：再走一轮不该多打一次宿主。
  const after = statusCalls;
  await env.timers.tick(20000);
  assert.equal(statusCalls, after, '地址取到之后不该再轮询');
});

/* ── 5b. 点下去做什么：弹两层（2026-11-05 用户改的）─────────────────────
 * 第一层只有一个简单入口：左「进入控制台」（= 原来那个跳转）、右「报错调试」。
 * 第二层才是那一屏读数（网页版的 `/api/relay/panel/debug`，按同源地址嵌进 iframe）。
 *
 * 为什么分两层：原来点图标一上来就是整屏读数，太重；绝大多数时候人只是想去配置页，
 * 或者去看手机为什么连不上。
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

/** 第一层那两块按钮里的一块（按文案找）。 */
function choiceButton(env, label) {
  const dialog = diagnosisNode(env);
  if (!dialog) return undefined;
  return elements(dialog).find(
    (node) => node.tag === 'button' && String(node.className || '').split(/\s+/).includes('dshm_choice') && texts(node)[0] === label,
  );
}

/** 把弹窗点到第二层（那一屏调试页）。 */
async function openDebugLayer(env) {
  const debug = choiceButton(env, '报错调试');
  assert.ok(debug, '第一层要有「报错调试」那一块');
  if (typeof debug.onclick === 'function') await debug.onclick();
  else await debug.props.onClick();
  await settle();
}

/** 调试页地址：按页面自身的同源地址推（`consoleUrlOf` 就是这么算的）。 */
function debugPageOf() {
  return 'http://127.0.0.1:56495/api/relay/panel/debug';
}

/** 只给一颗图标用的环境：`panelScope` 与窗口状态由调用方定。 */
function clickEnv({ panelScope = 'loopback', webAccess = { enabled: false, expiresAt: 0 }, confirm = true, pageProtocol = 'http:' } = {}) {
  const posts = [];
  const env = materialize({
    confirm,
    pageProtocol,
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope, webAccess }) };
      }
      if (String(url).endsWith('/web-access')) {
        posts.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled: true, expiresAt: 7_200_000 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  return { env, posts };
}

/** 渲染窄条那颗（自己占一行，点击处理器直接挂在元素上，最好驱动）。 */
async function railIcon(env) {
  env.renderFooter({}, { wide: false });
  await env.hooks.flush();
  return env.renderFooter({}, { wide: false });
}

test('本机回环：点下去先弹一个简单入口，左「进入控制台」右「报错调试」', async () => {
  const { env, posts } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  let prevented = false;
  await icon.props.onClick({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true, '点击一律先拦下来：这一下是弹窗，不是导航');
  assert.equal(env.openedWindows.length, 0, '第一层不许跳走');
  assert.deepEqual(posts, [], '本机浏览器控制面本来就认，不必开那两小时窗口');
  // 第一层只有两块，**没有 iframe**：那一屏读数得再点一下才进来。
  assert.equal(consoleFrame(env), undefined, '第一层不该直接摆整屏读数');
  assert.ok(choiceButton(env, '进入控制台'), '左边那块是进控制台');
  assert.ok(choiceButton(env, '报错调试'), '右边那块是报错调试');
  const choices = elements(diagnosisNode(env)).filter((node) =>
    String(node.className || '').split(/\s+/).includes('dshm_choice'),
  );
  assert.equal(choices.length, 2, '第一层就两块，不多不少');
});

test('入口右侧「报错调试」才进那一屏读数；「返回」回得来', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  await openDebugLayer(env);
  const frame = consoleFrame(env);
  assert.ok(frame, '第二层才嵌那一整页');
  assert.equal(frame.attrs.src, debugPageOf(), '嵌的是同源的调试页');
  assert.equal(frame.attrs.title, '移动端插件控制台');
  await clickDialogButton(env, '返回');
  assert.equal(consoleFrame(env), undefined, '返回之后回到第一层，iframe 撤掉');
  assert.ok(choiceButton(env, '报错调试'), '第一层那两块还在');
});

test('局域网地址：先把两小时窗口开了，再弹入口；进调试那层才有 iframe', async () => {
  const { env, posts } = clickEnv({ panelScope: 'private' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.deepEqual(posts, [{ enabled: true }], '远程浏览器要先开窗口，否则嵌进来是一屏 423');
  assert.equal(env.confirms.length, 0, '局域网不再问第二遍');
  assert.equal(env.openedWindows.length, 0, '只弹窗，不导航');
  assert.ok(choiceButton(env, '报错调试'), '先到入口那一层');
  await openDebugLayer(env);
  assert.equal(consoleFrame(env).attrs.src, debugPageOf());
});

test('公网地址：先弹一句确认，取消就什么都不做', async () => {
  const { env, posts } = clickEnv({ panelScope: 'public', confirm: false });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(env.confirms.length, 1, '公网地址必须先问一句');
  assert.match(env.confirms[0], /位于公网[\s\S]*2 小时/);
  assert.deepEqual(posts, [], '取消之后一个写请求都不许发');
  assert.equal(diagnosisNode(env), undefined, '取消就什么都不弹');
});

test('公网地址：确认之后开窗口再嵌控制台', async () => {
  const { env, posts } = clickEnv({ panelScope: 'public', confirm: true });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(env.confirms.length, 1);
  assert.deepEqual(posts, [{ enabled: true }]);
  await openDebugLayer(env);
  assert.ok(consoleFrame(env));
  assert.equal(env.openedWindows.length, 0);
});

test('窗口已经开着：不再确认也不再重复开（不续期），照样弹控制台', async () => {
  const { env, posts } = clickEnv({
    panelScope: 'public',
    webAccess: { enabled: true, expiresAt: 7_000_000 },
  });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.equal(env.confirms.length, 0);
  assert.deepEqual(posts, [], '开着就直接用，别又续一次两小时');
  await openDebugLayer(env);
  assert.ok(consoleFrame(env));
});

test('第二层那颗「在浏览器里打开」仍然能把配置页开出去', async () => {
  const { env } = clickEnv({ panelScope: 'loopback' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  await openDebugLayer(env);
  const button = dialogButton(env, '在浏览器里打开配置页面');
  assert.ok(button, '跳转没被取消，只是挪进了这一屏');
  if (typeof button.onclick === 'function') await button.onclick();
  else await button.props.onClick();
  await settle();
  assert.equal(env.openedWindows.length, 1, '按了才开浏览器窗口');
  assert.equal(env.openedWindows[0].location.href, readyStatus().panelUrl);
  assert.equal(consoleFrame(env), undefined, '开出去就把这一窗收掉');
});

test('桌面壳里的页面（dsh-app:）：照样就地嵌，页面不被导航走', async () => {
  // 桌面版前端跑在 `dsh-app://app`（Electron 的安全协议）下，所以 iframe 的地址必须按页面
  // 自身的同源地址推，**不能**用宿主报的那个 http 绝对地址（那是跨协议、会被当混合内容挡掉）。
  // 这一条钉的就是「地址来源是同源 baseURI，而不是 panelUrl」。
  const { env, posts } = clickEnv({ panelScope: 'private', pageProtocol: 'dsh-app:' });
  const icon = await railIcon(env);
  await icon.props.onClick({ preventDefault() {} });
  await settle();
  assert.deepEqual(posts, [{ enabled: true }], '两小时窗口照开：从别的机器打开这一页要用它');
  assert.equal(env.openedWindows.length, 0, '壳里 `window.open` 一定被拒，先开一个空窗口只会盖一屏黑的出来');
  assert.equal(
    env.sandbox.window.location.href,
    'http://127.0.0.1:56495/',
    '整个页面不许被导航走：这一下是弹窗',
  );
  await openDebugLayer(env);
  assert.ok(consoleFrame(env), '壳里同样要能进那一屏调试页');
});

test('插进那一行的那颗也走同一套点击逻辑', async () => {
  const sidebar = fakeSidebarRow();
  const env = materialize({
    sidebar,
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, status: 200, json: async () => readyStatus({ panelScope: 'public' }) };
      }
      if (String(url).endsWith('/web-access')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled: true, expiresAt: 7_200_000 } }) };
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
  assert.equal(env.confirms.length, 1);
  assert.ok(choiceButton(env, '报错调试'), '插进那一行的那颗点下去也是同一个入口');
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
    ['mobile-plugin: settings dictionaries', 'mobile-plugin: 客户端半边自检上报'],
    '没有桌面服务时只该有字典与自检上报两条 effect',
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

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
const VIEW_ENDPOINT = 'api/relay/desktop-view';
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

/** 元素树里的所有字符串叶子。 */
function texts(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (node == null || typeof node !== 'object') return out;
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
 * 建一个沙箱。`createEnv().run()` 可以在同一个沙箱里反复物化工厂——用来验证
 * 「样式只注入一次」这类跨次行为。
 *
 * `options.services` 是**可选**的桌面端服务表，对应运行时的 `ctx.get(name)`。
 * 不给就没有 `ctx.get`：两条绿点同步会整条不启动（它们依赖桌面端的 uiSession /
 * sessions 服务，拿不到就是空转），于是所有既有断言维持原样。
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
  let loaded = null;

  const document = {
    head: { appendChild: (node) => styles.push(node) },
    hidden: false,
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(selector);
      if (!match) return null;
      return styles.find((tag) => tag.dataset.pluginCss === match[1]) || null;
    },
    createElement: (tag) => ({ tag, dataset: {} }),
  };

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (descriptor) => { loaded = descriptor; } },
      confirm: () => true,
    },
    document,
    localStorage: storage,
    navigator: { clipboard: { writeText: async (text) => clipboardWrites.push(text) } },
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
    assert.equal(registrations.length, 1, 'apply 必须注册且只注册一个设置项');
    return plugin;
  }

  /** 渲染设置页签；`preset` 按 useState 顺序预置槽位。 */
  function render(preset) {
    const { t } = registrations[0].inject();
    hooks.begin(preset);
    return registrations[0].component({ t });
  }

  return {
    run,
    render,
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
    get registration() {
      return registrations[0];
    },
  };
}

/** 建好并物化一次的常用环境。 */
function materialize(options = {}) {
  const env = createEnv(options);
  env.run();
  return env;
}

/** 一份够用的宿主状态，让设置项进入「已就绪」分支。 */
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
  assert.equal(env.styles[0].dataset.pluginCss, 'dsh-mobile-plugin/settings-tab.css');
  assert.match(env.styles[0].textContent, /\.dshm_root\{/);
  env.run();
  env.run();
  assert.equal(env.styles.length, 1, '重复物化必须复用同一份样式');
});

/* ── 2. 桌面展开态 → 宿主 ──────────────────────────────────────────────── */

test('展开态同步：取版本最大的键并 POST 给宿主', async () => {
  const env = materialize({
    storage: createStorage({
      'dsh.workspace.view.v5': JSON.stringify({ groupExpansion: { a: true, b: false } }),
      'dsh.workspace.view.v9': JSON.stringify({ groupExpansion: { z: true } }),
      'unrelated.key': '{}',
    }),
  });
  await settle();

  const push = syncCalls(env).find((c) => String(c.url).endsWith(VIEW_ENDPOINT));
  assert.ok(push, '必须 POST 到 /api/relay/desktop-view');
  assert.equal(push.init.method, 'POST');
  assert.equal(push.init.credentials, 'same-origin');
  assert.equal(push.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(push.init.body), {
    source: 'dsh.workspace.view.v9',
    groupExpansion: { z: true },
  });
});

test('展开态同步：只取布尔值，并容忍 {state} 包装', async () => {
  const env = materialize({
    storage: createStorage({
      'dsh.workspace.view.v3': JSON.stringify({
        state: { groupExpansion: { keep: true, drop: 'yes', also: false, n: 1 } },
      }),
    }),
  });
  await settle();
  const push = syncCalls(env).find((c) => String(c.url).endsWith(VIEW_ENDPOINT));
  assert.deepEqual(JSON.parse(push.init.body).groupExpansion, { keep: true, also: false });
});

test('展开态同步：没有可读的展开态时一个请求都不发', async () => {
  const env = materialize({ storage: createStorage({ 'other.key': '{}' }) });
  await settle();
  assert.equal(syncCalls(env).length, 0);
  await env.timers.tick(2000);
  assert.equal(syncCalls(env).length, 0);
});

test('展开态同步：内容没变就不重复 POST（2s 轮询的成本压到最低）', async () => {
  const env = materialize({
    storage: createStorage({ 'dsh.workspace.view.v5': JSON.stringify({ groupExpansion: { a: true } }) }),
  });
  await settle();
  await env.timers.tick(2000);
  await env.timers.tick(2000);
  assert.equal(syncCalls(env).length, 1);
});

test('展开态同步：宿主返回非 2xx 时不记住这次内容，下一轮重试', async () => {
  const env = materialize({
    storage: createStorage({ 'dsh.workspace.view.v5': JSON.stringify({ groupExpansion: { a: true } }) }),
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await settle();
  await env.timers.tick(2000);
  assert.equal(syncCalls(env).length, 2);
});

test('展开态同步：effect 清理后定时器被收掉，不再发请求', async () => {
  const env = materialize({
    storage: createStorage({ 'dsh.workspace.view.v5': JSON.stringify({ groupExpansion: { a: true } }) }),
  });
  await settle();
  assert.equal(syncCalls(env).length, 1);
  const entry = env.effects.find((e) => !e.label);
  assert.ok(entry, '桌面视图同步必须走 ctx.effect');
  assert.equal(typeof entry.cleanup, 'function', 'effect 必须返回清理函数，否则卸载后还在轮询');
  const before = env.timers.count;
  entry.cleanup();
  await env.timers.tick(2000);
  assert.equal(syncCalls(env).length, 1, '卸载之后不能再发请求');
  // 只剩客户端半边自检上报那一个定时器：它是独立 effect，不归展开态这条管。
  assert.equal(env.timers.count, before - 1, '卸下展开态同步时它自己的定时器要收掉');
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

test('页签的取状态请求走文档相对的 api/relay/status 且同源', async () => {
  const { impl, calls } = routedFetch({ '/status': { body: readyStatus() } });
  const env = materialize({ fetch: impl });
  env.render();
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
  // 写成 `/api/...` 时，DSH 被反代挂到 `/dsh/` 下就会打到站点根，设置页现场是
  // 「读取宿主状态失败: HTTP 404」。
  const env = materialize();
  await settle();
  await env.timers.tick(2000);
  await env.timers.tick(10000);
  const absolute = env.fetchCalls
    .map((entry) => String(entry.url))
    .filter((url) => url.startsWith('/'));
  assert.deepEqual(absolute, [], `这些请求仍是站点根绝对地址：${absolute.join(' | ')}`);
});

test('宿主半边没加载（404）时说清怎么处理，不甩一句 HTTP 404', async () => {
  const env = materialize({
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  env.render();
  await env.hooks.flush();
  const text = texts(env.render()).join('');
  assert.match(text, /插件宿主侧没有加载/);
  assert.match(text, /完整退出再打开|插件市场重装/);
  assert.equal(text.includes('HTTP 404'), false);
});

test('404 时问外壳要原因：贴出宿主自己的说法，并给一颗「重新装载」', async () => {
  // 老宿主没有 `/api/relay/host-half`（也 404），这条口问不到就当没有 —— 上面那条用例
  // 钉的就是这个回退：只剩 loadMissing，不许多出一句报错。
  const calls = [];
  let reloaded = 0;
  const env = materialize({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/status')) return { ok: false, status: 404, json: async () => ({}) };
      if (String(url).endsWith('/host-half/reload')) {
        reloaded += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, half: { lastError: null, retrying: false } }),
        };
      }
      if (String(url).endsWith('/host-half')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            half: { lastError: '装载 0.5.0 超时：它可能卡在等一个永远不来的依赖服务上', retrying: true },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  env.render();
  await env.hooks.flush();

  const tree = env.render();
  const text = texts(tree).join('');
  assert.match(text, /插件宿主侧没有加载/);
  assert.match(text, /装载 0\.5\.0 超时/);
  assert.match(text, /还在后台自己重试/);

  const button = elements(tree)
    .find((node) => node.type === 'button' && texts(node).join('') === '重新装载');
  assert.ok(button, '装载失败时要有「重新装载」，否则用户只能重启整个 DSH');
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  // 这里刻意用 settle 而不是 hooks.flush：flush 会再跑一遍挂载 effect（3 秒轮询那条），
  // 于是刚拿回来的「已装好」又被下一次 404 自检覆盖掉，测的就不是这一次重装了。
  await settle();

  assert.equal(reloaded, 1);
  const post = calls.find((call) => call.url.endsWith('/host-half/reload'));
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.credentials, 'same-origin');
  // 重装成功之后原因就不该再挂在界面上。
  assert.equal(texts(env.render()).join('').includes('装载 0.5.0 超时'), false, texts(env.render()).join(' | '));
});

test('errorText 把三种错误形状拍平成一句话', async () => {
  const cases = [
    [{ error: '直接一句' }, 500, '直接一句'],
    [{ error: { code: 'busy', message: '有任务在跑' } }, 409, 'busy: 有任务在跑'],
    [{ error: { message: '只有消息' } }, 400, '只有消息'],
    [{ error: { code: 'only-code' } }, 400, 'only-code'],
    [{ error: { code: '', message: '' } }, 503, 'HTTP 503'],
    [{}, 503, 'HTTP 503'],
  ];
  for (const [body, status, expected] of cases) {
    const env = materialize({
      fetch: async () => ({ ok: false, status, json: async () => body }),
    });
    env.render();
    await env.hooks.flush();
    const tree = env.render();
    const classes = classNames(tree);
    assert.ok(classes.includes('dshm_error'), `body=${JSON.stringify(body)} 应走错误分支`);
    assert.ok(
      texts(tree).includes(`读取宿主状态失败: ${expected}`),
      `body=${JSON.stringify(body)} status=${status} → 期望 ${expected}，实际 ${texts(tree).join('|')}`,
    );
  }
});

test('正文不是 JSON 时按空对象处理，仍然拍出 HTTP 状态码', async () => {
  const env = materialize({
    fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } }),
  });
  env.render();
  await env.hooks.flush();
  assert.ok(texts(env.render()).includes('读取宿主状态失败: HTTP 502'));
});

test('网络异常（fetch 直接 reject）也变成可读的一行', async () => {
  const env = materialize({
    fetch: async () => { throw new Error('connection refused'); },
  });
  env.render();
  await env.hooks.flush();
  assert.ok(texts(env.render()).includes('读取宿主状态失败: connection refused'));
});

/* ── 4. 设置项（设置菜单里的顶层一项） ─────────────────────────────────── */

test('设置项注册信息：id=mobile、order=20、槽名走 settings.section、标签走字典', () => {
  const env = materialize();
  const registration = env.registration;
  assert.equal(registration.id, 'mobile');
  assert.equal(registration.order, 20);
  // 槽名是设置菜单顶层一项（settings.section），不是内置插件页里的页签
  // （settings.plugins.tab）——搬错了这一页会静默不出现。
  assert.equal(registration.pathname, 'settings.section');
  assert.equal(registration.locale, NS);
  assert.equal(registration.label(), '移动端');
  assert.equal(typeof registration.component, 'function');
});

test('字典注册在启动时一次性完成，且中英键一一对应', () => {
  const env = materialize();
  const dict = env.dictionaries.get(NS);
  assert.ok(dict, `${NS} 字典必须注册`);
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());
  // 键集**逐个钉死**：客户端 UI 只保留网页入口、本机临时访问开关，以及 404 时那条
  // 「宿主为什么没起来」的自检口，不长成第二个管理面板。
  assert.deepEqual(Object.keys(dict.zh).sort(), [
    'cardPanel', 'heading', 'hostHalfReason', 'hostHalfReload', 'hostHalfReloadFailed', 'hostHalfRetrying',
    'loadFailed', 'loadMissing', 'nav', 'openHint', 'openPanel', 'panelMissing', 'panelPending',
    'webAccessClose', 'webAccessError', 'webAccessHint', 'webAccessOff', 'webAccessOn', 'webAccessOpen', 'webAccessUnavailable',
  ]);
  assert.equal(env.effects.some((e) => String(e.label).includes('dictionaries')), true);
});

/* ── 5. 设置页保留一个薄卡片：网页入口 + 本机临时访问开关 ────────────────
 * 界面本体（连接状态、配对、中转配置、维护）仍在宿主吐出的网页；这里的开关只限时开放网页管理，
 * 必须由可信本机设置入口操作。插件更新仍交给 DSH 市场，避免再长出第二个管理面板。
 *
 * 下面反向钉住：单卡、绝对地址新标签链接、默认关、窗口固定到期、请求不续期，移动 API 不变。
 */

test('设置项仍只有一张卡：网页入口与本机开关', () => {
  const env = materialize();
  const cards = elements(env.render({ 0: readyStatus().panelUrl }))
    .filter((node) => node.type === 'section');
  assert.deepEqual(cards.map((node) => node.props.key), ['panel']);
});

test('网页入口是绝对地址的新标签页链接，不是同页跳转', () => {
  const env = materialize();
  const link = elements(env.render({ 0: readyStatus().panelUrl })).find((node) => node.type === 'a');
  assert.ok(link, '拿得到 panelUrl 就该渲染成 <a>');
  assert.equal(link.props.href, readyStatus().panelUrl);
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noreferrer');
  assert.equal(texts(link).join(''), '打开配置页面');
  // 相对地址在桌面端会被解析成 `dsh-app://`，而 Electron 只把 http(s) 交给浏览器，
  // 其它协议静默丢弃（点了没反应）—— 所以宿主必须给绝对地址，这里钉住。
  assert.match(link.props.href, /^https?:\/\//);
});

test('本机设置入口通过同源 POST 开关网页窗口，开放固定两小时文案且可关闭', async () => {
  const calls = [];
  let enabled = false;
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/status')) {
      return { ok: true, status: 200, json: async () => readyStatus({ webAccess: { enabled, expiresAt: enabled ? 7_200_000 : 0 } }) };
    }
    if (String(url).endsWith('/web-access')) {
      enabled = JSON.parse(init.body).enabled;
      return { ok: true, status: 200, json: async () => ({ ok: true, webAccess: { enabled, expiresAt: enabled ? 7_200_000 : 0 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const env = materialize({ fetch });
  env.render();
  await env.hooks.flush();

  let button = elements(env.render()).find((node) => node.type === 'button' && node.props.onClick);
  assert.ok(button);
  assert.equal(texts(button).join(''), '开放网页管理 2 小时');
  const hint = elements(env.render()).find((node) => node.type === 'p' && texts(node).join('').includes('默认关闭'));
  assert.ok(hint);
  assert.match(texts(hint).join(''), /关闭后公网不可访问，本机和局域网仍可访问/);
  await button.props.onClick();
  button = elements(env.render()).find((node) => node.type === 'button' && node.props.onClick);
  assert.equal(texts(button).join(''), '立即关闭网页管理');
  await button.props.onClick();

  const posts = calls.filter((call) => String(call.url).endsWith('/web-access'));
  assert.deepEqual(posts.map((call) => JSON.parse(call.init.body).enabled), [true, false]);
  assert.ok(posts.every((call) => call.init.method === 'POST' && call.init.credentials === 'same-origin'));
  assert.ok(calls.some((call) => String(call.url).endsWith('/status')));
});

test('还没问到地址、或宿主没给地址时，入口是禁用的按钮而不是死链', () => {
  const env = materialize();
  const pending = env.render();
  assert.equal(elements(pending).some((node) => node.type === 'a'), false, '不知道地址时不该有链接');
  const placeholder = elements(pending)
    .find((node) => node.type === 'button' && node.props.disabled === true);
  assert.ok(placeholder, '要有一个禁用的占位按钮');
  assert.equal(texts(placeholder).join(''), '正在读取页面地址…');

  const noUrl = env.render({ 0: '' });
  assert.equal(elements(noUrl).some((node) => node.type === 'a'), false, '宿主没给地址时也不能给链接');
  assert.ok(texts(noUrl).includes('宿主还没给出页面地址，稍后再打开这一页试试。'));
});

test('旧界面没有长回来：连接状态 / 配对 / 中转配置 / 维护 / 故障台账都不再渲染', () => {
  const env = materialize();
  const tree = env.render({ 0: readyStatus().panelUrl });
  const joined = texts(tree).join(' ');
  for (const gone of [
    '连接状态', '配对与二维码', '中转配置', '维护', '故障台账', '概览',
    '重新生成配对码', '吊销全部设备授权', '注册密钥', '局域网端口',
  ]) {
    assert.equal(joined.includes(gone), false, `「${gone}」已经搬进网页版，不该还留在这里`);
  }
  // 版式整理时按用户要求删掉的三处描述文字，跟着整块界面一起走了，别回来。
  assert.equal(/都在这里管理|插件能自己换实现|可重启范围/.test(joined), false);
  assert.equal(
    classNames(tree).some((name) => name.startsWith('dshm_modal')),
    false,
    '配置弹窗也搬去网页版了',
  );
});

test('插件自己不再更新：这一半里没有自更新残留（路由、状态点、旧卡片样式）', () => {
  // 自更新（`/api/relay/update/*`、`.live` 代机制、绿点状态点、dl 信息行）整套已经拆掉，
  // 更新改走 npm（DSH 插件市场）。这里按源码反查，免得哪天又悄悄长回来。
  for (const gone of ['/update/status', '/update/check', '/update/apply', '/update/reload']) {
    assert.equal(SOURCE.includes(gone), false, `${gone} 已经不存在了：插件不再自己更新`);
  }
  for (const cls of ['dshm_dot', 'dshm_row', 'dshm_mono', 'dshm_noteBad', 'dshm_cardTitle']) {
    const expected = cls === 'dshm_cardTitle';
    assert.equal(
      new RegExp(`\\.${cls}\\{`).test(SOURCE),
      expected,
      expected ? '卡片标题还在用，样式要在' : `.${cls} 只属于拆掉的更新卡片 / 信息行，样式该一起删`,
    );
  }
  assert.equal(/\bimplVersion\b|\bupdateNeedsRestart\b|\bcardUpdate\b/.test(SOURCE), false, '旧更新卡片的字典键不许回来');
});


/* ── 6. 侧边栏未读绿点的双向同步 ─────────────────────────────────────────
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
    ['mobile-plugin: settings dictionaries', undefined, 'mobile-plugin: 客户端半边自检上报'],
    '没有桌面服务时只该有字典、展开态与自检上报三条 effect',
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
    '辅助函数一处定义 + 两条同步 + 抓会话清单服务各一处调用',
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
      undefined,
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

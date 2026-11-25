// T14：用真实监听端口驱动配置与组件回调，覆盖取消、探测、地址状态及对应变异。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'React/src');
const appManifest = path.join(ROOT, '../app/package.json');
const runtimeOptions = { skip: fs.existsSync(appManifest) ? false : '主仓 app/ 不在场，缺少 TS 测试转译器' };
const requireApp = fs.existsSync(appManifest) ? createRequire(appManifest) : null;
const babel = requireApp ? requireApp('@babel/core') : null;
const preset = requireApp ? requireApp.resolve('@react-native/babel-preset') : null;
const text = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const t = (key, params = {}) => key + (params.target ? `:${params.target}` : '');
const PUBLIC_RELAYS = [{ url: 'https://public.example' }];
const isPublicRelayUrl = (url) => PUBLIC_RELAYS.some((item) => item.url === url.replace(/\/+$/, ''));

/** 沿用现有 Babel/VM 与最小 hooks 假体，执行实际 TSX 导出的回调及 effect。 */
function component(file, name, imports = {}, context = {}, mutate = (source) => source) {
  let cursor = 0;
  const slots = [];
  let effects = [];
  const element = (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.flat(Infinity) } : {}) } });
  const react = {
    createElement: element, Fragment: 'Fragment',
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; }];
    },
    useRef(initial) { const at = cursor++; return slots[at] ||= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (!previous || !deps || deps.some((value, i) => value !== previous.deps[i])) {
        effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: fn() }; });
      }
    },
  };
  const module = { exports: {} };
  const code = babel.transformSync(mutate(text(file)), { filename: file, presets: [preset], configFile: false, babelrc: false }).code;
  const ui = new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : key === 'buttonVariants' ? () => '' : key });
  const requireStub = (id) => {
    if (id.startsWith('@babel/runtime/')) return requireApp(id);
    if (id === 'react') return { ...react, default: react, __esModule: true };
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), jsxDEV: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (Object.hasOwn(imports, id)) return imports[id];
    if (id.includes('i18n/index')) return { t };
    if (id.includes('links.ts')) return { PUBLIC_RELAYS, isPublicRelayUrl };
    if (id.includes('format.ts')) return { cn: (...values) => values.filter(Boolean).join(' '), timeText: String };
    if (id.includes('latency-sparkline.ts')) return { latencyLevel: () => 'fast', latencySparklinePath: () => '', latencyColorClass: () => '', latencyStrokeColor: () => '' };
    if (id.includes('embed-visibility')) return { pageVisible: () => true };
    if (id.includes('panel-load')) return { reportPanelState() {} };
    if (id.includes('notify')) return { useNotify: () => () => {} };
    // 2026-11-20：Console 现在也接 selfcheck（连接状态变就重查），这里补一份最小桩，
    // 只为了让渲染路径跑通，断言仍落在 api 调用与回调上。
    if (id.includes('selfcheck.ts')) return {
      mobileLooksIdle: () => false,
      useSelfCheck: () => ({ data: null, checking: false, error: '', missing: false, ensure() {}, refresh() {} }),
      selfCheckRow: () => ({ tone: 'off', text: 'panel.selfcheck.notChecked' }),
    };
    // 港口兜底引导弹窗不在这条守卫的射程内，给个不渲染的桩，让 Console 的渲染路径跑通。
    if (id.includes('PortConflictDialog')) return { PortConflictDialog: () => null, portConflictReason: (reason) => reason };
    return ui;
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: requireStub, AbortController, performance,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, confirm: () => true },
    document: { addEventListener() {}, removeEventListener() {} }, ...context });
  return {
    render(props = {}) { cursor = 0; effects = []; return module.exports[name](props); },
    flush() { const pending = effects; effects = []; for (const effect of pending) effect(); },
  };
}
function nodes(root, type) {
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap((item) => nodes(item, type));
  return [...(root.type === type ? [root] : []), ...nodes(root.props?.children, type)];
}
const button = (root, key) => nodes(root, 'Button').find((item) => JSON.stringify(item.props.children).includes(key));
const STATUS = { enabled: true, relayUrl: '', name: 'host', tunnel: { state: 'off' }, lan: { state: 'listening', port: 18787 }, sidecar: {}, mirror: {}, pairingPolicy: 'code' };
const BOOK = { port: 18787, lan: [], public: [], ipv6: [], manualTcp: '' };

test('PLUG-30 合约变更：FRP 改独立「导入」弹窗，保存即时启动（不再暂存父窗）', runtimeOptions, () => {
  // 2026-11-22 需求变更：FRP 从「TCP 栏的导入 + 父窗保存才启动」改成独立分区的「导入」弹窗，
  // 弹窗里粘贴配置并点「保存并启动」即调用 importFrp；不再有 pendingFrp / FrpImportDialog 那套
  // 暂存到父窗保存的链路。
  const dialog = text('components/RelayConfigDialog.tsx');
  assert.match(dialog, /setFrpDialogOpen\(true\)/, '导入按钮打开 FRP 弹窗');
  assert.match(dialog, /<textarea[\s\S]*?value=\{frpText\}/, '弹窗内粘贴 frpc 配置');
  assert.match(dialog, /saveFrp/, '保存并启动走 saveFrp');
  assert.ok(!/pendingFrp/.test(dialog), '不再把导入结果暂存到父窗保存');
  assert.ok(!/<FrpImportDialog/.test(dialog), '父窗不再渲染解析式导入弹窗');
});

test('PLUG-29/30 子窗执行纯解析，INI 提示且不回填，JSON 保留到父保存', runtimeOptions, () => {
  const imported = [];
  const env = component('components/FrpImportDialog.tsx', 'FrpImportDialog', {
    '../lib/frp-config.ts': { parseFrpConfig: () => ({ ok: true, field: 'tcp', value: 'example.com:22' }) },
    '../lib/api.ts': { importFrp() { throw new Error('子窗不应访问宿主'); } },
  });
  const props = { open: true, onImport: (value) => imported.push(value), onOpenChange() {} };
  let tree = env.render(props);
  nodes(tree, 'Textarea')[0].props.onChange({ target: { value: '[common]\nserver_addr = example.com' } });
  tree = env.render(props); button(tree, 'panel.frp.fill').props.onClick();
  assert.equal(imported.length, 0);
  assert.match(JSON.stringify(env.render(props)), /panel.frp.iniUnsupported/);
  nodes(tree, 'Textarea')[0].props.onChange({ target: { value: '{"serverAddr":"example.com","proxies":[]}' } });
  tree = env.render(props); button(tree, 'panel.frp.fill').props.onClick();
  assert.match(imported[0].config, /^\{/);
});

async function consoleEnvironment(overrides = {}) {
  const calls = [];
  const api = {
    pairingRenewIn: () => null, errorText: (error) => error.message,
    // Console 会读港口的冲突原因决定要不要弹兜底引导，这里给「没有待处理问题」。
    lanFallbackReason: () => '',
    apiGet: async (url) => { calls.push(['get', url]); return url.includes('status') ? STATUS : url.includes('addresses') ? BOOK : {}; },
    apiPost: async (url, body) => { calls.push(['post', url, body]); return STATUS; },
    importFrp: async () => { calls.push(['import']); return { ok: true, status: { running: true, error: '', remoteAddress: 'example.com:6000' } }; },
    stopFrp: async () => { calls.push(['stop']); return { ok: true }; }, ...overrides,
  };
  const env = component('Console.tsx', 'Console', { './lib/api.ts': api });
  env.render(); env.flush(); await settle();
  let tree = env.render(); env.flush(); await settle(); tree = env.render();
  return { env, calls, tree };
}
// 2026-11-23 需求变了：FRP 是独立一条线路，导入只写自己的 `frpUrl`，不再借保存去改
// 「TCP 直连」那一格。这条守卫跟着改成「保存只写配置、且不再顺带触发导入」。
test('PLUG-25/30 保存只写用户填的配置，FRP 导入不再顺带改 TCP 直连', runtimeOptions, async () => {
  const { env, calls, tree } = await consoleEnvironment();
  nodes(tree, 'RelayConfigDialog')[0].props.onSave({ manualTcpUrl: 'example.com:22' });
  await settle();
  const posted = calls.find((row) => row[0] === 'post' && row[1] === '/api/relay/config');
  assert.equal(posted[2].manualTcpUrl, 'example.com:22', '手填的 TCP 目标原样保存');
  assert.equal(calls.filter((row) => row[0] === 'import').length, 0, '保存不再顺带导入 FRP');
  nodes(env.render(), 'RelayConfigDialog')[0].props.onSave({ manualTcpUrl: 'example.com:6001' });
  await settle();
  assert.equal(calls.filter((row) => row[0] === 'post' && row[1] === '/api/relay/config').at(-1)[2].manualTcpUrl, 'example.com:6001', '手改目标必须保留');
  nodes(env.render(), 'ConnectionCard')[0].props.onStopFrp();
  await settle();
  assert.equal(calls.filter((row) => row[0] === 'stop').length, 1);
});
test('PLUG-34 地址失败单独显示并复用重试，成功空清单清错误', runtimeOptions, async () => {
  let fail = true;
  const { env } = await consoleEnvironment({ apiGet: async (url) => {
    if (url.includes('status')) return STATUS;
    if (url.includes('addresses')) { if (fail) throw new Error('address error'); return BOOK; }
    return {};
  } });
  let tree = env.render();
  const config = nodes(tree, 'RelayConfigDialog')[0];
  config.props.onRetryAddresses(); await settle(); tree = env.render();
  assert.equal(nodes(tree, 'RelayConfigDialog')[0].props.addressError, 'address error');
  fail = false;
  nodes(tree, 'RelayConfigDialog')[0].props.onRetryAddresses(); await settle(); tree = env.render();
  assert.equal(nodes(tree, 'RelayConfigDialog')[0].props.addressError, '');
  assert.equal(nodes(tree, 'RelayConfigDialog')[0].props.addressBook.public.length, 0);
});

async function probeContract(mutate) {
  const timers = new Map();
  const pending = [];
  let id = 0;
  const env = component('components/PublicRelayPanelDialog.tsx', 'PublicRelayPanelDialog', {
    '../lib/api.ts': { errorText: (error) => error.message, apiPost: (_url, body) => new Promise((resolve, reject) => pending.push({ body, resolve, reject })) },
  }, { setInterval: (fn) => { timers.set(++id, fn); return id; }, clearInterval: (key) => timers.delete(key) }, mutate);
  let props = { open: true, activeUrl: 'https://private.example/', onOpenChange() {} };
  env.render(props); env.flush();
  // 2026-11-23 需求变了：公用中转面板只列内置公用地址，自建那条归它自己那栏的「检测」。
  assert.deepEqual(Array.from(pending[0].body.urls), ['https://public.example']);
  assert(!pending[0].body.urls.includes('https://private.example'), '自建中转不混进公用面板');
  for (const tick of timers.values()) { tick(); tick(); }
  assert.equal(pending.length, 1, '未完成的轮次必须互斥');
  props = { ...props, open: false }; env.render(props); env.flush();
  props = { ...props, open: true }; env.render(props); env.flush();
  pending[0].resolve({ results: [{ url: 'https://public.example', ms: 123 }] }); await settle();
  assert.doesNotMatch(JSON.stringify(env.render(props)), /123 ms/, '旧窗口结果不得污染新窗口');
  for (const tick of timers.values()) tick();
  assert.equal(pending.length, 2);
  pending[1].resolve({ results: [{ url: 'https://public.example', ms: 123 }] }); await settle();
  assert.match(JSON.stringify(env.render(props)), /123 ms/);
  for (const tick of timers.values()) tick();
  pending[2].reject(new Error('probe rejected')); await settle();
  assert.doesNotMatch(JSON.stringify(env.render(props)), /123 ms/, '整轮请求异常不得沿用旧成功值');
  assert.match(JSON.stringify(env.render(props)), /probe rejected/);
  for (const tick of timers.values()) tick();
  pending[3].resolve({ results: [{ url: 'https://public.example', ms: null }] }); await settle();
  assert.doesNotMatch(JSON.stringify(env.render(props)), /123 ms/, '新失败不得沿用旧成功值');
  env.render({ ...props, open: false }); env.flush();
  assert.equal(timers.size, 0);
}
test('PLUG-32 慢请求互斥、只测公用地址、关窗失效且失败不冒充旧成功', runtimeOptions, () => probeContract());
test('变异：去掉探测互斥会被实际在飞请求数拒绝', runtimeOptions, async () => {
  await assert.rejects(probeContract((source) => source.replace('!alive || inFlightRef.current', '!alive')), assert.AssertionError);
});
test('变异：请求异常不记空采样会被旧成功值断言拒绝', runtimeOptions, async () => {
  await assert.rejects(probeContract((source) => source.replace("setHistory((previous) => Object.fromEntries(urls.map((url) => [url, [...(previous[url] || []), null].slice(-HISTORY_POINTS)])))", 'void 0')), assert.AssertionError);
});

test('PLUG-31 实际目的地、自建说明和默认开关均来自现有状态', runtimeOptions, () => {
  const env = component('components/PairingCard.tsx', 'PairingPolicyRows');
  const props = { status: { ...STATUS, relayUrl: 'https://private.example', controlReportTargetUrl: 'https://directory.example/findme' }, busy: '' };
  let tree = env.render(props);
  assert.equal(nodes(tree, 'Switch').at(-1).props.checked, true);
  assert.match(JSON.stringify(tree), /https:\/\/directory.example\/findme/);
  assert.match(JSON.stringify(tree), /panel.pairing.controlReportSelfHosted/);
  tree = env.render({ ...props, status: { ...props.status, controlReportEnabled: false } });
  assert.equal(nodes(tree, 'Switch').at(-1).props.checked, false);
});

test('PLUG-33/34 NAT 只是谨慎建议，错误、未读取、空地址与IPv6分开', runtimeOptions, () => {
  let retries = 0;
  const env = component('components/AddressPicker.tsx', 'AddressPicker');
  const props = { book: null, port: 18787, value: '', onChange() {}, onRetry: () => retries++ };
  let tree = env.render({ ...props, error: 'failed' });
  assert.match(JSON.stringify(tree), /panel.address.loadFailed/);
  button(tree, 'panel.address.retry').props.onClick(); assert.equal(retries, 1);
  assert.match(JSON.stringify(env.render(props)), /panel.address.empty/);
  const empty = JSON.stringify(env.render({ ...props, book: BOOK }));
  assert.match(empty, /panel.address.none/);
  assert.match(empty, /panel.address.natHint/, '成功全空候选也必须有谨慎NAT引导');
  assert.doesNotMatch(JSON.stringify(env.render({ ...props, error: 'failed', book: BOOK })), /panel.address.natHint/, '读取失败不推断NAT');
  const privateBook = { ...BOOK, lan: [{ address: '192.168.1.2' }] };
  assert.match(JSON.stringify(env.render({ ...props, book: privateBook })), /panel.address.natHint/);
  tree = env.render({ ...props, book: { ...privateBook, ipv6: [{ address: '240e::1' }] } });
  assert.doesNotMatch(JSON.stringify(tree), /panel.address.natHint/);
  const dict = text('lib/i18n/messages/panel.ts');
  assert.match(dict, /可能经过家庭路由、双重 NAT 或运营商 NAT；这不能确认公网是否可达/);
});

async function emptyNatContract(mutate) {
  const env = component('components/AddressPicker.tsx', 'AddressPicker', {}, {}, mutate);
  const tree = env.render({ book: BOOK, port: 18787, value: '', onChange() {} });
  assert.match(JSON.stringify(tree), /panel.address.none/);
  assert.match(JSON.stringify(tree), /panel.address.natHint/);
}
test('变异：成功全空提前返回会被NAT引导契约拒绝', runtimeOptions, async () => {
  await emptyNatContract();
  await assert.rejects(emptyNatContract((source) => source.replaceAll("{book ? <span className=\"font-sans text-xs text-foreground-muted\">{t('panel.address.natHint')}</span> : null}", '')), assert.AssertionError);
});

function routes(frp = {}, mutate) {
  let { registerControlPlaneRoutes } = require('../lib/routes/control-plane.js');
  if (mutate) {
    const file = path.join(ROOT, 'lib/routes/control-plane.js');
    const module = { exports: {} };
    vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), { module, exports: module.exports, require: createRequire(file),
      __dirname: path.dirname(file), process, Buffer, performance, URL, setTimeout, clearTimeout });
    registerControlPlaneRoutes = module.exports.registerControlPlaneRoutes;
  }
  const table = new Map();
  const state = { manualTcpUrl: 'example.com:22' };
  const calls = [];
  registerControlPlaneRoutes({ registerRoute: (route) => table.set(route.path, route.handler),
    localOnly: (_method, handler) => handler, trustedLocalUi: () => true,
    readJson: async (req) => req.body || {}, sendJson: (res, code, body) => Object.assign(res, { code, body }),
    state, settings: { update: async (patch) => { calls.push(patch); Object.assign(state, patch); } },
    status: () => ({ controlReportEnabled: true }), syncSidecar: async () => {}, frp,
    getControlTargetUrl: () => 'https://directory.example/findme',
    credentials: { listDevices: () => [] }, lanPortInUse: () => 18787,
  });
  return { table, state, calls };
}
test('PLUG-25/29 控制面 INI 零保存启动；停止只清 FRP 这条线路，目的地只回字符串', async () => {
  const touched = [];
  const env = routes({ start: async () => touched.push('start'), saveConfig: () => touched.push('save'), clear: async () => ({ enabled: false, running: false }) });
  const response = {};
  await env.table.get('/api/relay/frp/import')({ body: { config: '[common]\nserver_addr = example.com' } }, response);
  assert.equal(response.code, 400);
  assert.deepEqual(touched, []);
  await env.table.get('/api/relay/frp/stop')({}, {});
  assert.equal(env.state.frpUrl, '', '停掉 frpc 就是这条线路没了');
  assert.equal(env.state.manualTcpUrl, 'example.com:22', '用户手填的 TCP 直连不归 FRP 管');
  const status = {};
  await env.table.get('/api/relay/status')({ headers: { host: 'localhost:18787' }, socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } }, status);
  assert.equal(status.body.controlReportTargetUrl, 'https://directory.example/findme');
  assert.equal(typeof status.body.controlReportTargetUrl, 'string');
  assert.equal(Object.hasOwn(status.body, 'token'), false);
  assert.equal(Object.hasOwn(status.body, 'controlSnapshot'), false);
});

async function importExitContract(mutate) {
  let current = { running: true, error: '', remoteAddress: '' };
  const env = routes({ runId: 1, saveConfig() {}, start: async () => ({ ...current }), status: () => current,
    discoverRemoteAddress: async () => { current = { running: false, error: 'frpc 已退出', remoteAddress: '' }; return ''; },
  }, mutate);
  const response = {};
  await env.table.get('/api/relay/frp/import')({ body: { config: 'serverAddr = "example.com"\n[[proxies]]\ntype = "tcp"' } }, response);
  assert.equal(response.body.ok, false, '发现期间退出不能报告启动成功');
  assert.equal(response.body.status.running, false);
  assert.match(response.body.status.error, /退出/);
  assert.equal(env.calls.length, 0, '退出后不能从旧快照写地址');
}
test('B2 发现期间退出重读当前状态，不使用 started 旧快照', () => importExitContract());
test('变异：回退 started 快照会被退出失败响应拒绝', async () => {
  await assert.rejects(importExitContract((source) => source.replace("const current = typeof deps.frp.status === 'function' ? deps.frp.status() : started", 'const current = started')), assert.AssertionError);
});

function runnerModule(mutate) {
  const file = path.join(ROOT, 'lib/frpc/runner.cjs');
  const module = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), { module, exports: module.exports, require: createRequire(file),
    process, Buffer, performance, setTimeout, clearTimeout, AbortController });
  return module.exports;
}
async function recoveryAddressContract(mutate = (source) => source) {
  const { createFrpcRunner } = runnerModule(mutate);
  const timers = new Map(), pending = [], published = [], children = [];
  let id = 0;
  const runner = createFrpcRunner({ portOf: () => 18787, root: fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-address-t14-')),
    setTimeoutImpl: (fn) => { timers.set(++id, fn); return id; }, clearTimeoutImpl: (key) => timers.delete(key),
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => { const events = {}; const child = { pid: children.length + 1, kill() {}, on(event, fn) { events[event] = fn; }, close() { events.close(1, null); } }; children.push(child); return child; },
    fetchImpl: async () => new Promise((resolve) => pending.push((address) => resolve({ ok: true, json: async () => ({ tcp: [{ remote_addr: address }] }) }))),
  });
  const impl = fs.readFileSync(path.join(ROOT, 'lib/impl.js'), 'utf8');
  const binding = impl.slice(impl.indexOf("  mount('frpc 公网地址'"), impl.indexOf('  if (!(frpHost && frpHost.runner))'));
  // 「TCP 直连」这一格用户自己填了跟 FRP 相同的地址：整条链跑完它必须原样不动 ——
  // 任何线路都不许往用户自己配的那格里写，连"顺手清掉重复"都不行（2026-11-23 用户口径）。
  const state = { frpUrl: '', manualTcpUrl: 'example.com:6000' };
  const patches = [];
  vm.runInNewContext(binding, { frpRunner: runner, state, name: 'test', mount: (_label, fn) => fn(),
    ctx: { effect: (fn) => fn() }, settings: { async update(patch) { Object.assign(state, patch); patches.push(patch); published.push(patch.frpUrl); } } });
  runner.saveConfig('webServer.port = 9000\nserverAddr = "example.com"\n[[proxies]]\nlocalPort = 22');
  try {
    await runner.start();
    assert.equal(pending.length, 1, '每代启动必须主动发现');
    pending.shift()('example.com:6000'); await settle();
    children.at(-1).close();
    const [key, retry] = timers.entries().next().value; timers.delete(key); retry(); await settle();
    assert.equal(pending.length, 1, '异常重启必须重新发现动态端口');
    pending.shift()('example.com:7000'); await settle();
    assert.deepEqual(published, ['example.com:6000', 'example.com:7000']);
    children.at(-1).close();
    const [lastKey, lastRetry] = timers.entries().next().value; timers.delete(lastKey); lastRetry(); await settle();
    const late = pending.shift();
    await runner.clear(); late('example.com:8000'); await settle();
    assert.deepEqual(published, ['example.com:6000', 'example.com:7000'], '停止后的发现不能回写');
    assert.equal(state.manualTcpUrl, 'example.com:6000', '用户手填的 TCP 直连一个字都不能动');
    assert(patches.every((patch) => !('manualTcpUrl' in patch)), 'FRP 的任何一次写回都不许带上 manualTcpUrl');
  } finally { await runner.clear(); }
}
test('B3 每代真实发现更新动态TCP，停止挡住迟到回写', () => recoveryAddressContract());
test('变异：重启不主动发现会被动态TCP同步契约拒绝', async () => {
  await assert.rejects(recoveryAddressContract((source) => source.replace("if (addressListener) void discoverRemoteAddress().catch(() => '');", '')), assert.AssertionError);
});

async function managementPortContract(mutate = (source) => source) {
  const { createFrpcRunner } = runnerModule(mutate);
  const urls = [];
  const runner = createFrpcRunner({ portOf: () => 18787, root: fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-port-t14-')),
    ensure: async () => ({ ok: true, path: '/fake/frpc' }), spawnImpl: () => ({ pid: 1, kill() {} }),
    fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => ({ tcp: [{ remote_addr: 'example.com:9001' }] }) }; },
  });
  runner.saveConfig('webServer.port = 9000\nserverAddr = "example.com"\n[[proxies]]\nlocalPort = 22');
  try {
    await runner.start(); await runner.discoverRemoteAddress();
    assert.deepEqual(urls, ['http://127.0.0.1:9000/api/status']);
  } finally { await runner.clear(); }
}
test('B4 发现读取当前配置管理端口', () => managementPortContract());
test('变异：硬编码默认管理端口会被实际请求URL拒绝', async () => {
  await assert.rejects(managementPortContract((source) => source.replace('${activeAdminPort}/api/status', '${adminPort}/api/status')), assert.AssertionError);
});

async function stoppedDownloadContract(mutate = (source) => source) {
  const { createFrpcRunner } = runnerModule(mutate);
  let release;
  let spawns = 0;
  const runner = createFrpcRunner({ portOf: () => 18787, root: fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-t14-')),
    ensure: () => new Promise((resolve) => { release = resolve; }), spawnImpl: () => { spawns++; return { pid: 1 }; } });
  runner.saveConfig('serverAddr = "example.com"\n[[proxies]]\nlocalPort = 22');
  const pending = runner.start();
  await runner.clear();
  release({ ok: true, path: '/fake/frpc' });
  await pending;
  try { assert.equal(spawns, 0, '停止后下载回包不能启动进程'); }
  finally { await runner.clear(); }
}
test('变异：移除停止代次判断会被真实延后下载回包识别', async () => {
  await stoppedDownloadContract();
  await assert.rejects(stoppedDownloadContract((source) => source.replace('if (!desired || generation !== token) return;', '')), assert.AssertionError);
});

async function restartContract(mutate = (source) => source) {
  const { createFrpcRunner } = runnerModule(mutate);
  const timers = new Map();
  let id = 0, closes, spawns = 0;
  const runner = createFrpcRunner({ portOf: () => 18787, root: fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-retry-t14-')),
    setTimeoutImpl: (fn) => { timers.set(++id, fn); return id; }, clearTimeoutImpl: (key) => timers.delete(key),
    ensure: async () => ({ ok: true, path: '/fake/frpc' }),
    spawnImpl: () => { spawns++; return { pid: 1, kill() {}, on(event, fn) { if (event === 'close') closes = fn; } }; },
  });
  runner.saveConfig('serverAddr = "example.com"\n[[proxies]]\nlocalPort = 22');
  try {
    await runner.start(); closes(1, null);
    assert.equal(timers.size, 1, '失败退出必须有受监督重试');
    const [key, retry] = timers.entries().next().value; timers.delete(key); retry(); await settle();
    assert.equal(spawns, 2);
    closes(1, null); await runner.clear();
    assert.equal(timers.size, 0, '停止必须取消退避');
  } finally { await runner.clear(); }
}
test('变异：移除失败重启会被实际 spawn 次数与定时器识别', async () => {
  await restartContract();
  await assert.rejects(restartContract((source) => source.replace('          scheduleRestart();', '')), assert.AssertionError);
});

async function provisionContract(mode, mutate = (source) => source) {
  const file = path.join(ROOT, 'lib/frpc/provision.cjs');
  const module = { exports: {} };
  const timers = new Map();
  let id = 0, now = 0, calls = 0;
  vm.runInNewContext(mutate(fs.readFileSync(file, 'utf8')), { module, exports: module.exports, require: createRequire(file),
    process, Buffer, AbortController, performance: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (key) => timers.delete(key) });
  const archive = Buffer.alloc(1536);
  archive.write('frp/frpc');
  archive.write('00000000002', 124, 'ascii');
  archive.write('0', 156, 'ascii');
  archive.write('OK', 512, 'ascii');
  const zipped = require('node:zlib').gzipSync(archive);
  const sha256 = require('node:crypto').createHash('sha256').update(zipped).digest('hex');
  const pending = module.exports.ensureFrpc({ platformId: 'linux-x64', env: { PATH: '' },
    cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-provision-t14-')), timeoutMs: 800,
    asset: { file: 'x.tar.gz', archive: 'tar.gz', bin: 'frpc', sha256 },
    fetchImpl: async (_url, { signal }) => {
      calls++;
      if (calls > 1) return { ok: true, arrayBuffer: async () => zipped };
      if (mode === 'checksum') return { ok: true, arrayBuffer: async () => Buffer.from('portal') };
      const hang = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
      return mode === 'headers' ? hang() : { ok: true, arrayBuffer: hang };
    },
  });
  if (mode !== 'checksum') {
    await settle();
    assert.equal(timers.size, 1, '响应体读完前预算必须保持有效');
    const [key, timer] = timers.entries().next().value;
    assert.ok(timer.ms <= 200, '首源最多取得整轮四分之一预算');
    timers.delete(key); now += timer.ms; timer.fn();
  }
  const result = await pending;
  assert.equal(result.ok, true, result.message);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'OK');
}
for (const mode of ['checksum', 'headers', 'body']) {
  test(`PLUG-27/28 ${mode} 失败后源仍通过真实校验安装`, () => provisionContract(mode));
}
test('变异：坏校验终止整轮会被后源成功契约拒绝', async () => {
  await assert.rejects(provisionContract('checksum', (source) => source.replace('lastError = error;', "lastError = error; if (error.code === 'checksum') throw error;")), assert.AssertionError);
});
test('变异：首源独占预算会被每源时限拒绝', async () => {
  await assert.rejects(provisionContract('headers', (source) => source.replace('remaining / (bases.length - index)', 'remaining')), assert.AssertionError);
});
test('变异：响应头后即清时限会被响应体预算契约拒绝', async () => {
  await assert.rejects(provisionContract('body', (source) => source.replace('buffer = Buffer.from(await response.arrayBuffer());', 'clearTimeout(timer); buffer = Buffer.from(await response.arrayBuffer());')), assert.AssertionError);
});

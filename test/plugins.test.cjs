'use strict';

/**
 * 移动端「插件清单」（桌面端 设置 → 插件 的只读快照）的透传契约。
 *
 * 桌面端由 dsh-client-ui-settings-plugin-inventory 渲染：模块短名作标题、小标签表示
 * 有效启停、彩色圆点表示根 fiber 状态，展开看 Loader 条目 id。数据来自宿主
 * dsh-host-plugin-inventory 的 pluginInventory.list —— 这个服务不在 apiProxy 上，
 * 是 Typert Remote 服务，同进程经 ctx.get('typertGateway') 到达。
 *
 * 这条链路容易写错的地方：
 *
 *  1. **这个方法没有声明任何参数**，args 必须是空对象；多塞一个字段会被
 *     assertExactArguments 判 arguments-invalid。它也没声明 cancellation，
 *     所以不能像 references 那样多给一个 signal；
 *  2. 命名空间是 `pluginInventory`，方法是 `list`；
 *  3. 宿主的 result 声明是 `{ entries: [...] }` 对象（不是数组、也不是 {items}），
 *     invoke 回来就是这个对象——畸形行必须丢掉而不是原样透传；
 *  4. entryId 与 moduleName 缺一不可（身份与标题），fiberPhase 只认五种枚举值，
 *     停用条目宿主会给 null；
 *  5. 网关缺失（宿主没装 dsh-api-gateway 或对应服务）是 503，不是 400。
 *
 * 本测试驱动真实的 handler（不是转写实现）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');
const { readWiring } = require('./lib/wiring.cjs')

const {
  handlePlugins,
  normalizePluginEntry,
  normalizeId,
  statusOf,
  PLUGIN_ID_MAX_CHARS,
  PLUGIN_NAME_MAX_CHARS,
  PLUGIN_MAX_ITEMS,
  PLUGIN_UNAVAILABLE,
} = require('../lib/mobile/plugins.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------------------
// 假宿主：记录每一次网关调用，按 endpoint 给假实现
//
// invoke 回的是 decode 后的业务结果本体，不是 {ok,value} 外壳（那层壳是浏览器
// 传输加的）。pluginInventory.list 声明的 result 是 { entries: [...] }，
// 所以真实宿主回来就是这个对象——假实现照抄这一点。
// ---------------------------------------------------------------------------

function makeGateway(impl = {}) {
  const calls = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      const key = `${request.namespace}/${request.method}`;
      const fn = impl[key];
      if (fn) return fn(request);
      return { entries: [] };
    },
  };
}

/** 复刻宿主侧 typertGateway 的注册方式：ctx.get('typertGateway')。 */
function makeCtx(gateway) {
  return { get: (name) => (name === 'typertGateway' ? gateway : undefined) };
}

function makeReq(url) {
  const req = Readable.from([Buffer.from('{}')]);
  req.headers = {};
  req.url = url;
  return req;
}

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

async function call(handler, ctx, url) {
  const res = makeRes();
  await handler(ctx, makeReq(url), res);
  assert.notEqual(res.status, null, 'handler 必须写回响应');
  return res;
}

const URL_PLUGINS = '/api/mobile/v1/plugins';

const ENTRY_ACTIVE = { entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active' };
const ENTRY_DISABLED = { entryId: 'include:hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: false, fiberPhase: null };

// ---------------------------------------------------------------------------
// 1. 条目归一化
// ---------------------------------------------------------------------------

test('normalizePluginEntry 认整条，enabled 只认 true', () => {
  assert.deepEqual(normalizePluginEntry(ENTRY_ACTIVE), ENTRY_ACTIVE);
  assert.deepEqual(normalizePluginEntry(ENTRY_DISABLED), ENTRY_DISABLED);
  // enabled 缺省/非 true 一律 false
  assert.equal(normalizePluginEntry({ entryId: 'a', moduleName: 'm' }).enabled, false);
  assert.equal(normalizePluginEntry({ entryId: 'a', moduleName: 'm', enabled: 1 }).enabled, false);
});

test('normalizePluginEntry 缺 entryId 或 moduleName 就丢掉', () => {
  assert.equal(normalizePluginEntry({ moduleName: 'm' }), null);
  assert.equal(normalizePluginEntry({ entryId: 'a' }), null);
  assert.equal(normalizePluginEntry({ entryId: '', moduleName: 'm' }), null);
  assert.equal(normalizePluginEntry({ entryId: 'a', moduleName: '   ' }), null);
  assert.equal(normalizePluginEntry({ entryId: 7, moduleName: 'm' }), null);
  assert.equal(normalizePluginEntry(null), null);
  assert.equal(normalizePluginEntry('a'), null);
});

test('normalizePluginEntry 只认五种 fiberPhase，其余当 null', () => {
  const base = { entryId: 'a', moduleName: 'm', enabled: true };
  for (const phase of ['failed', 'pending', 'active', 'loading', 'unloading']) {
    assert.equal(normalizePluginEntry({ ...base, fiberPhase: phase }).fiberPhase, phase);
  }
  assert.equal(normalizePluginEntry({ ...base, fiberPhase: 'bogus' }).fiberPhase, null);
  assert.equal(normalizePluginEntry({ ...base, fiberPhase: 3 }).fiberPhase, null);
  assert.equal(normalizePluginEntry(base).fiberPhase, null);
});

test('normalizePluginEntry 会 trim，超长 id/name 丢掉', () => {
  assert.equal(normalizePluginEntry({ entryId: ' a ', moduleName: ' m ' }).entryId, 'a');
  assert.equal(normalizePluginEntry({ entryId: 'a'.repeat(PLUGIN_ID_MAX_CHARS + 1), moduleName: 'm' }), null);
  assert.equal(normalizePluginEntry({ entryId: 'a', moduleName: 'm'.repeat(PLUGIN_NAME_MAX_CHARS + 1) }), null);
});

test('normalizeId 拒绝非字符串、空白与超长', () => {
  assert.equal(normalizeId('a', 5), 'a');
  assert.equal(normalizeId('  a  ', 5), 'a');
  assert.equal(normalizeId('', 5), null);
  assert.equal(normalizeId('   ', 5), null);
  assert.equal(normalizeId('abcdef', 5), null);
  assert.equal(normalizeId(null, 5), null);
  assert.equal(normalizeId(1, 5), null);
});

// ---------------------------------------------------------------------------
// 2. 调用形状：namespace/method/空 args，且不塞 signal
// ---------------------------------------------------------------------------

test('handlePlugins 用 pluginInventory/list + 空 args 调网关（不能多给 signal）', async () => {
  const gateway = makeGateway({ 'pluginInventory/list': () => ({ entries: [ENTRY_ACTIVE, ENTRY_DISABLED] }) });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, items: [ENTRY_ACTIVE, ENTRY_DISABLED] });
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].namespace, 'pluginInventory');
  assert.equal(gateway.calls[0].method, 'list');
  assert.deepEqual(gateway.calls[0].args, {});
  // 这个方法没声明 cancellation，多带一个 signal 会被宿主的参数校验当成多余字段
  assert.equal('signal' in gateway.calls[0], false);
});

// ---------------------------------------------------------------------------
// 3. 畸形行丢掉，不是原样透传
// ---------------------------------------------------------------------------

test('畸形条目被丢掉，好条目照常返回', async () => {
  const gateway = makeGateway({
    'pluginInventory/list': () => ({
      entries: [
        ENTRY_ACTIVE,
        { moduleName: 'no-id' },              // 缺 entryId
        { entryId: 'no-name' },               // 缺 moduleName
        null,
        'nope',
        ENTRY_DISABLED,
      ],
    }),
  });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [ENTRY_ACTIVE, ENTRY_DISABLED]);
});

test('宿主没给 entries（或给成非数组）时返回空清单而不是报错', async () => {
  for (const value of [{}, { entries: null }, { entries: 'nope' }]) {
    const gateway = makeGateway({ 'pluginInventory/list': () => value });
    const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
  }
});

test('宿主返回 undefined 是协议异常，报 400 而不是假装空清单', async () => {
  const gateway = makeGateway({ 'pluginInventory/list': () => undefined });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'plugin-inventory-error');
  assert.match(res.body.error.message, /意外的结果/);
});

test('清单超过上限时截断到 PLUGIN_MAX_ITEMS', async () => {
  const rows = Array.from({ length: PLUGIN_MAX_ITEMS + 20 }, (unused, i) => ({
    entryId: `e${i}`, moduleName: `@scope/m${i}`, enabled: true, fiberPhase: 'active',
  }));
  const gateway = makeGateway({ 'pluginInventory/list': () => ({ entries: rows }) });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.body.items.length, PLUGIN_MAX_ITEMS);
  assert.equal(res.body.items[0].entryId, 'e0');
});

// ---------------------------------------------------------------------------
// 4. 宿主能力缺失 / 失败
// ---------------------------------------------------------------------------

test('宿主没装网关时 503 且不炸', async () => {
  const res = await call(handlePlugins, makeCtx(null), URL_PLUGINS);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, PLUGIN_UNAVAILABLE.code);
  assert.match(res.body.error.message, /dsh-host-plugin-inventory/);
});

test('网关抛 service-unavailable 也翻成 503', async () => {
  const gateway = makeGateway({
    'pluginInventory/list': () => { const e = new Error('service unavailable'); e.code = 'service-unavailable'; throw e; },
  });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, PLUGIN_UNAVAILABLE.code);
});

test('其它网关异常按原话回报 400', async () => {
  const gateway = makeGateway({
    'pluginInventory/list': () => { const e = new Error('typert gateway: pluginInventory/list: arguments-invalid'); e.code = 'arguments-invalid'; throw e; },
  });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'plugin-inventory-error');
  assert.match(res.body.error.message, /arguments-invalid/);
});

test('宿主的业务失败 { ok:false, error } 原样回报', async () => {
  const gateway = makeGateway({
    'pluginInventory/list': () => ({ ok: false, error: { code: 'inventory-not-ready', message: 'Loader 还没就绪' } }),
  });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'inventory-not-ready');
  assert.equal(res.body.error.message, 'Loader 还没就绪');
});

test('宿主若把结果包成 { ok:true, value } 也认（容错）', async () => {
  const gateway = makeGateway({ 'pluginInventory/list': () => ({ ok: true, value: { entries: [ENTRY_ACTIVE] } }) });
  const res = await call(handlePlugins, makeCtx(gateway), URL_PLUGINS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [ENTRY_ACTIVE]);
});

test('statusOf：能力缺失 503，其余 400', () => {
  assert.equal(statusOf({ code: PLUGIN_UNAVAILABLE.code }), 503);
  assert.equal(statusOf({ code: 'plugin-inventory-error' }), 400);
  assert.equal(statusOf(null), 400);
});

// ---------------------------------------------------------------------------
// 5. 源码契约：路由挂上去了，且没有绕回 apiProxy
// ---------------------------------------------------------------------------

test('index.js 挂了路由并 require 了新模块', () => {
  const src = readWiring();
  assert.match(src, /require\('(?:\.\.\/mobile|\.\/mobile)\/plugins\.js'\)/);
  assert.match(src, /route\('\/api\/mobile\/v1\/plugins', plugins\.handlePlugins\)/);
});

test('plugins.js 不碰 apiProxy，只走 typertGateway', () => {
  const src = readSource('lib/mobile/plugins.js');
  assert.match(src, /ctx\.get\('typertGateway'\)/);
  // 注释里可以提 apiProxy（解释为什么不能走它），但不能真的调用
  assert.equal(src.includes('ctx.apiProxy'), false);
  assert.equal(/apiProxy\s*\./.test(src), false);
  assert.match(src, /namespace: 'pluginInventory'/);
  assert.match(src, /args: \{\}/);
});

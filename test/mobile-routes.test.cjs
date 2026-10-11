'use strict';

/**
 * 插件的移动端路由表 ↔ App 侧的 apiPaths.ts，逐条对齐。
 *
 * 这条测试存在的理由是一次真实故障：App 的 `renameWorkspace()` / `archiveSession()`
 * 一直在打 `/api/mobile/v1/workspace/rename` 和 `/api/mobile/v1/workspace/archive-session`，
 * 但插件从来没注册过这两条路由——手机端「重命名工作区」和「归档会话」必然 404，而
 * 两边的测试各自都绿：App 侧测的是「我拼出了这个路径」，插件侧测的是「我有的那些
 * handler 逻辑对不对」，没人把两张名单放在一起对过。
 *
 * 现在路由表被抽成 lib/routes/mobile-api.js，这里就直接拿它当真值，反向核对 App 常量表
 * 里的每一条子路径都在插件侧注册了（拼上 API_BASE 之后）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, readRouteTable } = require('./lib/wiring.cjs');

const APP_PATHS = path.join(ROOT, '..', 'app', 'src', 'services', 'viewmodels', 'apiPaths.ts');

/** App 侧声明的公共前缀。插件侧的路由全部挂在它下面。 */
const API_BASE = '/api/mobile/v1';

test('App 的 apiPaths.ts 在（对齐的前提是这张表能被读到）', () => {
  assert.ok(fs.existsSync(APP_PATHS), `找不到 ${APP_PATHS}；本测试依赖 App 侧路径常量表`);
});

/**
 * 由中转（dsh-mobile-server）而不是宿主插件提供的路径。
 *
 * App 侧对这些路径打的是 relayBaseUrl。逐条写明原因，不要写成一坨黑名单——否则下一个
 * 人加路由时会以为「插件没注册 = 忘了」，然后在插件里再实现一份。
 */
const RELAY_SERVED = new Map([
  ['deviceCredentialRevoke', '中转 server.js 的 /api/mobile/v1/device-credential/revoke：吊销中转侧设备凭据，宿主插件不参与（见 app/src/services/deviceCredential.ts 的文件头）'],
]);

/**
 * App 侧已整体下线、插件侧**故意保留**的移动端路由：子路径 → 为什么。
 *
 * 与 RELAY_SERVED 的区别：那些根本不归插件管；这些插件确实在提供，只是当前 App 不再
 * 调用。保留的唯一理由是**已发布的旧版 App 还在打它**——旧客户端靠 OTA 自更新，但更新
 * 到位前的那一小段窗口里，删路由会让它们从「本地降级匹配」变成 404 报错。
 *
 * 所以每条豁免都要同时满足四条：① 写明保留理由；② 有自己完整的透传契约测试；
 * ③ 插件侧真的还注册着；④ App 侧真的不再声明。后三条由下面的「没腐化」测试钉住。
 * 哪天确认野外没有旧客户端了，就该把路由和这条豁免一起删掉，而不是让它长期挂着。
 */
const LEGACY_ROUTES = new Map([
  ['/session/search', '2026-10 App 侧整条下线「侧栏工作区」的会话搜索（见 docs/decisions.md），但插件侧的正文检索透传对旧版 App 仍然有效；它的透传契约（500 码元截断、代理对不劈、宿主错误如实上报）由 test/session-search.test.cjs 完整覆盖，不是无主的死路由'],
]);

/** 从 PATH 对象里抽出所有 `key: '/子路径'`。 */
function appSubPaths() {
  const source = fs.readFileSync(APP_PATHS, 'utf8');
  const body = source.slice(source.indexOf('export const PATH = {'));
  return [...body.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)]
    .map((m) => ({ key: m[1], sub: m[2] }))
    .filter(({ key }) => !RELAY_SERVED.has(key));
}

/** 插件路由表里注册的全部路径。 */
function pluginPaths() {
  const table = readRouteTable();
  return new Set([...table.matchAll(/path:\s*'([^']+)'|(?:^|\s)route\('([^']+)'/gm)].map((m) => m[1] || m[2]));
}

test('App 声明的每一条移动端路径，插件侧都真的注册了', () => {
  const registered = pluginPaths();
  const missing = appSubPaths()
    .map(({ key, sub }) => ({ key, full: `${API_BASE}${sub}` }))
    .filter(({ full }) => !registered.has(full));
  assert.deepEqual(missing, [], `App 会打、插件没注册（真机上必然 404）：\n${missing.map((m) => `  ${m.key} → ${m.full}`).join('\n')}`);
  assert.ok(appSubPaths().length >= 30, '解析出来的 App 路径条数偏少，正则可能失效了');
});

test('由中转提供的路径清单本身没腐化（App 里那把钥匙还在）', () => {
  const all = fs.readFileSync(APP_PATHS, 'utf8');
  for (const [key, why] of RELAY_SERVED) {
    assert.ok(new RegExp(`^\\s{2}${key}:`, 'm').test(all), `RELAY_SERVED 里的 ${key} 在 apiPaths.ts 里已经不存在了，请删掉这条豁免`);
    assert.ok(why.length > 20, `RELAY_SERVED 里的 ${key} 得写清为什么由中转提供`);
  }
  assert.equal(RELAY_SERVED.size, 1);
});

test('保留的旧客户端路由清单本身没腐化', () => {
  const registered = pluginPaths();
  const known = new Set(appSubPaths().map(({ sub }) => `${API_BASE}${sub}`));
  for (const [sub, why] of LEGACY_ROUTES) {
    const full = `${API_BASE}${sub}`;
    assert.ok(registered.has(full), `LEGACY_ROUTES 里的 ${full} 插件侧已经没注册了，请删掉这条豁免`);
    assert.ok(!known.has(full), `LEGACY_ROUTES 里的 ${full} 在 apiPaths.ts 里又出现了（App 侧又接上了它），请删掉这条豁免`);
    assert.ok(why.length > 40, `LEGACY_ROUTES 里的 ${full} 得写清为什么保留`);
  }
  assert.equal(LEGACY_ROUTES.size, 1, '豁免要逐条写理由，不要胀成黑名单；确需新增请连同这份判定一起改');
});

test('插件侧没有 App 从不打的移动端路由（死路由要么删要么补测试）', () => {
  const known = new Set(appSubPaths().map(({ sub }) => `${API_BASE}${sub}`));
  const registered = [...pluginPaths()];
  // 只比 /api/mobile/v1 下的；control-plane 的 /api/relay/* 是桌面端用的，不在此表。
  // LEGACY_ROUTES 里的是「留给旧版 App 的」，它们有自己的契约测试，不算死路由。
  const extra = registered.filter((p) => p.startsWith(API_BASE) && !known.has(p) && !LEGACY_ROUTES.has(p.slice(API_BASE.length)));
  assert.deepEqual(extra, [], `插件注册了 App 从不请求的移动端路由：\n${extra.map((p) => `  ${p}`).join('\n')}`);
});

test('路由表是纯表：不出现 shell、系统设置这类越界能力', () => {
  // 移动 API 的设计前提是不暴露 shell 与系统设置。新增路由时若引入这两类能力，
  // 应当先改设计，而不是先加路由。
  // 先剥注释：路由表的注释里会举 `command/executed` 之类的宿主事件名当例子，那是散文。
  const table = readRouteTable()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  for (const forbidden of ['/shell', '/system-settings', '/exec', '/run-command']) {
    assert.ok(!table.includes(forbidden), `移动端路由表里不该出现 ${forbidden}`);
  }
});

test('插件里的 handler 全部经守卫挂载，没有裸奔的', () => {
  const table = readRouteTable();
  const bare = [...table.matchAll(/registerRoute\(\{\s*kind:\s*'exact',\s*path:\s*'\/api\/mobile\/v1[^']*',\s*handler:(?!\s*guarded\()/g)];
  assert.deepEqual(bare.map((m) => m[0]), [], '移动端路由必须走 guarded()，否则等于没有 token 校验');
  // 每条注册都该经过 route() 或 guarded()：统计一下两种入口的条数。
  const viaRoute = (table.match(/^\s*route\('/gm) || []).length;
  const viaGuarded = (table.match(/handler:\s*guarded\(/g) || []).length;
  assert.equal(viaGuarded, 2, '直接用 guarded 的只有 status 与 connection-info 两条（它们不走 route()）');
  assert.ok(viaRoute >= 45, `移动端路由条数偏少（${viaRoute}），表可能没挂全`);
});
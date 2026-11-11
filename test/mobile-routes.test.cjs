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

/**
 * App 侧路径表的缺席只在一种检出下成立：插件被单独 clone 出去（公开发布仓库）。
 * 那条流水线跑的是「发出去的包」，没有主仓的 app/；整仓检出里它必须存在，
 * 所以那一条断言单独留一条用例，而不是把这里的对账整组静默掉。
 */
const NO_APP = !fs.existsSync(APP_PATHS);
const SKIP_NO_APP = NO_APP && `${APP_PATHS} 不存在（插件单独检出），跳过跨仓对账`;

/** App 侧声明的公共前缀。插件侧的路由全部挂在它下面。 */
const API_BASE = '/api/mobile/v1';

test('App 的 apiPaths.ts 在（对齐的前提是这张表能被读到）', { skip: SKIP_NO_APP }, () => {
  assert.ok(fs.existsSync(APP_PATHS), `找不到 ${APP_PATHS}；本测试依赖 App 侧路径常量表`);
});

/**
 * 由中转（dsh-mobile-server）而不是宿主插件提供的路径。
 *
 * App 侧对这些路径打的是 relayBaseUrl。逐条写明原因，不要写成一坨黑名单——否则下一个
 * 人加路由时会以为「插件没注册 = 忘了」，然后在插件里再实现一份。
 */
const RELAY_SERVED = new Map([
  // 2026-10-22：中转回归纯转发后，`deviceCredentialRevoke` 改由插件自己应答
  //（`lib/routes/mobile-api.js`），所以从这里拿掉了——它不再是「中转代答」的路径。
  // 2026-11-10：`/blob` 是宿主离线时唯一能由中转代答的只读路径——它只回电脑侧事先封好的
  // 密文 blob（HK 加密、密钥不进中转），中转不持钥、不解密，能力面只到「取一段密文」。
  // 这是本轮唯一有意破例的「中转代答」，见 docs/decisions.md 2026-11-10 那条。
  ['blob', '宿主离线时由中转回事先封好的历史密文 blob；中转不持密钥、不解密，只按设备凭据摘要放行取密文'],
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

/**
 * 插件侧**故意不鉴权**的移动端路由：子路径 → 为什么可以公开。
 *
 * 分界线是「配对之前手机手上有没有凭据」：地址体检要在配对之前回答「这个地址上是宿主还是
 * 中转」（App 引导页那颗「检测」按钮消费），那时候手机没有任何 token。它回的话只有服务名与
 * 版本 —— 不含实例信息、没有任何能力面；中转侧在同一个路径上做同一件事，两条路都刻意不
 * 鉴权才能分辨对面是谁。
 */
const PUBLIC_ROUTES = new Map([
  ['/health', '地址体检：配对之前就要问「这个地址上是宿主还是中转」。只回 service/apiVersion/version，不含实例信息与能力面；中转侧同路径同样公开'],
  // 配对本身就在「还没有 token」的时刻发生，包 guarded 就是死循环。它的凭据是**配对码**
  // 而不是 token：码对得上才签发 token 与设备凭据，连错 5 次锁 60 秒（见 lib/mobile/pairing.js）。
  ['/pair', '配对：手机用配对码换 token 与设备凭据，此刻还没有 token 可验。凭据是配对码本身，附带失败限流；归宿主应答，中转只按实例标识转发'],
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

test('App 声明的每一条移动端路径，插件侧都真的注册了', { skip: SKIP_NO_APP }, () => {
  const registered = pluginPaths();
  const missing = appSubPaths()
    .map(({ key, sub }) => ({ key, full: `${API_BASE}${sub}` }))
    .filter(({ full }) => !registered.has(full));
  assert.deepEqual(missing, [], `App 会打、插件没注册（真机上必然 404）：\n${missing.map((m) => `  ${m.key} → ${m.full}`).join('\n')}`);
  assert.ok(appSubPaths().length >= 30, '解析出来的 App 路径条数偏少，正则可能失效了');
});

test('右栏「打开文件」那条：两侧都叫 /file/read，且与 /session/file 是两条路', { skip: SKIP_NO_APP }, () => {
  const registered = pluginPaths();
  // 插件侧：注册在这张表上（走 route() 即需 token）。
  assert.ok(registered.has(`${API_BASE}/file/read`), `插件侧没注册 ${API_BASE}/file/read`);
  // App 侧：按**值**对账，不钉 key 名 —— 改名不该让这条守卫假红，路径才是契约。
  const app = fs.readFileSync(APP_PATHS, 'utf8');
  assert.match(app, /^\s{2}\w+:\s*'\/file\/read',?$/m, "App 侧 apiPaths.ts 得声明一条 '/file/read'");
  // 两条并存：卡片/正文链接那条仍只认本会话工作区与交付声明，不能被这条顶掉。
  assert.ok(registered.has(`${API_BASE}/session/file`), `卡片取字节那条被人删了：${API_BASE}/session/file`);
});

test('已审核扩展清单的两条：两侧同名，清单在前、取文件在后', { skip: SKIP_NO_APP }, () => {
  const registered = pluginPaths();
  for (const sub of ['/extension/catalog', '/extension/catalog/file']) {
    assert.ok(registered.has(`${API_BASE}${sub}`), `插件侧没注册 ${API_BASE}${sub}`);
  }
  // 与 /file/read 那条同一口径：按**值**对账，不钉 key 名 —— 路径才是契约。
  const app = fs.readFileSync(APP_PATHS, 'utf8');
  assert.match(app, /^\s{2}\w+:\s*'\/extension\/catalog',?$/m, "App 侧 apiPaths.ts 得声明一条 '/extension/catalog'");
  assert.match(app, /^\s{2}\w+:\s*'\/extension\/catalog\/file',?$/m, "App 侧 apiPaths.ts 得声明一条 '/extension/catalog/file'");
});

test('由中转提供的路径清单本身没腐化（App 里那把钥匙还在）', { skip: SKIP_NO_APP }, () => {
  const all = fs.readFileSync(APP_PATHS, 'utf8');
  for (const [key, why] of RELAY_SERVED) {
    assert.ok(new RegExp(`^\\s{2}${key}:`, 'm').test(all), `RELAY_SERVED 里的 ${key} 在 apiPaths.ts 里已经不存在了，请删掉这条豁免`);
    assert.ok(why.length > 20, `RELAY_SERVED 里的 ${key} 得写清为什么由中转提供`);
  }
  // 2026-10-22 之后中转不再代答业务路径：它是纯转发，所有路径都落到插件。
  // 2026-11-10 起唯一例外是 `/blob`：只回电脑侧封好的密文（HK 加密、密钥不进中转），
  // 中转只做「按设备凭据放行取一段密文」，不解密、不解释业务。再出现别的一律先确认它
  // 真的不该由宿主回答。
  assert.equal(RELAY_SERVED.size, 1, '中转代答只允许 /blob 这一条密文路径；确需新增请先确认它真的不该由宿主回答');
});

test('保留的旧客户端路由清单本身没腐化', { skip: SKIP_NO_APP }, () => {
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

test('插件侧没有 App 从不打的移动端路由（死路由要么删要么补测试）', { skip: SKIP_NO_APP }, () => {
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
  const bare = [...table.matchAll(/registerRoute\(\{\s*kind:\s*'exact',\s*path:\s*'\/api\/mobile\/v1([^']*)',\s*handler:(?!\s*guarded\()/g)]
    .map((m) => m[1])
    .filter((sub) => !PUBLIC_ROUTES.has(sub));
  assert.deepEqual(bare, [], '移动端路由必须走 guarded()，否则等于没有 token 校验；确需公开请连同 PUBLIC_ROUTES 的判定一起改');
  // 每条注册都该经过 route() 或 guarded()：统计一下两种入口的条数。
  const viaRoute = (table.match(/^\s*route\('/gm) || []).length;
  const viaGuarded = (table.match(/handler:\s*guarded\(/g) || []).length;
  assert.equal(viaGuarded, 2, '直接用 guarded 的只有 status 与 connection-info 两条（它们不走 route()）');
  assert.ok(viaRoute >= 45, `移动端路由条数偏少（${viaRoute}），表可能没挂全`);
});

test('心跳里必须带 P2P 那一格（否则 App 永远显示「未配置」）', () => {
  // 这条钉的是一个真实故障：`/api/mobile/v1/status` 只回了 instanceId / name / relayUrl
  // 那几格，**完全没有 p2p**。于是 App 每 30 秒问一次都拿不到任何 P2P 信息，界面上就只能
  // 写「未配置」—— 而电脑面板那边明明显示「等待手机接入」，两边说的是同一件事，一边有
  // 数据、一边没有。手表/手机都连得上插件了，状态完全同步得过来。
  const table = readRouteTable();
  const statusBlock = table.slice(table.indexOf("path: '/api/mobile/v1/status'"));
  const body = statusBlock.slice(0, statusBlock.indexOf('}) })'));
  assert.match(body, /p2p\s*:/, '/status 的回包里必须有 p2p 这一格');
  assert.match(body, /p2p\.status\(\)/, '这一格要直接取门面的 status()，不要另算一套');
});

test('心跳里必须带「这一代少了什么」那一格（否则容量退化又是静默的）', () => {
  // 与上一条同一个病：官方工具解析不到同代那份时，宿主不失败、手机照常连上，只是某个
  // 工具不见了，模型只会说「不可用」。这一格是 App 唯一能说出「这几项现在用不了」的来源。
  // 它必须走 readCapabilityReport()（「没检查」要能和「检查了没问题」分开），
  // 不能在路由层另拼一个空数组。
  const table = readRouteTable();
  const statusBlock = table.slice(table.indexOf("path: '/api/mobile/v1/status'"));
  const body = statusBlock.slice(0, statusBlock.indexOf('}) })'));
  assert.match(body, /capabilities\s*:/, '/status 的回包里必须有 capabilities 这一格');
  assert.match(body, /readCapabilityReport\(\)/, '这一格要取那份活体台账，不要在路由里另算一套');
});

test('公开路由清单本身没腐化', () => {
  const table = readRouteTable();
  for (const [sub, why] of PUBLIC_ROUTES) {
    assert.ok(table.includes(`'${API_BASE}${sub}'`), `PUBLIC_ROUTES 里的 ${API_BASE}${sub} 插件侧已经没注册了，请删掉这条豁免`);
    assert.ok(why.length > 40, `PUBLIC_ROUTES 里的 ${API_BASE}${sub} 得写清为什么可以公开`);
  }
  assert.equal(PUBLIC_ROUTES.size, 2, '公开豁免要逐条写理由，不要胀成黑名单；确需新增请连同这份判定一起改');
});
/**
 * 报名那条路由必须从 `req.body` 取请求体。
 *
 * 协议 v2 的请求体是**守卫读掉的**：`createGuarded` 先 `readBody(req)` 解密、把明文放进
 * `req.body`，原始流到 handler 手里已经是空的。自己 `for await (const chunk of req)` 只会
 * 拿到空串，于是公钥永远是空的、一律 400 —— 手机那边看到的就是一句笼统的失败，而宿主日志
 * 里什么都没有。`readJson(req)` 就是这个文件里通用那一版：有 `req.body` 用 `req.body`，
 * 没有（老客户端明文）才读流。
 */
test('报名路由从 req.body 取请求体，不自己读流', () => {
  const table = readRouteTable();
  const at = table.indexOf("route('/api/mobile/v1/tunnel'");
  assert.ok(at > 0, '报名路由不见了');
  const body = table.slice(at, at + 900);
  assert.ok(/const body = await readJsonBody\(req, 64 \* 1024\)/.test(body), '必须用 readJsonBody(req) 取请求体（信封的明文在 req.body，原始流已经被守卫读掉）');
  assert.ok(!/for await \(const chunk of req\)/.test(body), '别自己读请求流：信封请求的那条流已经被守卫读掉，读出来是空的');
});

'use strict';

/**
 * 控制面路由（`/api/relay/*`）的守卫约定。
 *
 * 与移动端那套刻意不同：控制面**只认本机来源**（localOnly），移动端**只认 token**
 * （guarded）。这条不对称是安全的底线，不是风格问题——控制面能改配置、吊销全部授权、
 * 读带堆栈的进程级故障账本；把它暴露给中转等于把桌面端后门开到公网。
 *
 * 唯一的例外是 `/api/relay/internal/approval`：它由中转与局域网代理代转，没有本机
 * socket 可言，身份靠中转与 worker 之间的 sidecarToken。任何新加的例外都必须在这里
 * 一条条写明原因，否则半年后没人分得清哪条是必要的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');
const { pairingPayload } = require(path.join(__dirname, '..', 'lib', 'relay', 'pairing-payload.cjs'));
const {
  WEB_ACCESS_ROUTES,
  WEB_ACCESS_WINDOW_MS,
  panelScopeOf,
  createWebAccessWindow,
  createWebAccessLocalOnly,
  registerControlPlaneRoutes,
} = require(CONTROL_PLANE);

/** 允许不挂 localOnly 的控制面路由：key → 为什么。 */
const NO_LOCAL_ONLY = new Map([
  ['/api/relay/internal/approval', '由中转与局域网代理代转，没有本机 socket 可言；身份靠 sidecarToken（中转 ↔ worker 共享密钥），不是「这条路由不重要」的例外'],
  ['/api/relay/internal/issue-credential', '旁路子进程（局域网代理）签发凭据的唯一通道：凭据库只有主进程一个写方，身份靠 sidecarToken'],
  ['/api/relay/internal/rotate-pairing', '旁路子进程配对成功后换码换票据的唯一通道：状态文件只有主进程能写，身份靠 sidecarToken'],
]);

/** 不随网页管理窗口关闭的控制面通道：必须逐条说明用途。 */
const NO_WEB_ACCESS = new Map([
  ['/api/relay/internal/approval', '中转与 sidecar 的内部审批通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/internal/issue-credential', 'sidecar 签发凭据的内部通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/internal/rotate-pairing', 'sidecar 换码换票据的内部通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/desktop-view', '桌面客户端自身的工作区状态同步，不能随网页管理窗口停止'],
  ['/api/relay/read-receipt', '桌面端轮询上报回执以同步本地已读状态，属于客户端功能，不是网页管理面板。'],
  ['/api/relay/client-half', '桌面客户端每 10 秒上报存活与故障自检状态，不能随网页管理窗口停止。'],
  ['/api/relay/desktop-read', '桌面客户端轮询同步已读会话，属于手机与桌面协同通道，不是网页管理接口。'],
  ['/api/relay/web-access', '开关路由本身必须始终可达：侧边栏那颗手机图标要在窗口关着时把它打开'],
  ['/api/relay/canvas', '桌面画布只在本机打开：数据面走移动端 token，远程网页窗口打开它也没有库可读'],
]);

/**
 * 每条注册：`path` 后面、下一个 `path:` 之前的那段。
 *
 * 不去匹配整条 registerRoute(...) 的收尾括号——handler 里全是嵌套对象，平衡括号用
 * 正则匹配不出来（试过，11 条只解析出 2 条）。这里只关心「这条路径的 handler 段里有没有
 * 某个守卫」，按路径切段足够，也不依赖它被排版成几行。
 */
function registrations(source) {
  const hits = [...source.matchAll(/path:\s*'([^']+)'/g)];
  return hits.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    return { path: m[1], handler: source.slice(start, end) };
  });
}

test('控制面路由清单完整（解析条数下限防正则失效）', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const routes = registrations(source);
  assert.ok(routes.length >= 11, `只解析出 ${routes.length} 条控制面路由，正则可能失效了`);
  const known = new Set(routes.map((r) => r.path));
  for (const expected of [
    '/api/relay/internal/approval',
    '/api/relay/web-access',
    '/api/relay/status',
    // 面板页（设置界面搬进宿主吐的 HTML）与它的「引导走完了」标记。
    // 面板页三个地址：自己分流 / 强制引导 / 强制主页。
    '/api/relay/panel',
    '/api/relay/panel/setup',
    '/api/relay/panel/settings',
    '/api/relay/onboarded',
    '/api/relay/desktop-view',
    '/api/relay/read-receipt',
    '/api/relay/desktop-read',
    '/api/relay/faults',
    '/api/relay/toggle',
    '/api/relay/regenerate',
    '/api/relay/revoke-all',
    '/api/relay/config',
    // 面板上「检查端口」用的真实探针：只读、只试绑，不写配置。
    '/api/relay/check-port',
    // 手机连不上时的连接自检：本机在不在听 / 中转通不通 / 防火墙放不放行 / 手机最近来过没有。
    // 只读，不改规则也不提权（见 lib/relay/connection-check.js 的文件头）。
    '/api/relay/selfcheck',
    // 面板显示「手机该填哪个地址」用：检测到的局域网 / 公网地址，只读。
    '/api/relay/addresses',
    '/api/relay/reconnect',
    '/api/relay/restart-sidecar',
    // 开发机的「就地重载」（版本号不变、只把盘上这份重新装载一遍，见 A1-47）。
    '/api/relay/reload-implementation',
    // 自更新那四条（2026-10 搬回外壳之后重新有）：状态 / 查更新 / 装并就地换代 / 自动开关。
    '/api/relay/update/status',
    '/api/relay/update/check',
    '/api/relay/update/apply',
    '/api/relay/update/auto',
    '/api/relay/update/ota/status',
    '/api/relay/update/ota/check',
    '/api/relay/update/ota/apply',
  ]) {
    assert.ok(known.has(expected), `控制面少了 ${expected}`);
  }
});

test('除了写明原因的那条，其余控制面路由都挂在 localOnly 后面', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const bare = registrations(source)
    .filter((r) => r.path.startsWith('/api/relay/'))
    .filter((r) => !r.handler.includes('localOnly('))
    .map((r) => r.path);
  assert.deepEqual(bare.filter((p) => !NO_LOCAL_ONLY.has(p)), [], '控制面路由必须过 localOnly：本机来源是它唯一的防线');
});

test('豁免清单没腐化：每一条都还在，且写清了为什么', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const known = new Set(registrations(source).map((r) => r.path));
  for (const [route, why] of NO_LOCAL_ONLY) {
    assert.ok(known.has(route), `NO_LOCAL_ONLY 里的 ${route} 已经不存在了，请删掉这条豁免`);
    assert.ok(why.length > 20, `${route} 的豁免理由要写清楚，不能只是「特殊」`);
  }
  // 数字是刻意的绊线：加一条例外就必须来这里改一次，逼人想清楚「这条真的不能只给本机吗」。
  assert.equal(NO_LOCAL_ONLY.size, 3);
});

test('不挂 localOnly 的内部路由都真的校验 sidecarToken', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  for (const route of NO_LOCAL_ONLY.keys()) {
    const at = source.indexOf(`'${route}'`);
    assert.notEqual(at, -1, `${route} 找不到`);
    const end = source.indexOf('registerRoute', at + 1);
    const body = source.slice(at, end < 0 ? at + 800 : end);
    assert.match(
      body,
      /req\.headers\.authorization !== `Bearer \$\{sidecarToken\}`/,
      `${route} 必须校验中转↔worker 的共享密钥`,
    );
    assert.match(body, /sendJson\(res, 401, \{ error: 'unauthorized' \}\)/, `${route} 校验不过要回 401`);
  }
  // 决策要走 pairing-policy 的两种模式，不能在路由里另写一套准入判定。
  const at = source.indexOf("'/api/relay/internal/approval'");
  const end = source.indexOf('registerRoute', at + 1);
  assert.match(source.slice(at, end < 0 ? at + 800 : end), /pairingApproval\.evaluate\(state\.pairingPolicy, body\.device\)/);
});

test('改配置的路由逐字段校验，不接受任意键', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/config'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1600 : end);
  for (const field of ['relayUrl', 'lanEnabled', 'lanPort', 'name', 'pairingPolicy', 'registerSecret', 'preferredLanAddress', 'manualLanUrl', 'manualIpv6Url']) {
    assert.ok(route.includes(`patch.${field}`), `config 路由必须逐字段校验并只写白名单字段，缺 ${field}`);
  }
  // 端口范围与注册密钥长度是防呆，别被"顺手清理"掉。
  assert.match(route, /body\.lanPort >= 1024 && body\.lanPort <= 65535/, '端口范围校验');
  assert.match(route, /body\.registerSecret\.length <= 512/, '注册密钥长度校验');
  // 「手机优先用哪条地址」的**空串是合法值**（= 改回按宿主的网卡顺序自动选），所以它只挡
  // 类型和长度，不能照着 name 那样加一句非空判断：加了，这个选择一旦存下去就再也清不掉。
  assert.match(route, /typeof body\?\.preferredLanAddress === 'string'/, '优先地址只挡类型');
  assert.match(route, /body\.preferredLanAddress\.length <= 64/, '优先地址要有长度上限');
  assert.ok(!/\.\.\.body\b/.test(route), '不许把请求体整体透传进 settings.update');
});

test('面板的地址库把「现在选的是哪条」报出来，界面才回显得出', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/addresses'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 900 : end);
  // 只回显，不在这条上做排序：选择真正的落点是二维码与 connection-info 的候选顺序
  // （见 lib/relay/lan-network.cjs 的 orderCandidates）。少了这个字段，界面就不知道
  // 用户上次选的是哪条，只能每次都装作「默认第一条」，选择也就永远看不到。
  assert.match(route, /preferred/, '地址库要带上用户选的那条');
  assert.match(route, /state\.preferredLanAddress/, '取值来源是设置项 preferredLanAddress');
});

/**
 * 行为：把控制面真挂一遍，只留「路径 → handler」。
 *
 * 依赖全给最小假体，真正会跑到的只有配置 / 地址库这两条；`settings.update` 是唯一的真值
 * 落点 —— 这样才谈得上「写进去能读回」，只对着源码正则断言字段名是钉不住的。
 */
function controlRoutes({ state = {}, settingsCalls = [] } = {}) {
  const table = new Map();
  const settings = {
    async update(patch) {
      settingsCalls.push(patch);
      Object.assign(state, patch);
      return state;
    },
  };
  registerControlPlaneRoutes({
    registerRoute: (route) => table.set(route.path, route.handler),
    localOnly: (_method, handler) => handler,
    trustedLocalUi: () => true,
    sendJson: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async (req) => req.body || {},
    settings,
    state,
    status: () => ({}),
    syncSidecar: async () => {},
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    resolveLanPort: async () => 18787,
    // 二维码载荷走真模块：这条测试要钉的是「路由怎么读请求、有没有把预览写进配置」，
    // 载荷拼装本身由 `test/pair-cli.test.cjs` 与 App 侧那份契约钉着。
    pairingPayload,
  });
  return table;
}

test('行为：手填的 IPv6 直连地址写得进、读得回，空串能清掉', async () => {
  const state = { manualLanUrl: '', manualIpv6Url: '' };
  const calls = [];
  const table = controlRoutes({ state, settingsCalls: calls });
  const saved = {};
  await table.get('/api/relay/config')({ method: 'POST', body: { manualIpv6Url: ' http://[240e::1]:18787/ ' } }, saved);
  assert.equal(saved.status, 200);
  assert.equal(calls[0].manualIpv6Url, 'http://[240e::1]:18787', '空白与末尾斜杠要去掉');
  assert.equal(state.manualIpv6Url, 'http://[240e::1]:18787', '写进的是同一份 settings');

  const cleared = {};
  await table.get('/api/relay/config')({ method: 'POST', body: { manualIpv6Url: '' } }, cleared);
  assert.equal(state.manualIpv6Url, '', '空串 = 清掉这一条');
});

test('行为：手填的 IPv6 地址坏形状不写进去，也不连累同一发里的其余字段', async () => {
  // 控制面这一条的老口径是逐字段忽略（与移动端「整次拒绝」不同），保持原样；
  // 关键是坏形状**绝不能**写进 settings —— 那会让下一次产候选读到一个不是字符串的值。
  for (const bad of ['a'.repeat(201), 42, ['x'], { url: 'http://[240e::1]:18787' }, null]) {
    const state = { manualIpv6Url: '' };
    const calls = [];
    const table = controlRoutes({ state, settingsCalls: calls });
    const res = {};
    await table.get('/api/relay/config')({ method: 'POST', body: { manualIpv6Url: bad, name: 'ok' } }, res);
    assert.equal(res.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'manualIpv6Url'), false, `${JSON.stringify(bad)} 不该写进去`);
    assert.equal(calls[0].name, 'ok', '其余合法字段照旧写入');
  }
});

test('行为：二维码按 ?relayUrl= 预览出码，且不把预览地址写进配置', async () => {
  // 这条同时钉住「处理函数收的是 req」——它要读 `req.url` 才拿得到预览参数，把形参改名成
  // `_req` 会在面板上静默变成 500（2026-11-01 改这条路由时踩过一次）。
  const state = {
    enabled: true, instanceId: 'i1', pairingCode: '123456', pairingTicket: 't'.repeat(43),
    relayUrl: 'https://real.example.com', name: 'host', lanEnabled: false, lanPort: 18787,
    preferredLanAddress: '', manualLanUrl: '', manualIpv6Url: '',
  };
  const table = controlRoutes({ state });
  const res = {};
  await table.get('/api/relay/pairing')({ method: 'GET', url: '/api/relay/pairing?relayUrl=https://preview.example.com/' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.relayUrl, 'https://preview.example.com', '预览地址要去掉尾斜杠');
  assert.equal(res.body.pairingCode, '123456');
  assert.match(res.body.svg, /<svg/, '面板要的是那张 SVG');
  assert.equal(state.relayUrl, 'https://real.example.com', '预览只看不写：配置一个字都不许动');

  const off = controlRoutes({ state: { ...state, enabled: false } });
  const blocked = {};
  await off.get('/api/relay/pairing')({ method: 'GET', url: '/api/relay/pairing' }, blocked);
  assert.equal(blocked.status, 409, '没启用远程控制时不出码，说清该先做什么');
});

test('行为：地址库回显手填的 IPv6，并把它缀进 ipv6 候选最后', async () => {
  const table = controlRoutes({
    state: { preferredLanAddress: '', manualLanUrl: '', manualIpv6Url: 'http://[2001:4860:4860::8888]:18787' },
  });
  const res = {};
  await table.get('/api/relay/addresses')({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.manualIpv6, 'http://[2001:4860:4860::8888]:18787');
  const last = res.body.ipv6[res.body.ipv6.length - 1];
  assert.equal(last.interface, 'manual', '手填那条排最后当兜底，网卡候选一条不删');
  assert.equal(last.url, 'http://[2001:4860:4860::8888]:18787');
});

test('面板读不到时报的是能定位的诊断，不是一句「还没构建」', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  // 三个面板地址共用 servePanel。2026-10-10 的真机现场：装完没重启，旧实例挂在被删掉的
  // 目录上，而那句写死的「还没构建」把人往「去跑 React 构建」上带 —— 所以诊断必须现场算。
  const at = source.indexOf('const servePanel');
  assert.notEqual(at, -1, '找不到 servePanel');
  const body = source.slice(at, at + 1200);
  assert.match(body, /panelDiagnosis\(\)/, 'servePanel 必须现场算诊断：三种现场（没重启 / 老版本 / 没构建）分不开，现场就会白折腾');
  assert.match(body, /code: 'panel_missing'/, 'panel_missing 这个 code 要留着');
  assert.ok(!source.includes('面板页面还没构建'), '写死的那句构建提示已被按现场分的诊断取代，别退回去');
});

test('网页管理访问窗口只保护管理面板路由，例外路由逐条说明', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const routes = registrations(source).map((route) => route.path).filter((route) => route.startsWith('/api/relay/'));
  for (const route of routes) {
    assert.ok(
      WEB_ACCESS_ROUTES.has(route) || NO_WEB_ACCESS.has(route),
      `${route} 必须纳入网页访问窗口，或在 NO_WEB_ACCESS 写明理由`,
    );
  }
  for (const route of WEB_ACCESS_ROUTES) assert.ok(routes.includes(route), `保护清单里的 ${route} 已不存在`);
  for (const [route, reason] of NO_WEB_ACCESS) {
    assert.ok(routes.includes(route), `NO_WEB_ACCESS 里的 ${route} 已不存在，请删除豁免`);
    assert.ok(reason.length > 20, `${route} 的豁免理由要写清楚`);
  }
});

test('网页管理窗口默认关闭、固定两小时且访问不续期', () => {
  let wall = 1_000_000;
  let monotonic = 500;
  const window = createWebAccessWindow({ now: () => wall, monotonicNow: () => monotonic });
  assert.deepEqual(window.status(), { enabled: false, expiresAt: 0 });
  const opened = window.enable();
  assert.deepEqual(opened, { enabled: true, expiresAt: wall + WEB_ACCESS_WINDOW_MS });
  monotonic += 1_000;
  wall += 1_000;
  assert.deepEqual(window.status(), opened, '读取状态与请求访问不能滑动延长到期点');
  monotonic += WEB_ACCESS_WINDOW_MS - 1_001;
  assert.equal(window.isOpen(), true);
  monotonic += 1;
  assert.deepEqual(window.status(), { enabled: false, expiresAt: 0 });
  assert.deepEqual(window.enable(), { enabled: true, expiresAt: wall + WEB_ACCESS_WINDOW_MS });
  assert.deepEqual(window.disable(), { enabled: false, expiresAt: 0 });
});

test('面板地址分三类：本机回环 / 局域网 / 公网（域名一律算公网）', () => {
  const scope = (host) => panelScopeOf({ headers: { host } });
  assert.equal(scope('127.0.0.1:19387'), 'loopback');
  assert.equal(scope('localhost:19387'), 'loopback');
  assert.equal(scope('[::1]:19387'), 'loopback');
  assert.equal(scope('192.168.1.20:19387'), 'private');
  assert.equal(scope('10.0.0.5'), 'private');
  assert.equal(scope('172.16.4.4:19387'), 'private');
  assert.equal(scope('[fd00::1]:19387'), 'private');
  assert.equal(scope('203.0.113.9:19387'), 'public');
  assert.equal(scope('[240e::1]:19387'), 'public');
  // 域名分不出内网穿透还是公网：一律按公网走（多弹一次确认，比悄悄开放安全）。
  assert.equal(scope('dsh.example.com'), 'public');
  // 拿不到 Host 就别说它是本机。
  assert.equal(panelScopeOf({ headers: {} }), 'public');
  assert.equal(panelScopeOf({}), 'public');
});

test('行为：/status 把面板地址的分类一起报出去（那颗图标据此决定点下去做什么）', async () => {
  const table = controlRoutes({ state: {} });
  const res = {};
  await table.get('/api/relay/status')({ method: 'GET', headers: { host: '192.168.1.20:19387' } }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.panelScope, 'private');
  assert.equal(res.body.panelUrl, 'http://192.168.1.20:19387/api/relay/panel');
});

test('行为：那颗图标能从同源界面把两小时窗口打开 —— 不再要求请求来自本机回环', async () => {
  // 2026-11-02 用户拍板放宽：公网 / 局域网部署的人就是在自己的浏览器里点那颗图标，
  // 按老判据（trustedLocalUi）会 403，于是谁都开不了窗口、面板永远 423。
  // 跨站与经代理转发的请求仍在 localOnly 那一层挡着，这里只钉 handler 不再要求回环。
  const table = controlRoutes({ state: {} });
  const opened = {};
  await table.get('/api/relay/web-access')(
    { method: 'POST', headers: { host: '203.0.113.9:19387' }, body: { enabled: true } },
    opened,
  );
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.webAccess.enabled, true);

  const closed = {};
  await table.get('/api/relay/web-access')({ method: 'POST', body: { enabled: false } }, closed);
  assert.equal(closed.body.webAccess.enabled, false, '关掉也要走同一条路');

  const bad = {};
  await table.get('/api/relay/web-access')({ method: 'POST', body: { enabled: 'yes' } }, bad);
  assert.equal(bad.status, 400, 'enabled 必须是布尔值，别把字符串当开');
});

test('网页访问守卫：窗口关闭时拒绝公网、允许可信本机；开窗后放行管理 API', async () => {
  let monotonic = 0;
  const window = createWebAccessWindow({ now: () => 10_000, monotonicNow: () => monotonic });
  const sent = [];
  const guard = createWebAccessLocalOnly({
    localOnly: (_method, handler) => handler,
    trustedLocalUi: (req) => req.trusted === true,
    webAccessWindow: window,
    sendJson: (res, status, body) => { res.status = status; res.body = body; sent.push(status); },
  });
  let reached = 0;
  const handler = guard('GET', async () => { reached += 1; });
  const remote = { url: '/api/relay/config?from=web', trusted: false };
  const denied = {};
  await handler(remote, denied);
  assert.equal(denied.status, 423);
  assert.equal(denied.body.error.code, 'web_access_closed');
  assert.equal(reached, 0);
  await handler({ url: '/api/relay/config', trusted: true }, {});
  assert.equal(reached, 1, '本机仍可管理，不必先开公网窗口');
  window.enable();
  await handler(remote, {});
  assert.equal(reached, 2, '开窗后公网同源管理请求才放行');
  const sync = guard('GET', async () => { reached += 1; });
  await sync({ url: '/api/relay/read-receipt', trusted: false }, {});
  assert.equal(reached, 3, '桌面同步通道不受面板窗口影响');
  assert.deepEqual(sent, [423]);
});

test('二维码路由跟别的管理动作同一套规矩：窗口关着远程拿不到，开窗后能拿到', async () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/pairing'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1200 : end);
  // 2026-11-01 用户拍板：二维码不再自己造第二套判据，改由两小时窗口统一管。理由是
  // **服务器部署没有「本机屏幕」**——那台机器只有 SSH，人永远够不到那个判据，配一次都
  // 配不上；而窗口由本机设置页亲手开，开着的时候远程本来就能踢设备、改地址、重启 sidecar，
  // 单独把码拦在外面既不自洽，也让那颗按钮名不副实。终端命令（lib/cli/pair.cjs）是另一条
  // 「能登机器的人」的路，两条都不新开对外口子。
  assert.ok(WEB_ACCESS_ROUTES.has('/api/relay/pairing'), '二维码要随两小时窗口对网页开放');
  assert.ok(!/trustedLocalUi\(req\)/.test(route), '别再在路由里自己造一套更严的判据');
  assert.ok(!/pairing_local_only/.test(route), '那条 423 已经由窗口那层的 web_access_closed 取代');
});

test('只有面板页放开「人点开的一页」，别的控制面路由不放开跨站', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const allowed = registrations(source)
    .filter((route) => route.path.startsWith('/api/relay/'))
    .filter((route) => route.handler.includes('allowDocumentNavigation'))
    .map((route) => route.path)
    .sort();
  // 社区桌面壳会把自己接住的链接原地打开，从自定义协议页跳到面板地址时必带
  // `sec-fetch-site: cross-site`。这一种形态只对「只读的一页」放开（面板页、桌面画布页）；
  // 放开别的就得先想清楚它是不是也能被别人的网页点开。
  assert.deepEqual(allowed, ['/api/relay/canvas', '/api/relay/panel', '/api/relay/panel/settings', '/api/relay/panel/setup']);
});

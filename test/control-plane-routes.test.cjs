// 2026-11-25：状态接口逐路隔离，一路抛错不再整条 400。
// 2026-11-24：公用中转改成「码里没自己的线路才塞」的兜底，只配服务商的机器靠服务商地址出码。
// 2026-11-24：总开关下发失败要带 applyError，并钉住面板据此报失败。
// 二维码等待隧道窗口后读取当前票据与身份，换码期间出码仍可真实验票。
// 网络控制动作必须真实执行；重连失败不报成功，FRP 重试受理与运行状态分开。
'use strict';

/**
 * 控制面路由（`/api/relay/*`）的守卫约定。
 *
 * 控制面校验浏览器来源与网络范围，移动端校验 token；
 * 中转及移动端代理不能调用控制面。
 *
 * 唯一的例外是 `/api/relay/internal/approval`：它由中转与局域网代理代转，没有本机
 * socket 可言，身份靠中转与 worker 之间的 sidecarToken。任何新加的例外都必须在这里
 * 一条条写明原因，否则半年后没人分得清哪条是必要的。
 *
 * 配对与管理操作允许本机及标准局域网直连；公网窗口只放行只读面板。
 * 局域网部署由另一台电脑操作是受支持场景，不要求先开启两小时窗口。
 * 桌面侧边栏两颗图标的显示开关也走改配置那条路由，形状必须是布尔值。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const routing = require('../lib/http/routing.js');

const CONTROL_PLANE = path.join(__dirname, '..', 'lib', 'routes', 'control-plane.js');
const { pairingPayload } = require(path.join(__dirname, '..', 'lib', 'relay', 'pairing-payload.cjs'));
const {
  WEB_ACCESS_ROUTES,
  panelScopeOf,
  registerControlPlaneRoutes,
} = require(CONTROL_PLANE);

/** 允许不挂 localOnly 的控制面路由：key → 为什么。 */
const NO_LOCAL_ONLY = new Map([
  ['/api/relay/internal/approval', '由中转与局域网代理代转，没有本机 socket 可言；身份靠 sidecarToken（中转 ↔ worker 共享密钥），不是「这条路由不重要」的例外'],
  ['/api/relay/internal/issue-credential', '旁路子进程（局域网代理）签发凭据的唯一通道：凭据库只有主进程一个写方，身份靠 sidecarToken'],
  ['/api/relay/internal/rotate-pairing', '旁路子进程配对成功后换码换票据的唯一通道：状态文件只有主进程能写，身份靠 sidecarToken'],
  ['/api/relay/internal/pairing', '旁车子进程解手机配对请求前，向主进程现取当前配对码 / 票据 / 实例号的内部通道；身份靠 sidecarToken，没有本机 socket'],
]);

/** 不随网页管理窗口关闭的控制面通道：必须逐条说明用途。 */
const NO_WEB_ACCESS = new Map([
  ['/api/relay/internal/approval', '中转与 sidecar 的内部审批通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/internal/issue-credential', 'sidecar 签发凭据的内部通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/internal/rotate-pairing', 'sidecar 换码换票据的内部通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/internal/pairing', 'sidecar 配对校验前取当前配对码 / 票据 / 实例号的内部通道，依赖 sidecarToken，不由网页面板调用'],
  ['/api/relay/read-receipt', '桌面端轮询上报回执以同步本地已读状态，属于客户端功能，不是网页管理面板。'],
  ['/api/relay/client-half', '桌面客户端每 10 秒上报存活与故障自检状态，不能随网页管理窗口停止。'],
  ['/api/relay/desktop-read', '桌面客户端轮询同步已读会话，属于手机与桌面协同通道，不是网页管理接口。'],
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
    '/api/relay/status',
    '/api/relay/feedback',
    // 面板页（设置界面搬进宿主吐的 HTML）与它的「引导走完了」标记。
    // 面板页三个地址：自己分流 / 强制引导 / 强制主页。
    '/api/relay/panel',
    '/api/relay/panel/setup',
    '/api/relay/panel/settings',
    // 调试页 /api/relay/panel/debug 2026-11-17 删除，不再注册。
    // 控制台那一窗：同一份 HTML，点手机图标进来的第一屏。
    '/api/relay/panel/console',
    // 远程电脑独立页：同一份 HTML，点电脑图标进来的那一窗。
    '/api/relay/panel/remote',
    '/api/relay/onboarded',
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
  assert.equal(NO_LOCAL_ONLY.size, 4);
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

test('不挂 localOnly 的内部路由对宿主层声明匿名，身份仍靠 sidecarToken', () => {
  // 新版宿主把未声明 auth 的路由按 required 处理。旁车（局域网代理）没有桌面会话，
  // 不声明匿名就会被网关层 401 拦掉、根本到不了 handler 里的 sidecarToken 校验，
  // 表现为扫码配对永远失败（反馈 #39）。这里钉住这四条都必须声明 auth: 'anonymous'。
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const byPath = new Map(registrations(source).map((r) => [r.path, r.handler]));
  for (const route of NO_LOCAL_ONLY.keys()) {
    const slice = byPath.get(route);
    assert.ok(slice, `${route} 找不到`);
    assert.match(slice, /auth:\s*'anonymous'/, `${route} 必须对宿主层声明 auth: 'anonymous'`);
  }
});

test('改配置的路由逐字段校验，不接受任意键', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/config'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1600 : end);
  for (const field of ['relayUrl', 'lanEnabled', 'lanPort', 'name', 'pairingPolicy', 'registerSecret', 'preferredLanAddress', 'manualLanUrl', 'manualIpv6Url', 'desktopPhoneIcon', 'desktopComputerIcon']) {
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
function controlRoutes({ state = {}, settingsCalls = [], notifyCalls = [], credentials: credentialStore,
  localOnly = (_method, handler) => handler, trustedLocalUi = () => true, dropDeviceStreams = () => 0, getPluginRuntime = () => null,
  reconnectTunnel, frp, tailcat, cloudflare, zeroNews, syncSidecar = async () => {},
  registerRoutes = registerControlPlaneRoutes } = {}) {
  const table = new Map();
  // 设备清单那两条要拿同一份库回答，给个空库让不相干的用例也能把整张表挂起来。
  const credentials = credentialStore || { listDevices: () => [], listHistory: () => [], listDevicesWithHistory: () => ({ devices: [], history: [] }) };
  const settings = {
    async update(patch, options) {
      settingsCalls.push(patch);
      notifyCalls.push(options && options.notify);
      Object.assign(state, patch);
      return state;
    },
  };
  registerRoutes({
    registerRoute: (route) => table.set(route.path, route.handler),
    localOnly,
    trustedLocalUi,
    sendJson: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async (req) => req.body || {},
    settings,
    state,
    credentials,
    dropDeviceStreams,
    getPluginRuntime,
    status: () => ({}),
    syncSidecar,
    reconnectTunnel,
    frp,
    tailcat,
    cloudflare,
    zeroNews,
    sidecarToken: 'test',
    lanPortInUse: () => 18787,
    getLanPortAdjusted: () => false,
    resolveLanPort: async () => 18787,
    // 二维码载荷走真模块：这条测试要钉的是「路由怎么读请求、有没有把预览写进配置」，
    // 载荷拼装本身由 `test/pair-cli.test.cjs` 与 App 侧那份契约钉着。
    pairingPayload,
  });
  return table;
}

test('反馈读写：返回线程本身、续回复共用提交服务，来源守卫拒绝移动转发与公网窗口', async () => {
  const table = controlRoutes({ state: { instanceId: 'install-1' }, localOnly: routing.localOnly, trustedLocalUi: routing.trustedLocalUi });
  const handler = table.get('/api/relay/feedback');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ data: init.method === 'GET'
      ? { id: 9, thread_key: 'thread-1', status: 'open', messages: [{ id: 2, author: 'staff', content: '请补充信息', created_at: '2026-11-21', attachments: [] }] }
      : { thread_key: 'thread-1' } }) };
  };
  try {
    const get = {};
    await handler(networkRequest('/api/relay/feedback?thread_key=thread-1', '127.0.0.1', '127.0.0.1:19387'), get);
    assert.equal(get.status, 200);
    assert.equal(get.body.thread_key, 'thread-1');
    assert.equal(get.body.messages[0].content, '请补充信息');
    assert.equal(get.body.data, undefined);
    assert.equal(calls[0].url, 'https://app.wnluo.com/api/sdk/feedback?thread_key=thread-1');
    const post = {};
    await handler({ ...networkRequest('/api/relay/feedback', '192.168.1.2', '192.168.1.20:19387', { method: 'POST' }), body: { content: '版本已更新', threadKey: 'thread-1' } }, post);
    assert.equal(post.status, 200);
    assert.equal(post.body.threadKey, 'thread-1');
    assert.ok(post.body.submissionId);
    assert.equal(post.body.data, undefined);
    assert.equal(calls[1].init.body.get('thread_key'), 'thread-1');
    assert.equal(calls[1].init.body.get('content'), '版本已更新');
    assert.equal(calls[1].init.body.get('device_id'), 'install-1');
    const bad = {};
    await handler(networkRequest('/api/relay/feedback?thread_key=%20', '127.0.0.1', '127.0.0.1:19387'), bad);
    assert.equal(bad.status, 400);
    const empty = {};
    await handler({ ...networkRequest('/api/relay/feedback', '127.0.0.1', '127.0.0.1:19387', { method: 'POST' }), body: { content: '' } }, empty);
    assert.equal(empty.status, 400);
    const method = networkResponse();
    await handler(networkRequest('/api/relay/feedback', '127.0.0.1', '127.0.0.1:19387', { method: 'DELETE' }), method);
    assert.equal(method.status, 405);
    for (const method of ['GET', 'POST']) {
      // 2026-11-21：控制面不按来源拦截，只拦经中转 / 局域网代理转发来的请求。
      for (const headers of [{ 'x-dsh-via': 'relay' }, { 'x-dsh-via': 'lan' }, { 'x-dsh-instance': 'phone' }]) {
        const denied = networkResponse();
        await handler(networkRequest('/api/relay/feedback?thread_key=thread-1', '127.0.0.1', '127.0.0.1:19387', { method, headers }), denied);
        assert.equal(denied.status, 403);
      }
    }
    const remote = {};
    await handler(networkRequest('/api/relay/feedback?thread_key=thread-1', '203.0.113.2', 'public.example'), remote);
    assert.equal(remote.status, 200, '公网来源照常读取');
    assert.equal(calls.length, 3, '无效输入和转发来的请求不触发上游');
    globalThis.fetch = async () => ({ status: 404, json: async () => ({ error: '平台说线程不存在' }) });
    const missing = {};
    await handler(networkRequest('/api/relay/feedback?thread_key=missing', '127.0.0.1', '127.0.0.1:19387'), missing);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.message, '平台说线程不存在');
    assert.ok(WEB_ACCESS_ROUTES.has('/api/relay/feedback'));
  } finally { globalThis.fetch = originalFetch; }
});

test('行为：局域网配对成功回执记录完成时间，手动换码不伪造成功', async () => {
  const core = require('../lib/relay/core.js');
  const rotate = core.rotatePairing;
  const save = core.saveState;
  core.rotatePairing = (state) => ({ pairingCode: state.pairingCode = '654321' });
  core.saveState = () => {};
  try {
    const state = { pairingCode: '123456' };
    const table = controlRoutes({ state });
    const denied = {};
    await table.get('/api/relay/internal/rotate-pairing')({ headers: { authorization: 'invalid' } }, denied);
    assert.equal(denied.status, 401);
    assert.equal(state.lastPairingAt, undefined, '被拒的内部请求不记录成功');
    const started = Date.now();
    const success = {};
    await table.get('/api/relay/internal/rotate-pairing')({ headers: { authorization: 'Bearer test' } }, success);
    assert.equal(success.status, 200);
    assert.ok(state.lastPairingAt >= started, '局域网绑定成功才写完成时间');
    const recorded = state.lastPairingAt;
    await table.get('/api/relay/regenerate')({ method: 'POST', body: {} }, {});
    assert.equal(state.lastPairingAt, recorded, '面板手动换码不能冒充成功绑定');
  } finally {
    core.rotatePairing = rotate;
    core.saveState = save;
  }
});

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

test('行为：侧边栏图标开关只认布尔值，与其余配置写进同一份', async () => {
  const calls = [];
  const notifies = [];
  const table = controlRoutes({ state: { desktopPhoneIcon: true, desktopComputerIcon: true }, settingsCalls: calls, notifyCalls: notifies });
  const saved = {};
  await table.get('/api/relay/config')({ method: 'POST', body: { desktopPhoneIcon: false, desktopComputerIcon: true } }, saved);
  assert.equal(saved.status, 200);
  assert.deepEqual(calls[0], { desktopPhoneIcon: false, desktopComputerIcon: true });
  assert.equal(notifies[0], false, '纯图标写入不许顺手重建隧道');

  await table.get('/api/relay/config')({ method: 'POST', body: { desktopPhoneIcon: true, name: '桌机' } }, {});
  assert.equal(notifies[1], true, '混着真实配置项时照旧下发');

  for (const bad of ['false', 0, 1, null, {}]) {
    const badCalls = [];
    const badTable = controlRoutes({ state: { desktopPhoneIcon: true, desktopComputerIcon: true }, settingsCalls: badCalls });
    const res = {};
    await badTable.get('/api/relay/config')({ method: 'POST', body: { desktopPhoneIcon: bad, desktopComputerIcon: bad, name: 'ok' } }, res);
    assert.equal(res.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(badCalls[0], 'desktopPhoneIcon'), false,
      `${JSON.stringify(bad)} 不该写成显示状态`);
    assert.equal(Object.prototype.hasOwnProperty.call(badCalls[0], 'desktopComputerIcon'), false);
    assert.equal(badCalls[0].name, 'ok', '其余合法字段照旧写入');
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

test('行为：只配一家服务商线路、或一条都没有时都能出码', async () => {
  // 停用公用中转 + 关局域网 + 只接一家服务商：这是支持中的配置，出码判定必须认服务商线路。
  const state = {
    enabled: true, instanceId: 'i1', pairingCode: '123456', pairingTicket: 't'.repeat(43),
    relayUrl: '', relayUrls: [], lanEnabled: false, lanPort: 18787,
    publicRelayDisabled: true, zeroNewsUrl: 'https://zero.example.com',
  };
  const table = controlRoutes({ state });
  const res = {};
  await table.get('/api/relay/pairing')({ method: 'GET', url: '/api/relay/pairing' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.svg, /<svg/, '只接服务商也要真正生成二维码');

  // 一条线路都没有的机器，码里仍有内置公用做首次配对兜底，出码判定通过；判据没放宽，
  // 是码里带了地址。配了 http 服务商的机器则是服务商地址进 lanUrls 供老包拨，不再借公用。
  const none = controlRoutes({ state: { ...state, zeroNewsUrl: '' } });
  const bare = {};
  await none.get('/api/relay/pairing')({ method: 'GET', url: '/api/relay/pairing' }, bare);
  assert.equal(bare.status, 200, '纯新装机器靠公用兜底也能出码');
  assert.match(bare.body.svg, /<svg/, '带公用兜底的码也要真正生成');
});

/** 使用真实来源守卫，验证局域网网页访问而不是绕过校验的路由假体。 */
function networkRequest(url, remoteAddress, host, { method = 'GET', headers = {}, body } = {}) {
  return { url, method, socket: { remoteAddress }, body,
    headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', ...headers } };
}
function networkResponse() {
  return { status: 0, body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); } };
}

test('局域网与公网部署：不按来源拦截，只拒绝转发来的请求', async () => {
  // 同一局域网的另一台电脑、公网域名、反代后面都是受支持的管理入口，不能要求宿主先在本机开窗口。
  const state = { enabled: true, instanceId: 'i1', pairingCode: '123456', pairingTicket: 't'.repeat(43),
    relayUrl: 'https://relay.example.com', name: 'host', lanEnabled: false, lanPort: 18787 };
  const table = controlRoutes({ state, localOnly: routing.localOnly, trustedLocalUi: routing.trustedLocalUi });
  for (const [peer, host] of [
    ['127.0.0.1', '127.0.0.1:19387'], ['192.168.1.2', '192.168.1.20:19387'],
    ['::ffff:10.0.0.2', '10.0.0.20:19387'], ['172.31.0.2', '172.31.0.20:19387'],
    ['fd00::2', '[fd00::20]:19387'],
  ]) {
    const status = networkResponse();
    await table.get('/api/relay/status')(networkRequest('/api/relay/status', peer, host), status);
    assert.equal(status.status, 200, `${host} 无需开窗口即可读取状态`);
    const qr = networkResponse();
    await table.get('/api/relay/pairing')(networkRequest('/api/relay/pairing', peer, host), qr);
    assert.equal(qr.status, 200, JSON.stringify(qr.body));
    assert.match(qr.body.svg, /<svg/, `${host} 必须真正生成二维码`);
    const saved = networkResponse();
    await table.get('/api/relay/config')(networkRequest('/api/relay/config', peer, host,
      { method: 'POST', body: { name: 'LAN host' } }), saved);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(state.name, 'LAN host');
  }
  // 公网直连、Host 与来源不一致、带普通反代头都不再拒绝：面板从哪儿打开都能用。
  for (const [peer, host, headers] of [
    ['203.0.113.2', '203.0.113.20:19387', {}],
    ['203.0.113.2', '192.168.1.20:19387', {}],
    ['192.168.1.2', '203.0.113.20:19387', {}],
    ['192.168.1.2', 'dsh.example.com:19387', {}],
    ['192.168.1.2', '192.168.1.20:19387', { 'x-forwarded-for': '192.168.1.3' }],
  ]) {
    const qr = networkResponse();
    await table.get('/api/relay/pairing')(networkRequest('/api/relay/pairing', peer, host, { headers }), qr);
    assert.equal(qr.status, 200, `${host} 不再按来源拒绝`);
    assert.match(qr.body.svg, /<svg/);
  }
  // 经中转 / 局域网代理转发来的照旧拒绝：那条链路是手机的能力面。
  for (const via of ['lan', 'relay', 'tunnel']) {
    const qr = networkResponse();
    await table.get('/api/relay/pairing')(networkRequest('/api/relay/pairing', '127.0.0.1', '127.0.0.1:19387',
      { headers: { 'x-dsh-via': via } }), qr);
    assert.equal(qr.status, 403, JSON.stringify(qr.body));
    assert.equal(qr.body.error.code, 'local_only');
  }
  // 2026-11-21 需求变更：控制面不再按跨站来源拒绝，局域网直连带 cross-site 也照常出码。
  const crossSiteLan = networkResponse();
  await table.get('/api/relay/pairing')(networkRequest('/api/relay/pairing', '192.168.1.2', '192.168.1.20:19387',
    { headers: { 'sec-fetch-site': 'cross-site' } }), crossSiteLan);
  assert.equal(crossSiteLan.status, 200, '跨站来源不再拦，按局域网直连放行');
  const publicStatus = networkResponse();
  await table.get('/api/relay/status')(networkRequest('/api/relay/status', '203.0.113.2', '203.0.113.20:19387'), publicStatus);
  // 2026-11-21 需求变更：只读管理面不再限制来源，公网也直接能读状态、进面板。
  assert.equal(publicStatus.status, 200, '公网读接口不再要求两小时窗口');
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

test('行为：局域网地址栏不回显混进来的中转地址（2026-11-18 现场）', async () => {
  // 户外选路曾把「当前在用的中转地址」写进手机的局域网地址，手机再存成 preferred 传回来，
  // 面板的局域网地址栏就显示了一枚用户没填过的中转地址。这里认出是中转 host 就不再回显。
  const relayHost = 'dsh-relay.example.com';
  const table = controlRoutes({
    state: { relayUrl: `https://${relayHost}`, relayUrls: [`https://${relayHost}`], preferredLanAddress: relayHost },
  });
  const res = {};
  await table.get('/api/relay/addresses')({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.preferred, '', '中转地址的 host 不许当「优先局域网地址」回显');

  const real = controlRoutes({
    state: { relayUrl: `https://${relayHost}`, relayUrls: [`https://${relayHost}`], preferredLanAddress: '192.168.1.5' },
  });
  const realRes = {};
  await real.get('/api/relay/addresses')({ method: 'GET' }, realRes);
  assert.equal(realRes.body.preferred, '192.168.1.5', '真的局域网地址照旧回显');

  const pubHost = 'ai-hub-de-1.wnluo.com';
  const pub = controlRoutes({
    state: { relayUrl: `https://${pubHost}`, relayUrls: [`https://${pubHost}`], preferredLanAddress: pubHost },
  });
  const pubRes = {};
  await pub.get('/api/relay/addresses')({ method: 'GET' }, pubRes);
  assert.equal(pubRes.body.preferred, '', '公用中转 host 同样不许回显');
});

test('面板读不到时报的是能定位的诊断，不是一句「还没构建」', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  // 几条面板地址共用 servePanel。2026-10-10 的真机现场：装完没重启，旧实例挂在被删掉的
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
  // 控制面除了 `/api/relay/*`，还有 `/api/cloudflare/*` 这组兜底隧道启停；两者都按同一套
  // 网页访问窗口保护，盘点时一起纳入，别让新前缀成了漏网的例外。
  const routes = registrations(source).map((route) => route.path)
    .filter((route) => route.startsWith('/api/relay/') || route.startsWith('/api/cloudflare/'));
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

test('面板地址分三类：本机回环 / 局域网 / 公网（域名一律算公网）', () => {
  const scope = (host) => panelScopeOf({ headers: { host } });
  assert.equal(scope('127.0.0.1:19387'), 'loopback');
  assert.equal(scope('localhost:19387'), 'loopback');
  assert.equal(scope('[::1]:19387'), 'loopback');
  assert.equal(scope('127.24.8.9:19387'), 'loopback');
  assert.equal(scope('192.168.1.20:19387'), 'private');
  assert.equal(scope('10.0.0.5'), 'private');
  assert.equal(scope('172.16.4.4:19387'), 'private');
  assert.equal(scope('172.31.4.4:19387'), 'private');
  assert.equal(scope('[fd00::1]:19387'), 'private');
  assert.equal(scope('[fe80::1]:19387'), 'private');
  assert.equal(scope('198.18.0.1:19387'), 'public');
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

test('行为：/status 报「配了几台手机、最近一次连线」（图标标题要说这句）', async () => {
  // 与 `/devices` 同一把键、同一份活记录：两边数出不一样的台数比不显示更糟。
  const table = controlRoutes({
    state: { instanceId: 'i1' },
    credentials: {
      listDevices: () => [],
      listHistory: () => [],
      listDevicesWithHistory: () => ({
        devices: [
          { deviceId: 'a', lastSeenAt: 1_700_000_000_000 },
          { deviceId: 'b', lastSeenAt: 1_700_000_500_000 },
          { deviceId: 'c', lastSeenAt: 0 }, // 绑了但从没连过，不参与「最近」但算台数
        ],
        history: [],
      }),
    },
  });
  const res = {};
  await table.get('/api/relay/status')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.devices, { count: 3, lastSeenAt: 1_700_000_500_000 });
});

test('行为：/status 拿不到凭据库时报 null，不编一个 0 台', async () => {
  // 「不知道」与「一台都没有」在界面上是两句不同的话，混成一个就会天天提示去配对。
  const table = controlRoutes({ state: {}, credentials: { listDevices: () => [], listHistory: () => [] } });
  const res = {};
  await table.get('/api/relay/status')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.devices, null);
});

test('管理操作不按来源拦截：公网、局域网、本机都放行，只拒绝转发来的请求', async () => {
  const state = { enabled: true, instanceId: 'i1', pairingCode: '123456', pairingTicket: 't'.repeat(43),
    relayUrl: 'https://relay.example.com', name: 'host', lanEnabled: false, lanPort: 18787 };
  const table = controlRoutes({ state, localOnly: routing.localOnly });
  const cases = [
    ['/api/relay/pairing', 'GET'], ['/api/relay/devices', 'GET'],
    ['/api/relay/devices/history/clear', 'POST'], ['/api/relay/inbox/clear', 'POST'],
  ];
  for (const [route, method] of cases) {
    const publicRes = networkResponse();
    await table.get(route)(networkRequest(route, '203.0.113.2', 'public.example', { method }), publicRes);
    assert.notEqual(publicRes.status, 403, `${route} 不再按来源拒绝公网`);
    const forwarded = networkResponse();
    await table.get(route)(networkRequest(route, '127.0.0.1', '127.0.0.1:19387',
      { method, headers: { 'x-dsh-via': 'relay' } }), forwarded);
    assert.equal(forwarded.status, 403, `${route} 转发来的必须拒绝`);
    assert.equal(forwarded.body.error.code, 'local_only');
  }
});

test('二维码不另造来源判据：与其它路由共用同一个包装层', () => {
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const at = source.indexOf("'/api/relay/pairing'");
  assert.notEqual(at, -1);
  const end = source.indexOf('registerRoute', at + 1);
  const route = source.slice(at, end < 0 ? at + 1200 : end);
  // 二维码携带一次性票据，来源判断统一在包装层；handler 不另造第二套规则。
  assert.ok(WEB_ACCESS_ROUTES.has('/api/relay/pairing'), '仍留在路由清单里');
  assert.ok(!/trustedLocalUi\(req\)/.test(route), '别在路由 handler 里另造一套更严的判据');
  assert.ok(!/local_operator_only/.test(route), '路由里不自己造来源拒绝');
});

test('控制面不再有「按来源放开」的逐路由参数（来源统一不拦）', () => {
  // 2026-11-21 需求变更：跨站来源不再拦，原先只给面板页的 allowDocumentNavigation 一并删掉，
  // 免得留下一个看起来还在管来源、其实不该再管的死参数。
  const source = fs.readFileSync(CONTROL_PLANE, 'utf8');
  assert.equal(source.includes('allowDocumentNavigation'), false);
});

test('行为：设备清单带「历史有几条」，同一个 handler 按 ?history=1 换成已解绑清单', async () => {
  // 同一台手机可能同时在两张清单的口径里：活动那半只回活着的，已解绑那半整组跳过它。
  // 两条都不是凭据材料，`revokedCount` 只用来决定面板摆不摆那张卡。
  const calls = [];
  const table = controlRoutes({
    state: { instanceId: 'i1' },
    credentials: {
      listDevices: () => [{ deviceId: 'live-1', bindings: 1 }],
      listHistory: () => { calls.push('history'); return [{ deviceId: 'old-1', kind: 'revoked', bindings: 1, name: '旧手机' }]; },
      // 非历史分支走这一条：一份记录扫一次，两份结果一起拿。
      listDevicesWithHistory: () => {
        calls.push('both');
        return {
          devices: [{ deviceId: 'live-1', bindings: 1 }],
          history: [{ deviceId: 'old-1', kind: 'revoked', bindings: 1, name: '旧手机' }],
        };
      },
    },
  });

  const active = {};
  await table.get('/api/relay/devices')({ method: 'GET', url: '/api/relay/devices' }, active);
  assert.equal(active.status, 200);
  assert.equal(active.body.ok, true);
  assert.ok(active.body.serverNow > 0, '面板算「几分钟前」要的是同一台机器上的基准');
  assert.deepEqual(active.body.devices.map((row) => row.deviceId), ['live-1'], '不带 query 还是活动清单');
  assert.equal(active.body.revokedCount, 1, '历史有几行：面板据此决定摆不摆那张卡');
  assert.deepEqual(calls, ['both'], '活清单那一发只好一次扫描：别再为条数另扫一遍');
  calls.length = 0;

  const history = {};
  await table.get('/api/relay/devices')({ method: 'GET', url: '/api/relay/devices?history=1' }, history);
  assert.equal(history.status, 200);
  assert.equal(history.body.ok, true);
  assert.ok(history.body.serverNow > 0);
  assert.ok(Array.isArray(history.body.devices), 'history 分支同样回 devices 数组');
  assert.deepEqual(history.body.devices.map((row) => row.deviceId), ['old-1']);
  assert.equal(Object.prototype.hasOwnProperty.call(history.body, 'revokedCount'), false, '历史分支不必自己报数');
  assert.deepEqual(calls, ['history'], '历史那一发不需要活动那张表，别为了对称白扫一遍');

  // 别的 query 值不当成历史：只认 1，免得 `?history=false` 这种把活动清单换掉。
  const other = {};
  await table.get('/api/relay/devices')({ method: 'GET', url: '/api/relay/devices?history=0' }, other);
  assert.deepEqual(other.body.devices.map((row) => row.deviceId), ['live-1']);
})


test('单台吊销响应保留数字closed', async () => {
  const store = { revokeDevice: () => 1, listDevices: () => [], listDevicesWithHistory: () => ({ devices: [], history: [] }) };
  const table = controlRoutes({ state: { instanceId: 'closed-instance' }, credentials: store, dropDeviceStreams: (id) => { assert.equal(id, 'phone'); return 3; } });
  const res = {};
  await table.get('/api/relay/devices/revoke')({ method: 'POST', body: { deviceId: 'phone' }, headers: {} }, res);
  assert.equal(res.body.closed, 3);
  assert.equal(typeof res.body.closed, 'number');
});

function networkRoutesModule(mutate = source => source, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(mutate(fs.readFileSync(CONTROL_PLANE, 'utf8')), {
    module, exports: module.exports, require: createRequire(CONTROL_PLANE), __dirname: path.dirname(CONTROL_PLANE),
    process, Buffer, URL, performance, AbortController, fetch, setTimeout, clearTimeout, ...globals,
  });
  return module.exports.registerControlPlaneRoutes;
}

async function pairingWindowContract(mutate, change, phase = 'window') {
  const core = require('../lib/relay/core.js');
  const e2ee = require('../lib/shared/e2ee.js');
  const { openSealedPairRequest } = require('../lib/shared/e2ee-pair.js');
  const state = { enabled: true, instanceId: 'host-before', pairingCode: '123456',
    pairingTicket: Buffer.alloc(32, 1).toString('base64url'),
    relayUrl: 'https://relay.example.com', name: 'host', lanEnabled: false, lanPort: 18787 };
  const nextPairing = { pairingCode: '654321', pairingTicket: Buffer.alloc(32, 2).toString('base64url') };
  let reached, release, invite;
  const waiting = new Promise(resolve => { reached = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const pause = async () => { reached(); await pending; };
  const nativeRequire = createRequire(CONTROL_PLANE);
  const registerRoutes = networkRoutesModule(mutate, { require(id) {
    if (id === '../relay/core.js') return { ...core, saveState() {},
      rotatePairing(current) { Object.assign(current, nextPairing); return nextPairing; } };
    if (id === 'qrcode') return { async toString(text) {
      invite = JSON.parse(new URL(text).searchParams.get('data'));
      if (phase === 'render') await pause();
      return '<svg></svg>';
    } };
    return nativeRequire(id);
  } });
  const table = controlRoutes({ state, registerRoutes,
    tailcat: { async openPairingWindow() { if (phase === 'window') await pause(); return null; } } });
  const res = {};
  const request = table.get('/api/relay/pairing')({ method: 'GET', url: '/api/relay/pairing' }, res);
  await waiting;
  try {
    if (change === 'disabled') state.enabled = false;
    else if (change === 'identity') Object.assign(state, nextPairing, { instanceId: 'host-after' });
    else {
      const changed = {};
      const internal = change === 'paired';
      await table.get(internal ? '/api/relay/internal/rotate-pairing' : '/api/relay/regenerate')({
        method: 'POST', body: {}, headers: { authorization: 'Bearer test' },
      }, changed);
      assert.equal(changed.status, 200, '等待出码时，正常换码与配对成功回执仍可完成');
      assert.equal(Boolean(state.lastPairingAt), internal, '仅成功配对回执记录完成时间');
    }
  } finally { release(); }
  await request;
  if (phase === 'render' || change === 'disabled') {
    assert.equal(res.status, 409, '二维码渲染时换票、换身份或停用，必须拒绝返回过期码');
    assert.equal(res.body.svg, undefined, '过期或停用状态不返回二维码');
    return;
  }
  assert.equal(res.status, 200, '窗口打开后应生成当前可用的二维码');
  assert.equal(invite.instanceId, state.instanceId, '扫码路由与宿主使用同一当前身份');
  assert.equal(invite.code, state.pairingCode, '二维码与当前配对码一致');
  assert.equal(res.body.pairingCode, invite.code, '面板的当前码标识与实际二维码一致');
  const key = e2ee.derivePairKey(Buffer.from(invite.ticket, 'base64url'), invite.instanceId);
  const sealed = e2ee.seal(key, Buffer.from(JSON.stringify({
    deviceKey: Buffer.alloc(32, 3).toString('base64url'), keyId: '0102030405060708', device: { deviceId: 'phone' },
  })), e2ee.pairAad(invite.instanceId)).toString('base64');
  const open = (claimedInstanceId, ticket = state.pairingTicket) => openSealedPairRequest({
    ticket, instanceId: state.instanceId, claimedInstanceId, sealed,
  });
  assert.equal(open(invite.instanceId).ok, true, '从新二维码加密的真实配对请求必须能被当前宿主解封');
  assert.equal(open('different-host').ok, false, '宿主身份校验保持生效');
  assert.equal(open(invite.instanceId, Buffer.alloc(32, 4).toString('base64url')).ok, false, '错误票据仍须被拒绝');
}

test('二维码等待隧道窗口期间换码、配对成功或换身份，取完成后的当前票据', async () => {
  for (const change of ['regenerate', 'paired', 'identity']) await pairingWindowContract(undefined, change);
});
test('等待隧道窗口或二维码渲染时停用，不返回二维码；渲染中轮换票据和身份要求重新获取', async () => {
  await pairingWindowContract(undefined, 'disabled');
  for (const change of ['regenerate', 'paired', 'identity', 'disabled']) await pairingWindowContract(undefined, change, 'render');
});
test('变异：提前捕获票据或省略渲染完成复核，会被二维码验票流程拒绝', async () => {
  const snapshot = '    const source = previewUrl ? { ...state, relayUrl: previewUrl, relayUrls: [previewUrl] } : state\n    const { payload } = pairingPayload(source, lanPortInUse())\n';
  await assert.rejects(pairingWindowContract(source => source.replace(snapshot, '')
    .replace('    const tailcat = deps.tailcat', `${snapshot}    const tailcat = deps.tailcat`), 'regenerate'), assert.AssertionError);
  const currentCheck = "!state.enabled || payload.instanceId !== state.instanceId || payload.code !== state.pairingCode || payload.ticket !== (state.pairingTicket || '')";
  for (const change of ['regenerate', 'identity', 'disabled']) {
    await assert.rejects(pairingWindowContract(source => source.replace(currentCheck, 'false'), change, 'render'), assert.AssertionError);
  }
});

async function reconnectContract(mutate) {
  const registerRoutes = networkRoutesModule(mutate);
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const table = controlRoutes({ registerRoutes, reconnectTunnel: async () => { calls += 1; await pending; } });
  const res = {};
  const action = table.get('/api/relay/reconnect')({}, res);
  await Promise.resolve();
  assert.equal(calls, 1, '同配置也必须调用独立重连动作');
  assert.equal(res.status, undefined, '动作尚未受理不能先报成功');
  release(); await action;
  assert.equal(res.status, 200);
  const failed = controlRoutes({ registerRoutes, reconnectTunnel: async () => { throw new Error('worker unavailable'); } });
  const error = {};
  await failed.get('/api/relay/reconnect')({}, error);
  assert.equal(error.status, 502);
  assert.equal(error.body.error.code, 'reconnect-failed');
  const missing = {};
  await controlRoutes({ registerRoutes }).get('/api/relay/reconnect')({}, missing);
  assert.equal(missing.status, 503);
}
test('主动重连调用独立动作，等受理后回执，失败与缺能力不报成功', () => reconnectContract());
test('变异：主动重连退回幂等配置同步会被行为断言拒绝', async () => {
  await assert.rejects(reconnectContract(source => source.replace('await reconnectTunnel()', 'await syncSidecar()')), assert.AssertionError);
});

async function frpAcceptedContract(mutate) {
  const registerRoutes = networkRoutesModule(mutate);
  for (const phase of ['retrying', 'starting', 'failed']) {
    const current = { running: false, retrying: phase === 'retrying', starting: phase === 'starting', error: 'frpc offline' };
    let saved = 0;
    const table = controlRoutes({ registerRoutes, frp: { runId: 1, saveConfig() { saved += 1; }, start: async () => current, status: () => current } });
    const res = {};
    await table.get('/api/relay/frp/import')({ body: { config: 'serverAddr = "example.com"' } }, res);
    assert.equal(saved, 1);
    assert.equal(res.body.ok, phase !== 'failed', '配置已保存并自动重试时按受理处理');
    assert.equal(res.body.status.running, false, '受理不伪造成已连通');
    assert.equal(res.body.status.error, 'frpc offline');
  }
}
test('FRP配置受理包含启动和自动重试，终止失败仍保留真实错误', () => frpAcceptedContract());
test('变异：只认running会误报正在自动重试的导入失败', async () => {
  await assert.rejects(frpAcceptedContract(source => source.replace(' || current.retrying || current.starting', '')), assert.AssertionError);
});

test('Cloudflare 未接入时启停回 503 cloudflare-unavailable', async () => {
  const table = controlRoutes({ state: {} });
  for (const path of ['/api/cloudflare/start', '/api/cloudflare/stop']) {
    const res = {};
    await table.get(path)({}, res);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'cloudflare-unavailable');
  }
});

test('Cloudflare 启动成功回 ok 并带上当前状态', async () => {
  let started = 0;
  const table = controlRoutes({ state: {}, cloudflare: {
    start: async () => { started += 1; return { running: true } },
    status: () => ({ running: true, url: 'https://demo.trycloudflare.com' }),
  } });
  const res = {};
  await table.get('/api/cloudflare/start')({}, res);
  assert.equal(started, 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.running, true);
  assert.equal(res.body.url, 'https://demo.trycloudflare.com');
});

test('Cloudflare 停止成功回 ok 并带上当前状态', async () => {
  let stopped = 0;
  const table = controlRoutes({ state: {}, cloudflare: {
    stop: async () => { stopped += 1; return { running: false } },
    status: () => ({ running: false, url: '' }),
  } });
  const res = {};
  await table.get('/api/cloudflare/stop')({}, res);
  assert.equal(stopped, 1);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.running, false);
});

test('ZeroNews 公网地址路由：本机客户端在跑时回可用隧道，读不到也按 200 如实回', async () => {
  const nativeRequire = createRequire(CONTROL_PLANE);
  const registerRoutes = networkRoutesModule(source => source, {
    require(id) {
      // 探针结果由注入假体给，测试不依赖本机是否真的装了 ZeroNews。
      if (id === '../zeronews/probe.cjs') return {
        readZeroNewsEndpoints: async () => ({ ok: true, urls: ['https://zn.takin.cc'], available: true, error: '' }),
      };
      return nativeRequire(id);
    },
  });
  const table = controlRoutes({ state: {}, registerRoutes });
  const res = {};
  await table.get('/api/relay/zeronews/endpoints')({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.urls, ['https://zn.takin.cc']);
  assert.equal(res.body.available, true);
});

test('ZeroNews 彻底清理：有清理能力才做，失败按 200 把 ok / error 如实带回', async () => {
  let calls = 0;
  const table = controlRoutes({ state: {}, zeroNews: {
    purge: async () => { calls += 1; return { ok: false, reset: { attempted: true, ok: false, error: 'need admin' }, cacheRemoved: false, error: 'need admin' }; },
  } });
  const res = {};
  await table.get('/api/relay/zeronews/purge')({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /need admin/);
  assert.equal(calls, 1);

  const missing = controlRoutes({ state: {} });
  const unavailable = {};
  await missing.get('/api/relay/zeronews/purge')({}, unavailable);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'zeronews-unavailable');
});

test('节点小宝线路：设备端在跑时报安装与绑定状态，顺带把已填的地址回给面板', async () => {
  const nativeRequire = createRequire(CONTROL_PLANE);
  const registerRoutes = networkRoutesModule(source => source, {
    require(id) {
      // 设备端状态由注入假体给，测试不依赖本机是否真的装了节点小宝。
      if (id === '../jdxb/probe.cjs') return {
        readStatus: async () => ({ supported: true, installed: true, bound: true, peerid: 'ABC', tun: 'fail', port: 2080, error: '' }),
        readBindUrl: async () => ({ ok: true, url: 'https://yc.iepose.com/bind', error: '' }),
        lineOf: (value) => (value ? { url: 'nb.nblink.cc:15565', transport: 'tcp' } : null),
      };
      return nativeRequire(id);
    },
  });
  const table = controlRoutes({ state: { jdxbUrl: 'nb.nblink.cc:15565' }, registerRoutes });
  const res = {};
  await table.get('/api/relay/jdxb/status')({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.installed, true);
  assert.equal(res.body.bound, true);
  assert.equal(res.body.url, 'nb.nblink.cc:15565');
});

test('节点小宝绑定链接：未绑时把设备端的跳转目标交出去，已绑不再去要', async () => {
  let binds = 0;
  const make = (bound) => {
    const nativeRequire = createRequire(CONTROL_PLANE);
    const registerRoutes = networkRoutesModule(source => source, {
      require(id) {
        if (id === '../jdxb/probe.cjs') return {
          readStatus: async () => ({ supported: true, installed: true, bound, peerid: bound ? 'ABC' : '', tun: 'fail', port: 2080, error: '' }),
          readBindUrl: async () => { binds += 1; return { ok: true, url: 'https://yc.iepose.com/bind', error: '' }; },
        };
        return nativeRequire(id);
      },
    });
    return controlRoutes({ state: {}, registerRoutes });
  };
  const unbound = {};
  await make(false).get('/api/relay/jdxb/bind')({}, unbound);
  assert.equal(unbound.body.url, 'https://yc.iepose.com/bind');
  assert.equal(unbound.body.bound, false);
  const before = binds;
  const bound = {};
  await make(true).get('/api/relay/jdxb/bind')({}, bound);
  assert.equal(bound.body.bound, true);
  assert.equal(bound.body.url, '');
  assert.equal(binds, before, '已绑的设备不该再去要绑定链接');
});

test('节点小宝一键安装：装成系统服务后如实回报，失败按 500 带回原因', async () => {
  const nativeRequire = createRequire(CONTROL_PLANE);
  const make = (result) => networkRoutesModule(source => source, {
    require(id) {
      if (id === '../jdxb/provision.cjs') return {
        install: async () => result,
        installedSync: () => Boolean(result.installed),
      };
      return nativeRequire(id);
    },
  });
  const okTable = controlRoutes({ state: {}, registerRoutes: make({ ok: true, installed: true, started: true, error: '' }) });
  const ok = {};
  await okTable.get('/api/relay/jdxb/install')({}, ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  assert.equal(ok.body.service.installed, true);
  const badTable = controlRoutes({ state: {}, registerRoutes: make({ ok: false, installed: false, started: false, error: '授权被取消，设备端没有安装' }) });
  const bad = {};
  await badTable.get('/api/relay/jdxb/install')({}, bad);
  assert.equal(bad.status, 500, '装不上不能回 200');
  assert.match(bad.body.error, /取消/);
});

test('节点小宝线路地址：写「域名:端口」归一后落盘且不触发重配，坏地址与清空各有回法', async () => {
  const settingsCalls = [];
  const notifyCalls = [];
  const state = {};
  const table = controlRoutes({ state, settingsCalls, notifyCalls });
  const ok = {};
  await table.get('/api/relay/jdxb/url')({ body: { url: 'https://weadsad.iepose.cn/' } }, ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.url, 'https://weadsad.iepose.cn');
  assert.equal(ok.body.transport, 'http', '网页服务那条是 https 地址，按 http 线路报');
  const tcp = {};
  await table.get('/api/relay/jdxb/url')({ body: { url: 'nb.nblink.cc:15565' } }, tcp);
  assert.equal(tcp.body.url, 'nb.nblink.cc:15565');
  assert.equal(tcp.body.transport, 'tcp');
  assert.equal(notifyCalls.at(-1), false, '线路地址不进 sidecar 配置，别触发重配');
  const bad = {};
  await table.get('/api/relay/jdxb/url')({ body: { url: 'nb.nblink.cc' } }, bad);
  assert.equal(bad.status, 400, '缺端口的地址拨不通，必须挡住');
  const badUrl = {};
  await table.get('/api/relay/jdxb/url')({ body: { url: 'ftp://x' } }, badUrl);
  assert.equal(badUrl.status, 400);
  const cleared = {};
  await table.get('/api/relay/jdxb/url')({ body: { url: '' } }, cleared);
  assert.equal(cleared.status, 200);
  assert.equal(state.jdxbUrl, '', '空串 = 撤掉这条线路');
});

test('节点小宝绑定链接：必须手动接管跳转，跟过去就只剩网页没有地址', async () => {
  const { readBindUrl } = require('../lib/jdxb/probe.cjs');
  let seen = null;
  const result = await readBindUrl({
    port: 2080,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: false, headers: { get: (key) => (String(key).toLowerCase() === 'location' ? 'https://yc.iepose.com/jdxb_server_pc_v3/?pid=X' : '') } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.url.startsWith('https://yc.iepose.com/'), true);
  assert.equal(seen.init.redirect, 'manual', '跟着 302 跳过去就拿不到那个地址了');
});

async function probeCleanupContract(mutate) {
  const timers = new Set();
  const registerRoutes = networkRoutesModule(mutate, {
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    fetch: async () => { throw new Error('network unreachable'); },
  });
  const res = {};
  await controlRoutes({ registerRoutes }).get('/api/relay/probe-relays')({ body: { urls: ['https://relay.example'] } }, res);
  assert.equal(res.body.results[0].ms, null);
  assert.equal(timers.size, 0, '异常路径也必须撤销6秒探测期限');
}
test('公用中转探测失败后释放总期限计时器', () => probeCleanupContract());
test('变异：异常分支漏清计时器会被资源断言拒绝', async () => {
  await assert.rejects(probeCleanupContract(source => source.replace('} finally {\n        clearTimeout(timer)\n      }', '}')), assert.AssertionError);
});

test('行为：/status 如实报「外壳改过、要重启」，供侧边栏那颗入口变成提醒', async () => {
  // 外壳改过 = 盘上那份和跑着的不一样 = 这次更新要重启一次 DSH 才把外壳部分用上。
  const changed = controlRoutes({ state: {}, getPluginRuntime: () => ({ status: () => ({ shellChanged: true }) }) });
  const res = {};
  await changed.get('/api/relay/status')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.shellChanged, true);

  // 没有外壳 / 没改 / 量不到：一律 false，绝不假报重启。
  const plain = controlRoutes({ state: {} });
  const res2 = {};
  await plain.get('/api/relay/status')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res2);
  assert.equal(res2.body.shellChanged, false);
});

test('状态接口一路取值抛错只点名该路，其余照常回，不再整条 400', async () => {
  const written = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true };
  try {
    const table = controlRoutes({
      state: { enabled: true, instanceId: 'i1' },
      tailcat: { status: () => { throw new Error('tailcat snapshot exploded') } },
    });
    const res = {};
    await table.get('/api/relay/status')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res);
    assert.equal(res.status, 200, '一路坏不该把整条状态拖成 400');
    assert.equal(res.body.tailcat, null, '坏的那路如实报未取到');
    assert.match(res.body.panelUrl, /\/api\/relay\/panel$/, '其余取值照常回');
    assert.deepEqual(res.body.statusErrors.map((item) => item.field), ['tailcat']);
    assert.ok(written.join('').includes('tailcat snapshot exploded'), '异常原因要连堆栈写进宿主日志');
  } finally {
    process.stderr.write = originalWrite;
  }
});

/**
 * 总开关的下发结果：配置已经落盘，但旁车没接住时仍要回 200（界面据此显示新开关），
 * 同时把失败放进 applyError。绝不能回到「吞掉异常、弹已生效」那版。
 */
async function toggleContract(registerRoutes) {
  const state = { enabled: false };
  const fail = controlRoutes({
    state, registerRoutes,
    syncSidecar: async () => { throw new Error('worker unavailable'); },
  });
  const res = {};
  await fail.get('/api/relay/toggle')({ body: { enabled: true } }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.applyError, 'worker unavailable', '下发失败必须原样带回');
  assert.equal(state.enabled, true, '配置仍然落盘，与 /config 同一口径');

  const ok = {};
  await controlRoutes({ registerRoutes }).get('/api/relay/toggle')({ body: { enabled: false } }, ok);
  assert.equal(ok.body.applyError, undefined, '下发成功时不带 applyError');
}
test('总开关下发失败如实回 applyError，仍按已落盘回 200', () => toggleContract());
test('变异：把下发失败吞掉会被总开关守卫拒绝', async () => {
  const swallowed = 'await syncSidecar().catch(() => undefined)';
  const registerRoutes = networkRoutesModule(source => source.replace(
    'try { await syncSidecar() } catch (error) { applyError = String(error?.message || error) }', swallowed,
  ));
  await assert.rejects(toggleContract(registerRoutes), assert.AssertionError);
});
test('面板总开关读 applyError 报失败，不弹成功提示', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'React', 'src', 'Console.tsx'), 'utf8');
  const at = app.indexOf('const toggle = (enabled: boolean)');
  assert.notEqual(at, -1);
  const body = app.slice(at, app.indexOf('const restartSidecar', at));
  assert.match(body, /keepApplyError: true/, '总开关必须自己读 applyError，不能让通用请求直接抛掉');
  assert.match(body, /payload\.applyError/, '下发失败要据此改走失败提示');
  assert.match(body, /panel\.shell\.toggleApplyFailed/, '失败提示不是「已启用/已停用」那种成功回执');
});

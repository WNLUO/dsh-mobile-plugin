// 验证关闭局域网后 IPv6 候选保留，且中转只发布当前注册线路。
'use strict';

/**
 * `/api/mobile/v1/connection-info` 的候选契约：宿主到底把哪些地址报给手机。
 *
 * 这条接口是手机配对之后**唯一**能刷新到新地址的来源 —— 二维码里那份只在配对那一刻是
 * 新的（隐私地址按小时轮换、运营商换前缀之后旧的那条就拨不通）。所以 IPv6 直连候选必须
 * 跟着这份应答一起走：少回这一格，手机上那条通道就只能靠配对当时的旧地址活着，换一次网
 * 就静悄悄地退化成全程走中转。
 *
 * 这里钉三件事：局域网与 IPv6 两份候选都照实回；IPv6 那份不掺进局域网那份的顺序里
 * （手机要拿它单独和中转比快慢，两份混起来就没有比较对象了）。
 * PLUG-12 已确认独立保留 IPv6；关闭 LAN 只隐藏 IPv4 候选。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { registerMobileRoutes } = require(path.join(root, 'lib/routes/mobile-api.js'));

const LAN = { url: 'http://192.168.31.253:18787', address: '192.168.31.253', interface: 'en0', family: 'IPv4' };
const IPV6 = { url: 'http://[240e:338:5213:6c11::998]:18787', address: '240e:338:5213:6c11::998', interface: 'en1', family: 'IPv6' };

/** 假 ServerResponse：只记账，够 `sendJson` 用。 */
function fakeRes() {
  const res = {
    status: 0,
    raw: '',
    headersSent: false,
    writableEnded: false,
  };
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (chunk) => {
    res.raw = String(chunk == null ? '' : chunk);
    res.writableEnded = true;
  };
  return res;
}

/** 装一次路由表（宿主依赖全是固定的），取出 connection-info 那条。 */
function mountRoute(state) {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    guarded: (handler) => handler,
    state,
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({ tunnel: state.tunnel || { state: 'connected', relayUrl: state.relayUrl } }),
    safeLanCandidates: () => [LAN],
    safeIpv6Candidates: () => [IPV6],
    lanPortInUse: () => 18787,
    preview: { handleUpgrade() {} },
    core: {},
    pairingApproval: null,
  });
  const route = routes.find((item) => item.path === '/api/mobile/v1/connection-info');
  assert.ok(route, '没装出 /api/mobile/v1/connection-info');
  return route;
}

/** 发一次连接信息请求，回解析后的 JSON。 */
async function connectionInfo(state) {
  const route = mountRoute(state);
  const res = fakeRes();
  const req = { url: '/api/mobile/v1/connection-info', method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await route.handler({}, req, res);
  assert.equal(res.status, 200, `回了 ${res.status}：${res.raw.slice(0, 160)}`);
  return JSON.parse(res.raw);
}

const HOST = { lanEnabled: true, enabled: true, relayUrl: 'https://relay.example.com' };

test('IPv6 直连候选跟着这份应答一起回，形状与宿主报的一致', async () => {
  const body = await connectionInfo(HOST);
  assert.deepEqual(body.ipv6Candidates, [IPV6], 'IPv6 候选必须原样回给手机：它是配对之后唯一的新地址来源');
  // 手机按方括号拨号、按裸地址记（面板那条「手机优先用这条」也是裸地址），两者的分工别对调。
  assert.equal(body.ipv6Candidates[0].url, 'http://[240e:338:5213:6c11::998]:18787');
  assert.equal(body.ipv6Candidates[0].address, '240e:338:5213:6c11::998');
});

test('两份候选各回各的，IPv6 不掺进局域网那份的顺序', async () => {
  const body = await connectionInfo(HOST);
  assert.deepEqual(body.lanCandidates, [LAN], '局域网那份一个字都不该变');
  assert.equal(body.lanCandidates.some((item) => item.family === 'IPv6'), false);
  assert.equal(body.ipv6Candidates.some((item) => item.family === 'IPv4'), false);
});

test('关掉局域网只清IPv4候选，IPv6仍可用', async () => {
  const body = await connectionInfo({ ...HOST, lanEnabled: false });
  assert.deepEqual(body.lanCandidates, []);
  assert.deepEqual(body.ipv6Candidates, [IPV6]);
  assert.equal(body.relayUrl, 'https://relay.example.com', '中转地址与这个开关无关');
});

test('手机手填的直连地址排在最后当兜底，网卡候选一条不少地排在前面', async () => {
  // 现场：用户在这台电脑上填了内网穿透域名。它必须每次都被报回来 —— 手机重启、换网之后
  // 只剩这条路能把地址取回去；但它绕公网、比内网慢一个数量级，排在前面就会让手机永远选中
  // 它、家里那条内网地址一次都不试（2026-10-30 用户报的「现在没有局域网了」）。
  const body = await connectionInfo({ ...HOST, manualLanUrl: 'https://home.example.com:8443/' });
  assert.deepEqual(body.lanCandidates.map((item) => item.url), [LAN.url, 'https://home.example.com:8443']);
  assert.equal(body.lanCandidates[body.lanCandidates.length - 1].interface, 'manual');
});

test('手填的地址跟着局域网开关走：关掉直连就不报它', async () => {
  const body = await connectionInfo({ ...HOST, lanEnabled: false, manualLanUrl: 'https://home.example.com' });
  assert.deepEqual(body.lanCandidates, [], '直连监听没开，报一条拨不通的地址只会让手机白试');
});

test('手填的直连地址单独报 directUrl，供手机落到「直连」栏（不再只靠局域网候选里猜）', async () => {
  // 与局域网是两种地址：主机把它标成独立的 directUrl。lanUrls 里仍带着它只为老手机兼容，
  // 新手机读到 directUrl 就把那条从局域网候选里剔掉 —— 否则它会显示成「局域网地址」。
  const body = await connectionInfo({ ...HOST, manualLanUrl: 'https://home.example.com:8443/' });
  assert.equal(body.directUrl, 'https://home.example.com:8443');
  const none = await connectionInfo(HOST);
  assert.equal(none.directUrl, '', '没填也要带这一格（空串），手机据此知道电脑上没有直连地址');
});

test('手填的 IPv6 直连地址缀在 IPv6 候选最后，网卡那几条一条不少', async () => {
  // 与直连那条同一个取舍：手填的是兜底，同一个 Wi-Fi 下网卡地址快一个数量级，排前面
  // 就会按「先回话的赢」永远选中它。它也必须每轮跟着回来，否则手机重启一次就丢了。
  const body = await connectionInfo({ ...HOST, manualIpv6Url: 'http://[2001:4860:4860::8888]:18787/' });
  assert.deepEqual(body.ipv6Candidates.map((item) => item.url), [
    IPV6.url,
    'http://[2001:4860:4860::8888]:18787',
  ]);
  assert.equal(body.ipv6Candidates[body.ipv6Candidates.length - 1].interface, 'manual');
  // 它是 IPv6 那条通道的候选，不许漏进局域网那份（两份在 App 侧是独立的退避账）。
  assert.deepEqual(body.lanCandidates, [LAN]);
});

test('手填IPv6在关闭局域网后仍作为独立候选', async () => {
  const body = await connectionInfo({ ...HOST, lanEnabled: false, manualIpv6Url: 'http://[2001:4860:4860::8888]:18787' });
  assert.deepEqual(body.ipv6Candidates.map((item) => item.url), [IPV6.url, 'http://[2001:4860:4860::8888]:18787']);
});

test('TCP 直连目标始终回这一格：没配时是空串（手机据此把旧目标清掉）', async () => {
  // 只在有值时才报的话，「电脑上把 TCP 目标删掉」永远传不到手机：手机分不清
  // 「老宿主不认识这一格」与「宿主报了空」。两条一起钉住。
  const none = await connectionInfo(HOST);
  assert.equal(Object.prototype.hasOwnProperty.call(none, 'tcpUrl'), true, '没配也要带这一格');
  assert.equal(none.tcpUrl, '');
  const some = await connectionInfo({ ...HOST, manualTcpUrl: '[240e::1]:51543' });
  assert.equal(some.tcpUrl, '[240e::1]:51543', '方括号 IPv6 原样回给手机（与 tcpDirectTarget 同口径）');
});


test('当前线路取注册snapshot，配置首项和未注册备用不能冒充可连地址', async () => {
  const state = { ...HOST, relayUrls: ['https://relay.example.com', 'https://backup.example.com'], tunnel: { state: 'connected', relayUrl: 'https://backup.example.com' } };
  const live = await connectionInfo(state);
  assert.equal(live.relayUrl, 'https://backup.example.com');
  assert.deepEqual(live.relayUrls, ['https://backup.example.com']);
  const offline = await connectionInfo({ ...state, tunnel: { state: 'error', relayUrl: 'https://backup.example.com' } });
  assert.equal(offline.relayUrl, null);
  assert.deepEqual(offline.relayUrls, []);
});

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
 * （手机要拿它单独和中转比快慢，两份混起来就没有比较对象了）；关掉局域网直连时两份都
 * 为空（IPv6 那条监听挂在同一个代理上，没开就是没有这条通道）。
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
    getSidecarSnapshot: () => ({}),
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

test('关掉局域网直连时两份都为空（IPv6 那条监听挂在同一个代理上）', async () => {
  const body = await connectionInfo({ ...HOST, lanEnabled: false });
  assert.deepEqual(body.lanCandidates, []);
  assert.deepEqual(body.ipv6Candidates, []);
  assert.equal(body.relayUrl, 'https://relay.example.com', '中转地址与这个开关无关');
});

test('手机手填的直连地址排在最前，网卡候选一条不少地跟在后面', async () => {
  // 现场：用户在这台电脑上填了内网穿透域名。它必须每次都被报回来 —— 手机重启、换网之后
  // 只剩这条路能把地址取回去；被网卡候选挤到后面就等于「设置自己消失了」。
  const body = await connectionInfo({ ...HOST, manualLanUrl: 'https://home.example.com:8443/' });
  assert.deepEqual(body.lanCandidates.map((item) => item.url), ['https://home.example.com:8443', LAN.url]);
  assert.equal(body.lanCandidates[0].interface, 'manual');
});

test('手填的地址跟着局域网开关走：关掉直连就不报它', async () => {
  const body = await connectionInfo({ ...HOST, lanEnabled: false, manualLanUrl: 'https://home.example.com' });
  assert.deepEqual(body.lanCandidates, [], '直连监听没开，报一条拨不通的地址只会让手机白试');
});

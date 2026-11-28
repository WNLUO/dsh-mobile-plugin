// 候选重排口径统一：装配层那份直连候选带着 preferred，三条下游都拿到已重排清单。
'use strict';

/**
 * 反馈 1562:3883 回归。
 *
 * 面板上的「手机优先用这条」（设置项 `preferredLanAddress`）此前只在两处兑现：装配层自己
 * 调 `orderCandidates` 的 `/connection-info`、以及直接调 `phoneCandidates(...,{preferred})`
 * 的二维码配对载荷。另三条下游拿的是 `impl.js` 注入的 `safeLanCandidates` —— 它只传了
 * `manual`，于是同步概况 `hostSummary()` 与配对回包 `directCandidates` 报给手机的首位仍是
 * 宿主网卡排序那条，和用户在面板上看到的那条对不上。
 *
 * 这里从装配层源码里取出**真正注入的那条箭头函数**（不另抄一份），用真实 `phoneCandidates`
 * 重排，再分别喂给 `safeLanCandidates` 本身、`createSyncHandlers`（概况）与
 * `createPairHandler`（配对回包），三条路都钉首位是 preferred 那条。另钉两件事：手填地址
 * 仍缀在最后、同一 preferred 重排两次无副作用（所以 `/connection-info` 那层可以留着）。
 *
 * 运行：node --test test/preferred-lan-candidates.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const { phoneCandidates, orderCandidates } = require(path.join(ROOT, 'lib/relay/lan-network.cjs'));
const { createSyncHandlers } = require(path.join(ROOT, 'lib/mobile/sync.js'));
const { createPairHandler, resetPairLocks } = require(path.join(ROOT, 'lib/mobile/pairing.js'));
const { registerMobileRoutes } = require(path.join(ROOT, 'lib/routes/mobile-api.js'));
const core = require(path.join(ROOT, 'lib/relay/core.js'));
const pairingApproval = require(path.join(ROOT, 'lib/relay/pairing-policy.js'));

const PREFERRED = '172.16.183.129';
const OTHER = '10.222.222.1';
const PORT = 18787;
const ADVERTISED = [
  { url: `http://${OTHER}:${PORT}`, address: OTHER, interface: 'en0', family: 'IPv4' },
  { url: `http://${PREFERRED}:${PORT}`, address: PREFERRED, interface: 'eth0', family: 'IPv4' },
];

/** 从装配层源码里取真正注入的箭头函数：测试自己复制一份就钉不住装配层的回归。 */
function injectedSafeLanCandidates(state = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'lib/impl.js'), 'utf8');
  const match = source.match(/^ *safeLanCandidates:\s*(\(port\)[^\n]*),$/m);
  assert.ok(match, '装配层找不到 safeLanCandidates 注入');
  return new Function('phoneCandidates', 'advertisedCandidates', 'state', `return (${match[1]})`)(
    phoneCandidates,
    () => ADVERTISED.map(item => ({ ...item })),
    state,
  );
}

/** 最小 res 假体：记下状态码与 JSON 体。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    setHeader() {},
    end(raw) {
      if (raw && this.status === 0) this.status = 200;
      try { this.body = JSON.parse(raw); } catch { this.body = raw; }
    },
  };
}

/** 带 JSON 请求体的 req 假体（同步领券与配对都用）。 */
function fakeReq(payload, { method = 'POST', ip = '10.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/api/mobile/v1/pair';
  req.headers = { 'x-real-ip': ip };
  req.socket = { remoteAddress: ip };
  req.setEncoding = () => {};
  process.nextTick(() => {
    if (payload !== undefined) req.emit('data', JSON.stringify(payload));
    req.emit('end');
  });
  return req;
}

test('装配层注入的 safeLanCandidates 首位就是面板选中的那条', () => {
  const list = injectedSafeLanCandidates({ preferredLanAddress: PREFERRED, manualLanUrl: '' })(PORT);
  assert.deepEqual(list.map(item => item.address), [PREFERRED, OTHER]);
  assert.equal(list[0].url, `http://${PREFERRED}:${PORT}`);
});

test('重排后手填地址仍缀在最后，不抢内网那条的路', () => {
  const list = injectedSafeLanCandidates({
    preferredLanAddress: PREFERRED,
    manualLanUrl: 'https://home.example.com:8443',
  })(PORT);
  assert.deepEqual(list.map(item => item.address), [PREFERRED, OTHER, 'home.example.com']);
  assert.equal(list[list.length - 1].interface, 'manual');
});

test('同步概况 hostSummary 的 lanUrls 也按 preferred 打头', async () => {
  const handlers = createSyncHandlers({
    state: { instanceId: 'pref-sync', lanEnabled: true, lanPort: PORT },
    ticketStore: { mint: () => ['ticket'] },
    safeLanCandidates: injectedSafeLanCandidates({ preferredLanAddress: PREFERRED, manualLanUrl: '' }),
    lanPortInUse: () => PORT,
    log: () => {},
  });
  const res = fakeRes();
  await handlers.handleMintTickets({}, fakeReq({}), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.host.lanUrls, [
    `http://${PREFERRED}:${PORT}`,
    `http://${OTHER}:${PORT}`,
  ]);
});

test('配对回包 directCandidates 的首位同样是 preferred 那条', async () => {
  resetPairLocks();
  const handler = createPairHandler({
    state: {
      instanceId: 'pref-pair', pairingCode: '123456', lanSecret: 'x'.repeat(64),
      pairingPolicy: 'code', lanEnabled: true, lanPort: PORT,
    },
    core,
    credentials: { issue: () => ({ deviceId: 'dev-1', credential: 'dshc_test', expiresAt: 1 }) },
    pairingApproval,
    lanCandidates: injectedSafeLanCandidates({ preferredLanAddress: PREFERRED, manualLanUrl: '' }),
    ipv6Candidates: () => [],
    lanPort: () => PORT,
    log: () => {},
  });
  const res = fakeRes();
  await handler(fakeReq({ code: '123456', device: { deviceId: 'dev-1' } }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lanUrls, [
    `http://${PREFERRED}:${PORT}`,
    `http://${OTHER}:${PORT}`,
  ]);
});

test('同一 preferred 重排两次无副作用：连接信息那层重排可以留着', async () => {
  const once = orderCandidates(ADVERTISED, PREFERRED);
  assert.equal(orderCandidates(once, PREFERRED), once, '已在首位时原样返回，不另造数组');
  // 把注入函数原样装进 /connection-info：外层那层重排 + withManualCandidate 不改顺序、不添重复。
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    guarded: (handler) => handler,
    state: {
      enabled: true, lanEnabled: true, relayUrl: 'https://relay.example.com',
      preferredLanAddress: PREFERRED, manualLanUrl: '',
    },
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => ({ tunnel: { state: 'connected', relayUrl: 'https://relay.example.com' } }),
    safeLanCandidates: injectedSafeLanCandidates({ preferredLanAddress: PREFERRED, manualLanUrl: '' }),
    safeIpv6Candidates: () => [],
    lanPortInUse: () => PORT,
    preview: { handleUpgrade() {} },
    core: {},
    pairingApproval: null,
  });
  const route = routes.find((item) => item.path === '/api/mobile/v1/connection-info');
  assert.ok(route, '没装出 /api/mobile/v1/connection-info');
  const res = fakeRes();
  await route.handler({}, fakeReq(undefined, { method: 'GET' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lanCandidates.map(item => item.url), [
    `http://${PREFERRED}:${PORT}`,
    `http://${OTHER}:${PORT}`,
  ]);
});

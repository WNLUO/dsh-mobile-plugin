'use strict';

/**
 * 手机自己解绑（`POST /api/mobile/v1/device-credential/revoke`）的**范围**契约。
 *
 * 这条路坏起来是静默的，而且失败方向刚好相反于「删不掉」：多吊销一台就是把别人的手机
 * 踢下线。所以这里钉的不是「有没有回 ok」，而是三件事：
 *
 *  1. 出示的凭据属于哪台，就吊销那台名下**全部**活凭据（重配 / 升级留下的旧凭据一起收，
 *     否则桌面面板那一行删不掉、只减一条）；
 *  2. 别的设备一条都不许碰；
 *  3. 请求体里写谁都没用 —— deviceId 只从库里那条记录取（让手机自报等于允许吊销别人）。
 *
 * 走真路由表 + 真凭据库（临时文件），只有 `guarded` 换成一个恒放行的替身：这里验的是
 * handler 的范围，鉴权那条路有 `mobile-route-dispatch.test.cjs` 钉着。
 *
 * 运行：node --test test/phone-unbind.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库在 require 时就把落盘路径定下来，所以环境变量必须先设。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-unbind-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(DIR, 'relay-device-credentials.json');

const root = path.join(__dirname, '..');
const credentials = require(path.join(root, 'dsh-mobile-credentials', 'lib', 'credentials.js'));
const { registerMobileRoutes } = require(path.join(root, 'lib', 'routes', 'mobile-api.js'));
const { createGuarded } = require(path.join(root, 'lib', 'http', 'routing.js'));

const INSTANCE = 'b0b0c0c0';
const ROUTE = '/api/mobile/v1/device-credential/revoke';

function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); },
  };
}

/** 真装配一次路由表；`guarded` 恒放行（见文件头）。 */
function mount() {
  const routes = [];
  registerMobileRoutes({
    registerRoute: (route) => routes.push(route),
    registerUpgradeRoute: () => {},
    preview: { handleUpgrade() {} },
    guarded: createGuarded(null, () => true, null),
    state: { instanceId: INSTANCE },
    hostMetadata: () => ({}),
    getSidecarSnapshot: () => null,
    safeLanCandidates: () => [],
    lanPortInUse: () => 0,
  });
  const found = routes.find((route) => route.path === ROUTE);
  assert.ok(found, `没装出 ${ROUTE}`);
  return found;
}

const route = mount();

/** 每次从干净库开局：两台设备，其中 A 名下两条活凭据（模拟重配过一次）。 */
function seed() {
  credentials.resetForTest();
  try { fs.rmSync(process.env.DEVICE_CREDENTIALS_FILE, { force: true }); } catch { /* 没有就算了 */ }
  const a1 = credentials.issue(INSTANCE, { deviceId: 'device-a', platform: 'android', appVersion: '0.3.40' });
  const a2 = credentials.issue(INSTANCE, { deviceId: 'device-a', platform: 'android', appVersion: '0.3.40' }, '', undefined, { deviceKey: 'k', keyId: '0011223344556677' });
  const b1 = credentials.issue(INSTANCE, { deviceId: 'device-b', platform: 'ios', appVersion: '0.3.40' });
  return { a1: a1.credential, a2: a2.credential, b1: b1.credential };
}

/** 打一发吊销请求；body 里可以塞一个别人的 deviceId（刻意验它不被采纳）。 */
async function revoke(presented, body) {
  const req = {
    method: 'POST',
    headers: presented ? { 'x-dsh-device-credential': presented } : {},
    body,
  };
  const res = fakeRes();
  await route.handler(req, res);
  return res;
}

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('出示哪台的凭据，就吊销那台名下全部活凭据', async () => {
  const { a2 } = seed();
  assert.equal(credentials.listDevices(INSTANCE).find((row) => row.deviceId === 'device-a').bindings, 2);

  const res = await revoke(a2);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.revoked, true);
  assert.equal(res.body.count, 2, '这一台名下两条都该收掉');

  const rows = credentials.listDevices(INSTANCE);
  assert.equal(rows.some((row) => row.deviceId === 'device-a'), false, 'A 那一行应当从列表里消失');
});

test('别的设备一条都不碰', async () => {
  const { a2, b1 } = seed();
  await revoke(a2);

  const rows = credentials.listDevices(INSTANCE);
  assert.deepEqual(rows.map((row) => row.deviceId), ['device-b']);
  assert.equal(rows[0].bindings, 1);
  assert.ok(credentials.find(b1, INSTANCE), 'B 那枚必须还活着');
});

test('请求体里报别人的 deviceId 不算数（deviceId 只从库里那条记录取）', async () => {
  const { a2, b1 } = seed();

  const res = await revoke(a2, { deviceId: 'device-b' });
  assert.equal(res.body.count, 2, '吊销范围必须是出示凭据那一台');
  assert.ok(credentials.find(b1, INSTANCE), 'B 不能因为请求体写了它就掉');
});

test('库里查不到的通行证（升级前那种纯 HMAC）什么都不吊销', async () => {
  const { b1 } = seed();

  const res = await revoke(`${INSTANCE}.9999999999.not-in-store`);
  assert.equal(res.status, 200, '尽力而为的语义不变：删不掉也回 ok');
  assert.equal(res.body.revoked, false);
  assert.equal(res.body.count, 0);
  assert.ok(credentials.find(b1, INSTANCE), '谁都没动');
});

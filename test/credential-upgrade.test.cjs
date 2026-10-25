'use strict';

/**
 * 旧凭据原地升级（`POST /api/mobile/v1/device-credential/upgrade`）的规格。
 *
 * 这条路的**唯一判据**是：升级之后，手机手上那把钥匙能验过宿主存下的那把。曾经宿主自己
 * 生成一套密钥、只把标识回给手机，于是升级完两端各拿一把钥匙 —— 会话标成加密，之后每一条
 * 请求都是 `e2ee-bad-signature`，比不升级更糟。所以这里的用例不比对字段，而是真的拿升级
 * 回包里那套材料去签一条请求，交给宿主的信封校验。
 *
 * 运行：node --test test/credential-upgrade.test.cjs
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const e2ee = require(path.join(__dirname, '..', 'lib', 'shared', 'e2ee.js'));
const { openRequest } = require(path.join(__dirname, '..', 'lib', 'shared', 'e2ee-request.js'));
const { handleCredentialUpgrade } = require(path.join(__dirname, '..', 'lib', 'mobile', 'credential-upgrade.js'));

const INSTANCE = 'testupgrade1';

function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    setHeader() {},
    end(raw) {
      if (this.status === 0) this.status = 200;
      try { this.body = JSON.parse(raw); } catch { this.body = raw; }
    },
  };
}

/** 凭据库最小假体：只实现这条路由用到的那三样。 */
function fakeStore(initial = []) {
  const records = initial.slice();
  return {
    records,
    renewed: [],
    lookup(credential) {
      return records.find((record) => record.credential === credential) || null;
    },
    renew(record) { this.renewed.push(record); },
    issue(instanceId, device, _hostToken, _ttl, extra = {}) {
      const credential = `${instanceId}.deadbeef.${Math.random().toString(36).slice(2)}`;
      const record = { credential, instanceId, deviceId: device.deviceId || '', expiresAt: Date.now() + 3600_000, ...extra };
      records.push(record);
      return { credential, deviceId: record.deviceId, expiresAt: record.expiresAt, keyId: extra.keyId };
    },
  };
}

/** 一条 T1 记录（凭据 + 已经存好的密钥材料）。 */
function t1Record(credential, keyId, deviceKey) {
  return { credential, instanceId: INSTANCE, deviceId: 'dev-1', keyId, deviceKey };
}

function reqWith(credential, body) {
  return { headers: { 'x-dsh-device-credential': credential }, body };
}

async function upgrade(req, store) {
  const res = fakeRes();
  await handleCredentialUpgrade(req, res, { instanceId: INSTANCE, store });
  return res;
}

/** 用一把设备主密钥签一条 GET，交给宿主的信封校验 —— 能过就说明两边是同一把钥匙。 */
function sealedGetPasses(deviceKey, keyId, store) {
  const keys = e2ee.deriveSessionKeys(Buffer.from(deviceKey, 'base64url'));
  const ts = Date.now();
  const nonce = Buffer.from('0123456789ab', 'utf8').toString('base64url');
  const canonical = e2ee.canonicalString({
    method: 'GET',
    path: '/api/mobile/v1/status',
    query: '',
    ts,
    nonce,
    bodyBytes: Buffer.alloc(0),
  });
  const headers = {
    'x-dsh-proto': '2',
    'x-dsh-key-id': keyId,
    'x-dsh-ts': String(ts),
    'x-dsh-nonce': nonce,
    'x-dsh-sig': e2ee.sign(keys.sig, canonical),
  };
  const req = { headers, method: 'GET', url: '/api/mobile/v1/status' };
  const opened = openRequest(req, { keyFor: (id) => store.records.find((record) => record.keyId === id) || null });
  return opened;
}

test('手机带上自己的密钥：宿主存的就是这一把，回包 keyId 与本地一致', async () => {
  // 升级前的样子：只有凭据，没有密钥材料（协议 v1）。
  const store = fakeStore([{ credential: 'old-hmac-token', instanceId: INSTANCE, deviceId: 'dev-1' }]);
  const phoneKey = Buffer.alloc(32, 7).toString('base64url');
  const phoneKeyId = 'a1b2c3d4e5f60718';

  const res = await upgrade(reqWith('old-hmac-token', {
    device: { deviceId: 'dev-1' },
    deviceKey: phoneKey,
    keyId: phoneKeyId,
  }), store);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.upgraded, true);
  assert.equal(res.body.keyId, phoneKeyId, '回包必须回手机自己那个 keyId，否则手机按另一个标识去签');
  assert.equal(res.body.proto, 2);

  const stored = store.lookup(res.body.deviceCredential);
  assert.equal(stored.deviceKey, phoneKey, '宿主存的必须是手机那把钥匙');
  assert.equal(stored.keyId, phoneKeyId);

  // 真正的判据：手机按 v2 封一条请求，宿主能验过。
  const opened = sealedGetPasses(phoneKey, phoneKeyId, store);
  assert.equal(opened.ok, true, `升级之后手机那把钥匙必须能验过（实际：${opened.code || '健忘'}）`);
});

/**
 * 明文请求的真形状：守卫只为带信封的请求预先解好 `req.body`，老会话（v1）发的明文请求
 * 必须由 handler 自己把流读完。少了这一步宿主永远看到空对象、永远回「没升级」，App 那边
 * 就一直停在「链路未加密」——这条测试就是钉这个（旧实现只读 `req.body`，这里必红）。
 */
test('明文请求（req.body 没被预解）：从流里读出密钥，照样升级成功', async () => {
  const store = fakeStore([{ credential: 'old-hmac-token', instanceId: INSTANCE, deviceId: 'dev-1' }]);
  const phoneKey = Buffer.alloc(32, 5).toString('base64url');
  const phoneKeyId = '1122334455667788';
  const req = Readable.from([Buffer.from(JSON.stringify({
    device: { deviceId: 'dev-1' },
    deviceKey: phoneKey,
    keyId: phoneKeyId,
  }))]);
  // 只有头，没有 `body`：与守卫交给 handler 的那个请求对象同形。
  req.headers = { 'x-dsh-device-credential': 'old-hmac-token', 'content-type': 'application/json' };

  const res = await upgrade(req, store);

  assert.equal(res.body.upgraded, true, '明文请求的体必须被读出来，否则这条升级永远不生效');
  assert.equal(res.body.keyId, phoneKeyId);
  assert.equal(store.lookup(res.body.deviceCredential).deviceKey, phoneKey);
});

test('手机没带密钥：不升级，也不写任何记录', async () => {
  const store = fakeStore();
  const res = await upgrade(reqWith('old-hmac-token', { device: { deviceId: 'dev-1' } }), store);

  assert.equal(res.status, 200);
  assert.equal(res.body.upgraded, false);
  assert.equal(res.body.proto, 1, '没拿到密钥就别把会话标成加密');
  assert.equal(store.records.length, 0, '不许替手机生成一把它永远不会知道的钥匙');
});

test('已经是 T1 且没带密钥：只续期，幂等', async () => {
  const phoneKey = Buffer.alloc(32, 3).toString('base64url');
  const store = fakeStore([t1Record('t1-token', '0011223344556677', phoneKey)]);
  const res = await upgrade(reqWith('t1-token', { device: { deviceId: 'dev-1' } }), store);

  assert.equal(res.status, 200);
  assert.equal(res.body.upgraded, false);
  assert.equal(res.body.keyId, '0011223344556677');
  assert.equal(store.renewed.length, 1);
  assert.equal(store.records.length, 1, '幂等调用不许再签一条');
});

test('已经 T1 但手机换了新密钥（重装）：换发一条，新钥匙立刻可用', async () => {
  const store = fakeStore([t1Record('t1-token', '0011223344556677', Buffer.alloc(32, 3).toString('base64url'))]);
  const newKey = Buffer.alloc(32, 9).toString('base64url');
  const newKeyId = 'ffffffffffffffff';

  const res = await upgrade(reqWith('t1-token', { deviceKey: newKey, keyId: newKeyId, device: { deviceId: 'dev-1' } }), store);

  assert.equal(res.body.upgraded, true);
  assert.equal(res.body.keyId, newKeyId);
  const stored = store.lookup(res.body.deviceCredential);
  assert.equal(stored.deviceKey, newKey);
  assert.equal(sealedGetPasses(newKey, newKeyId, store).ok, true);
});

test('密钥形状不对：400，且不落库', async () => {
  const store = fakeStore();
  const res = await upgrade(reqWith('old-hmac-token', { deviceKey: 'not-a-key', keyId: 'zz' }), store);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad-device-secret');
  assert.equal(store.records.length, 0);
});

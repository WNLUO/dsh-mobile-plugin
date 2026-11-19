'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库与 relay.json 都在 require 时按 env 定路径，先设好。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-claim-id-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(DIR, 'relay-device-credentials.json');
process.env.DSH_HOME = DIR;

const NEW_ID = '11111111111111111111111111111111';
const OLD_ID = '22222222222222222222222222222222';
const OTHER_ID = '33333333333333333333333333333333';
const KEY_ID = '0011223344556677';
const DEVICE_KEY = Buffer.alloc(32, 0x22).toString('base64url');

fs.writeFileSync(
  path.join(DIR, 'relay.json'),
  JSON.stringify({ instanceId: NEW_ID, previousInstanceId: OLD_ID, lanSecret: 'sekret' }),
);

const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const { handleSyncIdentity } = require('../lib/mobile/claim-identity.js');
const auth = require('../lib/mobile/auth.js');

function fakeRes(req) {
  return {
    req,
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(buf) { this.body = JSON.parse(Buffer.from(buf).toString('utf8')); },
  };
}

async function call(deps, presented) {
  const req = { headers: presented ? { 'x-dsh-device-credential': presented } : {} };
  const res = fakeRes(req);
  await handleSyncIdentity(req, res, deps);
  return res;
}

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('认领身份：旧号凭据换当前号新凭据，旧凭据仍有效，新凭据能过鉴权', async () => {
  credentials.resetForTest();
  const oldIssued = credentials.issue(OLD_ID, { deviceId: 'd1', name: 'iPhone', model: 'iPhone 15' }, '', undefined, {
    deviceKey: DEVICE_KEY, keyId: KEY_ID, permissions: ['view'],
  });
  const deps = { instanceId: NEW_ID, previousInstanceId: OLD_ID, store: credentials };

  const res = await call(deps, oldIssued.credential);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.instanceId, NEW_ID, '应换成当前号');
  assert.notEqual(res.body.token, oldIssued.credential, '应签出一枚新凭据');
  assert.equal(res.body.deviceCredential, res.body.token);
  assert.equal(res.body.cookie, 'dsh_lan=' + res.body.token, 'cookie 应是 dsh_lan=<token>');
  assert.equal(res.body.keyId, KEY_ID, '继承 keyId');
  assert.deepEqual(res.body.permissions, ['view'], '继承权限');

  // 旧记录不吊销：仍能查到且有效。
  const oldRecord = credentials.find(oldIssued.credential, OLD_ID);
  assert.ok(oldRecord, '旧凭据应仍然有效');

  // 新凭据能通过主进程鉴权（鉴权同时认新旧号）。
  assert.equal(auth.authOutcome({ headers: { 'x-dsh-device-credential': res.body.token } }).ok, true);

  // 幂等：用新凭据再调一次，原样返回同一枚。
  const again = await call(deps, res.body.token);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.instanceId, NEW_ID);
  assert.equal(again.body.token, res.body.token, '已经是当前号应原样返回');
});

test('认领身份：出示无法识别的凭据回 401', async () => {
  credentials.resetForTest();
  const other = credentials.issue(OTHER_ID, { deviceId: 'd9' }, '');
  const deps = { instanceId: NEW_ID, previousInstanceId: OLD_ID, store: credentials };
  const res = await call(deps, other.credential);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库与 relay.json 都在 require 时按 env 定路径，先设好。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-dual-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(DIR, 'relay-device-credentials.json');
process.env.DSH_HOME = DIR;

const NEW_ID = '11111111111111111111111111111111';
const OLD_ID = '22222222222222222222222222222222';
const OTHER_ID = '33333333333333333333333333333333';

fs.writeFileSync(
  path.join(DIR, 'relay.json'),
  JSON.stringify({ instanceId: NEW_ID, previousInstanceId: OLD_ID, lanSecret: 'sekret' }),
);

const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const auth = require('../lib/mobile/auth.js');

function reqWith(cred) {
  return { headers: { 'x-dsh-device-credential': cred } };
}

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('过渡期鉴权：新号、旧号的凭据都认，别的号不认', () => {
  credentials.resetForTest();
  const oldCred = credentials.issue(OLD_ID, { deviceId: 'd1' }, '').credential;
  const newCred = credentials.issue(NEW_ID, { deviceId: 'd1' }, '').credential;
  const otherCred = credentials.issue(OTHER_ID, { deviceId: 'd9' }, '').credential;

  assert.deepEqual(auth.instanceIdsOf({ instanceId: NEW_ID, previousInstanceId: OLD_ID }), [NEW_ID, OLD_ID]);
  assert.equal(auth.authOutcome(reqWith(newCred)).ok, true, '新号凭据应通过');
  assert.equal(auth.authOutcome(reqWith(oldCred)).ok, true, '过渡期旧号凭据也应通过');
  assert.equal(auth.authOutcome(reqWith(otherCred)).ok, false, '不认识的号应拒绝');
});

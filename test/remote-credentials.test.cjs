'use strict';
// 电脑网页授权必须落盘且可撤销；普通手机凭据不能被默认提升为电脑授权。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-credentials-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(home, 'credentials.json');
const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
test('电脑网页能力独立落盘，权限调整会收回它，手机签发不能获得它', () => {
  credentials.resetForTest();
  const phone = credentials.issue('A', { deviceId: 'phone' }, '', undefined, { permissions: ['manage'] });
  assert.notEqual(credentials.find(phone.credential, 'A').remoteWeb, true);
  const desktop = credentials.issue('A', { deviceId: 'B', platform: 'computer' }, '', undefined, {
    deviceKey: 'k'.repeat(43), keyId: 'a'.repeat(16), permissions: [], remoteWeb: true,
  });
  credentials.resetForTest();
  assert.equal(credentials.find(desktop.credential, 'A').remoteWeb, true);
  // 权限档位已移除：记录不再带 `permissions`（缺省即全权），老记录读到也会被抹掉。
  assert.equal(credentials.find(desktop.credential, 'A').permissions, undefined);
  assert.deepEqual(credentials.listDevices('A').map(row => row.deviceId), ['phone']);
  assert.equal(credentials.activeDigests('A').length, 1, '电脑网页凭据不授予手机镜像读取');
  assert.deepEqual(credentials.listRemoteComputers('A').map(row => row.deviceId), ['B']);
  assert.deepEqual(credentials.listRemoteComputers('other-instance'), []);
  assert.doesNotMatch(JSON.stringify(credentials.listRemoteComputers('A')), /credential|hash|deviceKey/);
  credentials.setDevicePermissions('A', 'B', ['view']);
  assert.equal(credentials.find(desktop.credential, 'A').remoteWeb, false);
  credentials.revokeDevice('A', 'B');
  assert.equal(credentials.find(desktop.credential, 'A'), null);
  assert.ok(credentials.find(phone.credential, 'A'));
});

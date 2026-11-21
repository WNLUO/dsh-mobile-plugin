// 连续换号同时迁移凭据与连接登记，保留原连接并支持后续精确吊销。
'use strict';

/**
 * 换身份时把本机签发的设备凭据整体迁到新号（`reassignInstance`）的回归测试。
 *
 * 鉴权只认「当前号 + 上一代号」。若换号时不迁移，换到第二次，挂在更早一代、又没来得及换过来
 * 的手机就会被甩下、只能重新扫码——这正是「更新后实例变了、app 连不上」的根因。第一个用例锁
 * 「迁移后不受影响」，第二个是用例反向证明（不迁移就失效），第三个锁凭据库迁移本身的契约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库与 relay.json 都在 require 时按 env 定路径，先设好。
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-identity-migrate-'));
process.env.DSH_HOME = DIR;
process.env.DEVICE_CREDENTIALS_FILE = path.join(DIR, 'relay-device-credentials.json');

const core = require('../lib/relay/core.js');
const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const auth = require('../lib/mobile/auth.js');
const { createIdentityRotator } = require('../lib/relay/identity-rotate.cjs');
const registry = require('../lib/mobile/stream-registry');
const { createRequire } = require('node:module');

function reqWith(cred) {
  return { headers: { 'x-dsh-device-credential': cred } };
}

function resetStores() {
  credentials.resetForTest();
  try { fs.rmSync(process.env.DEVICE_CREDENTIALS_FILE, { force: true }); } catch { /* 没有就算了 */ }
}

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('换两次号后，最早配对的设备凭据仍有效（迁移后无需重扫）', async () => {
  resetStores();
  const state = core.defaultState();
  core.saveState(state);
  const firstId = state.instanceId;

  // 最早那台手机在第一代身份下配对。
  const firstCred = credentials.issue(firstId, { deviceId: 'phone-1', name: '旧手机' }, '').credential;

  const rotate = createIdentityRotator({
    state,
    rotateIdentity: core.rotateIdentity,
    saveState: core.saveState,
    syncSidecar: async () => {},
    syncControl: () => {},
    migrateCredentials: (toId) => credentials.reassignInstance(toId),
  });

  await rotate();
  await rotate();

  assert.notEqual(state.instanceId, firstId, '确实换过号');
  // 两次换号后鉴权只认 [当前号, 上一代号]，第一代早已不在其中——迁移把凭据收了过来。
  assert.equal(auth.authOutcome(reqWith(firstCred)).ok, true, '第一代配对的手机不应被甩下');
  // 设备清单也按新号能看到这台老手机。
  const devices = credentials.listDevices(state.instanceId);
  assert.equal(devices.some((d) => d.deviceId === 'phone-1'), true, '老设备仍在设备清单里');
});

test('反向证明：同样的两次换号若不迁移，第一代配对的手机就查不到凭据（正是要修的 bug）', () => {
  resetStores();
  const state = core.defaultState();
  core.saveState(state);
  const firstId = state.instanceId;
  const firstCred = credentials.issue(firstId, { deviceId: 'phone-2' }, '').credential;

  // 不迁移，仅换两次号（模拟旧行为）。
  core.rotateIdentity(state);
  core.rotateIdentity(state);
  assert.equal(auth.authOutcome(reqWith(firstCred)).ok, false, '不迁移时第一代凭据必然失效——所以迁移是必要的');
});

test('reassignInstance：本机全部凭据迁到新号，凭据串与吊销状态不变、只读拒绝', () => {
  resetStores();
  const target = 'c'.repeat(32);
  const a = credentials.issue('aaaaaaaa', { deviceId: 'd1' }, '').credential;
  const b = credentials.issue('bbbbbbbb', { deviceId: 'd2' }, '').credential;
  credentials.revoke(a, 'aaaaaaaa');

  const moved = credentials.reassignInstance(target);
  assert.equal(moved, 2, '两条不同旧代号的记录都迁走');
  assert.ok(credentials.lookup(a, target), '旧凭据串按新号仍查得到');
  assert.ok(credentials.lookup(b, target));
  assert.equal(credentials.lookup(a, 'aaaaaaaa'), null, '旧号下不再挂');
  // 吊销跟着记录走，不会因为换归属复活。
  const rec = credentials.lookup(a, target);
  assert.ok(rec.revokedAt, '吊销记录换号后仍是吊销');
  assert.equal(credentials.reassignInstance(target), 0, '幂等：全是目标号时没得迁');

  credentials.setReadOnly(true);
  assert.throws(() => credentials.reassignInstance('d'.repeat(32)), /只读/);
  credentials.setReadOnly(false);
});

async function assertConnectionMigration(createRotator = createIdentityRotator) {
  registry.reset();
  const state = { instanceId: 'scope-first' };
  const sse = { end() {}, destroy() { this.destroyed = true; } };
  const sibling = { end() {}, destroy() { this.destroyed = true; } };
  const detach = registry.track('phone', sse, state.instanceId);
  registry.track('phone', sibling, 'other-instance');
  const moved = [];
  const rotate = createRotator({ state, saveState() {}, migrateCredentials() {},
    rotateIdentity(current) { current.instanceId += '-next'; return { instanceId: current.instanceId }; },
    migrateConnections(from, to) { moved.push([from, to]); registry.reassignInstance(from, to); },
    syncSidecar: async () => {}, syncControl() {},
  });
  try {
    await rotate(); await rotate();
    assert.equal(moved.length, 2);
    assert.equal(registry.drop('phone', state.instanceId), 1);
    assert.equal(sse.destroyed, true);
    assert.equal(sibling.destroyed, undefined);
    detach();
  } finally { registry.reset(); }
}
test('换号钩子逐次迁移已有连接，连续换号后的吊销不漏流', () => assertConnectionMigration());
test('迁移后的SSE清理回调删除新scope，不留下空登记', () => {
  registry.reset();
  const response = {};
  const detach = registry.track('phone', response, 'first');
  registry.reassignInstance('first', 'second'); registry.reassignInstance('second', 'third');
  detach();
  assert.equal(registry.size(), 0);
  assert.equal(registry.dropAll('third'), 0);
  registry.reset();
});
test('装配迁移当前三类登记，旧外壳mux无迁移方法时清掉更早scope', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/impl.js'), 'utf8');
  const match = source.match(/migrateConnections: (\(fromId, toId\) => \{[^\n]+\}) \}\)/);
  assert.ok(match, '装配必须注入连接迁移钩子');
  const scopes = new Set(['first', 'second', 'current']);
  const calls = [];
  const migration = new Function('streamRegistry', 'preview', 'mux', `return (${match[1]})`)(
    { reassignInstance: (...ids) => calls.push(['sse', ...ids]) },
    { reassignInstance: (...ids) => calls.push(['preview', ...ids]) },
    { dropAll(scope) { assert.equal(scope, undefined, '旧service不能仅按上一代scope清理'); scopes.clear(); } },
  );
  migration('current', 'next');
  assert.equal(scopes.size, 0);
  assert.deepEqual(calls, [['sse', 'current', 'next'], ['preview', 'current', 'next']]);
});
test('变异：删除换号连接迁移钩子会被真实登记行为拒绝', async () => {
  const file = path.join(__dirname, '../lib/relay/identity-rotate.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const marker = 'if (typeof migrateConnections === \'function\') migrateConnections(previousInstanceId, instanceId);';
  assert.ok(source.includes(marker));
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source.replace(marker, ''))(createRequire(file), loaded, loaded.exports);
  await assert.rejects(assertConnectionMigration(loaded.exports.createIdentityRotator), assert.AssertionError);
});

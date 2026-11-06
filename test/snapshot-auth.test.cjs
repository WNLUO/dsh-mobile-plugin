'use strict';

/**
 * 读取隔离这层的鉴权：快照捷径绕开主进程守卫，必须自己验凭据。
 *
 * 缺陷现场（issue #7）：自建中转下，不带任何设备凭据、只带实例号请求头，就能经中转
 * `GET /sessions` / `/workspaces` 拿到 200 与完整列表——命中本地快照直接回，请求根本
 * 走不到主进程那条 401。这里钉住：没有有效凭据就不许走捷径；被吊销 / 过期的凭据即使
 * 旧的无状态令牌还能验过，也一律判否（吊销要立刻生效）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { snapshotAuthorized, credentialCandidates } = require('../lib/relay/snapshot-auth.js');

const ROOT = path.join(__dirname, '..');
const readSource = (relative) => {
  try { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); } catch { return ''; }
};

/** 造一份假的依赖：一张 `token -> record` 的表，外加一组「无状态令牌也认」的集合。 */
function deps({ records = {}, hmac = [] } = {}) {
  return {
    lookup: (presented) => records[presented] || null,
    verifyLanToken: (token) => hmac.includes(token),
  };
}

// ---------------------------------------------------------------------------
// 1. 三条出示通道都要认：独立凭据头 / Bearer / dsh_lan cookie
// ---------------------------------------------------------------------------

test('有效凭据：凭据头、Bearer、cookie 三条通道都放行', () => {
  const record = { hash: 'h1' };
  const d = deps({ records: { tok: record } });
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': 'tok' }, d), true);
  assert.equal(snapshotAuthorized({ authorization: 'Bearer tok' }, d), true);
  assert.equal(snapshotAuthorized({ cookie: 'a=1; dsh_lan=tok; b=2' }, d), true);
});

test('凭据头大小写不敏感、数组取第一个', () => {
  const record = { hash: 'h1' };
  const d = deps({ records: { tok: record } });
  assert.equal(snapshotAuthorized({ 'X-Dsh-Device-Credential': 'tok' }, d), true);
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': ['tok', 'other'] }, d), true);
});

test('没有任何凭据 → 判否（匿名请求不许命中快照）', () => {
  assert.equal(snapshotAuthorized({}, deps()), false);
  assert.equal(snapshotAuthorized(null, deps()), false);
  assert.equal(snapshotAuthorized({ cookie: 'a=1' }, deps()), false);
});

// ---------------------------------------------------------------------------
// 2. 记录为准：被吊销 / 已过期立即判否，且不许退回旧令牌（吊销必须生效）
// ---------------------------------------------------------------------------

test('被吊销的凭据：判否，且不许拿能验过的旧令牌兜底', () => {
  const d = deps({ records: { tok: { revokedAt: Date.now() - 1000 } }, hmac: ['tok'] });
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': 'tok' }, d), false);
});

test('已过期的凭据：判否，且不许拿能验过的旧令牌兜底', () => {
  const d = deps({ records: { tok: { expiresAt: Date.now() - 1000 } }, hmac: ['tok'] });
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': 'tok' }, d), false);
});

test('未过期但有未来过期时间的凭据：放行', () => {
  const d = deps({ records: { tok: { expiresAt: Date.now() + 1000 } } });
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': 'tok' }, d), true);
});

// ---------------------------------------------------------------------------
// 3. 本机不认识时才回退无状态令牌（升级前老 App / 中转签发的凭据）
// ---------------------------------------------------------------------------

test('查不到记录但旧令牌验得过 → 放行', () => {
  const d = deps({ hmac: ['legacy'] });
  assert.equal(snapshotAuthorized({ authorization: 'Bearer legacy' }, d), true);
});

test('查不到记录、旧令牌也验不过 → 判否', () => {
  assert.equal(snapshotAuthorized({ 'x-dsh-device-credential': 'whatever' }, deps()), false);
});

// ---------------------------------------------------------------------------
// 4. 源码契约：快照读捷径必须接上这道鉴权
// ---------------------------------------------------------------------------

test('sidecar 快照读在回快照前调用 snapshotAuthorized，失败回源', () => {
  const worker = readSource('lib/sidecar-facade-worker.cjs');
  assert.match(worker, /require\('\.\/relay\/snapshot-auth\.js'\)/, '工人要引入这道鉴权');
  assert.match(worker, /if \(!snapshotAuthorized\(info && info\.headers,/, '快照前必须验凭据');
  assert.match(worker, /credentials\.lookup\(presented, config\.instanceId\)/, '按本机凭据库查，且限定实例号');
  assert.match(worker, /core\.verifyLanToken\(config\.lanSecret, presented, config\.instanceId\)/, '旧令牌兜底沿用同一套 lanSecret 校验');
});

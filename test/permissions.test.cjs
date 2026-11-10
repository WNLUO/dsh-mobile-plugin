'use strict';

/**
 * 按设备权限子集的边界守卫。
 *
 * 这一组钉的是「只收紧不放开」的四条底线：
 *  1. 权限位集合 / 档位 / 依赖闭包的定义（lib/mobile/permissions.js 是唯一真源）；
 *  2. 移动路由**全部**被分类（漏一条就会 fail-closed 或开洞）；
 *  3. guarded 真的按位拦截：缺位回 403 permission-denied，老记录（无 permissions）/ BASE 放行，
 *     未分类路由 fail-closed；
 *  4. 凭据库：签发能带 permissions、listDevices 能显示、setDevicePermissions 改全部活记录，
 *     以及手机自助降档只能收窄、不能提权。
 *
 * 先设 DEVICE_CREDENTIALS_FILE 再 require 凭据库：它模块加载时就定死落盘路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpFile = path.join(os.tmpdir(), `dsh-perm-test-${process.pid}-${Date.now()}.json`);
process.env.DEVICE_CREDENTIALS_FILE = tmpFile;

const P = require('../lib/mobile/permissions.js');
const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const routing = require('../lib/http/routing.js');
const { handleDevicePermissions } = require('../lib/mobile/device-permissions.js');

test.after(() => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } });

// ── 1. 权限位 / 档位 / 依赖 ────────────────────────────────────────
test('档位展开成权限数组，未知档位回全权', () => {
  assert.deepEqual(P.permissionsForTier('readonly').sort(), ['files.read', 'view'].sort());
  assert.deepEqual(P.permissionsForTier('approve').sort(), ['approve', 'files.read', 'view'].sort());
  assert.equal(P.permissionsForTier('full').length, P.ALL_PERMISSIONS.length);
  // 未知 / 缺省 = 全权（向后兼容命门）
  assert.equal(P.permissionsForTier(undefined).length, P.ALL_PERMISSIONS.length);
  assert.equal(P.permissionsForTier('bogus').length, P.ALL_PERMISSIONS.length);
  assert.equal(P.isKnownTier('approve'), true);
  assert.equal(P.isKnownTier('bogus'), false);
});

test('依赖闭包：写依赖读、输入依赖看，缺依赖能报出来', () => {
  assert.deepEqual(P.missingDependencies(['files.write']), ['files.read']);
  assert.deepEqual(P.missingDependencies(['files.write', 'files.read']), []);
  assert.deepEqual(P.missingDependencies(['input']), ['view']);
  assert.deepEqual(P.missingDependencies(['view']), []);
});

test('hasPermission：缺字段=全权，空数组=什么都不给，老记录/无记录放行', () => {
  assert.equal(P.hasPermission({ permissions: ['view'] }, 'view'), true);
  assert.equal(P.hasPermission({ permissions: ['view'] }, 'files.write'), false);
  assert.equal(P.hasPermission({}, 'files.write'), true, '缺 permissions = 全权');
  assert.equal(P.hasPermission({ permissions: null }, 'files.write'), true, 'null = 全权');
  assert.equal(P.hasPermission({ permissions: [] }, 'view'), false, '空数组 = 明确什么都不给');
  assert.equal(P.hasPermission(null, 'files.write'), true, '无记录（升级前 HMAC）= 全权');
  assert.equal(P.hasPermission({ permissions: [] }, null), true, 'BASE 路由不需要权限位');
});

// ── 2. 路由分类完整（漏一条就是缺口）──────────────────────────────
/**
 * 手工注册（`registerRoute({ path: … })`）而**刻意不鉴权**的两条：它们发生在「手机还没有
 * 凭据」的时刻（地址体检 / 配对本身），包 guarded 就是死循环。豁免理由与
 * `test/mobile-routes.test.cjs` 的 PUBLIC_ROUTES 是同一份，两边改一处要一起改。
 */
const PUBLIC_PATHS = new Set(['/api/mobile/v1/health', '/api/mobile/v1/pair']);

/**
 * 从路由表里抽出**全部**注册过的移动端路径，两种写法都认：
 *  - `route('/api/mobile/v1/xxx', …)`（包 guarded）；
 *  - `registerRoute({ path: '/api/mobile/v1/xxx' })` / `registerUpgradeRoute({ path: … })`
 *    （手工注册，不包 guarded —— 升级路由与两条公开路由都在这边）。
 *
 * 只扫第一种是这条守卫原来的漏洞：五条 `path:` 手工注册的路由（health / pair / preview /
 * phone/control 等）从来没被权限表对过账，于是 `/phone/control` 这条动作通道连权限位都没登记。
 */
function registeredPaths() {
  const src = fs.readFileSync(path.join(__dirname, '../lib/routes/mobile-api.js'), 'utf8');
  const quoted = [...src.matchAll(/route\('(\/api\/mobile\/v1\/[^']+)'/g)].map((m) => m[1]);
  const manual = [...src.matchAll(/path:\s*'(\/api\/mobile\/v1\/[^']+)'/g)].map((m) => m[1]);
  return [...new Set([...quoted, ...manual])];
}

test('每一条走守卫的移动路由都被分类', () => {
  // 两条公开路由不鉴权、自然也不查权限位（见 PUBLIC_PATHS），它们不在这张表的对账范围里。
  const paths = registeredPaths().filter((p) => !PUBLIC_PATHS.has(p));
  assert.ok(paths.length > 150, `应解析到大量路由，实际 ${paths.length}`);
  const unclassified = paths.filter((p) => !P.isClassified(p));
  assert.deepEqual(unclassified, [], '这些路由没进权限分类表');
  const unknown = paths.filter((p) => P.resolvePermission(p) === 'unknown');
  assert.deepEqual(unknown, [], '这些路由解析成 unknown');
});

test('手工注册的路由也进对账（含两条 WebSocket 升级路由）', () => {
  const paths = registeredPaths();
  // 五条 `path:` 手写的路由：两条公开（健康检查 / 配对）、两条升级路由、还有一条也走 route()。
  assert.ok(paths.includes('/api/mobile/v1/health'), '解析不到手工注册的路由，正则失效了');
  assert.ok(paths.includes('/api/mobile/v1/pair'));
  // 升级路由：它们不过 guarded，权限位只能由服务自己判 —— 但必须在这张表里有分类，
  // 否则「是不是漏了一条」这件事永远查不出来。
  // 2026-11-10「操作手机」整块下线，`/phone/control` 动作通道随之删除，这条断言一并去掉；
  // 升级路由只剩 preview 一条。
  assert.equal(P.isClassified('/api/mobile/v1/preview'), true);
  assert.equal(P.resolvePermission('/api/mobile/v1/preview'), 'view');
  // 公开那两条按约定不进权限表，但它们必须仍在 PUBLIC_ROUTES 那份豁免里。
  const publicUnguarded = paths.filter((p) => PUBLIC_PATHS.has(p));
  assert.deepEqual(publicUnguarded.sort(), [...PUBLIC_PATHS].sort());
});


test('BASE / 已知 / 未分类的解析', () => {
  assert.equal(P.resolvePermission('/api/mobile/v1/status'), null, 'status 是保命 BASE');
  assert.equal(P.resolvePermission('/api/mobile/v1/device-credential/permissions'), null, '自助降档是 BASE');
  assert.equal(P.resolvePermission('/api/mobile/v1/file/create'), 'files.write');
  assert.equal(P.resolvePermission('/api/mobile/v1/desktop-view'), 'view');
  assert.equal(P.resolvePermission('/api/mobile/v1/not/in/table'), 'unknown', '未登记路由 fail-closed');
  // 同路径不同方法分读写
  assert.equal(P.resolvePermission('/api/mobile/v1/narration', 'GET'), 'view');
  assert.equal(P.resolvePermission('/api/mobile/v1/narration', 'POST'), 'files.write');
  // relay/config 的 POST 是保存（改地址 / 密钥 / 配对策略），归 manage；只有 GET 是只读自查。
  assert.equal(P.resolvePermission('/api/mobile/v1/relay/config', 'GET'), 'view');
  assert.equal(P.resolvePermission('/api/mobile/v1/relay/config', 'POST'), 'manage');
});

test('带部署前缀的路径与签名口径一致（锚到 /api/mobile/v1/）', () => {
  assert.equal(P.resolvePermission('/deploy/api/mobile/v1/desktop-view', 'GET'), 'view');
  assert.equal(P.resolvePermission('/deploy/api/mobile/v1/file/create', 'POST'), 'files.write');
  assert.equal(P.isClassified('/deploy/api/mobile/v1/desktop-view'), true);
});

// ── 3. guarded 真的按位拦截 ───────────────────────────────────────
function fakeRes() {
  return {
    status: 0,
    body: null,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(raw) { try { this.body = JSON.parse(String(raw)); } catch { this.body = raw; } },
  };
}
function makeGuard(record) {
  const authorized = () => ({ ok: true, record });
  return routing.createGuarded({}, authorized, null, {
    permission: { resolve: P.resolvePermission, has: P.hasPermission },
  });
}
const okHandler = async (_ctx, _req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true })); };

test('守卫：缺位回 403 permission-denied，带上 required/granted', async () => {
  const res = fakeRes();
  const g = makeGuard({ permissions: ['view', 'files.read'] });
  await g(okHandler)({ headers: {}, method: 'POST', url: '/api/mobile/v1/file/create' }, res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'permission-denied');
  assert.equal(res.body.error.required, 'files.write');
  assert.deepEqual(res.body.error.granted, ['view', 'files.read']);
});

test('守卫：有该位就放行到 handler', async () => {
  const res = fakeRes();
  const g = makeGuard({ permissions: ['view', 'files.read', 'files.write'] });
  await g(okHandler)({ headers: {}, method: 'POST', url: '/api/mobile/v1/file/create' }, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('守卫：老记录（无 permissions）与空数组的差别', async () => {
  let reached = 0;
  const handler = async (_c, _q, res) => { reached += 1; res.writeHead(200); res.end('{"ok":true}'); };
  // 缺字段 = 全权 → 放行
  await makeGuard({})(handler)({ headers: {}, method: 'POST', url: '/api/mobile/v1/file/create' }, fakeRes());
  assert.equal(reached, 1);
  // 空数组 = 什么都不给 → 403
  const res = fakeRes();
  await makeGuard({ permissions: [] })(handler)({ headers: {}, method: 'POST', url: '/api/mobile/v1/file/create' }, res);
  assert.equal(res.status, 403);
  assert.equal(reached, 1);
});

test('守卫：BASE 路由即使空数组也放行（收窄不能变砖）', async () => {
  const res = fakeRes();
  await makeGuard({ permissions: [] })(okHandler)({ headers: {}, method: 'GET', url: '/api/mobile/v1/status' }, res);
  assert.equal(res.status, 200);
});

test('守卫：未分类路由 fail-closed', async () => {
  const res = fakeRes();
  await makeGuard({ permissions: P.permissionsForTier('full') })(okHandler)({ headers: {}, method: 'GET', url: '/api/mobile/v1/unmapped/x' }, res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'permission-unclassified');
});

// ── 4. 凭据库 + 自助降档 ─────────────────────────────────────────
test('签发带 permissions，listDevices 显示，setDevicePermissions 改全部活记录', () => {
  credentials.resetForTest();
  const inst = 'inst-test';
  const a = credentials.issue(inst, { deviceId: 'dev-1' }, '', undefined, { permissions: P.permissionsForTier('readonly') });
  // 同一台设备再来一条（模拟重配），旧记录也在
  const b = credentials.issue(inst, { deviceId: 'dev-1' }, '', undefined, { permissions: P.permissionsForTier('readonly') });
  const rows = credentials.listDevices(inst);
  const row = rows.find((r) => r.deviceId === 'dev-1');
  assert.deepEqual(row.permissions.sort(), ['files.read', 'view'].sort());
  // 改成 approve 档：两条活记录都要改，否则旧那枚还停在只读
  const updated = credentials.setDevicePermissions(inst, 'dev-1', P.permissionsForTier('approve'));
  assert.equal(updated, 2);
  const row2 = credentials.listDevices(inst).find((r) => r.deviceId === 'dev-1');
  assert.deepEqual(row2.permissions.sort(), P.permissionsForTier('approve').sort());
  // 缺 permissions 的记录按全权显示（listDevices 里是 null = 全权）
  assert.ok(a.credential && b.credential);
  // 老记录没有 permissions 字段 → 行里是 null
  const c = credentials.issue(inst, { deviceId: 'dev-legacy' }, '', undefined, {});
  assert.ok(c.credential);
  const legacyRow = credentials.listDevices(inst).find((r) => r.deviceId === 'dev-legacy');
  assert.equal(legacyRow.permissions, null, '没设过权限 = null（视作全权）');
});

test('手机自助降档：能收窄、不能提权、无记录如实拒', async () => {
  credentials.resetForTest();
  const inst = 'inst-dp';
  const issued = credentials.issue(inst, { deviceId: 'dev-x' }, '', undefined, { permissions: P.permissionsForTier('full') });
  const call = async (tier) => {
    const res = fakeRes();
    await handleDevicePermissions(
      { headers: { 'x-dsh-device-credential': issued.credential }, body: { tier } },
      res,
      { instanceId: inst, store: credentials },
    );
    return res;
  };
  // 全权 → 只读：可以
  const down = await call('readonly');
  assert.equal(down.status, 200);
  assert.deepEqual(down.body.permissions.sort(), ['files.read', 'view'].sort());
  const after = credentials.lookup(issued.credential, inst);
  assert.deepEqual(after.permissions.sort(), ['files.read', 'view'].sort());
  // 只读 → 全权：提权，拒
  const up = await call('full');
  assert.equal(up.status, 400);
  assert.equal(up.body.error.code, 'permission-escalation-denied');
  // 没有记录（升级前 HMAC 那种）→ 如实拒
  const res2 = fakeRes();
  await handleDevicePermissions({ headers: { 'x-dsh-device-credential': 'unknown-token' }, body: { tier: 'readonly' } }, res2, { instanceId: inst, store: credentials });
  assert.equal(res2.status, 400);
  assert.equal(res2.body.error.code, 'no-device-record');
});

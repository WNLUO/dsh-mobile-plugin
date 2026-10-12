'use strict';

/** HTTP 路由守卫约定：localOnly 与可信本机设置入口的边界测试。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routing = require(path.join(root, 'lib/http/routing.js'));

/** 假 ServerResponse：只记录最后一次 writeHead + end。 */
function fakeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(String(raw)); },
  };
}

/** 假 IncomingMessage：默认是一个没有任何路由凭据的本机请求。 */
function fakeReq(headers = {}, method = 'GET') {
  return { headers, method };
}

test('网页管理开关只认 loopback 直连与本机 Host，并拒绝代理转发', () => {
  assert.equal(routing.isLoopbackAddress('127.0.0.1'), true);
  assert.equal(routing.isLoopbackAddress('127.24.8.9'), true);
  assert.equal(routing.isLoopbackAddress('::1'), true);
  assert.equal(routing.isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(routing.isLoopbackAddress('192.168.1.2'), false);
  assert.equal(routing.isLoopbackAddress('203.0.113.10'), false);

  const local = (headers = {}, remoteAddress = '127.0.0.1') => ({
    headers: { host: '127.0.0.1:19387', ...headers },
    socket: { remoteAddress },
  });
  assert.equal(routing.trustedLocalUi(local()), true);
  assert.equal(routing.trustedLocalUi(local({ host: '[::1]:19387' }, '::1')), true);
  assert.equal(routing.trustedLocalUi(local({ host: 'admin.example.com' })), false);
  assert.equal(routing.trustedLocalUi(local({}, '203.0.113.10')), false);
  assert.equal(routing.trustedLocalUi(local({ 'x-forwarded-for': '203.0.113.10' })), false);
  assert.equal(routing.trustedLocalUi({ headers: { host: 'localhost:19387' } }), false);
});

test('控制面：本机裸请求能过', async () => {
  const res = fakeRes();
  let reached = false;
  await routing.localOnly('GET', async () => { reached = true; })(fakeReq(), res);
  assert.equal(reached, true, '没有路由凭据、没有 origin 的请求是本机请求');
});

test('控制面：中转配对 cookie 不得调到控制面', async () => {
  for (const cookie of ['dsh_pair=abc', 'a=b; dsh_lan=xyz; c=d']) {
    const res = fakeRes();
    await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ cookie }), res);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'local_only', `cookie ${cookie} 应被当成中转路由凭据`);
  }
});

test('控制面：x-dsh-instance 头同样不算本机', async () => {
  const res = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ 'x-dsh-instance': 'i-1' }), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'local_only');
});

test('控制面：sec-fetch-site: cross-site 一律拒', async () => {
  const res = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ 'sec-fetch-site': 'cross-site' }), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'cross_site');
});

test('控制面：origin 与 host 不同源即拒', async () => {
  const res = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ origin: 'http://evil.test', host: '127.0.0.1:18787' }), res);
  assert.equal(res.body.error.code, 'cross_site');
  const same = fakeRes();
  let reached = false;
  await routing.localOnly('GET', async () => { reached = true; })(fakeReq({ origin: 'http://127.0.0.1:18787', host: '127.0.0.1:18787' }), same);
  assert.equal(reached, true, '同源 origin 必须放行');
  const hostless = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ origin: 'http://evil.test' }), hostless);
  assert.equal(hostless.body.error.code, 'cross_site', 'host 缺失时按拒绝处理');
});

test('控制面：方法不匹配回 405，且文案列出全部允许方法', async () => {
  const one = fakeRes();
  await routing.localOnly('POST', async () => { throw new Error('handler 不该被调用'); })(fakeReq({}, 'GET'), one);
  assert.equal(one.status, 405);
  assert.equal(one.body.error.message, '仅支持 POST');
  const two = fakeRes();
  await routing.localOnly(['GET', 'POST'], async () => { reached = true; })(fakeReq({}, 'DELETE'), two);
  assert.equal(two.status, 405);
  assert.equal(two.body.error.message, '仅支持 GET / POST');
});

test('控制面：方法数组里任一命中都放行', async () => {
  let reached = 0;
  for (const method of ['GET', 'POST']) {
    await routing.localOnly(['GET', 'POST'], async () => { reached += 1; })(fakeReq({}, method), fakeRes());
  }
  assert.equal(reached, 2);
});

test('控制面：实际动词大小写不敏感，缺省当 GET', async () => {
  let reached = 0;
  await routing.localOnly('POST', async () => { reached += 1; })({ headers: {}, method: 'post' }, fakeRes());
  await routing.localOnly('GET', async () => { reached += 1; })({ headers: {} }, fakeRes());
  assert.equal(reached, 2);
});

test('移动端：无 token 回 401 且 handler 不被调用', async () => {
  const ctx = { marker: true };
  const res = fakeRes();
  const handler = routing.createGuarded(ctx, () => false);
  await handler(async () => { throw new Error('handler 不该被调用'); })(fakeReq(), res);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthorized');
});

test('移动端：handler 抛错收成 500 信封而不是让请求炸掉', async () => {
  const res = fakeRes();
  const handler = routing.createGuarded({}, () => true);
  await handler(async () => { throw new Error('boom'); })(fakeReq(), res);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'internal');
  assert.equal(res.body.error.message, 'boom');
});

test('移动端：抛的不是 Error 也照样有文案', async () => {
  const res = fakeRes();
  const handler = routing.createGuarded({}, () => true);
  await handler(async () => { throw 'plain string'; })(fakeReq(), res);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.message, 'plain string');
});

test('移动端：ctx 透传给 handler（路由表里就是靠它拿 state）', async () => {
  const ctx = { state: { instanceId: 'i-9' } };
  const res = fakeRes();
  let seen = null;
  const handler = routing.createGuarded(ctx, () => true);
  await handler(async (gotCtx, req, res2) => {
    seen = gotCtx;
    routing.sendJson(res2, 200, { ok: true });
  })(fakeReq(), res);
  assert.equal(seen, ctx);
  assert.equal(res.body.ok, true);
});

test('控制面与移动端的不对称是刻意的：移动端不查跨站', async () => {
  // 移动端请求本来就要从公网进来，origin 不同源是常态；它只挡 token。
  // 一旦哪天给 guarded 也加上跨站检查，手机端会全线 403——这条断言把这个取舍写死。
  const res = fakeRes();
  let reached = false;
  await routing.createGuarded({}, () => true)(async (_ctx, _req, res2) => {
    reached = true;
    routing.sendJson(res2, 200, { ok: true });
  })(fakeReq({ 'sec-fetch-site': 'cross-site', origin: 'http://relay.example' }), res);
  assert.equal(reached, true);
  assert.equal(res.status, 200);
});

test('路由基建不认路由表：它只提供地基', () => {
  // 这些函数此前住在 index.js 的 apply() 闭包里，除了被它们自己用之外没人碰得到。
  // 断言这里没有出现任何具体路径，说明「哪条路由归谁」的决定仍在 apply() 侧。
  // 先剥注释：文件头的说明里举了 `/api/relay/desktop-view` 当例子，那是散文不是代码。
  const source = require('node:fs').readFileSync(path.join(root, 'lib/http/routing.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(source, /\/api\/(mobile|relay)\//, '路由基建里不该出现任何具体路由路径');
});
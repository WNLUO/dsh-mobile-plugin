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

test('控制面：代理转发来的一律不算本机（即使它长得和本机一模一样）', async () => {
  // 隧道与局域网代理都从宿主本机连出：socket 对端是回环地址，host 还被补成
  // `127.0.0.1:<上游端口>`。不带实例头、不带 cookie 的转发请求因此能骗过所有
  // 「像不像本机」的判据 —— 实测 `POST /api/relay/config` 就是这样被执行的。
  for (const via of ['relay', 'lan']) {
    const res = fakeRes();
    await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(
      { headers: { 'x-dsh-via': via, host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET' },
      res,
    );
    assert.equal(res.status, 403, `经 ${via} 转发的请求必须被挡`);
    assert.equal(res.body.error.code, 'local_only');
  }
});

test('控制面：转发标记为空不算转发，值大小写不敏感', async () => {
  const blank = fakeRes();
  let reached = false;
  await routing.localOnly('GET', async () => { reached = true; })(
    { headers: { 'x-dsh-via': '   ' }, method: 'GET' },
    blank,
  );
  assert.equal(reached, true, '空值当成没有这个头');

  const armed = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(
    { headers: { 'X-Dsh-Via': 'RELAY' }, method: 'GET' },
    armed,
  );
  assert.equal(armed.status, 403, '头名与值都不区分大小写，不能让换大小写绕过');
});

test('网页管理入口：带转发标记的 loopback 请求不算本机界面', () => {
  const local = { headers: { host: '127.0.0.1:19387', 'x-dsh-via': 'relay' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(routing.trustedLocalUi(local), false, '否则经中转就能开启两小时窗口');
});

test('控制面：sec-fetch-site: cross-site 一律拒', async () => {
  const res = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ 'sec-fetch-site': 'cross-site' }), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'cross_site');
});

test('控制面：只读面板页放行「人点开的一页」，页面里的 fetch 照旧拒', async () => {
  // 社区桌面壳把设置页里的链接原地打开：从自定义协议页跳到 http 面板地址，Chromium
  // 一定标 `sec-fetch-site: cross-site`。不放开这一种，用户看到的就是整屏一句 403 JSON。
  const navigation = fakeReq({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  let reached = false;
  await routing.localOnly('GET', async () => { reached = true; }, { allowDocumentNavigation: true })(navigation, fakeRes());
  assert.equal(reached, true, '人点开的面板页必须能显示');

  // 同一页里偷偷发的 fetch / 被嵌进 iframe 都不是「人点开的一页」，照旧拒。
  for (const headers of [
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    const res = fakeRes();
    await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); }, { allowDocumentNavigation: true })(fakeReq(headers), res);
    assert.equal(res.status, 403, `${JSON.stringify(headers)} 不是整页打开`);
    assert.equal(res.body.error.code, 'cross_site');
  }

  // 没显式放开的路由，整页打开也一样拒。
  const other = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(navigation, other);
  assert.equal(other.body.error.code, 'cross_site');
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
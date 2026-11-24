'use strict';
// 异常 500 的日志保留方法、无查询串路径和堆栈，并验证响应、鉴权与信封行为不变。

/** HTTP 路由守卫约定：本机与局域网直连分开识别，转发仍受限；来源（跨站）不再限制。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { format } = require('node:util');

const root = path.join(__dirname, '..');
const routing = require(path.join(root, 'lib/http/routing.js'));
const guard = require(path.join(root, 'lib/mobile/guarded.js'));

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

test('局域网界面：回环、标准私网和 IPv6 本地地址可直连，严格本机判据不扩大', () => {
  for (const address of [
    '127.0.0.1', '127.24.8.9', '::1', '0:0:0:0:0:0:0:1',
    '192.168.1.2', '10.0.0.2', '172.16.0.2', '172.17.0.2', '172.31.255.254',
    '::ffff:192.168.1.2', 'fd00::2', 'fc00::2', 'fe80::2',
  ]) assert.equal(routing.isLocalNetworkAddress(address), true, address);
  for (const address of ['203.0.113.2', '172.15.0.2', '172.32.0.2', '192.169.0.2',
    '198.18.0.2', '198.51.100.2', '100.64.0.2', '240e::2', 'example.com', '192.168.1.999', '']) {
    assert.equal(routing.isLocalNetworkAddress(address), false, address);
  }
  const request = (remoteAddress, host, headers = {}) => ({
    socket: { remoteAddress }, headers: { host, ...headers },
  });
  for (const [peer, host] of [
    ['192.168.1.2', '192.168.1.20:19387'], ['::ffff:10.0.0.2', '10.0.0.20:19387'],
    ['172.31.1.2', '172.31.1.20:19387'], ['fd00::2', '[fd00::20]:19387'],
    ['fe80::2', '[fe80::20]:19387'], ['127.0.0.1', '192.168.1.20:19387'],
  ]) {
    assert.equal(routing.trustedLocalNetworkUi(request(peer, host)), true, host);
    assert.equal(routing.trustedLocalUi(request(peer, host)), false, '严格本机限制仍然保持');
  }
  for (const req of [
    request('203.0.113.2', '192.168.1.20:19387'),
    request('192.168.1.2', '203.0.113.20:19387'),
    request('192.168.1.2', 'dsh.example.com:19387'),
    request('127.0.0.1', '127.0.0.1:19387', { 'x-dsh-via': 'relay' }),
    request('127.0.0.1', '127.0.0.1:19387', { 'x-dsh-via': 'lan' }),
    request('192.168.1.2', '192.168.1.20:19387', { 'x-forwarded-for': '192.168.1.3' }),
    request('192.168.1.2', '192.168.1.20:19387', { forwarded: 'for=192.168.1.3' }),
    { headers: { host: '192.168.1.20:19387' } },
  ]) assert.equal(routing.trustedLocalNetworkUi(req), false, JSON.stringify(req));
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
  // `tunnel` 是隧道落点代理（`lib/relay/tunnel-forwarder.cjs`）写的值：局域网关着时
  // 两条隧道都经它进来，它同样只是个转发标记，必须一起挡。
  for (const via of ['relay', 'lan', 'tunnel']) {
    const res = fakeRes();
    await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(
      { headers: { 'x-dsh-via': via, host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET' },
      res,
    );
    assert.equal(res.status, 403, `经 ${via} 转发的请求必须被挡`);
    assert.equal(res.body.error.code, 'local_only');
  }
});

test('控制面：网页版预览管道按本机界面放行', async () => {
  // 手机「网页版」是已配对设备通过预览管道打开宿主自己的 web 端口（见 lib/relay/preview.js
  // 的 webapp 档），手机上那整份网页版要用插件管理页，所以这一条必须能进控制面。
  for (const value of ['preview-webapp', 'PREVIEW-WEBAPP']) {
    const res = fakeRes();
    let reached = false;
    await routing.localOnly('GET', async () => { reached = true; })(fakeReq({ 'x-dsh-via': value }), res);
    assert.equal(reached, true, `${value} 应放行`);
  }
  // 同名头混进别的转发值时仍按远程处理，不能靠伪造第二个头绕过。
  const mixed = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(
    { headers: { 'x-dsh-via': ['preview-webapp', 'lan'] }, method: 'GET' },
    mixed,
  );
  assert.equal(mixed.status, 403);
  assert.equal(mixed.body.error.code, 'local_only');
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

test('控制面：不再按来源拦截——跨站请求也放行（需求变更：不限制部署位置）', async () => {
  // 2026-11-21 用户要求：控制面不再按跨站 / 来源拒绝，这台机器部署在哪儿都放行。
  // 守卫只剩「谁转发的」和 method 两条；跨站、反代改写 Host、桌面壳自定义协议一律照常。
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { origin: 'http://evil.test', host: '127.0.0.1:18787' },
    { origin: 'http://evil.test' },
  ]) {
    let reached = false;
    await routing.localOnly('GET', async () => { reached = true; })(fakeReq(headers), fakeRes());
    assert.equal(reached, true, `${JSON.stringify(headers)} 应放行`);
  }
  // 经中转 / 局域网代理转发来的请求照旧按远程拦下，与上面那条互不影响。
  const proxied = fakeRes();
  await routing.localOnly('GET', async () => { throw new Error('handler 不该被调用'); })(fakeReq({ 'x-dsh-via': 'relay' }), proxied);
  assert.equal(proxied.body.error.code, 'local_only');
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
  const handler = guard.createGuarded(ctx, () => false);
  await handler(async () => { throw new Error('handler 不该被调用'); })(fakeReq(), res);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthorized');
});

test('移动端：handler 抛错收成 500 信封而不是让请求炸掉', async () => {
  const res = fakeRes();
  const handler = guard.createGuarded({}, () => true);
  await handler(async () => { throw new Error('boom'); })(fakeReq(), res);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'internal');
  assert.equal(res.body.error.message, 'boom');
});

async function assertInternalErrorLog(api) {
  const lines = [];
  const logger = { error(...args) { lines.push(format(...args)); } };
  const error = new Error('读取会话失败');
  error.stack = 'Error: 读取会话失败\n    at listSessions (host.js:7:3)';
  const res = fakeRes();
  const req = {
    ...fakeReq({ authorization: 'Bearer header-private', cookie: 'cookie-private' }, 'post'),
    url: '/api/mobile/v1/session/send?token=query-private&query=private-search',
    body: { text: 'body-private' },
  };
  await api.createGuarded({ logger }, () => true)(async () => { throw error; })(req, res);
  assert.deepEqual(res.body, { ok: false, error: { code: 'internal', message: error.message } });
  assert.equal(res.status, 500);
  assert.equal(lines.length, 1, '同一异常只记一条日志');
  assert.match(lines[0], /POST \/api\/mobile\/v1\/session\/send:/);
  assert.ok(lines[0].includes(error.message), '日志保留异常原因');
  assert.ok(lines[0].includes(error.stack), '日志保留完整异常堆栈');
  for (const privateText of ['?', 'query-private', 'private-search', 'body-private', 'header-private', 'cookie-private']) {
    assert.ok(!lines[0].includes(privateText), `日志不携带请求私密内容：${privateText}`);
  }
}

test('移动端：异常 500 记录方法、无查询串路径与异常堆栈，不记录请求内容和凭据', async () => {
  await assertInternalErrorLog(guard);
});

test('移动端：日志出口异常仍返回原有 500 错误响应', async () => {
  const res = fakeRes();
  const logger = { error() { throw new Error('日志出口故障'); } };
  await guard.createGuarded({ logger }, () => true)(async () => { throw new Error('业务故障'); })(fakeReq(), res);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, error: { code: 'internal', message: '业务故障' } });
});

test('移动端：抛的不是 Error 也照样有文案和日志', async () => {
  const lines = [];
  const res = fakeRes();
  const handler = guard.createGuarded({ logger: { error(...args) { lines.push(format(...args)); } } }, () => true);
  await handler(async () => { throw 'plain string'; })(fakeReq(), res);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.message, 'plain string');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /GET \/: plain string$/);
});

test('移动端：未鉴权不执行 handler，也不记业务异常日志', async () => {
  const lines = [];
  const res = fakeRes();
  const handler = guard.createGuarded({ logger: { error(...args) { lines.push(args); } } }, () => false);
  await handler(async () => { throw new Error('不该执行'); })(fakeReq(), res);
  assert.equal(res.status, 401);
  assert.deepEqual(lines, []);
});

test('移动端：协议 v2 异常 500 保持原有加密信封，日志不含解封请求体', async () => {
  const e2ee = require(path.join(root, 'lib/shared/e2ee.js'));
  const { unwrapper } = require(path.join(root, 'lib/shared/e2ee-request.js'));
  const deviceKey = Buffer.alloc(32, 0x29);
  const keys = e2ee.deriveSessionKeys(deviceKey);
  const pathname = '/api/mobile/v1/session/send';
  const query = '?token=sealed-query-private';
  const method = 'POST';
  const ts = Date.now();
  const nonceBytes = Buffer.alloc(12, 0x79);
  const nonce = e2ee.b64url(nonceBytes);
  const plain = { text: 'sealed-body-private' };
  const encrypted = e2ee.sealWithNonce(keys.up, nonceBytes, Buffer.from(JSON.stringify(plain)), e2ee.upAad(method, pathname));
  const wire = Buffer.from(JSON.stringify({ v: 2, c: Buffer.from(encrypted).toString('base64') }));
  const signature = e2ee.sign(keys.sig, e2ee.canonicalString({ method, path: pathname, query, ts, nonce, bodyBytes: wire }));
  const req = {
    method, url: pathname + query,
    headers: {
      'x-dsh-proto': '2', 'x-dsh-key-id': 'http-routing-500', 'x-dsh-ts': String(ts),
      'x-dsh-nonce': nonce, 'x-dsh-sig': signature,
    },
  };
  const lines = [];
  const guarded = guard.createGuarded({ logger: { error(...args) { lines.push(format(...args)); } } }, () => true, null, {
    envelope: { keyFor: () => ({ deviceKey: deviceKey.toString('base64url') }), readBody: async () => wire },
  });
  const res = fakeRes();
  await guarded(async (_ctx, openedReq) => {
    assert.deepEqual(openedReq.body, plain);
    throw new Error('加密请求业务故障');
  })(req, res);
  assert.equal(res.status, 500);
  assert.equal(res.body.v, 2, '异常响应仍由既有信封路径加密');
  const opened = JSON.parse(e2ee.open(keys.down, unwrapper(res.body), e2ee.downAad(method, pathname, ts, nonce)).toString('utf8'));
  assert.deepEqual(opened, { ok: false, error: { code: 'internal', message: '加密请求业务故障' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /POST \/api\/mobile\/v1\/session\/send:/);
  assert.ok(!lines[0].includes('sealed-body-private'));
  assert.ok(!lines[0].includes('sealed-query-private'));
  assert.ok(!lines[0].includes(signature));
});

test('变异证明：去掉异常日志、带回查询串或丢堆栈，真实行为断言都会拒绝', async () => {
  const file = path.join(root, 'lib/mobile/guarded.js');
  const source = fs.readFileSync(file, 'utf8');
  const mutations = [
    ['异常日志', "ctx?.logger?.error?.('dsh-mobile-plugin: 移动请求异常 %s %s: %s%s', method, path,\n          String(error?.message || error), error?.stack ? `\\n${error.stack}` : '')", 'void 0'],
    ['查询串过滤', ".split('?')[0]", ''],
    ['异常堆栈', "error?.stack ? `\\n${error.stack}` : ''", "''"],
  ];
  for (const [label, before, after] of mutations) {
    assert.equal(source.split(before).length, 2, `${label}变异必须命中唯一生产逻辑`);
    const loaded = { exports: {} };
    vm.runInNewContext(source.replace(before, after), {
      module: loaded, exports: loaded.exports, require: createRequire(file), Buffer, URL,
    }, { filename: file });
    await assert.rejects(() => assertInternalErrorLog(loaded.exports), { name: 'AssertionError' }, `${label}回退必须让同一行为断言失败`);
  }
});

test('移动端：ctx 透传给 handler（路由表里就是靠它拿 state）', async () => {
  const ctx = { state: { instanceId: 'i-9' } };
  const res = fakeRes();
  let seen = null;
  const handler = guard.createGuarded(ctx, () => true);
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
  await guard.createGuarded({}, () => true)(async (_ctx, _req, res2) => {
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
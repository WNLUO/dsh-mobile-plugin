// 浏览器这条跨源客户端走远程电脑的配对与隧道：实例号从查询参数取，局域网代理回 CORS。
'use strict';

/**
 * 这次改动只为一件事：浏览器跨源走「远程电脑」。
 *
 * 浏览器有两件事做不到 —— 给 WebSocket 升级加自定义头、给 CORS 预检加自定义头。所以
 * 「这台电脑是哪一台」必须同时能从头和 `?instance=` 里读（口径与中转侧同一个：头优先，
 * 缺头看参数），配对那次 POST 还必须先过得去一次预检。
 *
 * 这份测试驱动**真实的** `remote/host.cjs` 与**真实的局域网代理监听**（就是浏览器会打的那条
 * 路），假件只有凭据库与上游网页端口。四组用例：
 *   ① 口径本身（头优先、参数兜底、冲突拒）；
 *   ② 配对入口认查询参数、指向别的电脑的实例号被拒；
 *   ③ 隧道升级认查询参数，且浏览器带的 Origin 不会让它被拒；
 *   ④ CORS：只在 `/pair` 这一条精确路径上回预检与回显头，别的路径照旧未认证 JSON 401。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');

// 必须在 require credentials-entry（局域网代理的依赖）之前指向临时文件，否则会污染真实凭据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-instance-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

const { createRemoteHost, PAIR_PATH, TUNNEL_PATH } = require('../lib/remote/host.cjs');
const { createLanProxy } = require('../lib/relay/lan-proxy.js');
const { resolveInstanceHint, instanceHintRefusal } = require('../lib/remote/instance-hint.cjs');
const c = require('../lib/remote/crypto.cjs');

const INSTANCE = 'browserinstance1';
const SECRET = 'browser-instance-secret';
const ORIGIN = 'https://dsh.example';
const deadline = { timeout: 8000 };

/** 假凭据库：远程电脑只用到 issue / find，够把两条入口跑完。 */
function fakeCredentials() {
  const records = [];
  return {
    records,
    issue(instanceId, device, _token, _ttl, extra) {
      const credential = `${instanceId}.9999999999.${crypto.randomBytes(32).toString('base64url')}`;
      records.push({ instanceId, ...device, ...extra, credential });
      return { credential, deviceId: device.deviceId };
    },
    find(value, instanceId) {
      return records.find((record) => record.credential === value && record.instanceId === instanceId && !record.revokedAt) || null;
    },
    lookup(value, instanceId) { return this.find(value, instanceId); },
  };
}

/**
 * 上游网页端口与假宿主。
 *
 * 升级那条按**请求路径名**匹配（带不带 `?instance=` 都算同一条路由）—— 宿主的升级路由就是
 * 精确路径匹配、忽略查询串，这里必须同口径，否则测出来的是假件的脾气而不是真实现的。
 */
async function startUpstream(host, state) {
  const sockets = new Set();
  const tunnels = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    if (url.pathname === PAIR_PATH) return host.handlePair(req, res);
    res.writeHead(404); res.end();
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://upstream');
    tunnels.push({ path: req.url, headers: req.headers });
    if (url.pathname !== TUNNEL_PATH) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    socket.on('error', () => {});
    host.handleUpgrade(req, socket, head);
  });
  const tcp = net.createServer({ allowHalfOpen: true }, (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hostServer = { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
  const proxy = createLanProxy({
    lanPort: 0,
    instanceId: state.instanceId,
    lanSecret: SECRET,
    pairingCode: '123456',
    pairingTicket: state.pairingTicket,
    upstreamPort: hostServer.port,
    onApprove: async () => ({ approved: false }),
  });
  await proxy.start();
  return {
    hostServer, proxy, tunnels,
    proxyPort: proxy.port(),
    async close() {
      proxy.stop();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => tcp.close(resolve)),
      ]);
    },
  };
}

function call(port, { method = 'GET', path: target, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 配对那条 AAD（与 `remote/host.cjs` 的 `pairAad` 同口径）。 */
const pairAad = (ticketId, direction) => JSON.stringify(['dsh-computer-pair-v1', INSTANCE, ticketId, direction]);

/** 一次真实的浏览器配对体：票据派生的密钥、密文、`v: 1`。 */
function sealedPairBody(invite) {
  const keys = c.pairKeys(invite.ticket, invite.instanceId, invite.ticketId);
  const aad = pairAad(invite.ticketId, 'up');
  const device = { deviceId: 'browser-1', deviceKey: c.random(32), keyId: '0011223344556677', nonce: c.random(32) };
  return {
    keys,
    aad,
    body: JSON.stringify({
      v: 1,
      instanceId: invite.instanceId,
      ticketId: invite.ticketId,
      sealed: c.sealJson(keys.up, { deviceId: device.deviceId, name: '浏览器', deviceKey: device.deviceKey, keyId: device.keyId, nonce: device.nonce }, aad),
    }),
  };
}

async function fixture() {
  const credentials = fakeCredentials();
  const state = { instanceId: INSTANCE, name: '被访问的电脑', pairingTicket: crypto.randomBytes(32).toString('base64url') };
  const host = createRemoteHost({
    state,
    credentials,
    routesOf: () => [{ url: 'https://dsh.example', channel: 'relay' }],
    getUpstreamPort: async () => 1,
    getWebPort: () => 1,
    getLaunchToken: () => 'launch-token',
  });
  const upstream = await startUpstream(host, state);
  // 让 host 的票据表里有这一张：`mintInvite()` 的返回就是它（票据由宿主生成、写进二维码，
  // 不走网络）。
  const minted = await host.mintInvite();
  const parsed = JSON.parse(Buffer.from(minted.invite.split('data=')[1], 'base64url').toString('utf8'));
  return {
    host, credentials, upstream, invite: parsed,
    pairPath: PAIR_PATH,
    tunnelPath: TUNNEL_PATH,
    async close() { host.close(); await upstream.close(); },
  };
}

test('实例号口径：头优先、缺头看 instance 查询参数、两者冲突按冲突拒', () => {
  const req = (headers = {}, url = '') => ({ headers, url });
  assert.deepEqual(resolveInstanceHint(req({ 'x-dsh-instance': 'a' }, '/p?instance=b')), { instance: 'a', conflict: true });
  assert.deepEqual(resolveInstanceHint(req({ 'x-dsh-instance': 'a' }, '/p?instance=a')), { instance: 'a', conflict: false });
  assert.deepEqual(resolveInstanceHint(req({}, '/p?instance=b')), { instance: 'b', conflict: false });
  assert.deepEqual(resolveInstanceHint(req({ 'x-dsh-instance': '  a  ' }, '/p')), { instance: 'a', conflict: false });
  // 重复头取第一枚（与仓里其它读入站头的写法一致）
  assert.deepEqual(resolveInstanceHint(req({ 'x-dsh-instance': ['a', 'b'] }, '')), { instance: 'a', conflict: false });
  // 什么都没说：不替协议下结论
  assert.deepEqual(resolveInstanceHint(req({}, '/p')), { instance: '', conflict: false });
  assert.deepEqual(resolveInstanceHint(req({}, '/p?instance=')), { instance: '', conflict: false });
  assert.equal(instanceHintRefusal(req({}, '/p?instance=other'), INSTANCE), 'instance-mismatch');
  assert.equal(instanceHintRefusal(req({ 'x-dsh-instance': 'other' }, '/p?instance=elsewhere'), INSTANCE), 'instance-conflict');
  assert.equal(instanceHintRefusal(req({ 'x-dsh-instance': INSTANCE }, '/p'), INSTANCE), null);
  assert.equal(instanceHintRefusal(req({}, '/p?instance=' + INSTANCE), INSTANCE), null);
  assert.equal(instanceHintRefusal(req({}, '/p'), INSTANCE), null);
});

test('配对入口认查询参数：命中本机就配对，指向别的电脑的实例号被拒', deadline, async () => {
  const f = await fixture();
  try {
    const sealed = sealedPairBody(f.invite);
    const headers = { 'content-type': 'application/json', origin: ORIGIN };
    const ok = await call(f.upstream.hostServer.port, {
      method: 'POST', path: `${f.pairPath}?instance=${INSTANCE}`, headers, body: sealed.body,
    });
    assert.equal(ok.status, 200, ok.body);
    const reply = JSON.parse(ok.body);
    assert.equal(reply.ok, true);
    const binding = c.openJson(sealed.keys.down, reply.sealed, pairAad(f.invite.ticketId, 'down'));
    assert.equal(binding.instanceId, INSTANCE);
    assert.equal(binding.deviceId, 'browser-1');

    // 一张指向别的电脑的链接：在花掉限流额度、读请求体之前就被拒。
    const wrong = await call(f.upstream.hostServer.port, {
      method: 'POST', path: `${f.pairPath}?instance=another-computer`, headers, body: sealed.body,
    });
    assert.equal(wrong.status, 400);
    assert.equal(JSON.parse(wrong.body).code, 'instance-mismatch');
    // 头与查询参数各说一台：按冲突拒。
    const conflict = await call(f.upstream.hostServer.port, {
      method: 'POST', path: `${f.pairPath}?instance=${INSTANCE}`, headers: { ...headers, 'x-dsh-instance': 'another-computer' }, body: sealed.body,
    });
    assert.equal(conflict.status, 400);
    assert.equal(JSON.parse(conflict.body).code, 'instance-conflict');
    assert.equal(f.credentials.records.length, 1, '被拒的两次都不该签发凭据');
  } finally { await f.close(); }
});

test('隧道升级认查询参数，浏览器带的 Origin 不使它被拒', deadline, async () => {
  const f = await fixture();
  try {
    // 浏览器 WebSocket 加不了自定义头：只有一个 `?instance=` 与官网 Origin。
    const ws = new WebSocket(`ws://127.0.0.1:${f.upstream.proxyPort}${f.tunnelPath}?instance=${INSTANCE}`, {
      origin: ORIGIN, headers: { 'user-agent': 'browser' },
    });
    ws.on('error', () => {});
    // 宿主那条 `welcome` 在握手回调里就发出去了，可能先于 `open` 到达客户端：监听必须先挂上。
    const welcomed = once(ws, 'message');
    await once(ws, 'open');
    const [tunnel] = f.upstream.tunnels;
    assert.ok(tunnel, '局域网代理必须把这条升级交给宿主');
    assert.equal(tunnel.path, `${f.tunnelPath}?instance=${INSTANCE}`, '查询参数必须原样带上去');
    assert.equal(tunnel.headers['user-agent'], 'browser', '客户端自带的头照旧转发');
    // 宿主发来的 welcome 帧：握手一个字没改，浏览器照样收得到。
    const [welcome] = await welcomed;
    assert.equal(JSON.parse(welcome.toString()).type, 'welcome');
    ws.terminate();

    const wrong = new WebSocket(`ws://127.0.0.1:${f.upstream.proxyPort}${f.tunnelPath}?instance=another-computer`);
    wrong.on('error', () => {});
    const [error] = await once(wrong, 'error');
    assert.match(String(error.message), /400/, '指向别的电脑的升级必须在握手前被拒');
  } finally { await f.close(); }
});

test('CORS 只给配对那一条精确路径：预检 204 + 回显 Origin，别的路径照旧 JSON 401', deadline, async () => {
  const f = await fixture();
  try {
    const preflight = await call(f.upstream.proxyPort, {
      method: 'OPTIONS',
      path: `${f.pairPath}?instance=${INSTANCE}`,
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dsh-instance' },
    });
    assert.equal(preflight.status, 204, '预检必须真的能过，不能只加响应头');
    assert.equal(preflight.body, '');
    assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');
    assert.equal(preflight.headers['access-control-allow-headers'], 'content-type, x-dsh-instance');
    assert.equal(preflight.headers['access-control-max-age'], '600');

    // 真配对那一次也要回同样的 Allow-Origin —— 少了它，浏览器拿到 200 也不把字节交给页面。
    const sealed = sealedPairBody(f.invite);
    const paired = await call(f.upstream.proxyPort, {
      method: 'POST', path: `${f.pairPath}?instance=${INSTANCE}`,
      headers: { 'content-type': 'application/json', origin: ORIGIN }, body: sealed.body,
    });
    assert.equal(paired.status, 200, paired.body);
    assert.equal(paired.headers['access-control-allow-origin'], ORIGIN);

    // 未认证的默认行为不许跟着变宽：同前缀下别的路径、以及同一个路径的别的动词，照旧 401。
    for (const target of ['/api/mobile/v1/status', '/api/mobile/v1/remote-computers/pairing']) {
      const res = await call(f.upstream.proxyPort, { path: target, headers: { origin: ORIGIN } });
      assert.equal(res.status, 401, `${target} 仍必须是未认证 401`);
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${target} 不该拿到 CORS 头`);
    }
    const other = await call(f.upstream.proxyPort, { method: 'OPTIONS', path: '/api/mobile/v1/status', headers: { origin: ORIGIN } });
    assert.equal(other.status, 401, '别的路径上的 OPTIONS 不是预检，照旧未认证 401');
  } finally { await f.close(); }
});

test('经中转那条路的配对也要回 CORS：不经过局域网代理、只打配对处理器本身', deadline, async () => {
  // 浏览器默认走中转：请求由中转转给设备出站隧道，最终落到配对处理器，全程不经过局域网代理。
  // 所以 CORS 必须由配对处理器自己兜住，不能只挂在局域网代理上（否则默认路线配不上对）。
  const f = await fixture();
  try {
    const preflight = await call(f.upstream.hostServer.port, {
      method: 'OPTIONS',
      path: `${f.pairPath}?instance=${INSTANCE}`,
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dsh-instance' },
    });
    assert.equal(preflight.status, 204, '配对处理器本身要把预检答掉');
    assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');
    assert.equal(preflight.headers['access-control-allow-headers'], 'content-type, x-dsh-instance');

    const sealed = sealedPairBody(f.invite);
    const paired = await call(f.upstream.hostServer.port, {
      method: 'POST', path: `${f.pairPath}?instance=${INSTANCE}`,
      headers: { 'content-type': 'application/json', origin: ORIGIN }, body: sealed.body,
    });
    assert.equal(paired.status, 200, paired.body);
    assert.equal(paired.headers['access-control-allow-origin'], ORIGIN, '正式回包也要带 Allow-Origin，否则浏览器不把字节交给页面');

    // 没带 Origin 的非浏览器调用（App 老路）：一个 CORS 头都不多回。
    const appLike = await call(f.upstream.hostServer.port, {
      method: 'POST', path: `${f.pairPath}?instance=${INSTANCE}`,
      headers: { 'content-type': 'application/json' }, body: sealedPairBody(f.invite).body,
    });
    assert.equal(appLike.headers['access-control-allow-origin'], undefined);
  } finally { await f.close(); }
});

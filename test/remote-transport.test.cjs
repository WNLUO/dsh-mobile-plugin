// 真实 HTTP/WS 响应验证加密传输边界与有证据的环境诊断。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');
const c = require('../lib/remote/crypto.cjs');
const { fixture, waitClose } = require('./remote-host-fixture.cjs');
const { parseInvitation, pairComputer, openRemoteStream, probeRemote } = require('../lib/remote/transport.cjs');

const deadline = { timeout: 8000 };

test('加密流分块、背压、双向半关闭；令牌/凭据/设备密钥从未明文过线', deadline, async () => {
  const f = await fixture();
  try {
    const invite = await f.invite();
    const binding = await pairComputer(invite);
    const opened = await openRemoteStream(binding, f.route);
    assert.equal(opened.host.port, 34567, '元信息是实际DSH口而非转发口');
    assert.equal(opened.host.token, 'private-launch-token');
    assert.ok(f.requests.every((req) => req.headers['x-dsh-instance'] === binding.instanceId));
    assert.ok(f.requests.some((req) => req.path === '/prefix/api/mobile/v1/remote-computers/tunnel'));
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    payload.write('unique-private-http-body');
    const received = [];
    let bytes = 0;
    opened.stream.on('data', (chunk) => { received.push(chunk); bytes += chunk.length; });
    const ended = once(opened.stream, 'end');
    assert.equal(opened.stream.write(payload), false, '大上传必须向调用方施加背压');
    opened.stream.end();
    await ended;
    assert.equal(bytes, payload.length);
    assert.deepEqual(Buffer.concat(received), payload);
    const observed = Buffer.concat(f.wire);
    for (const secret of [invite.ticket, binding.credential, binding.deviceKey, 'private-launch-token', 'unique-private-http-body']) {
      assert.equal(observed.includes(Buffer.from(secret)), false, `${secret.slice(0, 5)}不应出现在WS明文`);
      assert.equal(f.pairBodies.join('').includes(secret), false, '配对请求不应暴露密钥');
    }
  } finally { await f.close(); }
});

test('探测验证真实A身份，错误实例、设备密钥、凭据均拒绝且不拨目标', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    assert.equal(typeof await probeRemote(binding, f.route), 'number');
    assert.equal(f.upstreamConnections, 0);
    await assert.rejects(probeRemote({ ...binding, instanceId: 'wrong-instance' }, f.route));
    await assert.rejects(probeRemote({ ...binding, deviceKey: c.random() }, f.route), { code: 'REMOTE_AUTH' });
    await assert.rejects(probeRemote({ ...binding, credential: 'wrong-credential' }, f.route), { code: 'REMOTE_AUTH' });
    assert.equal(f.upstreamConnections, 0);
  } finally { await f.close(); }
});

test('加密字节重放直接断流，另一设备流保持有效', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    const healthy = await openRemoteStream(binding, f.route);
    const ws = new WebSocket(c.endpoint(f.route, '/api/mobile/v1/remote-computers/tunnel', true));
    const welcomeWait = once(ws, 'message');
    await once(ws, 'open');
    assert.equal(JSON.parse((await welcomeWait)[0]).type, 'welcome');
    const context = { instanceId: binding.instanceId, keyId: binding.keyId, clientNonce: c.random() };
    const challengeWait = once(ws, 'message');
    ws.send(JSON.stringify({ v: 1, type: 'hello', instanceId: binding.instanceId, keyId: binding.keyId, nonce: context.clientNonce }));
    const challenge = JSON.parse((await challengeWait)[0]);
    context.serverNonce = challenge.nonce;
    const initial = c.connectionKeys(binding.deviceKey, context);
    const readyWait = once(ws, 'message');
    ws.send(JSON.stringify({ v: 1, type: 'auth', sealed: c.sealJson(initial.authUp, { credential: binding.credential, deviceId: binding.deviceId, leaseMs: c.HOUR }, initial.transcript) }));
    await readyWait;
    const keys = c.connectionKeys(binding.deviceKey, { ...context, credential: binding.credential });
    const frame = c.codecs(keys, false).send.seal(0, Buffer.from('data'));
    const closed = once(ws, 'close');
    ws.send(frame);
    ws.send(frame);
    await closed;
    assert.equal(healthy.stream.destroyed, false);
    healthy.stream.destroy();
  } finally { await f.close(); }
});

test('租期到点主动断流，客户端不能把单连接延到一小时之后', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    const opened = await openRemoteStream(binding, f.route, { expiresAt: Date.now() + 150 });
    await waitClose(opened.stream);
    assert.equal(opened.stream.destroyed, true);
    const capped = await openRemoteStream(binding, f.route, { expiresAt: Date.now() + 2 * c.HOUR });
    f.advance(c.HOUR + 1);
    const closed = waitClose(capped.stream);
    f.host.checkAuthorization();
    await closed;
  } finally { await f.close(); }
});

for (const skew of [-5 * 60_000, 5 * 60_000]) test(`A时钟${skew < 0 ? '落后' : '领先'}5分钟：邀请以A为准，开流续期均为相对一小时`, deadline, async () => {
  const f = await fixture();
  try {
    f.advance(skew);
    const invite = await f.invite();
    const binding = await pairComputer({ ...invite, expiresAt: Date.now() - 1 });
    const opened = await openRemoteStream(binding, f.route, { expiresAt: Date.now() + c.HOUR });
    f.advance(59 * 60_000);
    f.host.checkAuthorization();
    assert.equal(opened.stream.destroyed, false);
    const localDeadline = Date.now() + c.HOUR;
    const accepted = await opened.stream.renew(localDeadline);
    assert.ok(accepted <= localDeadline && accepted > localDeadline - 1000, '续期返回B本地时钟期限');
    f.advance(59 * 60_000);
    f.host.checkAuthorization();
    assert.equal(opened.stream.destroyed, false);
    const received = once(opened.stream, 'data');
    opened.stream.write('clock-independent');
    assert.equal((await received)[0].toString(), 'clock-independent');
    const closed = waitClose(opened.stream);
    f.advance(2 * 60_000);
    f.host.checkAuthorization();
    await closed;
    const short = await openRemoteStream(binding, f.route, { expiresAt: Date.now() + 60 });
    await waitClose(short.stream);
    assert.equal(short.stream.destroyed, true, 'B本地短期限仍主动关闭');
  } finally { await f.close(); }
});

test('中转先回101、延后接通A时不会丢掉首条身份握手', deadline, async () => {
  const f = await fixture();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let earlyMessages = 0;
  const upstreams = new Set();
  wss.on('connection', (client) => {
    let upstream;
    client.on('message', (data, binary) => {
      if (upstream?.readyState === 1) upstream.send(data, { binary });
      else earlyMessages++;
    });
    setTimeout(() => {
      upstream = new WebSocket(c.endpoint(f.route, '/api/mobile/v1/remote-computers/tunnel', true));
      upstreams.add(upstream);
      upstream.on('message', (data, binary) => client.send(data, { binary }));
      upstream.on('error', () => client.terminate());
      upstream.on('close', () => client.close());
      client.on('close', () => upstream.terminate());
    }, 40);
  });
  try {
    const binding = await pairComputer(await f.invite());
    const result = await openRemoteStream(binding, { url: `http://127.0.0.1:${server.address().port}`, channel: 'relay' });
    assert.equal(earlyMessages, 0);
    const response = once(result.stream, 'data');
    result.stream.write('relay-ready');
    assert.equal((await response)[0].toString(), 'relay-ready');
    result.stream.destroy();
  } finally {
    for (const ws of [...wss.clients, ...upstreams]) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('手动续期经加密确认延长已有流，到期后不能复活', deadline, async () => {
  const f = await fixture();
  try {
    const binding = await pairComputer(await f.invite());
    const opened = await openRemoteStream(binding, f.route, { expiresAt: Date.now() + 200 });
    const renewed = await opened.stream.renew(Date.now() + 1200);
    assert.ok(renewed > Date.now() + 900);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(opened.stream.destroyed, false, '旧期限不能掐掉已续期长连接');
    const received = once(opened.stream, 'data');
    opened.stream.write('still-connected');
    assert.equal((await received)[0].toString(), 'still-connected');
    const closed = waitClose(opened.stream);
    f.advance(2000);
    f.host.checkAuthorization();
    await closed;
    await assert.rejects(opened.stream.renew(Date.now() + c.HOUR));
  } finally { await f.close(); }
});

test('未认证服务伪造吊销关闭只能报连接失败，取消信号能终止握手', deadline, async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const binding = { instanceId: 'a', deviceId: 'b', keyId: '0123456789abcdef', deviceKey: c.random(), credential: 'private' };
  const route = { url: `http://127.0.0.1:${server.address().port}`, channel: 'relay' };
  try {
    wss.once('connection', (ws) => ws.close(4003));
    await assert.rejects(probeRemote(binding, route), { code: 'REMOTE_CONNECT' });
    const connected = once(wss, 'connection');
    const controller = new AbortController();
    const pending = assert.rejects(openRemoteStream(binding, route, { signal: controller.signal }), { code: 'REMOTE_CONNECT' });
    const [ws] = await connected;
    const closed = once(ws, 'close');
    controller.abort();
    await pending;
    await closed;
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('邀请解析不接受旧六位码或携带秘密的路由URL', () => {
  assert.throws(() => parseInvitation('123456'), { code: 'REMOTE_INVITATION' });
  assert.throws(() => parseInvitation({ type: 'dsh-computer', version: 1, instanceId: 'a', name: 'a', ticketId: c.random(16), ticket: c.random(), expiresAt: Date.now() + 1000, routes: [{ url: 'http://user:secret@example.com', channel: 'relay' }] }), { code: 'REMOTE_INVITATION' });
});

test('邀请版本号是数字但不等于1时报版本不兼容，非数字仍按邀请非法', () => {
  const invite = { type: 'dsh-computer', instanceId: 'a', name: 'a', ticketId: c.random(16), ticket: c.random(), expiresAt: Date.now() + 1000, routes: [{ url: 'http://127.0.0.1:1/prefix', channel: 'relay' }] };
  assert.throws(() => parseInvitation({ ...invite, version: 2 }), { code: 'REMOTE_VERSION' });
  assert.throws(() => parseInvitation({ ...invite, version: '1' }), { code: 'REMOTE_INVITATION' });
});

test('配对响应版本号是数字但不等于1时报版本不兼容', async () => {
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 2, ok: true })); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const invite = { type: 'dsh-computer', version: 1, instanceId: 'a', name: 'a', ticketId: c.random(16), ticket: c.random(), expiresAt: Date.now() + 10_000, routes: [{ url: `http://127.0.0.1:${server.address().port}/prefix`, channel: 'relay' }] };
    await assert.rejects(pairComputer(invite), { code: 'REMOTE_VERSION' });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('握手信令版本号是数字但不等于1时报版本不兼容', { timeout: 8000 }, async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const binding = { instanceId: 'a', deviceId: 'b', keyId: '0123456789abcdef', deviceKey: c.random(), credential: 'private' };
  const route = { url: `http://127.0.0.1:${server.address().port}`, channel: 'relay' };
  try {
    wss.once('connection', (ws) => ws.send(JSON.stringify({ v: 2, type: 'welcome' })));
    await assert.rejects(probeRemote(binding, route), { code: 'REMOTE_VERSION' });
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});


test('配对和升级的407或HTML给出真实诊断，不回显响应且不误称门户', deadline, async () => {
  for (const [status, type, body, expected] of [
    [407, 'text/plain', 'private proxy challenge', 'REMOTE_PROXY'],
    [200, 'text/html', '<html>private login page</html>', 'REMOTE_INTERCEPTED'],
  ]) {
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': type }); res.end(body); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const route = { url: `http://127.0.0.1:${server.address().port}`, channel: 'relay' };
    const binding = { instanceId: 'a', deviceId: 'b', keyId: '0123456789abcdef', deviceKey: c.random(), credential: 'private' };
    const invite = { type: 'dsh-computer', version: 1, instanceId: 'a', name: 'a', ticketId: c.random(16), ticket: c.random(), expiresAt: Date.now() + 10000, routes: [route] };
    try {
      for (const attempt of [() => pairComputer(invite), () => probeRemote(binding, route)]) {
        await assert.rejects(attempt, error => error.code === expected && !error.message.includes('private') && !/portal/i.test(error.message));
      }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

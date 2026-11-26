// 2026-11-26：新宿主删了 browserAuth，远程电脑靠 entry-url 兜底取令牌，打开不能退化成 REMOTE_UNAVAILABLE。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { mountRemoteComputers } = require('../lib/remote/runtime.cjs');
const { pairComputer, openRemoteStream } = require('../lib/remote/transport.cjs');

const deadline = { timeout: 8000 };

test('新宿主没有 browserAuth 时，远程电脑从 entry-url 取令牌也能打开', deadline, async () => {
  const records = [];
  const credentials = {
    issue(instanceId, device, _token, _ttl, extra) {
      const credential = `${instanceId}.9999999999.${crypto.randomBytes(32).toString('base64url')}`;
      records.push({ instanceId, ...device, ...extra, credential });
      return { credential, deviceId: device.deviceId };
    },
    find(value, instanceId) { return records.find(r => r.credential === value && r.instanceId === instanceId && !r.revokedAt && (!r.expiresAt || r.expiresAt > Date.now())) || null; },
    findByKeyId(instanceId, keyId) { return records.find(r => r.instanceId === instanceId && r.keyId === keyId && !r.revokedAt) || null; },
    lookup(value, instanceId) { return records.find(r => r.credential === value && r.instanceId === instanceId) || null; },
    lookupRemoteByKeyId(instanceId, keyId) { return records.find(r => r.instanceId === instanceId && r.keyId === keyId && typeof r.remoteWeb === 'boolean') || null; },
  };
  const effects = [];
  const sockets = new Set();
  let server;
  const ctx = {
    webServer: { port: 0, host: '127.0.0.1' },
    get(name) {
      if (name === 'credentials') return credentials;
      // 新宿主：connection 服务还在，但 browserAuth 已被删掉。
      if (name === 'connection') return { browserPeer: {} };
      return null;
    },
    emit(thisArg, name, _baseUrl, collected) {
      assert.ok(thisArg, 'emit 应当拿到 thisArg');
      assert.equal(name, 'webserver/entry-url');
      assert.equal(_baseUrl, `http://127.0.0.1:${server.address().port}`);
      collected.push({ url: `http://127.0.0.1:${server.address().port}/?token=new-host-launch-token` });
    },
    effect(fn) { effects.push(fn()); },
  };
  const host = mountRemoteComputers({
    ctx,
    state: { instanceId: 'instance-a', name: '远端电脑 A', enabled: true, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'], lanEnabled: false },
    credentials,
    registerRoute() {},
    lanPortInUse: () => 0,
  });
  server = http.createServer((req, res) => host.handlePair(req, res));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => host.handleUpgrade(req, socket, head));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.webServer.port = server.address().port;
  let opened;
  try {
    const route = { url: `http://127.0.0.1:${server.address().port}/prefix`, channel: 'lan' };
    const invite = await host.mintInvite();
    const binding = await pairComputer(invite.invite, { routes: [route] });
    opened = await openRemoteStream(binding, route);
    assert.ok(opened.stream, '新宿主下应成功打开，而不是 REMOTE_UNAVAILABLE');
    assert.equal(typeof opened.host.token, 'string');
  } finally {
    opened?.stream?.destroy();
    for (const socket of sockets) socket.destroy();
    for (const dispose of effects) await dispose();
    await new Promise(resolve => server.close(resolve));
  }
});

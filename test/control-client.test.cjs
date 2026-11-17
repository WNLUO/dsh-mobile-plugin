'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timeout');
}

// 固定的 32 字节 HK（base64url），两端用它加解密。
const HK = Buffer.alloc(32, 7).toString('base64url');

test('总控客户端：加密上送全部地址、拿令牌落盘、变化推 update、断线重连', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');
  const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');

  const messages = [];
  const urls = [];
  const conns = [];
  server.on('connection', (ws, req) => {
    conns.push(ws);
    urls.push(req.url);
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      messages.push(msg);
      if (msg.type === 'register') ws.send(JSON.stringify({ type: 'registered', instanceId: 'inst-x', token: 'tok-1' }));
      else if (msg.type === 'update') ws.send(JSON.stringify({ type: 'updated' }));
    });
  });

  let addresses = [
    { kind: 'relay', url: 'https://relay.example' },
    { kind: 'lan', url: 'http://192.168.1.5:18787' },
  ];
  const state = { enabled: true, instanceId: 'inst-x' };
  let persisted = 0;
  const client = createControlClient({
    state,
    persist: () => { persisted += 1; },
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => addresses,
  });
  t.after(() => {
    client.stop();
    server.close();
  });

  client.start();
  await waitFor(() => messages.some((m) => m.type === 'register'));
  const reg = messages.find((m) => m.type === 'register');
  // 上报的是密文：用同一把 HK 解出来，应等于全部地址。
  const plain = openHistoryBlob(HK, 'control', 'inst-x', reg.payload);
  assert.deepEqual(plain.addresses, addresses);
  await waitFor(() => client.snapshot().token === 'tok-1' && client.snapshot().connected === true);
  assert.equal(client.snapshot().url, `http://127.0.0.1:${port}`);
  await waitFor(() => state.controlToken === 'tok-1' && persisted >= 1);

  addresses = [{ kind: 'relay', url: 'https://relay2.example' }];
  client.sync();
  await waitFor(() => messages.some((m) => m.type === 'update'));
  const upd = messages.find((m) => m.type === 'update');
  assert.deepEqual(openHistoryBlob(HK, 'control', 'inst-x', upd.payload).addresses, addresses);

  await waitFor(() => conns.length >= 1);
  conns[0].close();
  await waitFor(() => messages.filter((m) => m.type === 'register').length >= 2, 6000);
  assert.ok(urls.some((u) => u.includes('token=tok-1')), '重连 URL 应带上令牌');
});

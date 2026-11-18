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

const HK = Buffer.alloc(32, 7).toString('base64url');

test('健康信封：当前连上的中转与隧道状态随地址一起上报，状态变了就推 update', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient, controlMeta } = require('../lib/relay/control.js');
  const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');

  const messages = [];
  server.on('connection', (ws) => {
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      messages.push(msg);
      if (msg.type === 'register') ws.send(JSON.stringify({ type: 'registered', token: 'tok-meta' }));
    });
  });

  const state = { enabled: true, instanceId: 'inst-meta', relayUrl: 'https://public.example/' };
  let connected = true;
  const client = createControlClient({
    state,
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://public.example' }],
    getRelayConnected: () => connected,
  });
  t.after(() => {
    client.stop();
    server.close();
  });

  client.start();
  await waitFor(() => messages.some((m) => m.type === 'register'));
  const reg = openHistoryBlob(HK, 'control', 'inst-meta', messages.find((m) => m.type === 'register').payload);
  assert.equal(reg.meta.connectedRelay, 'https://public.example', '当前主用取宿主写回的那条，尾斜杠去掉');
  assert.equal(reg.meta.relayConnected, true);
  assert.ok(Number.isFinite(reg.meta.at) && reg.meta.at > 0, '采样的时刻要能判断新旧');

  connected = false;
  client.sync();
  await waitFor(() => messages.some((m) => m.type === 'update'));
  const upd = openHistoryBlob(HK, 'control', 'inst-meta', messages.find((m) => m.type === 'update').payload);
  assert.equal(upd.meta.relayConnected, false, '隧道断了要推一格新状态，不能只等地址变化');

  const before = messages.filter((m) => m.type === 'update').length;
  client.sync();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(messages.filter((m) => m.type === 'update').length, before, '状态没变就不重复推');
});

test('健康信封：没有中转地址或地址不合法时当前那条留空', () => {
  const { controlMeta } = require('../lib/relay/control.js');
  assert.equal(controlMeta({ relayUrl: '' }).connectedRelay, '');
  assert.equal(controlMeta({ relayUrl: 'not a url' }).connectedRelay, '');
  assert.equal(controlMeta({}).relayConnected, false);
});

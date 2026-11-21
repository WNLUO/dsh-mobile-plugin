'use strict';

// 总控转达「请自检」时，插件要把同一份诊断加密回过去，并且认得出手机问的是哪一台。
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

const HK = Buffer.alloc(32, 9).toString('base64url');

test('总控客户端：收到 ask 就回一份加密诊断，同一拍不重复回', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');
  const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');

  const answers = [];
  let socket = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'register') ws.send(JSON.stringify({ type: 'registered', instanceId: 'inst-d', token: 'tok-d' }));
      else if (msg.type === 'update') ws.send(JSON.stringify({ type: 'updated' }));
      else if (msg.type === 'answer') answers.push(msg);
    });
  });

  const diagnostics = { ok: true, tunnel: { state: 'connected' }, host: { plugin: '1.2.3' } };
  const state = { enabled: true, instanceId: 'inst-d' };
  const client = createControlClient({
    state,
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://relay.example' }],
    getDiagnostics: () => diagnostics,
  });
  t.after(() => {
    client.stop();
    server.close();
  });

  client.start();
  await waitFor(() => client.snapshot().token === 'tok-d' && client.snapshot().connected === true);

  socket.send(JSON.stringify({ type: 'ask' }));
  await waitFor(() => answers.length === 1);
  // 连着两发只回一份：手机连点两下不该把同一份诊断翻两遍。
  socket.send(JSON.stringify({ type: 'ask' }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(answers.length, 1);

  const plain = openHistoryBlob(HK, 'diagnose', 'inst-d', answers[0].payload);
  assert.equal(plain.kind, 'diagnose');
  assert.equal(plain.instanceId, 'inst-d');
  assert.deepEqual(plain.diagnostics, diagnostics);
  // 手机手上那份地址是不是旧的，靠这一格比对。
  assert.deepEqual(plain.reported, [{ kind: 'relay', url: 'https://relay.example' }]);
  assert.equal(plain.control.connected, true);

  // 地址那份信封（scope=control）解不开它：两个 scope 不能互相冒充。
  assert.throws(() => openHistoryBlob(HK, 'control', 'inst-d', answers[0].payload));
});

test('总控客户端：没有诊断出口时也回话，只是内容为空', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');
  const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');

  const answers = [];
  let socket = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'register') ws.send(JSON.stringify({ type: 'registered', instanceId: 'inst-e', token: 'tok-e' }));
      else if (msg.type === 'update') ws.send(JSON.stringify({ type: 'updated' }));
      else if (msg.type === 'answer') answers.push(msg);
    });
  });

  const state = { enabled: true, instanceId: 'inst-e' };
  const client = createControlClient({
    state,
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://relay.example' }],
  });
  t.after(() => {
    client.stop();
    server.close();
  });

  client.start();
  await waitFor(() => client.snapshot().token === 'tok-e' && client.snapshot().connected === true);
  socket.send(JSON.stringify({ type: 'ask' }));
  await waitFor(() => answers.length === 1);
  const plain = openHistoryBlob(HK, 'diagnose', 'inst-e', answers[0].payload);
  assert.equal(plain.diagnostics, null);
  assert.equal(plain.kind, 'diagnose');
});

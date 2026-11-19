// 验证总控加密信封只报告真实已注册线路。
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
    getConnectedRelay: () => connected ? 'https://actual.example/' : '',
  });
  t.after(() => {
    client.stop();
    server.close();
  });

  client.start();
  await waitFor(() => messages.some((m) => m.type === 'register'));
  const reg = openHistoryBlob(HK, 'control', 'inst-meta', messages.find((m) => m.type === 'register').payload);
  assert.equal(reg.meta.connectedRelay, 'https://actual.example', 'PLUG-13：真实注册线路优先于尚未写回的配置首项');
  assert.equal(reg.meta.relayConnected, true);
  assert.ok(Number.isFinite(reg.meta.at) && reg.meta.at > 0, '采样的时刻要能判断新旧');

  connected = false;
  client.sync();
  await waitFor(() => messages.some((m) => m.type === 'update'));
  const upd = openHistoryBlob(HK, 'control', 'inst-meta', messages.find((m) => m.type === 'update').payload);
  assert.equal(upd.meta.connectedRelay, '', '离线不能把配置首项冒充已注册线路');
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


test('真实地址getter非空→空→恢复，在原WS清空并重新发布；重连也能清空', async () => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const file = require.resolve('../lib/relay/control.js');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const prior = process.env.DSH_CONTROL_URL;
  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${server.address().port}`;
  let heartbeat;
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: loaded, exports: loaded.exports, require: createRequire(file), process, Buffer, WebSocket: globalThis.WebSocket,
    setTimeout, clearTimeout,
    setInterval: (fn) => { heartbeat = fn; return { unref() {} }; }, clearInterval() {},
  });
  if (prior === undefined) delete process.env.DSH_CONTROL_URL;
  else process.env.DSH_CONTROL_URL = prior;
  const { openHistoryBlob } = require('../lib/mirror/history-blob.cjs');
  const sockets = [];
  const messages = [];
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      messages.push({ type: frame.type, ...openHistoryBlob(HK, 'control', 'empty-route', frame.payload) });
      if (frame.type === 'register') ws.send(JSON.stringify({ type: 'registered', token: 'empty-token' }));
    });
  });
  let current = '';
  const client = loaded.exports.createControlClient({
    state: { enabled: true, instanceId: 'empty-route', lanEnabled: false, relayUrl: 'https://configured.example', relayUrls: ['https://configured.example', 'https://active.example'] },
    getPort: () => 0, getHistoryKey: () => HK, persist() {},
    getRelayConnected: () => Boolean(current), getConnectedRelay: () => current,
  });
  try {
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sockets.length, 0, '初次没有可用地址时不必建立目录连接');
    current = 'https://active.example'; client.sync();
    await waitFor(() => messages.length === 1);
    assert.deepEqual(JSON.parse(JSON.stringify(messages[0].addresses)), [{ kind: 'relay', url: current }, { kind: 'tcp', url: '' }]);
    current = ''; heartbeat();
    await waitFor(() => messages.length === 2);
    assert.deepEqual(JSON.parse(JSON.stringify(messages[1].addresses)), []);
    assert.equal(messages[1].meta.connectedRelay, '');
    assert.equal(messages[1].meta.relayConnected, false);
    assert.equal(sockets.length, 1, '清空必须沿已存在WS发update');
    current = 'https://active.example'; client.sync();
    await waitFor(() => messages.length === 3);
    assert.equal(messages[2].meta.relayConnected, true);
    current = ''; client.sync();
    await waitFor(() => messages.length === 4);
    assert.deepEqual(JSON.parse(JSON.stringify(messages[3].addresses)), []);
    assert.equal(messages[3].meta.connectedRelay, '');
    assert.equal(messages[3].meta.relayConnected, false);
    client.stop(); client.start();
    await waitFor(() => messages.length === 5);
    assert.equal(messages[4].type, 'register');
    assert.deepEqual(JSON.parse(JSON.stringify(messages[4].addresses)), []);
    current = 'https://active.example'; client.sync();
    await waitFor(() => messages.length === 6);
    assert.equal(messages[5].meta.connectedRelay, current);
  } finally {
    client.stop(); for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

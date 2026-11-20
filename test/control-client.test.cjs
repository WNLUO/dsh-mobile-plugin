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

test('总控客户端：状态晚于建客户端注入时，注册仍要带上已落盘令牌（稳定外壳场景）', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');

  const urls = [];
  server.on('connection', (ws, req) => {
    urls.push(req.url);
    ws.on('message', () => {
      try { ws.send(JSON.stringify({ type: 'registered', instanceId: 'inst-x', token: 'tok-1' })); } catch {}
    });
  });

  // 复刻 shell/transport-host.js：control 客户端先用空 providers 建好，稍后才注入真状态。
  let state = {};
  const client = createControlClient({
    getState: () => state,
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://relay.example' }],
  });
  t.after(() => { client.stop(); server.close(); });

  state = { enabled: true, instanceId: 'inst-x', controlToken: 'tok-persisted' };
  client.start();
  await waitFor(() => urls.length >= 1);
  assert.ok(
    urls[0].includes('token=tok-persisted'),
    `注册 URL 应带上注入后的已落盘令牌，实际为 ${urls[0]}`,
  );
});

test('总控客户端：被服务端拒绝时退避递增，不会每秒硬撞', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');

  const times = [];
  server.on('connection', (ws) => {
    times.push(Date.now());
    // 每次都拒（模拟同一 instanceId 令牌被别处占用 / 令牌对不上），并断开。
    ws.on('message', () => {
      try { ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' })); } catch {}
      try { ws.close(); } catch {}
    });
  });

  const client = createControlClient({
    state: { enabled: true, instanceId: 'inst-x' },
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://relay.example' }],
  });
  t.after(() => { client.stop(); server.close(); });

  client.start();
  await waitFor(() => times.length >= 3, 8000);
  // 第 1→2 次约 1 秒（首次退避），第 2→3 次应约 2 秒：退避在增长而不是恒定 1 秒。
  const gap = times[2] - times[1];
  assert.ok(gap >= 1500, `被拒后第 2→3 次重连间隔应 ≥1.5s（实际 ${gap}ms），不能恒定每秒硬撞`);
});

test('总控客户端：连续 identity_conflict 达到阈值触发一次换身份回调', async (t) => {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  process.env.DSH_CONTROL_URL = `http://127.0.0.1:${port}`;
  delete require.cache[require.resolve('../lib/relay/control.js')];
  const { createControlClient } = require('../lib/relay/control.js');

  server.on('connection', (ws) => {
    ws.on('message', () => {
      try { ws.send(JSON.stringify({ type: 'error', message: 'identity_conflict' })); } catch {}
      try { ws.close(); } catch {}
    });
  });

  let triggered = 0;
  const client = createControlClient({
    state: { enabled: true, instanceId: 'inst-x' },
    getPort: () => 0,
    getHistoryKey: () => HK,
    getAddresses: () => [{ kind: 'relay', url: 'https://relay.example' }],
    onIdentityConflict: () => { triggered += 1; },
  });
  t.after(() => { client.stop(); server.close(); });

  client.start();
  await waitFor(() => triggered >= 1, 9000);
  assert.equal(triggered, 1, '达到阈值只应触发一次（冷却期内不再触发）');
});

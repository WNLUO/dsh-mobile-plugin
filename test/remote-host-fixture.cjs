// 远程电脑测试的真实网络假体：凭据可独立吊销，TCP只监听回环。
'use strict';

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRemoteHost, PAIR_PATH } = require('../lib/remote/host.cjs');
const { parseInvitation } = require('../lib/remote/transport.cjs');

async function fixture(options = {}) {
  const records = [];
  const pairBodies = [];
  const wire = [];
  const requests = [];
  const sockets = new Set();
  const controls = [];
  let clock = Date.now();
  let upstreamConnections = 0;
  const credentials = {
    issue(instanceId, device, _token, _ttl, extra) {
      const credential = `${instanceId}.9999999999.${crypto.randomBytes(32).toString('base64url')}`;
      records.push({ instanceId, ...device, ...extra, credential });
      return { credential, deviceId: device.deviceId };
    },
    find(value, instanceId) { return records.find((r) => r.credential === value && r.instanceId === instanceId && !r.revokedAt && (!r.expiresAt || r.expiresAt > clock)) || null; },
    findByKeyId(instanceId, keyId) { return records.find((r) => r.instanceId === instanceId && r.keyId === keyId && !r.revokedAt && (!r.expiresAt || r.expiresAt > clock)) || null; },
    lookup(value, instanceId) { return records.find((r) => r.credential === value && r.instanceId === instanceId) || null; },
    lookupRemoteByKeyId(instanceId, keyId) { return records.find((r) => r.instanceId === instanceId && r.keyId === keyId && typeof r.remoteWeb === 'boolean') || null; },
  };
  const tcp = net.createServer({ allowHalfOpen: true }, (socket) => {
    upstreamConnections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    if (req.url === `/prefix${PAIR_PATH}`) {
      const chunks = [];
      req.on('data', (data) => chunks.push(data));
      req.on('end', () => pairBodies.push(Buffer.concat(chunks).toString()));
      host.handlePair(req, res);
    } else { res.writeHead(404); res.end(); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    requests.push({ path: req.url, headers: req.headers });
    host.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const route = { url: `http://127.0.0.1:${server.address().port}/prefix`, channel: 'lan' };
  const host = createRemoteHost({
    state: { instanceId: 'instance-a', name: '远端电脑 A' }, credentials,
    routesOf: () => [route], now: () => clock,
    getUpstreamPort: async () => tcp.address().port, getWebPort: () => 34567,
    getLaunchToken: () => 'private-launch-token',
    getConnectionInfo: () => ({ routes: [route], p2p: { publicKey: 'public' } }),
    onControl: async (record, request) => { controls.push({ deviceId: record.deviceId, request }); return { routes: [route] }; },
    ...options,
  });
  const upgrade = host.handleUpgrade;
  host.handleUpgrade = (req, socket, head) => {
    const write = socket.write;
    socket.write = function(chunk, ...args) { wire.push(Buffer.from(chunk)); return write.call(this, chunk, ...args); };
    socket.on('data', (chunk) => wire.push(Buffer.from(chunk)));
    return upgrade(req, socket, head);
  };
  return {
    host, records, controls, pairBodies, requests, wire, route,
    get upstreamConnections() { return upstreamConnections; },
    now: () => clock, advance: (ms) => { clock += ms; },
    async invite() { return parseInvitation((await host.mintInvite()).invite); },
    async close() {
      host.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => tcp.close(resolve))]);
    },
  };
}

function waitClose(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.once('close', resolve));
}

module.exports = { fixture, waitClose };

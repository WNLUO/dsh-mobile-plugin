// 实际装配与 IPv6 候选必须对应真实监听端口。
'use strict';
// 实际装配使用真实凭据库/Host/Controller，验证入口存在、生成邀请及卸载释放。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-runtime-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(dir, 'credentials.json');
process.env.DSH_MOBILE_REMOTE_STORE = path.join(dir, 'remote-computers.json');
const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
const { mountRemoteComputers } = require('../lib/remote/runtime.cjs');
const { createHostControl, routesOf } = require('../lib/remote/host-control.cjs');

test('运行期管理入口使用真实安全清单，邀请可复制且卸载完成', async () => {
  const effects = [];
  const routes = new Map();
  const ctx = { webServer: { port: 34567 }, get: () => ({ browserAuth: { launchToken: 'private' } }),
    effect(fn) { const dispose = fn(); effects.push(dispose); } };
  const host = mountRemoteComputers({ ctx, state: { instanceId: 'runtimeA', name: 'A', enabled: true, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'], lanEnabled: false },
    credentials, registerRoute: row => routes.set(row.path, row.handler), lanPortInUse: () => 0 });
  const req = new PassThrough(); Object.assign(req, { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:34567', origin: 'http://127.0.0.1:34567', 'content-type': 'application/json' } });
  const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
  const running = routes.get('/api/relay/remote-computers/invite')(req, res);
  req.end('{}'); await running;
  assert.equal(res.status, 200); assert.match(res.body.invite, /^dshcomputer:/);
  assert.ok(res.body.expiresAt > Date.now());
  assert.equal(typeof host.handlePair, 'function'); assert.equal(typeof host.handleUpgrade, 'function');
  for (const close of effects) await close();
  await assert.rejects(host.mintInvite(), { code: 'REMOTE_CONNECT' });
});
test('隧道会合只映射对端公钥与候选，使用已有固定入口且并发合并', async () => {
  const calls = [];
  const p2p = { targetPort: () => 19999, constants: { P2P_PORT: 48950 },
    async open(value) { calls.push(value); return { ok: true, publicKey: 'public-A', candidates: ['192.168.1.2:10'] }; } };
  const control = createHostControl({ state: { enabled: true, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'] },
    lanPortInUse: () => 0, p2p, tailcat: { enroll: async () => ({ address: 'tc-address', port: 48941 }) } });
  const record = { remoteWeb: true, deviceId: 'B' };
  const result = await control.onControl(record, { op: 'tunnels', tailcatPublicKey: 'nodekey:' + 'a'.repeat(64),
    p2p: { publicKey: 'b'.repeat(43) + '=', candidates: ['203.0.113.1:4000'], localCandidates: [] } });
  assert.equal(calls.length, 1); assert.equal(calls[0].phonePublicKey, 'b'.repeat(43) + '=');
  assert.equal(calls[0].targetPort, 19999); assert.equal(result.p2p.port, 48950);
  assert.equal(result.tailcat.address, 'tc-address');
  await assert.rejects(control.onControl(record, { op: 'shell' }), /unsupported/);
  await assert.rejects(control.onControl({ deviceId: 'phone' }, { op: 'tunnels' }), /denied/);
});
test('远程电脑候选按 lanAvailable 谓词产出局域网/IPv6，与手机开关解耦', () => {
  const state = { enabled: true, lanEnabled: false, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'] };
  // 手机开关关、也没有远程电脑绑定：行为与旧实现一致，只产出 relay。
  assert.deepEqual(routesOf({ state, lanPortInUse: () => 0 }).map((row) => row.channel), ['relay']);
  // 注入的 lanAvailable 为真（有远程电脑）：即便手机开关是关的，仍产出 lan/ipv6 候选。
  // 网卡固定成一份（私网 IPv4 + 全球单播 IPv6），结果不随执行测试那台机器的真实网卡变化。
  const interfaces = {
    en0: [
      { address: '192.168.1.5', family: 'IPv4', netmask: '255.255.255.0', internal: false },
      { address: '240e:338::998', family: 'IPv6', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
    ],
  };
  const rows = routesOf({ state, lanPortInUse: () => 18787, lanAvailable: () => true, interfaces });
  assert.ok(rows.some((row) => row.channel === 'lan'));
  assert.ok(rows.some((row) => row.channel === 'ipv6'));
  assert.ok(rows.some((row) => row.channel === 'relay'));
  const independent = routesOf({ state, lanPortInUse: () => 18787, lanAvailable: () => false, interfaces });
  assert.ok(independent.some(row => row.channel === 'ipv6'));
  assert.ok(!independent.some(row => row.channel === 'lan'));
  const stopped = routesOf({ state, lanPortInUse: () => 0, lanAvailable: () => false, interfaces });
  assert.ok(!stopped.some(row => row.channel === 'ipv6'));
});
test('「TCP 直连」目标成为远程电脑的一条候选线路', () => {
  const state = { enabled: true, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'], manualTcpUrl: '203.0.113.9:51543' };
  const rows = routesOf({ state, lanPortInUse: () => 0, lanAvailable: () => false });
  assert.deepEqual(rows.find((row) => row.channel === 'tcp'), { url: 'http://203.0.113.9:51543', channel: 'tcp' });
  // 没填就不产出 tcp，别凭空造一条。
  const without = routesOf({ state: { ...state, manualTcpUrl: '' }, lanPortInUse: () => 0, lanAvailable: () => false });
  assert.ok(!without.some((row) => row.channel === 'tcp'));
});

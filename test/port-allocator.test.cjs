'use strict';
// 需求已确认：原端口优先，已监听且完成发现发布后才能保存新入口。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { canListen, freePort } = require('../lib/relay/port-allocator.cjs');
const { canChangeLanPort, createLanPortPolicy } = require('../lib/relay/lan-port-policy.cjs');
const { bindLanEndpoint } = require('../lib/relay/lan-discovery.cjs');

const store = rows => ({ listActive: () => rows });
const compatible = store([{ instanceId: 'i', lanDiscovery: 1 }]);
const busy = () => Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
function fixture(error = busy(), ready = true, credentials = compatible) {
  const attempts = []; const stopped = []; const published = [];
  return { attempts, stopped, published, args: {
    requestedPort: 18787, instanceId: 'i', store: credentials,
    discovery: { publish: async port => { published.push(port); return ready; }, stop: () => {} },
    createProxy(port) { attempts.push(port); return {
      start: async () => { if (port === 18787) throw error; },
      stop: async () => { stopped.push(port); }, port: () => port || 23456,
    }; },
  } };
}

test('自检仍区分空闲和占用，探测不改配置', async () => {
  const port = await freePort('127.0.0.1');
  assert.ok(await canListen(port, '127.0.0.1'));
  const held = net.createServer();
  await new Promise(resolve => held.listen(port, '127.0.0.1', resolve));
  try { assert.equal(await canListen(port, '127.0.0.1'), false); }
  finally { await new Promise(resolve => held.close(resolve)); }
});

test('没有设备、旧设备、能力未知都不自动换端口；其他实例和电脑凭据不挡', () => {
  for (const rows of [[], [{ instanceId: 'i' }], [{ instanceId: 'i', lanDiscovery: 0 }],
    [{ instanceId: 'i', lanDiscovery: 1 }, { instanceId: 'i' }]]) assert.equal(canChangeLanPort(store(rows), 'i'), false);
  assert.equal(canChangeLanPort(store([{ instanceId: 'i', lanDiscovery: 1 }, { instanceId: 'x' },
    { instanceId: 'i', kind: 'computer' }]), 'i'), true);
});

test('原端口可用时只监听原端口；发现失效也保留现有入口', async () => {
  const f = fixture();
  f.args.createProxy = port => ({ start: async () => { f.attempts.push(port); }, stop: async () => {}, port: () => port });
  f.args.discovery.publish = async () => false;
  assert.equal((await bindLanEndpoint(f.args)).port, 18787);
  assert.deepEqual(f.attempts, [18787]);
});

test('只有真实占用且全部支持发现时才绑定新入口，再发布实绑端口', async () => {
  const f = fixture();
  assert.equal((await bindLanEndpoint(f.args)).port, 23456);
  assert.deepEqual(f.attempts, [18787, 0]);
  assert.deepEqual(f.published, [23456]);
});

test('旧手机占用时不换号，权限错误不换号，新入口发布失败就关闭', async () => {
  const old = fixture(busy(), true, store([{ instanceId: 'i' }]));
  await assert.rejects(bindLanEndpoint(old.args), /未自动换端口/);
  assert.deepEqual(old.attempts, [18787]);
  const permission = fixture(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await assert.rejects(bindLanEndpoint(permission.args), /denied/);
  assert.deepEqual(permission.attempts, [18787]);
  const noDiscovery = fixture(busy(), false);
  await assert.rejects(bindLanEndpoint(noDiscovery.args), /保留原端口/);
  assert.deepEqual(noDiscovery.stopped, [18787, 0]);
});

test('有效凭据的发现能力可落盘、刷新和撤销，电脑凭据不阻止手机入口恢复', () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-cap-test-'));
  const before = process.env.DEVICE_CREDENTIALS_FILE;
  process.env.DEVICE_CREDENTIALS_FILE = path.join(dir, 'credentials.json');
  const credentials = require('../dsh-mobile-credentials/lib/credentials.js');
  try {
    const issued = credentials.issue('i', { deviceId: 'phone' });
    assert.equal(canChangeLanPort(credentials, 'i'), false);
    const record = credentials.lookup(issued.credential, 'i');
    credentials.touch(record, { meta: { lanDiscovery: 1 } });
    assert.equal(canChangeLanPort(credentials, 'i'), true);
    assert.equal(JSON.parse(fs.readFileSync(process.env.DEVICE_CREDENTIALS_FILE, 'utf8'))[0].lanDiscovery, 1);
    credentials.touch(record, { meta: { lanDiscovery: 0 } });
    assert.equal(canChangeLanPort(credentials, 'i'), false);
    credentials.revoke(issued.credential, 'i');
    assert.equal(canChangeLanPort(credentials, 'i'), false);
  } finally {
    credentials.resetForTest();
    if (before === undefined) delete process.env.DEVICE_CREDENTIALS_FILE; else process.env.DEVICE_CREDENTIALS_FILE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('变异：删除旧手机保护时，同一条占用断言必须失败', async () => {
  const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module');
  const file = path.join(__dirname, '../lib/relay/lan-discovery.cjs');
  const source = fs.readFileSync(file, 'utf8').replace('if (!canChangeLanPort(store, instanceId))', 'if (false && !canChangeLanPort(store, instanceId))');
  const mutated = { exports: {} };
  new Function('require', 'module', 'exports', source)(Module.createRequire(file), mutated, mutated.exports);
  const f = fixture(busy(), true, store([{ instanceId: 'i' }]));
  const protectsOldPhone = bind => assert.rejects(bind(f.args), /未自动换端口/);
  await protectsOldPhone(bindLanEndpoint);
  await assert.rejects(protectsOldPhone(mutated.exports.bindLanEndpoint), { code: 'ERR_ASSERTION' });
});

test('失效配置不能留下监听或新地址', async () => {
  const f = fixture();
  f.args.isCurrent = () => false;
  await assert.rejects(bindLanEndpoint(f.args), /配置已更新/);
  assert.deepEqual(f.attempts, [18787]);
});

test('端口只在监听成功后落盘，重启继续用它，只有 LAN 鉴权才算恢复', () => {
  const state = { lanPort: 18787 }; let saves = 0;
  const policy = createLanPortPolicy({ state, saveState: () => { saves += 1; } });
  for (const mode of ['off', 'connecting', 'error']) policy.apply({ state: mode, port: 23456, requestedPort: 18787 });
  assert.equal(state.lanPort, 18787);
  policy.apply({ state: 'listening', port: 23456, requestedPort: 18787 });
  assert.equal(state.lanPort, 23456); assert.equal(saves, 1);
  policy.apply({ state: 'listening', port: 34567, requestedPort: 18787 });
  assert.equal(state.lanPort, 23456);
  assert.equal(policy.recovery().state, 'awaiting-device');
  policy.noteAuthorized({ headers: { host: '192.168.1.2:23456' } }, 'relay');
  assert.equal(policy.recovery().state, 'awaiting-device');
  policy.noteAuthorized({ headers: { host: '192.168.1.2:23456' } }, 'lan');
  assert.equal(policy.recovery().state, 'verified');
  assert.equal(createLanPortPolicy({ state, saveState: () => {} }).port(), 23456);
});

'use strict';
// 2026-11-27：从 0.5.126 的宿主凭据记录把电脑绑定补进新本地库，幂等、不覆盖、不删旧记录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createRemoteStore } = require('../lib/remote/store.cjs');
const { mountRemoteComputers } = require('../lib/remote/runtime.cjs');

function fileOf() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-migration-')), 'remote-computers.json');
}

function legacyKey(id) {
  return 'dsh-mobile-plugin/remote-computer-' + Buffer.from(id, 'utf8').toString('hex');
}

function grant(id, binding = {}) {
  return {
    kind: 'grant',
    payload: { version: 1, binding: { id, instanceId: 'instance-' + id, name: '旧电脑', tunnelKeys: { p2pPrivateKey: 'private' }, ...binding } },
  };
}

/** 照旧宿主凭据 seam 的形状造假体：记录按 key 存，listRecords 只回 key/kind。 */
function legacyProvider(records = {}) {
  return {
    records,
    async listRecords() { return Object.keys(records).map(key => ({ key, kind: records[key].kind })); },
    async readRecord(key) { return records[key]; },
  };
}

test('旧凭据有绑定、新库为空：创建 store 后能读到该绑定，旧记录一条不删', async () => {
  const credentials = legacyProvider({
    [legacyKey('hostA')]: grant('hostA'),
    [legacyKey('hostB')]: grant('hostB'),
    'other-plugin/api-key': { kind: 'api-key', payload: { value: 'secret' } },
  });
  const store = createRemoteStore({ file: fileOf(), legacyCredentials: credentials });
  const rows = await store.list();
  assert.deepEqual(rows.map(row => row.id), ['hostA', 'hostB']);
  assert.deepEqual(rows[0], {
    id: 'hostA', instanceId: 'instance-hostA', name: '旧电脑', tunnelKeys: { p2pPrivateKey: 'private' },
  });
  assert.equal((await store.get('hostB')).instanceId, 'instance-hostB');
  assert.equal(credentials.records[legacyKey('hostA')].kind, 'grant');
  assert.equal(credentials.records['other-plugin/api-key'].kind, 'api-key');
});

test('重复启动幂等：不会写第二份，也不会拿旧记录盖掉新库里改过的值', async () => {
  const file = fileOf();
  const credentials = legacyProvider({ [legacyKey('hostA')]: grant('hostA') });
  const first = createRemoteStore({ file, legacyCredentials: credentials });
  await first.list();
  await first.update('hostA', () => ({ name: '新名字', mode: 'relay' }));

  const second = createRemoteStore({ file, legacyCredentials: credentials });
  await second.list();
  const third = createRemoteStore({ file, legacyCredentials: credentials });
  assert.deepEqual((await third.list()).map(row => row.id), ['hostA']);
  assert.equal((await third.get('hostA')).name, '新名字');
  assert.equal((await third.get('hostA')).mode, 'relay');
});

test('新库已有同 id 记录：旧凭据不覆盖它，也不混入旧字段', async () => {
  const file = fileOf();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    bindings: { hostA: { id: 'hostA', instanceId: 'instance-hostA', name: '本地新名字', mode: 'relay' } },
  }));
  const credentials = legacyProvider({ [legacyKey('hostA')]: grant('hostA') });
  const store = createRemoteStore({ file, legacyCredentials: credentials });
  const row = await store.get('hostA');
  assert.deepEqual(row, { id: 'hostA', instanceId: 'instance-hostA', name: '本地新名字', mode: 'relay' });
  assert.equal((await store.list()).length, 1);
});

test('旧凭据没有绑定记录、凭据服务缺失或读取失败：不报错，新库保持可用', async () => {
  const empty = legacyProvider({ 'other-plugin/api-key': { kind: 'api-key', payload: {} } });
  assert.deepEqual(await createRemoteStore({ file: fileOf(), legacyCredentials: empty }).list(), []);
  assert.deepEqual(await createRemoteStore({ file: fileOf(), legacyCredentials: () => null }).list(), []);
  const broken = { async listRecords() { throw new Error('credentials unavailable'); }, async readRecord() {} };
  const store = createRemoteStore({ file: fileOf(), legacyCredentials: broken });
  assert.deepEqual(await store.list(), []);
  await store.put({ id: 'hostA', instanceId: 'instance-hostA' });
  assert.equal((await store.get('hostA')).instanceId, 'instance-hostA');
});

test('运行时挂载从宿主凭据补绑定，管理清单里看得到旧电脑', async () => {
  const file = fileOf();
  const previous = process.env.DSH_MOBILE_REMOTE_STORE;
  process.env.DSH_MOBILE_REMOTE_STORE = file;
  try {
    const credentials = legacyProvider({ [legacyKey('hostRT')]: grant('hostRT') });
    const effects = [];
    const routes = new Map();
    const ctx = {
      webServer: { port: 34567, host: '127.0.0.1' },
      get(name) { return name === 'credentials' ? credentials : null; },
      effect(fn) { effects.push(fn()); },
    };
    mountRemoteComputers({
      ctx,
      state: { instanceId: 'A', name: 'A', enabled: true, relayUrl: 'https://relay.test', relayUrls: ['https://relay.test'], lanEnabled: false },
      credentials: { listRemoteComputers: () => [], revokeDevice: () => 0 },
      registerRoute: row => routes.set(row.path, row.handler),
      lanPortInUse: () => 0,
    });
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url: '/api/relay/remote-computers', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:34567', origin: 'http://127.0.0.1:34567' } });
    req.setEncoding = () => {};
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
    await routes.get('/api/relay/remote-computers')(req, res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.devices.map(row => row.id), ['hostRT']);
    assert.deepEqual(res.body.authorizedComputers, []);
    for (const close of effects) await close();
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_REMOTE_STORE;
    else process.env.DSH_MOBILE_REMOTE_STORE = previous;
  }
});

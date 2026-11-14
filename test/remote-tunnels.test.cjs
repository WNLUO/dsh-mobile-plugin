// 桌面隧道适配守卫：加密控制会合、每设备私钥、两阶段候选与单设备清理。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteTunnels } = require('../lib/remote/tunnels.cjs');

function fixture() {
  const records = new Map();
  const calls = [];
  const controls = [];
  const stopped = [];
  let serial = 0;
  let candidates = ['192.168.1.8:49000', '203.0.113.2:49000'];
  const helper = {
    status: () => ({ running: true, generation: 1 }),
    async request(command, fields) {
      calls.push({ command, ...fields });
      if (command === 'remoteTailcatKey') {
        const key = fields.privateKey || `tailcat-private-${++serial}`;
        return { privateKey: key, publicKey: key.replace('private', 'public') };
      }
      if (command === 'remoteP2PKeys') return { private: `p2p-private-${++serial}`, public: `p2p-public-${serial}` };
      if (command === 'remoteTailcatStart') return { port: 31001 };
      if (command === 'remoteP2PStart') return { url: 'http://127.0.0.1:31002', candidates };
      if (command === 'remoteP2PCandidates') return { candidates, localCandidates: [] };
      return {};
    },
    async closeDevice(id) { stopped.push(id); },
    async close() { stopped.push('*'); },
  };
  const transport = { async callRemoteControl(binding, route, payload) {
    controls.push({ id: binding.id, route, payload });
    return { tailcat: { address: 'tc-test', port: 48941 }, p2p: { publicKey: 'a-public', port: 48950, candidates: ['192.168.1.2:45000'] } };
  } };
  const store = { async get(id) { return records.get(id); }, async put(value) { records.set(value.id, value); } };
  const binding = id => ({ id, instanceId: id, credential: 'T1-secret', routes: [{ url: 'https://relay.test/prefix', channel: 'relay' }] });
  return { records, calls, controls, stopped, helper, transport, store, binding, setCandidates(value) { candidates = value; } };
}

test('两阶段会合只发公钥，复用句柄和候选集合，每台电脑保存独立私钥', async () => {
  const f = fixture();
  const tunnels = createRemoteTunnels(f);
  const a = f.binding('a');
  const b = f.binding('b');
  await f.store.put(a); await f.store.put(b);
  assert.deepEqual(await tunnels.routesFor(a), [
    { url: 'http://127.0.0.1:31001', channel: 'tunnel' }, { url: 'http://127.0.0.1:31002', channel: 'p2p' },
  ]);
  assert.equal(f.controls.length, 2);
  assert.deepEqual(f.controls[0].payload.p2p.candidates, []);
  assert.ok(f.controls[1].payload.p2p.candidates.length);
  assert.equal(f.controls[1].payload.op, 'tunnels.refresh');
  assert.doesNotMatch(JSON.stringify(f.controls), /private|T1-secret/);
  f.setCandidates(['203.0.113.2:49000', '192.168.1.8:49000']);
  await tunnels.routesFor(a);
  assert.equal(f.controls.length, 2, '仅顺序改变不能重建');
  assert.equal(f.calls.filter(item => item.command === 'remoteP2PStart').length, 1);
  await tunnels.routesFor(b);
  assert.notEqual(f.records.get('a').tunnelKeys.p2pPrivateKey, f.records.get('b').tunnelKeys.p2pPrivateKey);
  assert.notEqual(f.records.get('a').tunnelKeys.tailcatPrivateKey, f.records.get('b').tunnelKeys.tailcatPrivateKey);
  await tunnels.closeAll();
});

test('网络刷新和停止只清当前设备，长期密钥保留', async () => {
  const f = fixture();
  const tunnels = createRemoteTunnels(f);
  const a = f.binding('a'); const b = f.binding('b');
  await f.store.put(a); await f.store.put(b);
  await tunnels.routesFor(a); await tunnels.routesFor(b);
  const keys = { ...f.records.get('a').tunnelKeys };
  f.stopped.length = 0;
  await tunnels.refresh(a);
  assert.deepEqual(f.stopped, ['a']);
  assert.deepEqual(f.records.get('a').tunnelKeys, keys);
  const starts = f.calls.filter(item => item.command === 'remoteP2PStart').length;
  await tunnels.routesFor(b);
  assert.equal(f.calls.filter(item => item.command === 'remoteP2PStart').length, starts);
  await tunnels.close('a');
  assert.deepEqual(f.stopped, ['a', 'a']);
  await tunnels.closeAll();
});

test('已认证的吊销与过期向上传播，旧助手不阻断基础线路', async () => {
  for (const code of ['REMOTE_REVOKED', 'REMOTE_EXPIRED']) {
    const f = fixture();
    f.transport.callRemoteControl = async () => { throw Object.assign(new Error('denied'), { code }); };
    const tunnels = createRemoteTunnels(f);
    const a = f.binding('a');
    await assert.rejects(tunnels.routesFor(a), error => error.code === code);
    assert.equal(a.routes.length, 1);
    await tunnels.closeAll();
  }
  const f = fixture();
  f.helper.request = async () => { throw new Error('remote-helper-unsupported'); };
  const tunnels = createRemoteTunnels(f);
  assert.deepEqual(await tunnels.routesFor(f.binding('a')), []);
  await tunnels.closeAll();
});

test('户外会合覆盖中转，错误身份继续换路，正常原生启动有足够预算', async () => {
  const f = fixture();
  const call = f.transport.callRemoteControl;
  const attempted = [];
  f.transport.callRemoteControl = async (binding, route, payload, options) => {
    attempted.push(route.channel);
    assert.ok(options.timeoutMs >= 12000);
    if (route.channel !== 'relay') throw Object.assign(new Error('wrong instance'), { code: 'REMOTE_AUTH' });
    return call(binding, route, payload);
  };
  const a = f.binding('a');
  a.routes = [
    { url: 'http://192.168.1.2:1234', channel: 'lan' },
    { url: 'http://10.0.0.1:1234', channel: 'direct' },
    { url: 'https://relay.test/prefix', channel: 'relay' },
  ];
  const tunnels = createRemoteTunnels(f);
  assert.equal((await tunnels.routesFor(a)).length, 2);
  assert.deepEqual(attempted.slice(0, 2), ['lan', 'relay']);
  await tunnels.closeAll();
});

test('Tailcat 失败仍保留 P2P，拒绝助手提供的非回环地址', async () => {
  const f = fixture();
  const request = f.helper.request;
  f.helper.request = async (command, fields) => {
    if (command === 'remoteTailcatStart') throw new Error('unavailable');
    return request(command, fields);
  };
  const tunnels = createRemoteTunnels(f);
  assert.deepEqual(await tunnels.routesFor(f.binding('a')), [{ url: 'http://127.0.0.1:31002', channel: 'p2p' }]);
  await tunnels.closeAll();
  f.helper.request = async (command, fields) => command === 'remoteP2PStart' ? { url: 'http://example.com:31002' } : request(command, fields);
  const other = createRemoteTunnels(f);
  assert.deepEqual(await other.routesFor(f.binding('a')), [{ url: 'http://127.0.0.1:31001', channel: 'tunnel' }]);
  await other.closeAll();
});

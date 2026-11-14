'use strict';
// 验证绑定凭据进入宿主记录、缺存储时报错，以及并发更新不覆盖其他密钥。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteStore, PREFIX } = require('../lib/remote/store.cjs');
function provider() {
  const records = new Map();
  let queue = Promise.resolve();
  return {
    records,
    readRecord: async key => records.get(key),
    listRecords: async () => [...records.keys()].map(key => ({ key, kind: 'grant' })),
    deleteRecord: async key => { records.delete(key); },
    modifyRecord(key, fn) {
      const job = queue.then(async () => { const next = await fn(records.get(key)); if (next) records.set(key, next); });
      queue = job.catch(() => {});
      return job;
    },
  };
}
test('绑定存入专属grant记录，重新创建store仍可读取且删除只影响该设备', async () => {
  const credentials = provider();
  const store = createRemoteStore({ credentials });
  const row = { instanceId: 'hostA', credential: 'private-token', deviceKey: 'private-key', name: '家里电脑' };
  await store.put(row);
  await store.put({ instanceId: 'hostB', credential: 'other' });
  assert.equal(credentials.records.get(PREFIX + Buffer.from('hostA').toString('hex')).kind, 'grant');
  assert.match([...credentials.records.keys()][0], /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/);
  const reloaded = createRemoteStore({ credentials });
  assert.equal((await reloaded.get('hostA')).credential, 'private-token');
  const copy = await reloaded.get('hostA');
  copy.deviceKey = 'changed';
  assert.equal((await store.get('hostA')).deviceKey, 'private-key');
  await store.delete('hostA');
  assert.deepEqual((await store.list()).map(item => item.id), ['hostB']);
});
test('并发局部更新在宿主独占写入中合并，不丢失隧道密钥或线路档位', async () => {
  const store = createRemoteStore({ credentials: provider() });
  await store.put({ instanceId: 'hostA', credential: 'secret' });
  await Promise.all([
    store.update('hostA', () => ({ mode: 'relay' })),
    store.update('hostA', () => ({ tunnelKeys: { p2pPrivateKey: 'private' } })),
  ]);
  assert.deepEqual(await store.get('hostA'), {
    instanceId: 'hostA', id: 'hostA', credential: 'secret', mode: 'relay', tunnelKeys: { p2pPrivateKey: 'private' },
  });
});
test('宿主凭据服务不可用时不回退明文文件，非法设备标识不能构造其他scope', async () => {
  const store = createRemoteStore({ credentials: null });
  await assert.rejects(store.put({ instanceId: 'hostA' }), { code: 'credentials-unavailable' });
  const good = createRemoteStore({ credentials: provider() });
  await assert.rejects(good.get('../other/secret'), /标识/);
});

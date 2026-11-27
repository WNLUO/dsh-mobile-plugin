'use strict';
// 绑定落到插件自己的本地文件：重开可读、并发更新不丢其他字段，非法标识进不了文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRemoteStore } = require('../lib/remote/store.cjs');

function fileOf() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-store-')), 'remote-computers.json');
}

test('绑定存入本地文件，重新创建 store 仍可读取且删除只影响该设备', async () => {
  const file = fileOf();
  const store = createRemoteStore({ file });
  const row = { instanceId: 'hostA', name: '家里电脑', tunnelKeys: { p2pPrivateKey: 'private' } };
  await store.put(row);
  await store.put({ instanceId: 'hostB', name: '公司电脑' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.bindings.hostA.kind !== undefined, false);
  assert.equal(raw.bindings.hostA.name, '家里电脑');
  const reloaded = createRemoteStore({ file });
  assert.equal((await reloaded.get('hostA')).name, '家里电脑');
  const copy = await reloaded.get('hostA');
  copy.tunnelKeys.p2pPrivateKey = 'changed';
  assert.equal((await store.get('hostA')).tunnelKeys.p2pPrivateKey, 'private');
  await store.delete('hostA');
  assert.deepEqual((await store.list()).map((item) => item.id), ['hostB']);
});

test('并发局部更新串行合并，不丢失隧道密钥或线路档位', async () => {
  const store = createRemoteStore({ file: fileOf() });
  await store.put({ instanceId: 'hostA', name: 'A' });
  await Promise.all([
    store.update('hostA', () => ({ mode: 'relay' })),
    store.update('hostA', () => ({ tunnelKeys: { p2pPrivateKey: 'private' } })),
  ]);
  assert.deepEqual(await store.get('hostA'), {
    instanceId: 'hostA', id: 'hostA', name: 'A', mode: 'relay', tunnelKeys: { p2pPrivateKey: 'private' },
  });
});

test('文件损坏时不拿空库覆盖，非法设备标识不能构造其他 scope', async () => {
  const file = fileOf();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const store = createRemoteStore({ file });
  await assert.rejects(store.put({ instanceId: 'hostA' }), { code: 'remote-store-corrupt' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  const clean = createRemoteStore({ file: fileOf() });
  await assert.rejects(clean.get('../other/secret'), /标识/);
});

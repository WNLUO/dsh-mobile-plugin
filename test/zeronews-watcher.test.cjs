// ZeroNews 线路观察器：插件自己读本机隧道，变了才写状态；读失败保留现有线路。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createZeroNewsWatcher } = require('../lib/zeronews/watcher.cjs');

function harness({ initial = '', result = { ok: true, urls: [], available: true, error: '' } } = {}) {
  const state = { zeroNewsUrl: initial };
  const writes = [];
  const changes = [];
  const settings = { async update(patch, options) {
    writes.push({ patch, options });
    state.zeroNewsUrl = patch.zeroNewsUrl;
  } };
  const watcher = createZeroNewsWatcher({
    settings,
    getState: () => state,
    readEndpoints: async () => result,
    onChange: () => changes.push(state.zeroNewsUrl),
    intervalMs: 3_600_000,
  });
  return { state, writes, changes, watcher };
}

test('读到隧道就写独立字段，只落一次、不触发 sidecar 重配', async () => {
  const url = 'https://abc.takin.cc';
  const h = harness({ result: { ok: true, urls: [url], available: true, error: '' } });
  await h.watcher.refresh();
  assert.deepEqual(h.writes, [{ patch: { zeroNewsUrl: url }, options: { notify: false } }]);
  assert.deepEqual(h.changes, [url]);
  await h.watcher.refresh();
  assert.equal(h.writes.length, 1, '地址没变不重复写');
});

test('本机回应但没有隧道时清空这一格，让手机撤销线路', async () => {
  const h = harness({ initial: 'https://old.takin.cc' });
  await h.watcher.refresh();
  assert.equal(h.state.zeroNewsUrl, '');
  assert.deepEqual(h.changes, ['']);
});

test('本机客户端连不上或读失败时保留现有线路', async () => {
  const existing = 'https://still.takin.cc';
  for (const result of [
    { ok: false, urls: [], available: false, error: 'not installed' },
    { ok: false, urls: [], available: true, error: 'business error' },
  ]) {
    const h = harness({ initial: existing, result });
    await h.watcher.refresh();
    assert.equal(h.writes.length, 0);
    assert.equal(h.state.zeroNewsUrl, existing);
  }
});

test('多条隧道只取第一条；start/stop 不留下定时器', async () => {
  const h = harness({ result: { ok: true, urls: ['https://first.takin.cc', 'https://second.takin.cc'], available: true, error: '' } });
  h.watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.zeroNewsUrl, 'https://first.takin.cc');
  h.watcher.stop();
  const before = h.writes.length;
  await h.watcher.refresh();
  assert.equal(h.writes.length, before, 'stop 之后不再写');
});

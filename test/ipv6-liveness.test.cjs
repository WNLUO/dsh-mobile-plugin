'use strict';
// IPv6 候选本机活性预筛：短超时 TCP 探针 + TTL 缓存，同步过滤已知死地址。
const test = require('node:test');
const assert = require('node:assert/strict');
const liveness = require('../lib/relay/ipv6-liveness.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('parseHostPort 解析 IPv6 方括号与端口、端口缺失返回 null', () => {
  assert.deepEqual(liveness.parseHostPort('http://[240e:338::1]:49906'), { host: '240e:338::1', port: 49906 });
  assert.deepEqual(liveness.parseHostPort('http://192.168.1.5:49906'), { host: '192.168.1.5', port: 49906 });
  assert.equal(liveness.parseHostPort('http://[240e:338::1]'), null);
  assert.equal(liveness.parseHostPort(''), null);
});

test('连不上的判死并从候选里过滤，TTL 到期后放出来重试', async () => {
  let now = 1_000;
  const seen = [];
  const cache = liveness.createLivenessCache({
    now: () => now,
    ttlMs: 60_000,
    retryMs: 0,
    probe: async (host, port) => { seen.push(`${host}:${port}`); return host === '240e:338::1'; },
  });
  const urls = ['http://[240e:338::1]:49906', 'http://[240e:338::2]:49906'];
  // 首轮没有结论，原样返回并起探。
  assert.deepEqual(cache.filter(urls), urls);
  await tick();
  // 第二轮：死地址被过滤，活的留下。
  assert.deepEqual(cache.filter(urls), ['http://[240e:338::1]:49906']);
  // TTL 到期后恢复（放出来重测）。
  now += 60_001;
  assert.deepEqual(cache.filter(urls), urls);
  await tick();
});

test('reset 清空结论', async () => {
  const cache = liveness.createLivenessCache({ ttlMs: 60_000, retryMs: 0, probe: async () => false });
  const urls = ['http://[240e::9]:49906'];
  cache.filter(urls);
  await tick();
  assert.equal(cache.isDead(urls[0]), true);
  cache.reset();
  assert.equal(cache.isDead(urls[0]), false);
});

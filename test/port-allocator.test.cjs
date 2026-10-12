'use strict';

/**
 * 局域网端口自愈（resolvePort）。
 *
 * 为什么值得单独钉：这个模块 0.2.0 迁移时是全新加的，当过时的只有「首选端口被占」
 * 这一个场景，而它一旦失效的表现是**手机配不上对**——`/api/relay/status` 只会说
 * lan.state='error'，和真正的原因（端口被占）隔了十万八千里。修过一次真实的
 * EADDRINUSE 之后，零测试的这段代码就成了下一个同类事故的候选。
 *
 * 注意这里测的是「内核当时的状态」，存在天然的探测—使用间隙（TOCTOU）：真绑定
 * 发生在 lan-proxy 里，它另有 EADDRINUSE 兜底。所以断言只到「给出的端口当下可绑」
 * 为止，不去假装能断言「一定绑得上」。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { canListen, freePort, resolvePort } = require('../lib/relay/port-allocator.cjs');

const HOST = '127.0.0.1';

const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, HOST, () => resolve(server));
});

const waitFor = async (fn, what) => {
  for (let i = 0; i < 60; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`超时：${what}`);
};

test('canListen：空端口为真，已被占用的端口为假', async () => {
  const free = await freePort(HOST);
  assert.ok(free > 0, 'freePort 应当给出一个端口');
  assert.equal(await canListen(free, HOST), true, `端口 ${free} 此刻应当可绑`);

  const server = await listen(0);
  const busy = server.address().port;
  try {
    assert.equal(await canListen(busy, HOST), false, `端口 ${busy} 正被本进程占着，应当判为不可用`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolvePort：首选端口空闲时就用它，并如实说没调整过', async () => {
  const free = await freePort(HOST);
  const r = await resolvePort(free, HOST);
  assert.deepEqual(r, { port: free, adjusted: false, requested: free });
});

test('resolvePort：首选端口被占时换一个，并如实说调整过', async () => {
  const server = await listen(0);
  const busy = server.address().port;
  try {
    const r = await resolvePort(busy, HOST);
    assert.equal(r.requested, busy, 'requested 必须保留原始请求值，配对二维码与状态里都要靠它对账');
    assert.equal(r.adjusted, true, '换了端口就必须说调整过——这个标记会透到 /api/relay/status');
    assert.notEqual(r.port, busy, '不应当返回那个正被占用的端口');
    assert.ok(r.port > 1024 && r.port <= 65535);
    assert.equal(await canListen(r.port, HOST), true, '换出来的端口应当确实可绑');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolvePort：非法请求值一律回落到默认端口 18787', async () => {
  for (const bad of [0, -1, 80, 1023, 65536, 99999, NaN, '53520', null, undefined, 1.5]) {
    const r = await resolvePort(bad, HOST);
    assert.equal(r.requested, 18787, `${JSON.stringify(bad)} 应当回落到 18787，实际 requested=${r.requested}`);
  }
});

test('resolvePort：合法边界值照单全收，不被默认值吞掉', async () => {
  for (const edge of [1024, 65535]) {
    const server = await listen(edge);
    try {
      const r = await resolvePort(edge, HOST);
      assert.equal(r.requested, edge, `${edge} 是合法端口，不该被换成默认值`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('freePort 给出的端口在被拿到之前一直是可用的', async () => {
  // 连续取几次，模拟调用方拿着端口去真绑定的那一下。
  for (let i = 0; i < 3; i += 1) {
    const port = await freePort(HOST);
    assert.ok(port > 0, '应当拿到有效端口');
    const server = await listen(port);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('真实场景：18787 被占时 resolvePort 不该把服务拖死', async () => {
  const server = await listen(18787).catch(() => null);
  // 18787 常常被别的服务占着（这台开发机就被 billion-context 占过），所以这里只断言
  // 「无论它是否已被占用，resolvePort 都必须给出一个当下可绑的端口」——这正是 lan-proxy
  // 拿不到就回退 bind(0) 的那套逻辑所依赖的保证。
  const r = await resolvePort(18787, HOST);
  assert.equal(r.requested, 18787);
  assert.ok(r.port > 0, '无论如何都要给出一个端口');
  await waitFor(async () => r.adjusted || (await canListen(r.port, HOST)), '给出的端口应当可绑');
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('resolvePort：自己正绑着的端口不算「被占」——原样保留，连试绑都不做', async () => {
  // 这条钉的是 2026-10-11 的真机故障。局域网代理绑上首选端口之后，任何一次重新解析都会
  // 把这个**自己占着**的端口判成「被占」，换一个内核随手给的空闲端口回传；调用方再把它
  // 写回 relay.json——监听没动、落盘端口却一路漂（现场：18787→22779→33091→17079），
  // 平时看不出来，下次重启按漂过的值绑，手机里存的地址就废了。触发点还不止同步：
  // 面板上「看一眼二维码」那条只读路由也会解析一次端口。
  const server = await listen(0);
  const ours = server.address().port;
  try {
    const r = await resolvePort(ours, HOST, { ours });
    assert.deepEqual(
      r,
      { port: ours, adjusted: false, requested: ours, ours: true },
      '这个号是我们自己占着的，应当原样保留并如实说「是我的」，而不是换号',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolvePort：ours 只对号入座，对不上就照旧探测', async () => {
  const server = await listen(0);
  const busy = server.address().port;
  try {
    for (const ours of [0, undefined, busy + 1]) {
      const r = await resolvePort(busy, HOST, { ours });
      assert.equal(r.adjusted, true, `ours=${ours} 不应当把被占的 ${busy} 认成自己的`);
      assert.notEqual(r.port, busy);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

'use strict';

/**
 * 自检台账要的三个数必须真的从 worker 报上来（2026-10-19 宿主内存事故的配套）。
 *
 * 为什么单独有一条端到端守卫：台账取数走的是**宿主侧注入的取值器**，谁都能把它接到一条
 * 不存在的路径上——那样字段永远是 null、`unavailable` 里挂一条说明，界面看着「有台账」
 * 却一个真值都没有（`desktop-half-stats.cjs` 的文件头管这叫「比没有台账更误导人」）。
 * 本用例起**真实的 sidecar facade worker**：
 *   1) `/status` 必须带 `process.memoryUsage` 与 `streams.{lan,relaySseOpen}`（0 就是 0，不是 null）；
 *   2) 手机真的挂一条 SSE 时 `streams.lan` 必须涨到 1，断开必须落回 0——这一条同时钉住
 *      「上游随手机断开被拆」与「计数只涨不落」两件事；
 *   3) 台账读这一份快照时那个字段必须真出数，而不是落进 `unavailable`。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

process.env.DEVICE_CREDENTIALS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selfcheck-')), 'relay-device-credentials.json');

const { SidecarFacade } = require('../lib/sidecar-facade.cjs');
const { createSelfCheck } = require('../lib/mobile/self-check.cjs');
const core = require('../lib/relay/core.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** 假宿主：SSE 路径永不结束（模拟宿主的长流），其余 404。 */
function startUpstream() {
  const server = http.createServer((req, res) => {
    const isSse = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
    if (!isSse) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': pad\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function openSse(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: '/api/mobile/v1/thing/stream',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    }, (res) => {
      res.on('error', () => {});
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
    req.end();
    const timer = setTimeout(() => reject(new Error('局域网 SSE 没有开始推流')), 5000);
    timer.unref();
  });
}

;(async () => {
  const upstream = await startUpstream();
  const lanPort = await freePort();
  const instanceId = 'selfcheck1';
  const lanSecret = randomBytes(32).toString('hex');
  const facade = new SidecarFacade({ parentPort: upstream.port, token: randomBytes(32).toString('hex') });
  const baseConfig = {
    enabled: true,
    relayUrl: '',                       // 纯局域网模式：隧道不建，中转路那个数必须是 0 而不是 null
    instanceId,
    pairingCode: '123456',
    name: 'SelfCheck Test',
    upstreamPort: upstream.port,
    lanPort,
    lanEnabled: true,
    lanSecret,
  };

  try {
    await facade.start();
    await facade.configure(baseConfig);
    await waitFor(
      async () => (await facade.request('/status'))?.lan?.state === 'listening',
      8000,
      '局域网代理没起来',
    );

    // --- 1. 三个数都在，且「没有流」报 0 而不是 null ---
    const idle = await facade.request('/status');
    assert.equal(Number.isFinite(idle.process?.memoryUsage?.rss), true,
      `侧车自己的内存必须上报，实际 ${JSON.stringify(idle.process)}`);
    assert.equal(Number.isFinite(idle.process.memoryUsage.heapUsed), true);
    assert.deepEqual(idle.streams?.lan, { upstreamOpen: 0, sseOpen: 0 },
      '没有手机连接时局域网流数应是 0/0（null 表示「不知道」，两者不能混）');
    assert.equal(idle.streams?.relaySseOpen, 0, '纯局域网模式（没有隧道）中转路必须是 0');

    // --- 2. 手机挂一条 SSE：计数必须跟着涨，断开必须落回 ---
    const token = core.signLanToken(lanSecret, instanceId, core.MOBILE_TOKEN_TTL_SEC || 3600);
    const stream = await openSse(lanPort, token);
    await waitFor(async () => (await facade.request('/status'))?.streams?.lan?.sseOpen === 1, 4000,
      `手机挂上 SSE 之后 sseOpen 应变成 1，实际 ${JSON.stringify((await facade.request('/status'))?.streams)}`);
    const busy = await facade.request('/status');
    assert.deepEqual(busy.streams.lan, { upstreamOpen: 1, sseOpen: 1 });

    stream.res.destroy();
    await waitFor(async () => (await facade.request('/status'))?.streams?.lan?.upstreamOpen === 0, 4000,
      `手机断开后上游必须被拆、计数必须落回 0，实际 ${JSON.stringify((await facade.request('/status'))?.streams)}`);

    // --- 3. 台账读这份快照时必须真出数，而不是落进 unavailable ---
    const status = await facade.request('/status');
    const selfCheck = createSelfCheck({
      getSidecarSnapshot: () => status,
      getLanProxyStats: () => status.streams?.lan ?? null,
    });
    const snapshot = selfCheck.snapshot();
    assert.equal(typeof snapshot.streams.lanUpstreamOpen, 'number', '台账里的局域网流数必须是真值');
    assert.equal(typeof snapshot.streams.relaySseOpen, 'number', '台账里的中转路流数必须是真值');
    assert.equal(typeof snapshot.sidecarProcess.memory?.rss, 'number', '台账里的侧车内存必须是真值');
    // 只钉这三条通道：镜像与凭据库在本用例里刻意没有注入（没有 ctx、没有凭据包），
    // 那两条本来就该落进 unavailable——本用例管的是「worker 报上来的那三个数」。
    const blocked = snapshot.unavailable.filter((line) => /sidecarProcess\.memory|streams\.relaySseOpen|streams\.lanUpstreamOpen/.test(line));
    assert.deepEqual(blocked, [], `这三条通道都该通，不该落进 unavailable：${JSON.stringify(blocked)}`);

    // --- 4. 契约面：宿主侧那根线必须接在快照的这个路径上（改了任一端都要红） ---
    const impl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'impl.js'), 'utf8');
    assert.match(impl, /getLanProxyStats:\s*\(\)\s*=>\s*sidecarLifecycle\.getSnapshot\(\)\?\.streams\?\.lan\s*\?\?\s*null/,
      '装配层必须把 lan-proxy 的 stats() 从侧车快照的 streams.lan 带出来，接到别处等于台账永远空');
    assert.match(impl, /getSidecarSnapshot:\s*sidecarLifecycle\.getSnapshot/,
      '台账读侧车快照必须走 sidecarLifecycle.getSnapshot');

    console.log('self-check wiring tests passed');
  } finally {
    await facade.stop();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

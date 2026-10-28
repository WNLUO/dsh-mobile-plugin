'use strict';

/**
 * 插件版本上报与「被中转按版本挡下来」这一档。
 *
 * 中转手里有一个「最低可接受插件版本」（默认空＝不拦）。要让它成立，两头各钉一件事：
 *
 *  1. **注册帧必须带 `version`**。不带的话中转只能把每台都当成「未知」，门槛形同虚设，
 *     而且老版本只要不报就永远拦不住。
 *  2. **被拒之后不许按 5 秒退避重连**。门槛不会因为多敲几次就降下来，而强制打开那天所有
 *     老宿主一起敲，会把中转的握手和日志刷满。这一档单独走三十分钟，状态也另立成
 *     `outdated`，面板与手机才能显示「去更新插件」而不是「连接断开」。
 *
 * 跑法：`node dsh-mobile-plugin/test/plugin-version-gate.test.cjs`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');

const { SidecarFacade } = require('../lib/sidecar-facade.cjs');
const { T, jsonFrame, createFrameDecoder, parseJson } = require('../lib/relay/protocol.js');
const { createReconnectScheduler } = require('../lib/reconnect-scheduler.cjs');

const { version: PLUGIN_VERSION } = require('../package.json');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
};

/**
 * 假中转：收到 register 记一份，然后按 `reject` 决定是回 registered 还是回一条
 * wsError（id=0）再断开。`connections` 用来数「宿主又连了几次」。
 */
async function startRig({ reject = null } = {}) {
  const parent = http.createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));

  const registers = [];
  let connections = 0;
  const relay = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: relay });
  wss.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (data) => {
      const push = createFrameDecoder((frame) => {
        if (frame.type !== T.register) return;
        registers.push(parseJson(frame.payload));
        if (reject) {
          setTimeout(() => {
            try { ws.send(jsonFrame(T.wsError, 0, reject)); } catch { /* ignore */ }
            try { ws.close(); } catch { /* ignore */ }
          }, 20);
          return;
        }
        setTimeout(() => { try { ws.send(jsonFrame(T.registered, 0, {})); } catch { /* ignore */ } }, 20);
      });
      push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));

  const facade = new SidecarFacade({ parentPort: parent.address().port, token: randomBytes(32).toString('hex') });
  await facade.start();
  await facade.configure({
    enabled: true,
    relayUrl: `http://127.0.0.1:${relay.address().port}`,
    instanceId: 'i-version',
    pairingCode: '123456',
    name: 'Version',
    upstreamPort: 12345,
    lanPort: 18791,
    lanEnabled: false,
    lanSecret: randomBytes(32).toString('hex'),
  });
  return {
    facade,
    registers,
    connections: () => connections,
    stop: async () => {
      await facade.stop();
      await new Promise((resolve) => relay.close(resolve));
      await new Promise((resolve) => parent.close(resolve));
    },
  };
}

test('注册帧带上插件版本（中转的版本门槛只认这一处）', async () => {
  const rig = await startRig();
  try {
    await waitFor(() => rig.registers.length > 0, 5000, '中转应收到 register');
    assert.equal(rig.registers[0].version, PLUGIN_VERSION, '版本号必须与包自己的 package.json 一致');
    assert.ok(/^\d+\.\d+\.\d+$/.test(rig.registers[0].version), `版本号要能逐段比：${rig.registers[0].version}`);
    assert.ok(rig.registers[0].instanceId, '原有字段一个都不许丢');
  } finally {
    await rig.stop();
  }
});

test('中转回「插件太旧」：状态另立成 outdated，且不落进 5 秒重连循环', async () => {
  const rig = await startRig({
    reject: { code: 'plugin_too_old', message: '插件 0.4.7 太旧，至少要 0.5.0', retryAfterMs: 1800000 },
  });
  try {
    await waitFor(async () => (await rig.facade.request('/status')).tunnel.state === 'outdated', 5000, '被拒之后状态应为 outdated');
    const status = await rig.facade.request('/status');
    assert.match(String(status.tunnel.error || ''), /太旧|更新/, '状态里要能看见「去更新插件」这句话');

    // 5 秒退避会在 5～7 秒内再来一条连接。等 7 秒，连接数必须还是一。
    const before = rig.connections();
    await delay(7000);
    assert.equal(rig.connections(), before, '被版本挡住时不许按 5 秒退避反复撞门');
  } finally {
    await rig.stop();
  }
});

test('重连调度器支持一次性指定间隔（版本过旧那条路要用三十分钟档）', async () => {
  const waits = [];
  const scheduler = createReconnectScheduler({
    delayMs: 5000,
    jitterMs: 0,
    maxDelayMs: 30000,
    onFire: () => {},
    setTimer: (fn, ms) => { waits.push(ms); return { fn, ms }; },
    clearTimer: () => {},
  });
  scheduler.schedule(1800000);
  assert.deepEqual(waits, [1800000], '指定间隔要原样用上，不被 5s 起步的退避或 30s 上限改写');
  scheduler.cancel();
  scheduler.schedule();
  assert.deepEqual(waits, [1800000, 5000], '不指定时仍是原来的退避口径');
});

test('源码口径：版本号只从包自己的 package.json 读，别另立一份', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'relay', 'tunnel.js'), 'utf8');
  assert.match(source, /require\('\.\.\/\.\.\/package\.json'\)/, '版本只有一个来源：包自己的 package.json');
  assert.match(source, /version: PLUGIN_VERSION/, '注册帧里要带上它');
});

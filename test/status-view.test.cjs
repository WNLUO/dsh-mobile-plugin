'use strict';

/**
 * 状态视图（lib/relay/status.js）的单元测试。
 *
 * 这块以前是 apply() 闭包里的一坨内联函数，插件测试**从不加载 lib/index.js**，只把它当
 * 源码文本读——所以 status() 的字段拼装从来没有被真正执行过一次。抽出来之后可以直接
 * require 真模块跑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeTunnel, hostMetadata, createStatusView, TUNNEL_ADMISSION } = require('../lib/relay/status.js');

const baseDeps = (overrides = {}) => ({
  state: { enabled: true, instanceId: 'inst-1', pairingCode: 'CODE', relayUrl: 'wss://relay.example', name: '桌机', pairingPolicy: 'code', lanPort: 18787 },
  webServerPort: 3080,
  getSidecarSnapshot: () => ({ tunnel: { state: 'connected', error: null }, lan: { state: 'up', lanUrl: 'http://192.168.1.9' } }),
  lanPortInUse: () => 18788,
  getLanPortAdjusted: () => true,
  getSidecarState: () => 'healthy',
  getSidecarRestarts: () => 3,
  getSidecarRestartedAt: () => 1700000000000,
  getSidecarRestartError: () => null,
  getMirrorPush: () => ({ pushedAt: 42, ok: true, error: null }),
  ...overrides,
});

test('describeTunnel 只在真错误里补判定，正常状态原样返回', () => {
  assert.deepEqual(describeTunnel({ state: 'connected', error: null }), { state: 'connected', error: null });
  assert.deepEqual(describeTunnel(undefined), { state: 'off', error: null });
  const errored = describeTunnel({ state: 'error', error: '隧道关闭: 1008 bad registration secret' });
  assert.equal(errored.registerSecretRequired, true);
  assert.equal(errored.admissionHint, 'register-secret');
  assert.equal(describeTunnel({ state: 'error', error: 'unknown instance' }).instanceNotAllowed, true);
  // 认词不认字母：中转写 'bad registration secret'，库内写 'bad register secret'，两种都要命中。
  assert.equal(TUNNEL_ADMISSION[0].pattern.test('bad register secret'), true);
  assert.equal(TUNNEL_ADMISSION[0].pattern.test('bad registXYZ secret'), true);
  // 非准入类错误不该被硬塞一个提示。
  const other = describeTunnel({ state: 'error', error: 'ECONNREFUSED' });
  assert.equal(other.admissionHint, undefined);
  assert.equal(other.registerSecretRequired, undefined);
});

test('status() 的身份字段来自内存 state 与本进程端口', () => {
  const status = createStatusView(baseDeps())();
  assert.equal(status.instanceId, 'inst-1');
  assert.equal(status.pairingCode, 'CODE');
  assert.equal(status.relayUrl, 'wss://relay.example');
  assert.equal(status.name, '桌机');
  assert.equal(status.localPort, 3080);
  assert.equal(status.pairingPolicy, 'code');
  assert.equal(status.platform, process.platform);
});

test('status() 的 lan 段以本进程解析出的实际端口为准', () => {
  const lan = createStatusView(baseDeps())().lan;
  // 快照里的 lan 没有 port（要 listen 之后才拿得到），status 必须填 inUse() 的值，
  // 否则状态接口与二维码会报出两个不同的端口。
  assert.equal(lan.port, 18788);
  assert.equal(lan.requestedPort, 18787);
  assert.equal(lan.adjusted, true);
  assert.equal(lan.lanUrl, 'http://192.168.1.9');
});

test('status() 如实区分「哪一层能重启」', () => {
  const sidecar = createStatusView(baseDeps())().sidecar;
  assert.deepEqual(sidecar.scope, { worker: 'restartable', facade: 'restartable', host: 'needs-host-restart' });
  assert.equal(sidecar.restarts, 3);
  assert.equal(sidecar.restartedAt, 1700000000000);
  assert.equal(sidecar.restartError, null);
});

test('status() 的镜像段与未推送时的默认值', () => {
  assert.deepEqual(createStatusView(baseDeps())().mirror, { pushedAt: 42, ok: true, error: null });
  const never = createStatusView(baseDeps({ getMirrorPush: () => ({ pushedAt: 0, ok: null, error: '未推送' }) }))().mirror;
  assert.deepEqual(never, { pushedAt: 0, ok: null, error: '未推送' });
});

test('state 被 applySidecarConfig 整体替换后，状态视图读到的必须是新快照', () => {
  // 这就是 getSidecarSnapshot 必须传取值器的原因：传对象会让连接信息永远停在
  // 进程启动那一刻，手机端看 lan.updatedAt 像失联了一样。
  let snapshot = { tunnel: { state: 'off', error: null }, lan: { state: 'off', updatedAt: 1 } };
  const status = createStatusView(baseDeps({ getSidecarSnapshot: () => snapshot }));
  assert.equal(status().lan.updatedAt, 1);
  snapshot = { tunnel: { state: 'connected', error: null }, lan: { state: 'up', updatedAt: 2 } };
  assert.equal(status().lan.updatedAt, 2, '换了快照后再调一次必须读到新的');
});

test('hostMetadata 只有一个版本来源（包自己的 package.json）', () => {
  const meta = hostMetadata();
  assert.equal(meta.appVersion, require('../package.json').version);
  assert.equal(meta.osVersion, require('node:os').release());
});
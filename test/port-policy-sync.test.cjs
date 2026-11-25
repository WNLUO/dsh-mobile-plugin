// 固定入口、原端口短暂重试与自动换号接线的行为及变异验证。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { lanPortLockReason } = require('../lib/relay/lan-port-policy.cjs');
const { bindLanEndpoint } = require('../lib/relay/lan-discovery.cjs');
const occupied = () => Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
function fixture(lockReason = '') {
  const attempts = []; const waited = []; const published = [];
  let failures = Infinity;
  return { attempts, waited, published, fail: count => { failures = count; }, args: {
    requestedPort: 18787, lockReason, instanceId: 'host',
    store: { listActive: () => [{ instanceId: 'host', lanDiscovery: 1 }] },
    wait: async delay => { waited.push(delay); },
    discovery: { publish: async port => { published.push(port); return true; }, stop: async () => {} },
    createProxy(port) { attempts.push(port); return {
      start: async () => { if (port && failures-- > 0) throw occupied(); },
      stop: async () => {}, port: () => port || 23456,
    }; },
  } };
}

test('显式固定、穿透配置和手填固定地址自动锁定，普通中转不锁', () => {
  assert.equal(lanPortLockReason({ lanPortFixed: true }), 'fixed');
  assert.equal(lanPortLockReason({}, true), 'forwarding');
  for (const key of ['manualLanUrl', 'manualIpv6Url', 'manualTcpUrl']) {
    assert.equal(lanPortLockReason({ [key]: 'fixed.example:18787' }), 'forwarding');
  }
  assert.equal(lanPortLockReason({ relayUrl: 'https://relay.example' }), '');
});

test('固定开关与手机端口配置共用严格校验且默认不锁定', () => {
  const { configPatch, configView } = require('../lib/mobile/relay-control.js');
  const { configOf } = require('../lib/relay/config-store.js');
  assert.equal(configOf({}).lanPortFixed, false);
  assert.equal(configView({}).lanPortFixed, false);
  assert.deepEqual(configPatch({ lanPortFixed: true }).patch, { lanPortFixed: true });
  assert.equal(configPatch({ lanPortFixed: 'true' }).ok, false);
});

test('临时占用先重试同端口；仍占用且可发现时才随机换号', async () => {
  const transient = fixture(); transient.fail(1);
  assert.equal((await bindLanEndpoint(transient.args)).port, 18787);
  assert.deepEqual(transient.attempts, [18787, 18787]);
  assert.deepEqual(transient.waited, [250]);
  const permanent = fixture();
  assert.equal((await bindLanEndpoint(permanent.args)).port, 23456);
  assert.deepEqual(permanent.attempts, [18787, 18787, 18787, 0]);
  assert.deepEqual(permanent.waited, [250, 750]);
  assert.deepEqual(permanent.published, [23456]);
});

async function assertFixed(bind) {
  for (const reason of ['fixed', 'forwarding']) {
    const f = fixture(reason);
    await assert.rejects(bind(f.args), /未自动换端口/);
    assert.deepEqual(f.attempts, [18787, 18787, 18787]);
    assert.deepEqual(f.published, []);
  }
}
test('固定入口即使全部手机支持发现也不自动漂移', async () => { await assertFixed(bindLanEndpoint); });

test('变异：去掉固定入口保护会被同一断言拒绝', async () => {
  const file = path.join(__dirname, '../lib/relay/lan-discovery.cjs');
  const source = fs.readFileSync(file, 'utf8').replace('if (lockReason) throw', 'if (false && lockReason) throw');
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', source)(createRequire(file), loaded, loaded.exports);
  await assert.rejects(assertFixed(loaded.exports.bindLanEndpoint), { code: 'ERR_ASSERTION' });
});

test('固定开关进配置但不重建健康监听，实际监听状态驱动总控与穿透', () => {
  const impl = fs.readFileSync(path.join(__dirname, '../lib/impl.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '../lib/sidecar-facade-worker.cjs'), 'utf8');
  // 监听状态变化时才同步：总控报地址、frp 与 cloudflare 各自同步端口。旧断言钉的是单行
  // 写法，Cloudflare 接入后 syncNetwork 变为多行且多了 cloudflare 一路，这里按现状重钉。
  // 2026-11-25：专属入口实绑端口也要在这一拍落盘（notify:false 只写盘），所以 onLanState
  // 不再是单行；判据仍是「监听状态驱动同步」，新增的那一格由下面的变异证明钉住。
  const ingressWrite = /onLanState = lan => \{[\s\S]*?lanPorts\.apply\(lan\)[\s\S]*?tunnelIngressPort: ingress[\s\S]*?syncNetwork\(\)\s*\}/;
  assert.match(impl, ingressWrite);
  // 变异：把落盘那一格抹掉，同一条守卫必须转红。
  assert.equal(ingressWrite.test(impl.replace('tunnelIngressPort: ingress', 'tunnelIngressPort: 0')), false);
  assert.match(impl, /syncNetwork = \(\) => \{[\s\S]*?control\.sync\(\)[\s\S]*?frpRunner\.syncLocalPort\?\.\(\)[\s\S]*?cloudflare\.syncLocalPort\?\.\(\)/);
  assert.match(impl, /lanPortLockReason: portLock\(\)/);
  assert.match(worker, /lockReason: config\.lanPortLockReason/);
  const signature = worker.slice(worker.indexOf('function lanSignature'), worker.indexOf('function monitorSignature'));
  assert.doesNotMatch(signature, /lanPortLockReason/);
});

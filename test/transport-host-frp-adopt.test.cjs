// FRP 传输主机：换代按「实现指纹」沿用或换新 —— 只影响 FRP 一条线路，DSH 不重启。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/** 造一个够 installTransportHosts 跑起来的最小 ctx。 */
function fakeCtx() {
  const services = {};
  const effects = [];
  return {
    services,
    effects,
    ctx: {
      logger: { warn() {}, info() {}, debug() {} },
      reflect: { provide: (name, obj) => { services[name] = obj; } },
      effect: (fn, label) => { effects.push({ fn, label }); return () => {}; },
      get: () => null,
      webServer: { port: 19387, register: () => () => {}, registerUpgrade: () => () => {} },
    },
  };
}

test('FRP：指纹不变沿用同一个 runner，指纹变了才换新', async () => {
  const { installTransportHosts } = await import('../lib/shell/transport-host.js');
  const { services, ctx } = fakeCtx();
  installTransportHosts(ctx);
  const frp = services.dshMobileTransportFrp;
  assert.ok(frp, '外壳应 provide dshMobileTransportFrp');
  assert.equal(typeof frp.adopt, 'function', '外壳要暴露 adopt 给这一代交出 runner');

  const disposed = [];
  const create = ({ portOf }) => {
    const runner = { portOf, shouldAutoStart: () => false, start() {}, dispose() { disposed.push(runner); } };
    return runner;
  };

  const a = frp.adopt({ fingerprint: 'v1', create });
  assert.ok(a, '第一次 adopt 应建出 runner');
  assert.equal(frp.runner, a, 'adopt 之后外壳应持有它');

  const b = frp.adopt({ fingerprint: 'v1', create });
  assert.equal(b, a, '指纹没变必须沿用同一个 runner（换代不断 FRP）');
  assert.equal(disposed.length, 0, '沿用不能 dispose');

  const c = frp.adopt({ fingerprint: 'v2', create });
  assert.notEqual(c, a, '指纹变了要换新 runner（这条线路短暂重连）');
  assert.equal(disposed.length, 1, '换新时旧 runner 要被 dispose');
  assert.equal(frp.runner, c, '外壳持有的要换成新的那个');
});

test('frpc 实现指纹：同一份实现稳定、格式固定', () => {
  const { frpcFingerprint } = require('../lib/frpc/runner.cjs');
  const a = frpcFingerprint();
  const b = frpcFingerprint();
  assert.equal(a, b, '同一份实现两次算出的指纹必须一致，否则换代会被误判成「变了」而重连');
  assert.match(a, /^[0-9a-f]{16}$/, '指纹应是 16 位十六进制');
});

// FRP/隧道助手/点对点传输主机：换代按「实现指纹」沿用或换新 —— 只影响某一条线路，DSH 不重启。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
      // 真如实现在启动时调用 fn 拿到清理回调、返回一个「调用即清理」的 disposer —— 否则测不出 effect 有没有被收。
      effect: (fn, label) => {
        let cleanup;
        try { cleanup = fn(); } catch { cleanup = undefined; }
        effects.push({ label, cleanup });
        return () => { if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } } };
      },
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

test('三个实现指纹：改任一被 hash 的文件都必须变（漏算文件会导致「改了不生效」）', () => {
  const base = path.join(__dirname, '..');
  const frpc = require('../lib/frpc/runner.cjs');
  const tailcat = require('../lib/tailcat/wiring.cjs');
  const p2p = require('../lib/p2p/wiring.cjs');
  const p2pFp = Object.entries(p2p).find(([name]) => /Fingerprint$/.test(name))[1];
  assert.equal(typeof p2pFp, 'function', 'p2p 应导出实现指纹函数');
  const cases = [
    { label: 'frpc', fn: frpc.frpcFingerprint, dir: 'lib/frpc', files: ['runner.cjs', 'provision.cjs'] },
    { label: 'tailcat', fn: tailcat.tailcatFingerprint, dir: 'lib/tailcat', files: ['wiring.cjs', 'ingress.cjs', 'session.cjs', '../tailcat/host-process.cjs', '../relay/tunnel-forwarder.cjs'] },
    { label: 'p2p', fn: p2pFp, dir: 'lib/p2p', files: ['wiring.cjs', 'session.cjs', '../tailcat/host-process.cjs', '../relay/tunnel-forwarder.cjs'] },
  ];
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fp-'));
    try {
      for (const rel of c.files) {
        const dst = path.join(tmp, c.dir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(base, c.dir, rel), dst);
      }
      const dir = path.join(tmp, c.dir);
      const baseline = c.fn(dir);
      assert.match(baseline, /^[0-9a-f]{16}$/);
      for (const rel of c.files) {
        const file = path.join(tmp, c.dir, rel);
        const before = fs.readFileSync(file);
        fs.appendFileSync(file, '\n// mutated');
        assert.notEqual(c.fn(dir), baseline, `${c.label} 指纹没覆盖 ${rel}：改它不会触发重建`);
        fs.writeFileSync(file, before);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

function adoptSwapTest(label, serviceName) {
  test(`${label}：指纹不变沿用 door，变了重建并收掉旧 effect`, async () => {
    const { installTransportHosts } = await import('../lib/shell/transport-host.js');
    const { services, ctx } = fakeCtx();
    installTransportHosts(ctx);
    const host = services[serviceName];
    assert.ok(host && typeof host.ensure === 'function', `外壳应 provide ${serviceName}（惰性 ensure）`);

    const built = [];
    const stopped = [];
    const disposedEffects = [];
    const mount = (opts) => {
      const door = { status: () => ({ available: true }), start() {}, stop() { stopped.push(door); } };
      built.push(door);
      // 模拟 mount 内部把启停登记成 ctx.effect：清理时记录，用来验证重建确实把旧 effect 收了。
      opts.ctx.effect(() => () => { disposedEffects.push(door); }, `fake ${label} life`);
      return door;
    };

    const d1 = host.ensure({ providers: {}, mount, fingerprint: 'v1' });
    assert.equal(built.length, 1);
    const d2 = host.ensure({ providers: {}, mount, fingerprint: 'v1' });
    assert.equal(d2, d1, '指纹没变必须沿用同一个 door（换代不断直连）');
    assert.equal(built.length, 1, '沿用不得重建');
    assert.equal(disposedEffects.length, 0, '沿用不得收旧 effect');
    const d3 = host.ensure({ providers: {}, mount, fingerprint: 'v2' });
    assert.notEqual(d3, d1, '指纹变了要重建 door');
    assert.equal(built.length, 2);
    assert.ok(stopped.includes(d1), '重建时旧 door 要被 stop，不能留着旧监听');
    assert.ok(disposedEffects.includes(d1), '重建时必须把旧 door 登记的 effect 收掉，否则监听/定时器泄漏');
  });
}

adoptSwapTest('隧道助手', 'dshMobileTransportTailcat');
adoptSwapTest('点对点', 'dshMobileTransportP2P');

// ── 三条主链路：提交时才换实例；失败回滚保留旧实例，旧实例一直活到提交成功 ──
function swapHarness() {
  return import('../lib/shell/transport-host.js').then(({ installTransportHosts }) => {
    const box = fakeCtx()
    installTransportHosts(box.ctx)
    return box.services
  })
}

test('sidecar：boot 建并启动；换指纹只登记待建、不动旧实例；commit 才停旧建新起新；rollback 丢待建', async () => {
  const services = await swapHarness()
  const host = services.dshMobileSidecarHost
  const swap = services.dshMobileTransportSwap
  const made = []; const starts = []; const stops = []
  const mk = ({ token } = {}) => {
    const h = { token, started: false, sidecarToken: token, start() { this.started = true; starts.push(this) }, stop() { this.started = false; stops.push(this) }, isStarted() { return this.started }, setProviders() {}, onTunnelUp() { return () => {} }, onRouteAdopted() { return () => {} }, syncSidecar() {}, tunnelConnected: () => false, getSnapshot: () => ({}) }
    made.push(h); return h
  }
  const f1 = host.adopt({ fingerprint: 'a', create: mk })
  assert.equal(made.length, 1, 'boot 应立即建实例'); assert.equal(starts.length, 1, 'boot 应启动')
  assert.match(String(f1.sidecarToken), /^[0-9a-f]{64}$/, '门面属性应读到稳定 token')
  host.adopt({ fingerprint: 'b', create: mk })
  assert.equal(made.length, 1, '换指纹时不得在 apply 期建实例'); assert.equal(stops.length, 0, '换指纹时不得先停旧实例')
  swap.commit()
  assert.equal(made.length, 2, '提交时才建新实例'); assert.equal(stops.length, 1, '提交时才停旧实例'); assert.equal(starts.length, 2, '新实例要启动')
  host.adopt({ fingerprint: 'c', create: mk })
  assert.equal(made.length, 2, '再次换指纹仍只在提交时建')
  swap.rollback()
  assert.equal(made.length, 2, '回滚丢弃待建（不建）'); assert.equal(stops.length, 1, '回滚保留当前实例在跑')
})

test('控制上报：提交时才换客户端；待建期 setProviders 缓存，提交后用到新客户端', async () => {
  const services = await swapHarness()
  const host = services.dshMobileTransportControl
  const swap = services.dshMobileTransportSwap
  const made = []; const stops = []
  const mk = (store) => { const c = { store, started: false, start() { this.started = true }, stop() { stops.push(this) }, sync() {}, snapshot: () => ({}), targetUrl: '' }; made.push(c); return c }
  host.adopt({ fingerprint: 'a', create: mk })
  assert.equal(made.length, 1, 'boot 建客户端')
  host.setProviders({ getState: () => ({ tag: 'a' }) })
  assert.equal(made[0].started, true, 'boot 后 setProviders 应启动当前客户端')
  host.adopt({ fingerprint: 'b', create: mk })
  assert.equal(made.length, 1, '换指纹时不在 apply 期建客户端')
  host.setProviders({ getState: () => ({ tag: 'b' }) })
  assert.equal(stops.length, 0, '待建期不停止当前客户端')
  swap.commit()
  assert.equal(made.length, 2, '提交时才建新客户端'); assert.equal(stops.length, 1, '提交时停旧客户端')
  assert.equal(made[1].store.getState().tag, 'b', '新客户端用到待建期缓存的来源')
})

test('mux：提交时才换服务；回滚保留旧服务', async () => {
  const services = await swapHarness()
  const host = services.dshMobileTransportMux
  const swap = services.dshMobileTransportSwap
  const made = []; const drops = []
  const mkMux = () => { const s = { dropAll() { drops.push(this) }, dropDevice() {}, reassignInstance() {}, handleUpgrade() {} }; made.push(s); return s }
  host.adopt({ fingerprint: 'a', create: mkMux })
  assert.equal(made.length, 1, 'boot 建服务')
  host.setProviders({ authorize: () => true })
  host.adopt({ fingerprint: 'b', create: mkMux })
  assert.equal(made.length, 1, '换指纹时不在 apply 期建服务')
  swap.commit()
  assert.equal(made.length, 2, '提交时才建新服务'); assert.equal(drops.length, 1, '提交时旧服务应 dropAll 释放旧长连接')
  host.adopt({ fingerprint: 'c', create: mkMux })
  swap.rollback()
  assert.equal(made.length, 2, '回滚丢待建')
})

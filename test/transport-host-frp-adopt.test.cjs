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

// ── 三条主链路：提交时才换实例（事务化：换代期注入先暂存，commit 才落、rollback 丢弃） ──
async function swapHarness() {
  const { installTransportHosts } = await import('../lib/shell/transport-host.js')
  const box = fakeCtx()
  installTransportHosts(box.ctx)
  return box.services
}

test('sidecar：boot 建并启动；换指纹只在提交时建新；同指纹不重建；rollback 保留旧；令牌稳定', async () => {
  const services = await swapHarness()
  const host = services.dshMobileSidecarHost
  const swap = services.dshMobileTransportSwap
  const made = []; const starts = []; const stops = []
  const mk = ({ token } = {}) => { const h = { token, sidecarToken: token, start() { starts.push(this) }, stop() { stops.push(this) }, isStarted: () => true, setProviders() {}, onTunnelUp() { return () => {} }, onRouteAdopted() { return () => {} }, syncSidecar() {}, tunnelConnected: () => false, getSnapshot: () => ({}) }; made.push(h); return h }
  const f1 = host.adopt({ fingerprint: 'a', create: mk }) // boot
  assert.equal(made.length, 1); assert.equal(starts.length, 1)
  assert.match(String(f1.sidecarToken), /^[0-9a-f]{64}$/, '门面属性读到稳定 token')
  // 同指纹换代：不重建
  swap.begin(); host.adopt({ fingerprint: 'a', create: mk }); await swap.commit()
  assert.equal(made.length, 1, '同指纹不得重建'); assert.equal(stops.length, 0)
  // 换指纹：apply 期不建不停，commit 才停旧建新
  swap.begin(); host.adopt({ fingerprint: 'b', create: mk })
  assert.equal(made.length, 1, 'apply 期不得建新'); assert.equal(stops.length, 0, 'apply 期不得停旧')
  await swap.commit()
  assert.equal(made.length, 2); assert.equal(stops.length, 1); assert.equal(starts.length, 2)
  // rollback：丢弃待建，当前实例仍在跑
  swap.begin(); host.adopt({ fingerprint: 'c', create: mk }); swap.rollback()
  assert.equal(made.length, 2, '回滚丢弃待建'); assert.equal(stops.length, 1, '回滚保留当前实例')
  assert.equal(String(services.dshMobileSidecarHost.lifecycle.sidecarToken), String(f1.sidecarToken), 'token 跨重建稳定')
})

test('控制上报：提交时才换客户端；换代期 setProviders 暂存、commit 才落到新客户端；rollback 丢弃', async () => {
  const services = await swapHarness()
  const host = services.dshMobileTransportControl
  const swap = services.dshMobileTransportSwap
  const made = []; const stops = []
  const mk = (store) => { const c = { store, started: false, start() { this.started = true }, stop() { stops.push(this) }, sync() {}, snapshot: () => ({}), targetUrl: '' }; made.push(c); return c }
  host.adopt({ fingerprint: 'a', create: mk }) // boot
  host.setProviders({ getState: () => ({ tag: 'a' }) }) // 非事务期直接启动当前
  assert.equal(made.length, 1); assert.equal(made[0].started, true)
  swap.begin(); host.adopt({ fingerprint: 'b', create: mk })
  host.setProviders({ getState: () => ({ tag: 'b' }) })
  assert.equal(made.length, 1, 'apply 期不得建新客户端'); assert.equal(stops.length, 0, 'apply 期不得停旧')
  await swap.commit()
  assert.equal(made.length, 2); assert.equal(stops.length, 1)
  assert.equal(made[1].store.getState().tag, 'b', '新客户端用到换代期暂存的来源')
  // 同指纹 + 回滚：暂存来源应被丢弃，当前客户端仍用旧来源
  swap.begin(); host.adopt({ fingerprint: 'b', create: mk }); host.setProviders({ getState: () => ({ tag: 'boom' }) }); swap.rollback()
  assert.equal(made[1].store.getState().tag, 'b', '回滚不得把失败代的来源写进当前客户端')
})

test('mux：提交时才换服务；换代期 authorize 暂存、commit 落新服务、rollback 丢弃', async () => {
  const services = await swapHarness()
  const host = services.dshMobileTransportMux
  const swap = services.dshMobileTransportSwap
  const made = []; const drops = []
  const mkMux = () => { const s = { dropAll() { drops.push(this) }, dropDevice() {}, reassignInstance() {}, handleUpgrade() {} }; made.push(s); return s }
  host.adopt({ fingerprint: 'a', create: mkMux }); host.setProviders({ authorize: () => true })
  assert.equal(made.length, 1)
  swap.begin(); host.adopt({ fingerprint: 'b', create: mkMux })
  assert.equal(made.length, 1, 'apply 期不得建新服务')
  await swap.commit()
  assert.equal(made.length, 2, '提交时才建新服务'); assert.equal(drops.length, 1, '提交时旧服务 dropAll 释放旧长连接')
  swap.begin(); host.adopt({ fingerprint: 'c', create: mkMux }); swap.rollback()
  assert.equal(made.length, 2, '回滚丢待建')
})

test('三个主链路实现指纹：稳定、16 位十六进制、互不相同', () => {
  const sidecar = require('../lib/sidecar-lifecycle.cjs')
  const control = require('../lib/relay/control.js')
  const mux = require('../lib/mobile/mux.js')
  const fps = [sidecar.sidecarFingerprint(), control.controlFingerprint(), mux.muxFingerprint()]
  for (const fp of fps) assert.match(fp, /^[0-9a-f]{16}$/)
  assert.equal(new Set(fps).size, 3, '三条指纹不应相同')
})

test('sidecar 实现指纹覆盖 worker 的依赖闭包（改 relay/* 会触发提交时重建）', () => {
  const { sidecarFingerprintFiles } = require('../lib/sidecar-lifecycle.cjs')
  const files = sidecarFingerprintFiles().map(f => f.split('/lib/')[1])
  for (const rel of ['relay/tunnel.js', 'relay/protocol.js', 'relay/lan-proxy.js', 'relay/core.js', 'relay/lan-discovery.cjs']) {
    assert.ok(files.includes(rel), `sidecar 指纹没覆盖 ${rel}（共 ${files.length} 个）；漏了改它就不会重建`)
  }
  // 凭据子包是动态 require 进来的（字面量正则跟不到），必须被显式并进指纹：只改凭据实现也要触发重建。
  const raw = sidecarFingerprintFiles()
  assert.ok(
    raw.some(f => f.endsWith('/dsh-mobile-credentials/lib/credentials.js')),
    'sidecar 指纹没覆盖凭据包的 credentials.js；只改凭据实现就不会重建，worker 会一直跑旧凭据代码',
  )
})

test('control 实现指纹覆盖 e2ee 传递依赖（改 shared/e2ee.js 会触发提交时重建）', () => {
  const { controlFingerprintFiles } = require('../lib/relay/control.js')
  const base = path.join(__dirname, '..', 'lib', 'relay')
  const rels = controlFingerprintFiles()
  assert.ok(rels.includes('../shared/e2ee.js'), 'control 指纹没覆盖 shared/e2ee.js：密封用到它，改了却不换客户端就新旧混跑')
  for (const rel of rels) assert.ok(fs.existsSync(path.join(base, rel)), `control 指纹列了不存在的文件：${rel}`)
})

test('同指纹就地热重载：隧道连上 / 线路回写的订阅随代退订，反复热重载不累积泄漏', async () => {
  const services = await swapHarness()
  const host = services.dshMobileSidecarHost
  const swap = services.dshMobileTransportSwap
  const subs = new Set()
  const mk = () => ({
    token: 't', sidecarToken: 't', start() {}, stop() {},
    isStarted: () => true, setProviders() {}, syncSidecar() {}, tunnelConnected: () => false, getSnapshot: () => ({}),
    onTunnelUp(cb) { subs.add(cb); return () => subs.delete(cb) },
    onRouteAdopted(cb) { subs.add(cb); return () => subs.delete(cb) },
  })
  // boot（非事务期）：直接登记，拿到的是真退订
  host.adopt({ fingerprint: 'same', create: mk })
  let offUp = host.onTunnelUp(() => {})
  let offRt = host.onRouteAdopted(() => {})
  assert.equal(subs.size, 2, 'boot 后各登记一个订阅')
  // 连续三次同指纹热重载：每代登记自己的订阅、退订上一代；总数必须恒为 2，不往上爬
  for (let i = 0; i < 3; i += 1) {
    swap.begin()
    host.adopt({ fingerprint: 'same', create: mk }) // 同指纹：不换实例，只走换代事务
    const nextUp = host.onTunnelUp(() => {})
    const nextRt = host.onRouteAdopted(() => {})
    await swap.commit()
    if (typeof offUp === 'function') offUp() // 模拟运行时兑现上一代的退订
    if (typeof offRt === 'function') offRt()
    offUp = nextUp; offRt = nextRt
    assert.equal(subs.size, 2, `第 ${i + 2} 代提交并退订上一代后，订阅数应恒为 2（退订被吞就会累积）`)
  }
  if (typeof offUp === 'function') offUp()
  if (typeof offRt === 'function') offRt()
  assert.equal(subs.size, 0, '整代销毁后订阅应清空')
})

test('控制上报：提交时新客户端启动失败 → 保留旧客户端、不把没起来的设成当前', async () => {
  const services = await swapHarness()
  const host = services.dshMobileTransportControl
  const swap = services.dshMobileTransportSwap
  const made = []; const starts = []; const stops = []
  let failNext = false
  const mk = store => { const c = { store, start() { if (failNext) { failNext = false; throw new Error('boom') } starts.push(c) }, stop() { stops.push(c) }, sync() {}, snapshot: () => ({}), targetUrl: '' }; made.push(c); return c }
  host.adopt({ fingerprint: 'a', create: mk })
  host.setProviders({ getState: () => ({ tag: 'a' }) })
  const first = made[0]
  swap.begin(); host.adopt({ fingerprint: 'b', create: mk }); failNext = true
  await swap.commit()
  assert.equal(made.length, 2, '提交时确实尝试建了新客户端')
  assert.ok(stops.includes(first), '旧客户端被停过一次')
  assert.equal(starts.filter(c => c === first).length, 2, '旧客户端被重启恢复（boot 一次 + 失败后一次）')
  assert.ok(!starts.includes(made[1]), '没起来的新客户端不算启动成功')
  host.setProviders({ getState: () => ({ tag: 'after' }) })
  assert.equal(first.store.getState().tag, 'after', '失败后当前仍是旧客户端（新来源落到它）')
  assert.notEqual((made[1].store.getState() || {}).tag, 'after', '没起来的新客户端不该被当成当前')
})

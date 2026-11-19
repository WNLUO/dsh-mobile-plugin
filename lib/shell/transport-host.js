/**
 * 稳定外壳持有的传输进程：sidecar（中转隧道 + 局域网监听）、FRP 直连、总控上报。
 *
 * 它们都是长期活着的连接/进程，**不能挂在一代实现下**——否则换代（dispose 旧代）会把它们
 * 连同隧道一起停掉再重建，手机就在那几秒断线。这里由外壳创建并持有，跨代存活；换代只把
 * 配置/端口/状态来源重新注入（`setProviders` / `setPortProvider`），进程本身照跑。
 *
 * 惰性启动：只有「认识对应服务」的一代注入来源时才真正 start，避免回滚到不认识该服务的旧版
 * 时外壳与旧代各起一份（重复 frpc / 重复上报连接）。
 *
 * 外壳（`lib/index.js`）只调一次 `installTransportHosts(ctx)`，业务逻辑全在这个文件里，
 * 免得把外壳那个「只装代码」的入口撑大（`test/assembly-layer.test.cjs` 钉着）。
 */
import sidecarLifecycleCjs from '../sidecar-lifecycle.cjs'
import frpcRunnerCjs from '../frpc/runner.cjs'
import controlCjs from '../relay/control.js'

const { createSidecarLifecycle } = sidecarLifecycleCjs
const { createFrpcRunner } = frpcRunnerCjs
const { createControlClient } = controlCjs

export function installTransportHosts(ctx) {
  // ── sidecar：中转隧道 + 局域网监听 ──────────────────────────────────
  // 由代首次 sync 时惰性 start（幂等）；换代只换配置来源，隧道跨代存活。外壳卸载才 stop。
  const sidecarHost = createSidecarLifecycle({ ctx })
  ctx.reflect.provide('dshMobileSidecarHost', sidecarHost)
  ctx.effect(() => () => sidecarHost.stop(), 'dsh-mobile-plugin: sidecar transport host')

  // ── FRP 直连：frpc 子进程 ──────────────────────────────────────────
  let frpPortProvider = () => 0
  const frpRunner = createFrpcRunner({ portOf: () => frpPortProvider() })
  ctx.reflect.provide('dshMobileTransportFrp', {
    runner: frpRunner,
    setPortProvider: fn => {
      if (typeof fn !== 'function') return
      frpPortProvider = fn
      if (frpRunner.shouldAutoStart()) void frpRunner.start()
    },
  })
  ctx.effect(() => () => { void frpRunner.dispose() }, 'dsh-mobile-plugin: frpc transport host')

  // ── 总控上报：常连的出站客户端 ─────────────────────────────────────
  let controlProviders = {
    getState: () => ({}),
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => '',
    getRelayConnected: () => sidecarHost.tunnelConnected(),
  }
  const controlClient = createControlClient({
    getState: () => controlProviders.getState(),
    persist: () => controlProviders.persist(),
    getPort: () => controlProviders.getPort(),
    getHistoryKey: () => controlProviders.getHistoryKey(),
    getRelayConnected: () => controlProviders.getRelayConnected(),
  })
  ctx.reflect.provide('dshMobileTransportControl', {
    client: controlClient,
    setProviders: p => {
      controlProviders = { ...controlProviders, ...(p && typeof p === 'object' ? p : {}) }
      controlClient.start()
      controlClient.sync()
    },
  })
  ctx.effect(() => () => controlClient.stop(), 'dsh-mobile-plugin: control transport host')

  return { sidecarHost, frpRunner, controlClient }
}

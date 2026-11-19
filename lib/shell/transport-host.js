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
import tailcatWiringCjs from '../tailcat/wiring.cjs'
import p2pWiringCjs from '../p2p/wiring.cjs'
import muxCjs from '../mobile/mux.js'

const { createSidecarLifecycle } = sidecarLifecycleCjs
const { createFrpcRunner } = frpcRunnerCjs
const { createControlClient } = controlCjs
const { mountTailcat } = tailcatWiringCjs
const { mountP2P } = p2pWiringCjs
const { createMuxService } = muxCjs

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
    // 身份冲突时触发换身份的动作，由当前这一代注入（换代换它即可）。缺省不启用。
    onIdentityConflict: null,
  }
  const controlClient = createControlClient({
    getState: () => controlProviders.getState(),
    persist: () => controlProviders.persist(),
    getPort: () => controlProviders.getPort(),
    getHistoryKey: () => controlProviders.getHistoryKey(),
    getRelayConnected: () => controlProviders.getRelayConnected(),
    onIdentityConflict: (...args) => {
      const fn = controlProviders.onIdentityConflict
      return typeof fn === 'function' ? fn(...args) : undefined
    },
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

  // ── 对话页长连接（mux） ─────────────────────────────────────────────
  // mux 只是一条把逻辑流转成本地回环 HTTP 打到移动 API 的搬运工。把它和它的升级路由提到外壳，
  // 已建立的手机 WS 就能跨过换代不断（底层订阅续传由 App 的序号机制兜）。鉴权在服务里做，
  // `authorize` 由当前这一代注入（换代换它即可）。
  let muxProviders = { authorize: () => false }
  const muxService = createMuxService({
    upstream: { port: ctx.webServer.port },
    authorize: req => (typeof muxProviders.authorize === 'function' ? muxProviders.authorize(req) : false),
    onLog: message => { try { ctx.logger?.info?.(`dsh-mobile-plugin: ${message}`) } catch { /* ignore */ } },
  })
  ctx.reflect.provide('dshMobileTransportMux', {
    service: muxService,
    setProviders: p => { if (p && typeof p === 'object') muxProviders = { ...muxProviders, ...p } },
  })
  try {
    if (typeof ctx.webServer.registerUpgrade === 'function') {
      ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/mobile/v1/mux', handler: muxService.handleUpgrade }), 'dsh-mobile-plugin: mux upgrade route')
    }
  } catch { /* 宿主没有升级路由能力时这条不挂，App 走 HTTP/SSE 兜底 */ }

  // ── 隧道助手（直连隧道） ────────────────────────────────────────────
  // 惰性 ensure：只有认识这个服务的一代第一次用到时才真正创建入口/落点/助手会话并起监听，
  // 测试里的假代不碰它就完全不起端口/进程。创建用外壳的 ctx，effect 挂在外壳上，跨代存活；
  // 换代只更新状态/端口来源（`ensure` 传进来的 providers），助手会话本身照跑。
  const warn = message => { try { ctx.logger?.warn?.(`dsh-mobile-plugin: ${message}`) } catch { /* 日志不许反噬 */ } }
  const looseMount = (label, fn) => { try { return fn() } catch (error) { warn(`${label} 没挂上：${error && error.message ? error.message : error}`); return undefined } }
  let tailcatDoor = null
  let tailcatProviders = {}
  ctx.reflect.provide('dshMobileTransportTailcat', {
    ensure: providers => {
      if (providers && typeof providers === 'object') tailcatProviders = { ...tailcatProviders, ...providers }
      const pick = name => (typeof tailcatProviders[name] === 'function' ? tailcatProviders[name] : null)
      if (!tailcatDoor) {
        tailcatDoor = mountTailcat({
          mount: looseMount,
          warn,
          getState: () => (pick('getState') ? pick('getState')() : {}),
          saveState: state => { const fn = pick('saveState'); if (fn) fn(state) },
          lanEnabled: () => (pick('lanEnabled') ? pick('lanEnabled')() : false),
          lanPort: () => (pick('lanPort') ? pick('lanPort')() : 0),
          webPort: () => (pick('webPort') ? pick('webPort')() : 0),
          webHost: () => (pick('webHost') ? pick('webHost')() : '127.0.0.1'),
          hostName: () => (pick('hostName') ? pick('hostName')() : ''),
          ctx,
          name: 'dsh-mobile-plugin',
        })
      }
      return tailcatDoor
    },
  })

  // ── 点对点隧道 ──────────────────────────────────────────────────────
  // 与隧道助手同一套惰性 ensure：不碰它就不起端口/会话；换代只更新来源。
  let p2pDoor = null
  let p2pProviders = {}
  ctx.reflect.provide('dshMobileTransportP2P', {
    ensure: providers => {
      if (providers && typeof providers === 'object') p2pProviders = { ...p2pProviders, ...providers }
      const pick = name => (typeof p2pProviders[name] === 'function' ? p2pProviders[name] : null)
      if (!p2pDoor) {
        p2pDoor = mountP2P({
          mount: looseMount,
          warn,
          getState: () => (pick('getState') ? pick('getState')() : {}),
          saveState: state => { const fn = pick('saveState'); if (fn) fn(state) },
          localPort: () => (pick('localPort') ? pick('localPort')() : 0),
          lanEnabled: () => (pick('lanEnabled') ? pick('lanEnabled')() : false),
          lanPort: () => (pick('lanPort') ? pick('lanPort')() : 0),
          webPort: () => (pick('webPort') ? pick('webPort')() : 0),
          webHost: () => (pick('webHost') ? pick('webHost')() : '127.0.0.1'),
          ctx,
          name: 'dsh-mobile-plugin',
        })
      }
      return p2pDoor
    },
  })

  return { sidecarHost, frpRunner, controlClient, tailcatDoor: () => tailcatDoor, p2pDoor: () => p2pDoor }
}

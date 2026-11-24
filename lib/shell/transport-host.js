// 稳定持有传输服务，并从当前实现读取地址与中转注册真值。
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
export function installTransportHosts(ctx) {
  /** 外壳自己的告警出口：拿不到 logger 也照常往下走，不打日志不算失败。 */
  const warn = (message, detail) => {
    try { ctx.logger?.warn?.(`dsh-mobile-plugin: ${message}${detail ? ` ${detail}` : ''}`) } catch { /* 日志不许反噬 */ }
  }

  // ── sidecar：中转隧道 + 局域网监听 ──────────────────────────────────
  // 生命周期实现搬进「代」：这一代 adopt 时把 create 交进来，外壳按实现指纹持有它 ——
  // 指纹不变沿用（换代不断隧道），变了才重建（只有中转这条短暂重连，DSH 不重启）。
  let sidecarEntry = null // { fingerprint, lifecycle }
  const sidecarLifecycleOf = () => (sidecarEntry ? sidecarEntry.lifecycle : null)
  ctx.reflect.provide('dshMobileSidecarHost', {
    get lifecycle() { return sidecarLifecycleOf() },
    adopt: ({ fingerprint, create } = {}) => {
      if (typeof create !== 'function') return sidecarLifecycleOf()
      if (sidecarEntry && sidecarEntry.fingerprint === fingerprint) return sidecarEntry.lifecycle
      const previous = sidecarEntry
      const lifecycle = create()
      sidecarEntry = { fingerprint, lifecycle }
      if (previous && previous.lifecycle !== lifecycle) { try { void previous.lifecycle.stop() } catch { /* 已经停了 */ } }
      return lifecycle
    },
  })
  ctx.effect(() => () => { const lifecycle = sidecarLifecycleOf(); if (lifecycle) void lifecycle.stop() }, 'dsh-mobile-plugin: sidecar transport host')

  // ── FRP 直连：frpc 子进程 ──────────────────────────────────────────
  // 实现（怎么起 frpc）住在「代」里，由当前这一代 `adopt` 交进来；外壳只按「实现指纹」持有它 ——
  // 指纹不变就沿用正在跑的那个（换代不断 FRP），指纹变了才换新（只有这条线路短暂重连）。
  let frpPortProvider = () => 0
  let frpEntry = null // { fingerprint, runner }
  const frpRunnerOf = () => (frpEntry ? frpEntry.runner : null)
  ctx.reflect.provide('dshMobileTransportFrp', {
    get runner() { return frpRunnerOf() },
    adopt: ({ fingerprint, create } = {}) => {
      if (typeof create !== 'function') return frpRunnerOf()
      if (frpEntry && frpEntry.fingerprint === fingerprint) return frpEntry.runner
      const previous = frpEntry
      const runner = create({ portOf: () => frpPortProvider() })
      frpEntry = { fingerprint, runner }
      if (previous && previous.runner !== runner) {
        try { void previous.runner.dispose() } catch { /* 已经停了 */ }
      }
      return runner
    },
    setPortProvider: fn => {
      if (typeof fn !== 'function') return
      frpPortProvider = fn
      const runner = frpRunnerOf()
      if (runner && runner.shouldAutoStart()) void runner.start()
    },
  })
  ctx.effect(() => () => { const runner = frpRunnerOf(); if (runner) void runner.dispose() }, 'dsh-mobile-plugin: frpc transport host')

  // ── 总控上报：常连的出站客户端 ─────────────────────────────────────
  // 实现搬进「代」：这一代 adopt 时把 create 交进来（它用下面这个 provider 仓库造客户端）；
  // 外壳按实现指纹持有客户端，换代只更新仓库、不换客户端（换代不断上报）。
  let controlEntry = null // { fingerprint, client }
  const controlProviders = {
    getState: () => ({}),
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => '',
    getRelayConnected: () => { const l = sidecarLifecycleOf(); return l ? l.tunnelConnected() : false },
    getConnectedRelay: () => { const l = sidecarLifecycleOf(); const tunnel = l ? l.getSnapshot()?.tunnel : null; return tunnel?.state === 'connected' ? tunnel.relayUrl || tunnel.route?.url || '' : '' },
    // 身份冲突时触发换身份的动作，由当前这一代注入（换代换它即可）。缺省不启用。
    onIdentityConflict: null,
    // 总控转达的「请自检」要回的那份诊断，由当前这一代注入（同一份内容，见 relay-control）。
    getDiagnostics: null,
    // 服务商线路清单 / 候选计算：都由当前这一代注入（改它们只换代，外壳不动）。缺省空。
    getProviderLines: null,
    getLanTools: null,
    log: null,
  }
  const controlClientOf = () => (controlEntry ? controlEntry.client : null)
  ctx.reflect.provide('dshMobileTransportControl', {
    get client() { return controlClientOf() },
    adopt: ({ fingerprint, create } = {}) => {
      if (typeof create !== 'function') return controlClientOf()
      if (controlEntry && controlEntry.fingerprint === fingerprint) return controlEntry.client
      const previous = controlEntry
      const client = create(controlProviders)
      controlEntry = { fingerprint, client }
      if (previous && previous.client !== client) { try { previous.client.stop() } catch { /* 已经停了 */ } }
      return client
    },
    setProviders: p => {
      // 就地合并：客户端 getter 闭包引用的是同一个仓库对象，换代不能换成新对象。
      Object.assign(controlProviders, p && typeof p === 'object' ? p : {})
      const client = controlClientOf()
      if (client) { client.start(); client.sync() }
    },
  })
  ctx.effect(() => () => { const client = controlClientOf(); if (client) client.stop() }, 'dsh-mobile-plugin: control transport host')

  // ── 对话页长连接（mux） ─────────────────────────────────────────────
  // 实现搬进「代」：外壳持有 service 和一条**稳定的升级路由**（永远指向当前 service，重建不失联），
  // 按实现指纹沿用/重建。鉴权 `authorize` 由当前这一代注入（换代换它即可）。
  let muxEntry = null // { fingerprint, service }
  let muxAuthorize = () => false
  const muxServiceOf = () => (muxEntry ? muxEntry.service : null)
  const muxUpgradeHandler = (req, socket, head) => {
    const service = muxServiceOf()
    if (!service || typeof service.handleUpgrade !== 'function') { try { socket.destroy() } catch { /* ignore */ } return }
    return service.handleUpgrade(req, socket, head)
  }
  ctx.reflect.provide('dshMobileTransportMux', {
    get service() { return muxServiceOf() },
    adopt: ({ fingerprint, create } = {}) => {
      if (typeof create !== 'function') return muxServiceOf()
      if (muxEntry && muxEntry.fingerprint === fingerprint) return muxEntry.service
      const previous = muxEntry
      const service = create({
        upstream: { port: ctx.webServer.port },
        authorize: req => muxAuthorize(req),
        onLog: message => { try { ctx.logger?.info?.(`dsh-mobile-plugin: ${message}`) } catch { /* ignore */ } },
      })
      muxEntry = { fingerprint, service }
      if (previous && previous.service !== service) { try { previous.service.dropAll?.() } catch { /* ignore */ } }
      return service
    },
    setProviders: p => { if (p && typeof p.authorize === 'function') muxAuthorize = p.authorize },
  })
  ctx.effect(() => () => { try { muxServiceOf()?.dropAll?.() } catch { /* ignore */ } }, 'dsh-mobile-plugin: mux service')
  try {
    if (typeof ctx.webServer.registerUpgrade === 'function') {
      ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/mobile/v1/mux', handler: muxUpgradeHandler, auth: 'anonymous' }), 'dsh-mobile-plugin: mux upgrade route')
    }
  } catch { /* 宿主没有升级路由能力时这条不挂，App 走 HTTP/SSE 兜底 */ }

  // ── 隧道助手（直连隧道） ────────────────────────────────────────────
  // 实现搬进「代」：这一代在 ensure 时把 mount 交进来，外壳按实现指纹持有 door。指纹不变就沿用
  // 正在跑的会话与监听（换代不断直连），变了才重建（只有这条线路短暂重连，DSH 不重启）。
  // effect 挂在外壳上（tailcatBag），重建前按账把旧 door 的 effect 与 stop 收干净。
  const looseMount = (label, fn) => { try { return fn() } catch (error) { warn(`${label} 没挂上：${error && error.message ? error.message : error}`); return undefined } }
  let tailcatDoor = null
  let tailcatProviders = {}
  let tailcatFingerprint = null
  let tailcatDisposers = []
  // 更新装包前要暂停助手（Windows 文件锁）：换成稳定的门面，永远指向当前 door，重建也不失联。
  const tailcatCtlHolder = {
    stop: () => { const d = tailcatDoor; return d && typeof d.stop === 'function' ? d.stop() : Promise.resolve() },
    start: () => { const d = tailcatDoor; return d && typeof d.start === 'function' ? d.start() : undefined },
    status: () => (tailcatDoor && typeof tailcatDoor.status === 'function' ? tailcatDoor.status() : null),
  }
  ctx.reflect.provide('dshMobileTailcatCtl', tailcatCtlHolder)
  const disposeTailcat = () => {
    const door = tailcatDoor
    const disposers = tailcatDisposers
    tailcatDoor = null
    tailcatDisposers = []
    for (const dispose of disposers) { try { dispose() } catch { /* 已经停了 */ } }
    try { if (door && typeof door.stop === 'function') void door.stop() } catch { /* 已经停了 */ }
  }
  // mount 内部会把它的启停挂成 `ctx.effect`：外壳这里把每次登记的 disposer 记账，重建时统一收。
  const tailcatBag = {
    effect: (fn, label) => { const dispose = ctx.effect(fn, label); tailcatDisposers.push(dispose); return dispose },
    reflect: { provide: (n, o) => { if (n === 'dshMobileTailcatCtl') return; try { ctx.reflect.provide(n, o) } catch { /* 已提供就交回壳里的稳定门面 */ } } },
  }
  ctx.reflect.provide('dshMobileTransportTailcat', {
    ensure: ({ providers, mount, fingerprint } = {}) => {
      if (providers && typeof providers === 'object') tailcatProviders = { ...tailcatProviders, ...providers }
      if (typeof mount !== 'function') return tailcatDoor
      if (tailcatDoor && fingerprint === tailcatFingerprint) return tailcatDoor
      disposeTailcat()
      const pick = name => (typeof tailcatProviders[name] === 'function' ? tailcatProviders[name] : null)
      tailcatDoor = mount({
        mount: looseMount,
        warn,
        getState: () => (pick('getState') ? pick('getState')() : {}),
        saveState: state => { const fn = pick('saveState'); if (fn) fn(state) },
        lanEnabled: () => (pick('lanEnabled') ? pick('lanEnabled')() : false),
        lanPort: () => (pick('lanPort') ? pick('lanPort')() : 0),
        webPort: () => (pick('webPort') ? pick('webPort')() : 0),
        webHost: () => (pick('webHost') ? pick('webHost')() : '127.0.0.1'),
        hostName: () => (pick('hostName') ? pick('hostName')() : ''),
        ctx: tailcatBag,
        name: 'dsh-mobile-plugin',
      })
      tailcatFingerprint = fingerprint
      return tailcatDoor
    },
  })
  ctx.effect(() => () => disposeTailcat(), 'dsh-mobile-plugin: tailcat transport host')

  // ── 点对点隧道 ──────────────────────────────────────────────────────
  // 与隧道助手同一套：实现（助手会话 + 落点代理）搬进「代」，外壳按实现指纹持有 door。
  // 指纹不变沿用（换代不断直连），变了才重建（这条线路短暂重连，DSH 不重启）。
  let p2pDoor = null
  let p2pProviders = {}
  let p2pFingerprint = null
  let p2pDisposers = []
  const disposeP2P = () => {
    const door = p2pDoor
    const disposers = p2pDisposers
    p2pDoor = null
    p2pDisposers = []
    for (const dispose of disposers) { try { dispose() } catch { /* 已经停了 */ } }
    try { if (door && typeof door.stop === 'function') void door.stop() } catch { /* 已经停了 */ }
  }
  const p2pBag = {
    effect: (fn, label) => { const dispose = ctx.effect(fn, label); p2pDisposers.push(dispose); return dispose },
  }
  ctx.reflect.provide('dshMobileTransportP2P', {
    ensure: ({ providers, mount, fingerprint } = {}) => {
      if (providers && typeof providers === 'object') p2pProviders = { ...p2pProviders, ...providers }
      if (typeof mount !== 'function') return p2pDoor
      if (p2pDoor && fingerprint === p2pFingerprint) return p2pDoor
      disposeP2P()
      const pick = name => (typeof p2pProviders[name] === 'function' ? p2pProviders[name] : null)
      p2pDoor = mount({
        mount: looseMount,
        warn,
        getState: () => (pick('getState') ? pick('getState')() : {}),
        saveState: state => { const fn = pick('saveState'); if (fn) fn(state) },
        localPort: () => (pick('localPort') ? pick('localPort')() : 0),
        lanEnabled: () => (pick('lanEnabled') ? pick('lanEnabled')() : false),
        lanPort: () => (pick('lanPort') ? pick('lanPort')() : 0),
        webPort: () => (pick('webPort') ? pick('webPort')() : 0),
        webHost: () => (pick('webHost') ? pick('webHost')() : '127.0.0.1'),
        ctx: p2pBag,
        name: 'dsh-mobile-plugin',
      })
      p2pFingerprint = fingerprint
      return p2pDoor
    },
  })
  ctx.effect(() => () => disposeP2P(), 'dsh-mobile-plugin: p2p transport host')

  return { get sidecarLifecycle() { return sidecarLifecycleOf() }, get frpRunner() { return frpRunnerOf() }, get controlClient() { return controlClientOf() }, tailcatDoor: () => tailcatDoor, p2pDoor: () => p2pDoor }
}

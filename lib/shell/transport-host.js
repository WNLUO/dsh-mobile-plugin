// 稳定持有传输服务，并从当前实现读取地址与中转注册真值。
/**
 * 稳定外壳持有的传输进程：sidecar（中转隧道 + 局域网监听）、FRP 直连、总控上报、
 * 隧道助手（tailcat）、点对点（p2p）、mux 长连接。
 *
 * ## 三条主链路：提交时才换实例（永不重启 DSH）
 *
 * sidecar / 总控 / mux 是**单实例主连接**。它们的实现住在一代里，但实例由外壳持有；换代时
 * **不立刻拆旧实例**：新代先把「待建工厂」登记下来，外壳给它一个**稳定门面**（方法都委托到
 * 当前实例）。等到运行时确认这一代**提交成功并通过自检**，外壳才 `commit`：停旧实例、按新代
 * 工厂建新、启动新。若这次换代失败回滚，`rollback` 只丢弃待建、旧实例一直活着——回滚是干净的。
 * 于是改动这三条主链路的代码不再需要用户重启 DSH，最多在提交那一刻短暂重连一次。
 *
 * 门面能跨实例稳定，是因为它每次调用都转发到「当前实例」；换代只换当前实例，不换门面。
 * 配置/注册类方法（setProviders / onTunnelUp 等）在有待建时先缓存，提交建新后回放给新实例。
 *
 * ## 可选线路：FRP / 隧道助手 / 点对点
 *
 * 仍由外壳持有、按实现指纹沿用或重建（沿用不重连；变了只换这一条，DSH 不重启）。
 *
 * 外壳（`lib/index.js`）只调一次 `installTransportHosts(ctx)`，业务逻辑全在这个文件里。
 */
import crypto from 'node:crypto'

/** 给一个「每次现取当前实例」的门面：属性读当前值，方法转发；待建期把配置/注册类方法缓存起来。 */
function makeFacade(getHandle, { props = [], defer = [], pendingOf = () => null } = {}) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      const current = getHandle()
      if (props.includes(prop) || (current && typeof current[prop] !== 'function')) {
        return current ? current[prop] : undefined
      }
      return (...args) => {
        const pending = pendingOf()
        if (pending && defer.includes(prop)) { pending.buffered.push([prop, args]); return undefined }
        const handle = getHandle()
        if (!handle || typeof handle[prop] !== 'function') return undefined
        return handle[prop](...args)
      }
    },
  })
}

/**
 * 提交时才切换的槽：boot 时建并启动；换代变化只登记待建、不碰旧实例；commit 停旧建新起新；
 * rollback 丢弃待建、旧实例毫发无损。
 */
function createSwapSlot({ create, start = null, stop = null, props = [], defer = [] } = {}) {
  let current = null // { fingerprint, handle }
  let pending = null // { fingerprint, build, buffered: [] }
  const getHandle = () => (current ? current.handle : null)
  const facade = makeFacade(getHandle, { props, defer, pendingOf: () => pending })
  const slot = {
    facade,
    get current() { return getHandle() },
    /** 首代（boot）或同指纹：用/返回当前实例；指纹变了：登记待建、继续返回旧（旧的一直活到提交）。 */
    adopt({ fingerprint, create: build } = {}) {
      if (typeof build !== 'function') return facade
      if (current && current.fingerprint === fingerprint) return facade
      if (pending && pending.fingerprint === fingerprint) return facade
      if (!current) {
        current = { fingerprint, handle: build() }
        try { if (start) start(current.handle) } catch { /* 启动失败由各自自检兜 */ }
        return facade
      }
      pending = { fingerprint, build, buffered: [] }
      return facade
    },
    commit() {
      if (!pending) return
      const prev = current
      let next
      try { next = pending.build() } catch (error) { pending = null; throw error }
      for (const [prop, args] of pending.buffered) { try { if (typeof next[prop] === 'function') next[prop](...args) } catch { /* 回放失败不挡切换 */ } }
      if (prev) { try { if (stop) stop(prev.handle) } catch { /* 已经停了 */ } }
      try { if (start) start(next) } catch { /* 同上 */ }
      current = { fingerprint: pending.fingerprint, handle: next }
      pending = null
    },
    rollback() { pending = null },
    dispose() { if (current) { try { if (stop) stop(current.handle) } catch { /* 已经停了 */ } } },
    hasPending: () => pending !== null,
  }
  return slot
}

export function installTransportHosts(ctx) {
  /** 外壳自己的告警出口：拿不到 logger 也照常往下走，不打日志不算失败。 */
  const warn = (message, detail) => {
    try { ctx.logger?.warn?.(`dsh-mobile-plugin: ${message}${detail ? ` ${detail}` : ''}`) } catch { /* 日志不许反噬 */ }
  }

  // ── sidecar：中转隧道 + 局域网监听（提交时才换实例） ────────────────
  // 生命周期实现由当前这一代 `adopt` 时交进来；外壳按实现指纹持有，提交成功才换，失败保留旧的。
  const sidecarToken = crypto.randomBytes(32).toString('hex')
  const sidecarSlot = createSwapSlot({
    start: handle => handle.start(),
    stop: handle => handle.stop(),
    props: ['sidecarToken'],
    defer: ['setProviders', 'onTunnelUp', 'onRouteAdopted'],
  })
  // 门面上的 adopt 要把稳定 token 交给这一代的工厂，保证重建后 token 不变（手机侧不受影响）。
  const sidecarAdopt = ({ fingerprint, create } = {}) =>
    sidecarSlot.adopt({ fingerprint, create: typeof create === 'function' ? () => create({ token: sidecarToken }) : create })
  ctx.reflect.provide('dshMobileSidecarHost', { adopt: sidecarAdopt, get lifecycle() { return sidecarSlot.current } })

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

  // ── 总控上报：常连的出站客户端（提交时才换客户端） ─────────────────
  const controlDefaults = () => ({
    getState: () => ({}),
    persist: () => {},
    getPort: () => 0,
    getHistoryKey: () => '',
    getRelayConnected: () => { const lc = sidecarSlot.current; return lc && typeof lc.tunnelConnected === 'function' ? lc.tunnelConnected() : false },
    getConnectedRelay: () => { const lc = sidecarSlot.current; const tunnel = lc ? lc.getSnapshot?.()?.tunnel : null; return tunnel?.state === 'connected' ? tunnel.relayUrl || tunnel.route?.url || '' : '' },
    onIdentityConflict: null,
    getDiagnostics: null,
    getProviderLines: null,
    getLanTools: null,
    log: warn,
  })
  let controlCurrent = null // { fingerprint, client, store }
  let controlPending = null // { fingerprint, providers }
  const controlFacade = makeFacade(() => (controlCurrent ? controlCurrent.client : null), { props: ['targetUrl'] })
  const controlAdopt = ({ fingerprint, create } = {}) => {
    if (typeof create !== 'function') return controlFacade
    if (controlCurrent && controlCurrent.fingerprint === fingerprint) return controlFacade
    if (controlPending && controlPending.fingerprint === fingerprint) return controlFacade
    if (!controlCurrent) {
      const store = controlDefaults()
      controlCurrent = { fingerprint, store, client: create(store) }
      return controlFacade
    }
    controlPending = { fingerprint, create, providers: null }
    return controlFacade
  }
  ctx.reflect.provide('dshMobileTransportControl', {
    get client() { return controlFacade },
    adopt: controlAdopt,
    setProviders: p => {
      const patch = p && typeof p === 'object' ? p : {}
      if (controlPending) { controlPending.providers = { ...(controlPending.providers || {}), ...patch }; return }
      if (!controlCurrent) return
      Object.assign(controlCurrent.store, patch)
      controlCurrent.client.start()
      controlCurrent.client.sync()
    },
  })

  // ── 对话页长连接（mux，提交时才换服务） ─────────────────────────────
  let muxAuthorize = () => false
  let muxCurrent = null // { fingerprint, service }
  let muxPending = null // { fingerprint, build }
  const muxFacade = makeFacade(() => (muxCurrent ? muxCurrent.service : null))
  const muxAdopt = ({ fingerprint, create } = {}) => {
    if (typeof create !== 'function') return muxFacade
    if (muxCurrent && muxCurrent.fingerprint === fingerprint) return muxFacade
    if (muxPending && muxPending.fingerprint === fingerprint) return muxFacade
    const build = () => create({ upstream: { port: ctx.webServer.port }, authorize: req => muxAuthorize(req), onLog: message => { try { ctx.logger?.info?.(`dsh-mobile-plugin: ${message}`) } catch { /* ignore */ } } })
    if (!muxCurrent) { muxCurrent = { fingerprint, service: build() }; return muxFacade }
    muxPending = { fingerprint, build }
    return muxFacade
  }
  ctx.reflect.provide('dshMobileTransportMux', {
    get service() { return muxFacade },
    adopt: muxAdopt,
    setProviders: p => { if (p && typeof p.authorize === 'function') muxAuthorize = p.authorize },
  })
  try {
    if (typeof ctx.webServer.registerUpgrade === 'function') {
      ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/mobile/v1/mux', handler: (req, socket, head) => { const s = muxCurrent ? muxCurrent.service : null; if (!s || typeof s.handleUpgrade !== 'function') { try { socket.destroy() } catch { /* ignore */ } return } return s.handleUpgrade(req, socket, head) }, auth: 'anonymous' }), 'dsh-mobile-plugin: mux upgrade route')
    }
  } catch { /* 宿主没有升级路由能力时这条不挂，App 走 HTTP/SSE 兜底 */ }

  // ── 提交/回滚协调：运行时在换代提交成功/失败时调它 ─────────────────
  ctx.reflect.provide('dshMobileTransportSwap', {
    commit: () => {
      try { sidecarSlot.commit() } catch (error) { warn('sidecar 换代切换失败：', error?.message || String(error)) }
      try {
        if (controlPending) {
          const prev = controlCurrent
          const store = { ...controlDefaults(), ...(controlPending.providers || {}) }
          const client = controlPending.create(store)
          try { if (prev) prev.client.stop() } catch { /* 已经停了 */ }
          try { client.start(); client.sync() } catch { /* 由自检兜 */ }
          controlCurrent = { fingerprint: controlPending.fingerprint, store, client }
          controlPending = null
        }
      } catch (error) { controlPending = null; warn('总控上报换代切换失败：', error?.message || String(error)) }
      try {
        if (muxPending) {
          const prev = muxCurrent
          const service = muxPending.build()
          try { if (prev && prev.service !== service) prev.service.dropAll?.() } catch { /* ignore */ }
          muxCurrent = { fingerprint: muxPending.fingerprint, service }
          muxPending = null
        }
      } catch (error) { muxPending = null; warn('mux 换代切换失败：', error?.message || String(error)) }
    },
    rollback: () => {
      sidecarSlot.rollback()
      controlPending = null
      muxPending = null
    },
  })
  ctx.effect(() => () => { sidecarSlot.dispose() }, 'dsh-mobile-plugin: sidecar transport host')
  ctx.effect(() => () => { if (controlCurrent) { try { controlCurrent.client.stop() } catch { /* ignore */ } } }, 'dsh-mobile-plugin: control transport host')
  ctx.effect(() => () => { if (muxCurrent) { try { muxCurrent.service.dropAll?.() } catch { /* ignore */ } } }, 'dsh-mobile-plugin: mux transport host')

  // ── 隧道助手（直连隧道，可选线路：按指纹沿用/重建） ────────────────
  const looseMount = (label, fn) => { try { return fn() } catch (error) { warn(`${label} 没挂上：${error && error.message ? error.message : error}`); return undefined } }
  let tailcatDoor = null
  let tailcatProviders = {}
  let tailcatFingerprint = null
  let tailcatDisposers = []
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

  // ── 点对点隧道（可选线路：按指纹沿用/重建） ───────────────────────
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

  return { get sidecarLifecycle() { return sidecarSlot.current }, get frpRunner() { return frpRunnerOf() }, get controlClient() { return controlCurrent ? controlCurrent.client : null }, tailcatDoor: () => tailcatDoor, p2pDoor: () => p2pDoor }
}

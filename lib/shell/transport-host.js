// 稳定持有传输服务，并从当前实现读取地址与中转注册真值。
/**
 * 稳定外壳持有的传输进程：sidecar（中转隧道 + 局域网监听）、FRP 直连、总控上报、
 * 隧道助手（tailcat）、点对点（p2p）、mux 长连接。
 *
 * ## 三条主链路：提交时才换实例（永不重启 DSH）
 *
 * sidecar / 总控 / mux 是**单实例主连接**。实现住在一代里，实例由外壳持有；换代时**不立刻拆旧
 * 实例**：新代把「待建工厂」登记下来，外壳给它一个**稳定门面**（方法都委托到当前实例）。运行时
 * 在换代「提交成功且自检通过」后调 swap.commit()：停旧、按新代工厂建新、起新；失败调
 * swap.rollback()：丢弃待建、旧实例毫发无损——回滚是干净的。
 *
 * 换代事务化：整个 reload 期间（runtime 调 swap.begin 到 commit/rollback 之间），这一代注入的
 * providers / authorize **先暂存**，commit 才落到（新的或当前的）实例，rollback 直接丢弃。这样
 * 即使指纹没变（最常见）也不会在 apply 期污染旧实例、回滚也还原得回来。
 *
 * 门面跨实例稳定（每次调用转发到「当前实例」）；换代只换当前实例，不换门面引用。
 *
 * ## 可选线路：FRP / 隧道助手 / 点对点
 *
 * 仍按实现指纹沿用或重建（沿用不重连；变了只换这一条，DSH 不重启）。
 *
 * 外壳（`lib/index.js`）只调一次 `installTransportHosts(ctx)`，业务逻辑全在这个文件里。
 */
import crypto from 'node:crypto'
import { createOptionalLineRegistry } from './optional-lines.js'

/** 门面：每次现取当前实例；属性读当前值，方法转发；换代事务期把配置/注册类方法暂存起来。 */
function makeFacade(getHandle, { props = [], stageMethods = [], stage = null } = {}) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      const current = getHandle()
      if (props.includes(prop) || (current && typeof current[prop] !== 'function')) {
        return current ? current[prop] : undefined
      }
      return (...args) => {
        if (stage && stageMethods.includes(prop)) {
          const staged = stage(prop, args)
          if (staged) return staged.result
        }
        const handle = getHandle()
        if (!handle || typeof handle[prop] !== 'function') return undefined
        return handle[prop](...args)
      }
    },
  })
}

/** 提交时才切换的槽（事务化）：boot 建并启动；换代变化只登记待建；配置暂存；commit 落配置并换实例；rollback 全丢。 */
function createSwapSlot({ start = null, stop = null, props = [], stageMethods = [], isSwapping } = {}) {
  let current = null // { fingerprint, handle }
  let pending = null // { fingerprint, build }
  let staged = [] // [[prop, args]]
  const getHandle = () => (current ? current.handle : null)
  // 换代过渡期把「配置/注册」类方法先暂存，commit 才落到当前（或新）实例。这里必须把「退订凭据」
  // 交回给调用方：订阅类方法（隧道连上补推、选中线路回写）返回的是取消订阅函数，如果暂存时把它
  // 吞成空，这一代 dispose 时就退订不了——反复同指纹热重载会在同一个长活实例上越挂越多，已卸载
  // 那代的闭包还挂在订阅表里，隧道再连上会把它们当活的调起来。
  const stage = (prop, args) => {
    if (!isSwapping()) return null
    const entry = { prop, args, off: null, cancelled: false }
    staged.push(entry)
    const off = () => {
      entry.cancelled = true
      const real = entry.off
      entry.off = null
      if (typeof real === 'function') { try { real() } catch { /* 已经退了 */ } }
    }
    return { result: off }
  }
  const facade = makeFacade(getHandle, { props, stageMethods, stage })
  return {
    facade,
    get current() { return getHandle() },
    adopt({ fingerprint, create: build } = {}) {
      if (typeof build !== 'function') return facade
      if (current && current.fingerprint === fingerprint) return facade
      if (pending && pending.fingerprint === fingerprint) return facade
      if (!current) { current = { fingerprint, handle: build() }; if (start) { try { Promise.resolve(start(current.handle)).catch(() => { /* 由自检兜 */ }) } catch { /* 由自检兜 */ } } ; return facade }
      pending = { fingerprint, build }
      return facade
    },
    async commit() {
      const config = staged
      staged = []
      // 回放暂存的配置/注册：订阅类方法返回的退订函数要存进 entry.off，这一代 dispose 时才好退。
      const replay = handle => {
        for (const entry of config) {
          if (entry.cancelled) continue
          try {
            if (handle && typeof handle[entry.prop] === 'function') {
              const off = handle[entry.prop](...entry.args)
              if (typeof off === 'function') entry.off = off
            }
          } catch { /* 回放失败不挡切换 */ }
        }
      }
      if (pending) {
        const prev = current
        const fingerprint = pending.fingerprint
        const build = pending.build
        pending = null
        let next
        try { next = build() } catch (error) { if (prev) current = prev; throw error }
        replay(next)
        if (prev) { try { await stop(prev.handle) } catch { /* 已经停了 */ } }
        try { if (start) await start(next) } catch { /* 起不来就退回旧实例，别把没起来的设成当前 */ if (prev) { try { if (start) await start(prev.handle) } catch { /* 尽力恢复 */ } current = prev } return }
        current = { fingerprint, handle: next }
      } else {
        replay(getHandle())
      }
    },
    rollback() { pending = null; staged = [] },
    /** boot/补齐里某一代先 adopt 建出实例后又装载失败：收回它，让回退代能干净重建。
     *  必须 await 停完再返回：不等旧 worker 真退就进下一代，两个 sidecar 可能抢同一个 LAN 端口。 */
    async reset() { const prev = current; current = null; pending = null; staged = []; if (prev) { try { if (stop) await stop(prev.handle) } catch { /* 已经停了 */ } } },
    async dispose() { if (current) { const handle = current.handle; current = null; try { if (stop) await stop(handle) } catch { /* 已经停了 */ } } },
  }
}

export function installTransportHosts(ctx) {
  const warn = (message, detail) => {
    try { ctx.logger?.warn?.(`dsh-mobile-plugin: ${message}${detail ? ` ${detail}` : ''}`) } catch { /* 日志不许反噬 */ }
  }

  // 换代事务开关：runtime 在 reload 开始调 begin，在提交成功 commit / 失败 rollback 时关闭。
  let inSwap = false
  const isSwapping = () => inSwap

  // ── sidecar：中转隧道 + 局域网监听（提交时才换实例） ────────────────
  const sidecarToken = crypto.randomBytes(32).toString('hex')
  const sidecarSlot = createSwapSlot({
    start: handle => handle.start(),
    stop: handle => handle.stop(),
    props: ['sidecarToken'],
    stageMethods: ['setProviders', 'onTunnelUp', 'onRouteAdopted'],
    isSwapping,
  })
  const sidecarAdopt = ({ fingerprint, create } = {}) =>
    sidecarSlot.adopt({ fingerprint, create: typeof create === 'function' ? () => create({ token: sidecarToken }) : create })
  // 旧代（不认识 adopt）把这份服务当 lifecycle 用：把门面本身当 host，挂上 adopt/lifecycle，旧代 .start() 也不会崩。
  const sidecarHost = new Proxy(sidecarSlot.facade, {
    get(target, prop) {
      if (prop === 'adopt') return sidecarAdopt
      if (prop === 'lifecycle') return sidecarSlot.current
      return target[prop]
    },
  })
  ctx.reflect.provide('dshMobileSidecarHost', sidecarHost)

  // ── FRP 直连：frpc 子进程（可选线路：按指纹沿用/重建） ─────────────
  let frpPortProvider = () => 0
  let frpEntry = null
  const frpRunnerOf = () => (frpEntry ? frpEntry.runner : null)
  ctx.reflect.provide('dshMobileTransportFrp', {
    get runner() { return frpRunnerOf() },
    adopt: ({ fingerprint, create } = {}) => {
      if (typeof create !== 'function') return frpRunnerOf()
      if (frpEntry && frpEntry.fingerprint === fingerprint) return frpEntry.runner
      const previous = frpEntry
      const runner = create({ portOf: () => frpPortProvider() })
      frpEntry = { fingerprint, runner }
      if (previous && previous.runner !== runner) { try { void previous.runner.dispose() } catch { /* 已经停了 */ } }
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

  // ── 总控上报：常连的出站客户端（提交时才换客户端 / 事务化注入来源） ──
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
  let controlPending = null // { fingerprint, create }
  let controlStaged = null // 换代事务期暂存的来源
  const controlFacade = makeFacade(() => (controlCurrent ? controlCurrent.client : null), { props: ['targetUrl'] })
  const controlAdopt = ({ fingerprint, create } = {}) => {
    if (typeof create !== 'function') return controlFacade
    if (controlCurrent && controlCurrent.fingerprint === fingerprint) return controlFacade
    if (controlPending && controlPending.fingerprint === fingerprint) return controlFacade
    if (!controlCurrent) { const store = controlDefaults(); controlCurrent = { fingerprint, store, client: create(store) }; return controlFacade }
    controlPending = { fingerprint, create }
    return controlFacade
  }
  ctx.reflect.provide('dshMobileTransportControl', {
    get client() { return controlFacade },
    adopt: controlAdopt,
    setProviders: p => {
      const patch = p && typeof p === 'object' ? p : {}
      if (isSwapping()) { controlStaged = { ...(controlStaged || {}), ...patch }; return }
      if (!controlCurrent) return
      Object.assign(controlCurrent.store, patch)
      controlCurrent.client.start()
      controlCurrent.client.sync()
    },
  })

  // ── 对话页长连接（mux，提交时才换服务 / 事务化注入鉴权） ────────────
  let muxAuthorize = () => false
  let muxCurrent = null // { fingerprint, service }
  let muxPending = null // { fingerprint, build }
  let muxStagedAuthorize = null
  const muxFacade = makeFacade(() => (muxCurrent ? muxCurrent.service : null))
  const buildMuxService = create => create({ upstream: { port: ctx.webServer.port }, authorize: req => muxAuthorize(req), onLog: message => { try { ctx.logger?.info?.(`dsh-mobile-plugin: ${message}`) } catch { /* ignore */ } } })
  const muxAdopt = ({ fingerprint, create } = {}) => {
    if (typeof create !== 'function') return muxFacade
    if (muxCurrent && muxCurrent.fingerprint === fingerprint) return muxFacade
    if (muxPending && muxPending.fingerprint === fingerprint) return muxFacade
    if (!muxCurrent) { muxCurrent = { fingerprint, service: buildMuxService(create) }; return muxFacade }
    muxPending = { fingerprint, build: () => buildMuxService(create) }
    return muxFacade
  }
  ctx.reflect.provide('dshMobileTransportMux', {
    get service() { return muxFacade },
    /** 当前有几条手机长连接（自动更新用来判断「有没有人在用」）。服务还没起 / 老服务没有这个方法时按 0。 */
    get activeMuxConnections() {
      const svc = muxCurrent && muxCurrent.service
      return svc && typeof svc.connectionCount === 'function' ? svc.connectionCount() : 0
    },
    adopt: muxAdopt,
    setProviders: p => {
      const fn = p && typeof p.authorize === 'function' ? p.authorize : null
      if (!fn) return
      if (isSwapping()) { muxStagedAuthorize = fn; return }
      muxAuthorize = fn
    },
  })
  try {
    if (typeof ctx.webServer.registerUpgrade === 'function') {
      ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/mobile/v1/mux', handler: (req, socket, head) => { const s = muxCurrent ? muxCurrent.service : null; if (!s || typeof s.handleUpgrade !== 'function') { try { socket.destroy() } catch { /* ignore */ } return } return s.handleUpgrade(req, socket, head) }, auth: 'anonymous' }), 'dsh-mobile-plugin: mux upgrade route')
    }
  } catch { /* 宿主没有升级路由能力时这条不挂，App 走 HTTP/SSE 兜底 */ }

  const commitControl = () => {
    if (controlPending) {
      const prev = controlCurrent
      const fingerprint = controlPending.fingerprint
      const create = controlPending.create
      const store = { ...controlDefaults(), ...(controlStaged || {}) }
      const client = create(store)
      try { if (prev) prev.client.stop() } catch { /* 已经停了 */ }
      try { client.start(); client.sync() } catch (error) {
        // 新客户端起不来就别把没起来的设成当前（否则上报从此静默中断）：退回旧客户端继续上报。
        if (prev) { try { prev.client.start(); prev.client.sync() } catch { /* 尽力恢复 */ } controlCurrent = prev }
        controlPending = null
        controlStaged = null
        warn('总控上报换客户端启动失败，保留旧客户端：', error?.message || String(error))
        return
      }
      controlCurrent = { fingerprint, store, client }
      controlPending = null
    } else if (controlStaged && controlCurrent) {
      Object.assign(controlCurrent.store, controlStaged)
      try { controlCurrent.client.start(); controlCurrent.client.sync() } catch { /* ignore */ }
    }
    controlStaged = null
  }
  const commitMux = () => {
    if (muxPending) {
      const prev = muxCurrent
      const fingerprint = muxPending.fingerprint
      const build = muxPending.build
      if (muxStagedAuthorize) muxAuthorize = muxStagedAuthorize
      const service = build()
      try { if (prev && prev.service !== service) prev.service.dropAll?.() } catch { /* ignore */ }
      muxCurrent = { fingerprint, service }
      muxPending = null
    } else if (muxStagedAuthorize) {
      muxAuthorize = muxStagedAuthorize
    }
    muxStagedAuthorize = null
  }

  // ── 提交/回滚协调：运行时在换代开始 begin、提交成功 commit、失败 rollback ──
  ctx.reflect.provide('dshMobileTransportSwap', {
    begin: () => { inSwap = true },
    commit: async () => {
      try { await sidecarSlot.commit() } catch (error) { warn('sidecar 换代切换失败：', error?.message || String(error)) }
      try { commitControl() } catch (error) { controlPending = null; controlStaged = null; warn('总控上报换代切换失败：', error?.message || String(error)) }
      try { commitMux() } catch (error) { muxPending = null; muxStagedAuthorize = null; warn('mux 换代切换失败：', error?.message || String(error)) }
      inSwap = false
    },
    rollback: () => {
      try { sidecarSlot.rollback() } catch { /* ignore */ }
      controlPending = null; controlStaged = null
      muxPending = null; muxStagedAuthorize = null
      inSwap = false
    },
    // boot/补齐里某代 adopt 建出实例后又装载失败：把三条主链路收回，回退代才能干净重建。
    // 收 sidecar 要 await 停完，否则与回退代新建的 sidecar 抢同一个 LAN 端口。
    abort: async () => {
      try { await sidecarSlot.reset() } catch { /* ignore */ }
      if (controlCurrent) { try { await controlCurrent.client.stop() } catch { /* ignore */ } }
      controlCurrent = null; controlPending = null; controlStaged = null
      if (muxCurrent) { try { await muxCurrent.service.dropAll?.() } catch { /* ignore */ } }
      muxCurrent = null; muxPending = null; muxStagedAuthorize = null
      inSwap = false
    },
  })
  ctx.effect(() => () => { void sidecarSlot.dispose() }, 'dsh-mobile-plugin: sidecar transport host')
  ctx.effect(() => () => { if (controlCurrent) { try { controlCurrent.client.stop() } catch { /* ignore */ } } }, 'dsh-mobile-plugin: control transport host')
  ctx.effect(() => () => { if (muxCurrent) { try { muxCurrent.service.dropAll?.() } catch { /* ignore */ } } }, 'dsh-mobile-plugin: mux transport host')

  // ── 可选线路的通用登记表（新线路走这里，不再逐条改外壳） ─────────────
  const looseMount = (label, fn) => { try { return fn() } catch (error) { warn(`${label} 没挂上：${error && error.message ? error.message : error}`); return undefined } }

  // 通用登记表：以后新增可选线路由代调 `adopt` 声明，外壳一行都不用动（见 optional-lines.js）。
  // frp / 隧道助手 / 点对点仍走各自的老挂法，等它们下次改动再迁过来即可，迁不迁不影响新线路。
  const extraLines = createOptionalLineRegistry({ ctx, warn })
  ctx.reflect.provide('dshMobileTransportExtraLines', {
    adopt: spec => extraLines.adopt(spec),
    get: name => extraLines.get(name),
    control: name => extraLines.control(name),
  })

  // ── 隧道助手（直连隧道，可选线路：按指纹沿用/重建） ────────────────
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

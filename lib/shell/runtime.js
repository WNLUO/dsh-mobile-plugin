/** 2026-11-28：卸载时把稳定分派器与分发表一并撤干净，停用后不再把请求转给已卸载的实现。 */
/**
 * 代际运行时：把「外壳」和「某一代实现」缝在一起，并负责换代那一刻的秩序。
 *
 * 外壳只做两件事：启动时激活版本最高的一代，以及把换代请求转给这里。实现侧拿到的是一个普通
 * 的 cordis `Context`，不知道自己是被外壳装进来的。
 *
 * 换代必须串行、且先停后起：一代在 `apply` 里会注册同一条路径的路由（撞路径直接抛错）、绑
 * sidecar、起镜像推送，只能先 dispose 旧代（每个 `ctx.effect` 反向清理），再装新代。
 *
 * 换代前先等 `inFlight` 归零，最多等 `DRAIN_TIMEOUT_MS`——把清理跑在别人的请求中间会出事，
 * 但卡住的请求也不该拖住一次修复性更新。
 */

import { importGeneration, invalidateGeneration, resolveGeneration, resolveGenerations } from './manager.js'
import { checkGenerationAlive } from './self-check-after-swap.js'

/** 换代前等在飞请求归零的上限。 */
const DRAIN_TIMEOUT_MS = 2000
/**
 * 等一代装载完成的上限。装载卡住（依赖永远不来）时不能把整个外壳拖死。
 *
 * 20s 在慢机器上不够：失败的首要原因就是注入的服务（typertGateway / apiProxy）比本插件
 * 晚就位，而 Windows 冷启动、装了一堆插件的 DSH 要几十秒才轮到那条服务。真实现场是
 * 「重启还是不行」—— 设置页一句 404，日志里什么都没有。
 */
const ACTIVATE_TIMEOUT_MS = 60000
/** 首次装载全失败后的重试间隔与次数（重试理由见 `start()`）。 */
const START_RETRY_LIMIT = 6
/**
 * 启动那一轮没成之后，后台继续按这个节奏重试多久。
 *
 * 失败代价是**整张控制面路由表都不在**，而根因多半是「服务晚到」这种会自己好的事。
 * 只重试启动那六次（约五分钟）然后就躺平，等于把一个瞬态问题固定成故障，用户唯一的
 * 出路是重启 —— 而重启正好又落回同一个时间窗里。这里按长间隔再试一小时，并让设置页
 * 看得到「还在试」。
 */
const RETRY_BACKLOG_MS = 120000
const RETRY_BACKLOG_LIMIT = 30
/** 间隔可用环境变量压低，只给测试（与 `DSH_MOBILE_PROFILE_NODE_MODULES` 同款逃生口）。 */
const START_RETRY_MS = Number(process.env.DSH_MOBILE_START_RETRY_MS) > 0
  ? Number(process.env.DSH_MOBILE_START_RETRY_MS)
  : 30000

/**
 * 代没有声明 `inject` 时的兜底（只有测试里的假代会走这里）。
 *
 * 真实实现 `lib/impl.js` 一定声明 inject，而且是按运行时二选一的，所以这里**不能**
 * 拿它去覆盖代自己的声明 —— 那会把旧运行时要用的 `apiProxy` 抹掉。兜底值同样只留
 * `webServer`：多一个服务就多一种「整行 pending」的理由。
 */
const DEFAULT_INJECT = ['webServer']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createRuntime() {
  /** 外壳那份 `apply` 拿到的 context。装载完成前是 null。 */
  let ctx = null
  /** 当前活跃的 fiber（旧代）。 */
  let fiber = null
  /**
   * 当前这一代**已经 import 进来的模块本体**。
   *
   * 回滚必须用它，不能靠「按版本号再挑一次」：市场装新版会把旧的 store 目录整个带走，
   * 那一刻盘上已经找不到旧代了 —— 照版本号找会拿到 null，于是回滚失败、插件彻底没有
   * 活跃实现（手机连不上，日志里只剩一行 pending）。模块本体在内存里，重新 `apply`
   * 一次就是完整的旧代。
   */
  let loadedCurrent = null
  /** 当前代的描述（`{version, source, dir, hostPath}` 的子集）。 */
  let current = null
  /** 上一次成功激活过的代，供回滚。 */
  let previous = null
  /** 串行化所有换代动作。 */
  let swapping = null
  /** 在飞请求计数（`beginRequest` / `endRequest` 维护）。 */
  let inFlight = 0

  // ── 蓝绿路由分发表 ───────────────────────────────────────────────────
  // 六条传输都归外壳之后，新旧两代可以短暂并存：新一代把它注册的路由登记到 stage 表，并给每个
  // 路径挂一个**稳定分派器**（每个路径只挂一次，分派器读 live 表）。提交时原子把 live 指向
  // 新代、旧代继续服务在飞请求，排空后再卸。这样换代码那一刻没有「路由暂缺 / 404」的空窗，
  // 也不会因为新旧两代注册同一路径撞「duplicate route」。
  let applying = false
  let liveHttp = new Map()
  let liveUp = new Map()
  let stageHttp = null
  let stageUp = null
  const httpDispatchers = new Map() // path -> unregister
  const upDispatchers = new Map()
  let dispatchServer = null
  let dispatchOuter = null
  let dispatchOuterUpgrade = null

  /** 外壳把真实服务器的原始 register/registerUpgrade 交给运行时（只调一次）。 */
  function installDispatch(server, outer, outerUpgrade) {
    dispatchServer = server
    dispatchOuter = typeof outer === 'function' ? outer : null
    dispatchOuterUpgrade = typeof outerUpgrade === 'function' ? outerUpgrade : null
  }

  /**
   * 给 route.handler 外面套「进 +1 / 出 -1」；拿不到 handler 原样返回。
   *
   * 必须**原样透传全部实参**：新版 web 服务器按 `handler(req, res, peer)` 调用，第三个
   * 是准入后的 peer 上下文；只转 `(req, res)` 会丢掉 peer，RPC 端拿不到身份就一直挂着
   * 不响应（表现为桌面「Loading plugins…」卡死、`/api` 全部超时）。
   */
  function wrapInFlight(route) {
    if (!route || typeof route.handler !== 'function') return route
    const handler = route.handler
    route.handler = async (...args) => {
      inFlight += 1
      try { return await handler(...args) } finally { inFlight = Math.max(0, inFlight - 1) }
    }
    return route
  }

  function ensureHttpDispatcher(path, sample) {
    if (httpDispatchers.has(path) || !dispatchServer || !dispatchOuter) return
    const dispatcher = {
      // 原样带上样例路由的其余字段（尤其 `auth` 准入策略）——新版宿主按 `auth` 判准入，
      // 漏掉它会被当成 "required"，把本该由插件自己 token 守卫的移动端路由挡在网关外。
      ...(sample || {}),
      kind: sample && sample.kind,
      path,
      handler: async (...args) => {
        const res = args[1]
        const live = liveHttp.get(path)
        if (!live || typeof live.handler !== 'function') {
          try { res.statusCode = 404 } catch { /* ignore */ }
          try { res.end && res.end('') } catch { /* ignore */ }
          return
        }
        return live.handler(...args)
      },
    }
    const unregister = dispatchOuter.call(dispatchServer, wrapInFlight(dispatcher))
    httpDispatchers.set(path, typeof unregister === 'function' ? unregister : () => {})
  }

  function ensureUpDispatcher(path, sample) {
    if (upDispatchers.has(path) || !dispatchServer || !dispatchOuterUpgrade) return
    const dispatcher = {
      ...(sample || {}),
      handler: (...args) => {
        const [, socket] = args
        const live = liveUp.get(path)
        if (!live || typeof live.handler !== 'function') {
          try { if (socket) socket.destroy() } catch { /* ignore */ }
          return
        }
        return live.handler(...args)
      },
    }
    const unregister = dispatchOuterUpgrade.call(dispatchServer, dispatcher)
    upDispatchers.set(path, typeof unregister === 'function' ? unregister : () => {})
  }

  /** 代注册一条 HTTP 路由。装在分发表里；只有「外壳自己的路由」（非装载期）才直挂真服务器。 */
  function registerRoute(route, outer, thisArg) {
    if (!applying) return outer.call(thisArg, wrapInFlight(route))
    if (!route || typeof route.path !== 'string') return () => {}
    stageHttp.set(route.path, route)
    ensureHttpDispatcher(route.path, route)
    return () => {}
  }

  /** 代注册一条升级（WebSocket）路由，同上。 */
  function registerUpgradeRoute(route, outer, thisArg) {
    if (!applying) return outer.call(thisArg, route)
    if (!route || typeof route.path !== 'string') return () => {}
    stageUp.set(route.path, route)
    ensureUpDispatcher(route.path, route)
    return () => {}
  }

  function beginActivation() {
    applying = true
    stageHttp = new Map()
    stageUp = new Map()
  }

  /** 原子提交：live 指向新代；旧代有、新代没有的分派器撤掉。返回提交前的 live 快照供回退。 */
  function commitActivation() {
    const prev = { http: liveHttp, up: liveUp }
    for (const path of liveHttp.keys()) {
      if (!stageHttp.has(path) && httpDispatchers.has(path)) {
        try { httpDispatchers.get(path)() } catch { /* ignore */ }
        httpDispatchers.delete(path)
      }
    }
    for (const path of liveUp.keys()) {
      if (!stageUp.has(path) && upDispatchers.has(path)) {
        try { upDispatchers.get(path)() } catch { /* ignore */ }
        upDispatchers.delete(path)
      }
    }
    liveHttp = stageHttp
    liveUp = stageUp
    stageHttp = null
    stageUp = null
    applying = false
    return prev
  }

  /** 装载失败：丢弃 staging，撤掉只为新代挂上的分派器；live 不动。 */
  function rollbackActivation() {
    if (stageHttp) {
      for (const path of stageHttp.keys()) {
        if (!liveHttp.has(path) && httpDispatchers.has(path)) {
          try { httpDispatchers.get(path)() } catch { /* ignore */ }
          httpDispatchers.delete(path)
        }
      }
    }
    if (stageUp) {
      for (const path of stageUp.keys()) {
        if (!liveUp.has(path) && upDispatchers.has(path)) {
          try { upDispatchers.get(path)() } catch { /* ignore */ }
          upDispatchers.delete(path)
        }
      }
    }
    stageHttp = null
    stageUp = null
    applying = false
  }

  /** 自检失败：把 live 换回旧代；新代独有分派器撤掉，旧代独有的补回（旧 fiber 一直活着）。 */
  function restoreLive(prev) {
    for (const path of liveHttp.keys()) {
      if (!prev.http.has(path) && httpDispatchers.has(path)) {
        try { httpDispatchers.get(path)() } catch { /* ignore */ }
        httpDispatchers.delete(path)
      }
    }
    for (const path of prev.http.keys()) if (!liveHttp.has(path)) ensureHttpDispatcher(path, prev.http.get(path))
    for (const path of liveUp.keys()) {
      if (!prev.up.has(path) && upDispatchers.has(path)) {
        try { upDispatchers.get(path)() } catch { /* ignore */ }
        upDispatchers.delete(path)
      }
    }
    for (const path of prev.up.keys()) if (!liveUp.has(path)) ensureUpDispatcher(path, prev.up.get(path))
    liveHttp = prev.http
    liveUp = prev.up
  }

  let lastError = null
  let activatedAt = null
  let detached = false
  /**
   * 最近一次「装上了、但新版自检没过，于是自己退回去」的记录。
   *
   * 为什么要它：这件事**不能靠手机按回滚** —— 装坏的后果是 App 连不上这台设备，那一刻
   * 手机上任何按钮都发不出去。所以退回是宿主自己做的，而手机只能在**下一次连上之后**
   * 读到这条已经发生过的事实（`lastApply.rolledBack` 就是从它来的）。
   */
  let lastRollback = null
  /**
   * 后台补齐重试的账：启动那一轮失败后接着试，试到成功或额度用完。
   *
   * 这三格同时也是说给用户听的：`retrying` 决定面板劝人「再等等」还是「重装」，
   * `nextRetryAt` 让人知道下一次是几分钟后。
   */
  let retryTimer = null
  let retryAttempts = 0
  let nextRetryAt = null

  /** 对外状态快照。控制面接口直接把它交给客户端。 */
  function status() {
    return {
      version: current?.version ?? null,
      source: current?.source ?? null,
      previousVersion: previous?.version ?? null,
      activatedAt,
      lastError,
      inFlight,
      swapping: swapping !== null,
      lastRollback,
      retrying: retryTimer !== null,
      retryAttempts,
      nextRetryAt,
    }
  }

  /** 装载一代并等它真正 ACTIVE。失败抛错，由调用方决定是否回滚。 */
  async function activate(generation) {
    return activateLoaded(await importGeneration(generation))
  }

  /**
   * 把已经 import 进来的那代装上去（回滚走这条）。
   *
   * 回滚**不重新 import**：新代装失败时旧代的目录可能已经被市场删掉了，重新读盘会
   * MODULE_NOT_FOUND；而旧代的模块本体一直在内存里，重新 apply 一次就够了。
   */
  async function activateLoaded(loaded, options = {}) {
    const commit = options.commit !== false
    let timer = null
    // 用 `{ inject, apply }` 而不是裸函数：cordis 只有在**声明过** inject 的 fiber 上
    // 才允许 `ctx.webServer` 这种取值（裸函数会以 "cannot get property without inject"
    // 失败）。代里的实现自己声明了 `inject`，但它作为插件对象被装进来时那份声明不会
    // 自动生效，所以外壳在这里转交给 cordis。
    //
    // 用代自己声明的 inject，不写死：`lib/impl.js` 的 inject 是**按运行时二选一**的
    // （旧运行时多一个 `apiProxy`，0.2.0 没有）。写死成 `['webServer','sessions']` 会让
    // 旧运行时上读 `ctx.apiProxy` 抛 "cannot get property apiProxy without inject"。
    // 测试里的假代没声明 inject 时退回外壳默认值。
    const inject = Array.isArray(loaded.inject) && loaded.inject.length > 0 ? loaded.inject : DEFAULT_INJECT
    beginActivation()
    let result
    try {
      result = await Promise.race([
        Promise.resolve().then(() => ctx.plugin({ inject, apply: loaded.apply })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`装载 ${loaded.version} 超时（${ACTIVATE_TIMEOUT_MS}ms）：它可能卡在等一个永远不来的依赖服务上`)), ACTIVATE_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      // 装载失败：丢掉 staging、撤掉只为新代挂的分派器，live 保持旧代不动。
      rollbackActivation()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    // 默认直接提交（start / attemptAll / 回滚装载）；reload 要自检，先不提交，由它自己 commit。
    if (commit) commitActivation()
    return { loaded, fiber: result }
  }

  function describe(loaded, dir) {
    return { version: loaded.version, source: loaded.source, hostPath: loaded.hostPath ?? dir ?? null }
  }

  /**
   * 换代之后问一次自己的 `/health`：这一代真的在跑、路由真的挂上了吗？
   *
   * 端口取**运行中那一份**（`ctx.webServer.port`），不是配置里的默认值 —— 端口被改过之后
   * 两者可能不同，按配置去问会问到一个没人监听的地方，于是「自检失败」全是假的。
   * 拿不到端口时返回 `skip` 而不是失败：那种现场（老宿主、测试里的假 ctx）不代表新版坏了。
   */
  async function checkSelfCheck() {
    let port = null
    try { port = ctx?.webServer?.port ?? null } catch { port = null }
    return checkGenerationAlive({ port })
  }

  /**
   * 把上一代装回去，并记下「退回过」这件事。
   *
   * 顺序是刻意的：**先用内存里那份**（`loadedCurrent`），因为它一定还在；盘上那份可能
   * 已经被这次安装带走了（pnpm 换 store 目录），照版本号找会找空。
   *
   * 记 `lastRollback` 是给手机的：它不按回滚，只在**下一次连上之后**读到这条已经发生过
   * 的事实（`lastApply.rolledBack`）。容器里带 `ok`，退失败也要如实说。
   */
  async function rollbackTo(oldCurrent, oldLoaded, reason) {
    let ok = false
    try {
      if (oldLoaded) {
        const { fiber: nextFiber } = await activateLoaded(oldLoaded)
        fiber = nextFiber
        loadedCurrent = oldLoaded
        current = describe(oldLoaded, oldCurrent?.dir ?? null)
        activatedAt = new Date().toISOString()
        ok = true
      } else {
        const fallback = resolveGeneration(oldCurrent?.version)
        if (fallback) {
          const { loaded, fiber: nextFiber } = await activate(fallback)
          fiber = nextFiber
          loadedCurrent = loaded
          current = describe(loaded, fallback.dir)
          activatedAt = new Date().toISOString()
          ok = true
        }
      }
    } catch (rollbackError) {
      lastError = `${reason}；回滚到 ${oldCurrent?.version ?? '上一代'} 也失败：${rollbackError?.message || rollbackError}`
      lastRollback = {
        at: new Date().toISOString(),
        ok: false,
        toVersion: null,
        fromVersion: previous?.version ?? null,
        reason,
      }
      return false
    }
    lastRollback = {
      at: new Date().toISOString(),
      ok,
      toVersion: ok ? (current?.version ?? null) : null,
      fromVersion: previous?.version ?? null,
      reason,
    }
    return ok
  }

  /**
   * 换到指定版本（默认版本最高的那一代）。
   *
   * 旧代先停、新代后起；新代起不来就回滚把旧代装回去，并把错误留在 `lastError` 里——
   * 「更新把自己弄挂了」必须能被看见，而不是静默少个插件。
   *
   * `options.reread` 是给**开发机**的那条路：版本号与目录都没变，只是盘上
   * 那几个文件被改了。默认会走上面那句「身份一致就直接返回」，于是改完代码再触发也没有
   * 任何变化 —— 开发时看到的「改了不生效」就是这么来的。带上它就先把这一代从
   * `imported` 里作废、再让 `importGeneration` 清掉 CJS 子树，强制重新读盘。
   *
   * 这条**不给市场更新用**：市场每次都是新目录（新 realpath），天然绕开全部缓存，
   * 走 reread 只是白清一遍缓存。
   */
  async function reload(preferVersion, options = {}) {
    if (detached) throw new Error('插件已经卸载，不能再换代')
    if (swapping) return swapping
    // 三条主链路的"提交时才换实例"协调器：提交成功才换、失败保留旧实例（见 shell/transport-host.js）。
    const swap = (() => { try { return typeof ctx?.get === 'function' ? ctx.get('dshMobileTransportSwap') || null : null } catch { return null } })()
    swapping = (async () => {
      const target = resolveGeneration(preferVersion)
      if (!target) throw new Error('找不到任何一代实现：包内的 lib/impl.js 缺失')
      const sameGeneration = current
        && target.version === current.version
        && target.source === current.source
        && target.dir === current.hostPath
      // 同版本也可能从 OTA 切到 npm：来源与 realpath 不同就必须重新装载。
      if (sameGeneration && options.reread !== true) return status()
      // 同一份目录里改了文件：不清缓存的话，重新 import 拿回来的还是内存里那份旧实现。
      if (options.reread === true) invalidateGeneration(target.version)

      // 先把新代模块整份读进内存（解析、依赖树、磁盘这一大段是本该慢的部分），**在动旧代之前**。
      // 好处有两条：a) 新代连 import 就失败（缺文件 / 语法错 / 依赖解析不到）时，旧代毫发无损、
      // 根本不进换代；b) 真正切换那一刻只剩 apply，旧路由摘掉到新路由挂上的空窗被压到最小。
      const prepared = await importGeneration(target)

      await drain()
      const oldFiber = fiber
      const oldCurrent = current
      // 旧的**模块本体**要在激活新代之前抓住：`loadedCurrent` 一旦被新代覆盖，回滚就只能
      // 拿到刚装坏的那一份。
      const oldLoaded = loadedCurrent
      const oldActivatedAt = activatedAt
      // 蓝绿：不再先卸旧代。新代先登记到分发表（staging），旧代继续服务在飞请求；提交后才卸
      // 旧代。这样换代码那一刻没有路由空窗，也不会因为新旧两代注册同一路径撞 duplicate route。
      try {
        // 换代事务开始：这期间新代注入的 providers/authorize 只暂存，提交成功才落、失败即丢。
        if (swap && typeof swap.begin === 'function') { try { swap.begin() } catch { /* ignore */ } }
        const next = await activateLoaded(prepared, { commit: false })
        // 原子提交：分发表切到新代
        const prevLive = commitActivation()
        fiber = next.fiber
        loadedCurrent = next.loaded
        current = describe(next.loaded, target.dir)
        activatedAt = new Date().toISOString()
        lastError = null
        // 自检：此刻 live 已是新代，真打一发确认手机要的那批接口能应答。
        if (options.selfCheck !== false && oldCurrent) {
          const alive = await checkSelfCheck()
          if (alive.ok === false) {
            const failure = `新版 ${target.version} 换上来之后没通过自检：${alive.reason}`
            // 退回旧代：分发表切回、卸新代；旧 fiber 一直活着，没有空窗。
            restoreLive(prevLive)
            fiber = oldFiber
            loadedCurrent = oldLoaded
            current = oldCurrent
            activatedAt = oldActivatedAt
            if (swap && typeof swap.rollback === 'function') { try { swap.rollback() } catch { /* ignore */ } }
            const brokenFiber = next.fiber
            if (brokenFiber) { try { await brokenFiber.dispose() } catch { /* 卸不干净也照退 */ } }
            lastRollback = { at: new Date().toISOString(), ok: true, toVersion: oldCurrent?.version ?? null, fromVersion: target.version, reason: failure }
            lastError = failure
            const error = new Error(failure)
            error.code = 'self_check_failed'
            throw error
          }
        }
        // 自检通过 = 这次换代真的成功：这时才把三条主链路的实例换成新实现；失败路径不会走到这。
        if (swap && typeof swap.commit === 'function') { try { await swap.commit() } catch (error) { lastError = `换代切换传输失败：${error?.message || error}` } }
        if (oldCurrent) previous = oldCurrent
        // 成功：旧代排空后卸掉（在飞请求仍跑旧 handler 闭包）。
        await drain()
        if (oldFiber) {
          try { await oldFiber.dispose() } catch (error) { lastError = `卸载 ${oldCurrent?.version ?? '旧代'} 时出错：${error?.message || error}` }
        }
        clearBacklogRetry()
        return status()
      } catch (error) {
        // 装载直接抛错：activateLoaded 已 rollbackActivation，旧代毫发无损（fiber/current 没动）。
        if (swap && typeof swap.rollback === 'function') { try { swap.rollback() } catch { /* ignore */ } }
        if (error?.code === 'self_check_failed') throw error
        lastError = `装载 ${target.version} 失败：${error?.message || error}`
        throw error
      }
    })().finally(() => {
      swapping = null
    })
    return swapping
  }

  /**
   * 第一次激活；最高代装载失败时按优先级尝试保留的回退代；全失败则按固定间隔重试有限次。
   *
   * 为什么要重试：一次失败 = **整张控制面路由表都不在**，而设置页
   * 的「移动端」照样画得出来（客户端半边按包扫描，不看宿主 fiber 活没活），于是现场只表现成
   * 「读取宿主状态失败: HTTP 404」。失败最常见的原因恰好是**可能自己好**的：注入的服务
   * （typertGateway / apiProxy）比本插件晚就位、撞上 20s 装载上限，或者第一次装载撞上
   * IO/时序抖动。一次失败就永久躺平到下次重启，等于把一个瞬态问题固定成故障。
   */
  /**
   * 把当前可用的每一代都试一遍：成功就装成当前代并返回 `{ok:true}`，全失败返回
   * `{ok:false, failures}`。`start()` 与后台补齐重试共用这一份，别各写一遍。
   *
   * 候选**现算**而不是启动时抓一份快照：市场换过代、OTA 落过一版之后，这里要能看见新目录。
   */
  async function attemptAll() {
    const failures = []
    // boot/补齐也接上 swap：某一代 adopt 之后失败要把它建出的实例收回，别让待建悬挂、也别继续跑坏代。
    const swap = (() => { try { return typeof ctx?.get === 'function' ? ctx.get('dshMobileTransportSwap') || null : null } catch { return null } })()
    for (const target of resolveGenerations()) {
      if (detached) throw new Error('插件已经卸载，不再重试装载')
      try {
        const { loaded, fiber: startedFiber } = await activate(target)
        fiber = startedFiber
        loadedCurrent = loaded
        current = describe(loaded, target.dir)
        activatedAt = new Date().toISOString()
        lastError = failures.length
          ? `${failures.join('；')}；已回退到 ${target.version}（${target.source}）`
          : null
        return { ok: true, version: target.version }
      } catch (error) {
        failures.push(`装载 ${target.version}（${target.source}）失败：${error?.message || error}`)
        if (swap && typeof swap.abort === 'function') { try { await swap.abort() } catch { /* ignore */ } }
      }
    }
    return { ok: false, failures }
  }

  /** 停掉后台补齐重试（装成功后调用：再试一次只会撞同一批路由）。 */
  function clearBacklogRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryAttempts = 0
    nextRetryAt = null
  }

  /**
   * 启动那一轮没成之后接着试：长间隔、有额度，成功即停。
   *
   * 它是 `lastError` 之外的第二次机会，也是「用户什么都不做也能自己好」的那条路。
   */
  function scheduleBacklogRetry(log) {
    if (detached || retryTimer !== null || retryAttempts >= RETRY_BACKLOG_LIMIT) return
    retryAttempts += 1
    nextRetryAt = new Date(Date.now() + RETRY_BACKLOG_MS).toISOString()
    retryTimer = setTimeout(() => {
      retryTimer = null
      nextRetryAt = null
      if (detached) return
      void attemptAll().then(result => {
        if (result.ok) {
          retryAttempts = 0
          log('info', 'dsh-mobile-plugin: 后台补齐成功，已装载 %s', result.version)
          return
        }
        lastError = `所有可用插件实现均装载失败：${result.failures.join('；')}`
        log('warn', 'dsh-mobile-plugin: 后台补齐仍未成功：%s', lastError)
        scheduleBacklogRetry(log)
      }).catch(error => {
        lastError = `后台补齐装载出错：${error?.message || error}`
        scheduleBacklogRetry(log)
      })
    }, RETRY_BACKLOG_MS)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  /**
   * 第一次激活；最高代装载失败时按优先级尝试保留的回退代；全失败则按固定间隔重试有限次，
   * 之后交给后台补齐接着试。
   *
   * 为什么要重试：一次失败 = **整张控制面路由表都不在**，而设置页
   * 的「移动端」照样画得出来（客户端半边按包扫描，不看宿主 fiber 活没活），于是现场只表现成
   * 「读取宿主状态失败: HTTP 404」。失败最常见的原因恰好是**可能自己好**的：注入的服务
   * （typertGateway / apiProxy）比本插件晚就位、撞上装载上限，或者第一次装载撞上 IO/时序抖动。
   * 一次失败就永久躺平到下次重启，等于把一个瞬态问题固定成故障。
   */
  async function start(context, options = {}) {
    ctx = context
    const log = typeof options.log === 'function' ? options.log : () => {}
    if (!resolveGenerations().length) throw new Error('找不到任何一代实现：包内的 lib/impl.js 缺失')
    let lastFailure = ''
    for (let attempt = 1; attempt <= START_RETRY_LIMIT; attempt += 1) {
      const result = await attemptAll()
      if (result.ok) {
        clearBacklogRetry()
        return status()
      }
      lastFailure = `所有可用插件实现均装载失败：${result.failures.join('；')}`
      if (attempt >= START_RETRY_LIMIT) break
      lastError = `${lastFailure}（第 ${attempt} 次，${START_RETRY_MS / 1000}s 后重试）`
      log('warn', 'dsh-mobile-plugin: 装载失败，%d 秒后重试：%s', START_RETRY_MS / 1000, lastFailure)
      await sleep(START_RETRY_MS)
    }
    lastError = lastFailure
    // 抛出去是为了让外壳那行日志照旧留下；后台补齐另起一条线，两条不冲突。
    scheduleBacklogRetry(log)
    throw new Error(lastFailure)
  }

  /** 等在飞请求结束（最多 `DRAIN_TIMEOUT_MS`）。 */
  async function drain() {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (inFlight > 0 && Date.now() < deadline) {
      await sleep(25)
    }
  }

  /** 外壳被卸载时调用：停当前代，之后不再接受换代。 */
  async function detach() {
    detached = true
    clearBacklogRetry()
    const oldFiber = fiber
    fiber = null
    current = null
    // 停用/卸载这一层时，光停当前这一代不够：给每条路径挂的稳定分派器、以及它们读的 live 表
    // 都还留在宿主上，于是请求继续被转给已卸载的实现，再启用时新分派器又因撞名挂不上。
    // 这里把分派器和分发表一并撤干净；撤之前先让在飞请求排空，别把正在服务的 handler 抽走。
    try {
      await drain()
      if (oldFiber) await oldFiber.dispose()
    } finally {
      for (const unregister of httpDispatchers.values()) { try { unregister() } catch { /* ignore */ } }
      for (const unregister of upDispatchers.values()) { try { unregister() } catch { /* ignore */ } }
      httpDispatchers.clear()
      upDispatchers.clear()
      liveHttp = new Map()
      liveUp = new Map()
      stageHttp = null
      stageUp = null
      applying = false
    }
  }

  return {
    start,
    reload,
    detach,
    status,
    installDispatch,
    registerRoute,
    registerUpgradeRoute,
    beginRequest: () => {
      inFlight += 1
    },
    endRequest: () => {
      inFlight = Math.max(0, inFlight - 1)
    },
    /**
     * 把一个路由 handler 包成「进来 +1、出去 -1」。
     *
     * 宿主 webServer 没有 Koa 式中间件（只有 `register(route)` / `registerUpgrade` /
     * `registerFallback` / `tapIndex`），所以「在飞请求」只能在 handler 外面数。包错
     * 形状时原样返回，绝不因为统计把一条路由弄丢。
     */
    wrapHandler: (route) => {
      if (!route || typeof route.handler !== 'function') return route
      const handler = route.handler
      route.handler = async (...args) => {
        inFlight += 1
        try {
          return await handler(...args)
        } finally {
          inFlight = Math.max(0, inFlight - 1)
        }
      }
      return route
    },
  }
}

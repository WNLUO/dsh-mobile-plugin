/**
 * 代际运行时：把「外壳」和「某一代实现」缝在一起，并负责换代那一刻的秩序。
 *
 * 外壳（`lib/index.js`）只做两件事：启动时激活版本最高的一代，以及把换代请求转给这里。
 * 实现侧完全不知道自己是被外壳装进来的 —— 它拿到的是一个普通的 cordis `Context`，
 * 照常 `ctx.effect(...)` / `ctx.webServer.register(...)` / `ctx.reflect.provide(...)`。
 *
 * ## 换代为什么必须串行、而且先停后起
 *
 * 一个代在 `apply` 里会往宿主注册**同一条路径**的路由（`ctx.webServer.register` 撞路径会抛
 * `webserver: duplicate exact route`），还会绑 sidecar、起镜像推送。所以不能「先装新的再
 * 卸旧的」——只能先把旧代的 fiber dispose 掉（它的每个 `ctx.effect` 会反向执行清理：路由
 * 摘掉、子进程收掉），再装新的。这个文件里的 `swapping` 锁就是保证同一时刻只有一次换代。
 *
 * ## 让路
 *
 * 手机那边随时可能有一个请求在读事件流。直接 dispose 会把 `ctx.effect` 的清理跑在别人的
 * 请求中间。所以换代前先等 `inFlight` 归零，最多等 `DRAIN_TIMEOUT_MS`（等不到也照换——
 * 卡住的请求不该拖住一次修复性更新）。
 */

import { importGeneration, resolveGeneration, resolveGenerations } from './manager.js'

/** 换代前等在飞请求归零的上限。 */
const DRAIN_TIMEOUT_MS = 2000
/** 等一代装载完成的上限。装载卡住（依赖永远不来）时不能把整个外壳拖死。 */
const ACTIVATE_TIMEOUT_MS = 20000

/**
 * 代没有声明 `inject` 时的兜底（只有测试里的假代会走这里）。
 *
 * 真实实现 `lib/impl.js` 一定声明 inject，而且是按运行时二选一的，所以这里**不能**
 * 拿它去覆盖代自己的声明 —— 那会把旧运行时要用的 `apiProxy` 抹掉。
 */
const DEFAULT_INJECT = ['webServer', 'sessions']

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
  let lastError = null
  let activatedAt = null
  let detached = false

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
  async function activateLoaded(loaded) {
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
    const result = await Promise.race([
      Promise.resolve().then(() => ctx.plugin({ inject, apply: loaded.apply })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`装载 ${loaded.version} 超时（${ACTIVATE_TIMEOUT_MS}ms）：它可能卡在等一个永远不来的依赖服务上`)), ACTIVATE_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    return { loaded, fiber: result }
  }

  function describe(loaded, dir) {
    return { version: loaded.version, source: loaded.source, hostPath: loaded.hostPath ?? dir ?? null }
  }

  /**
   * 换到指定版本（默认版本最高的那一代）。
   *
   * 旧代先停、新代后起；新代起不来就回滚把旧代装回去，并把错误留在 `lastError` 里——
   * 「更新把自己弄挂了」必须能被看见，而不是静默少个插件。
   */
  async function reload(preferVersion) {
    if (detached) throw new Error('插件已经卸载，不能再换代')
    if (swapping) return swapping
    swapping = (async () => {
      const target = resolveGeneration(preferVersion)
      if (!target) throw new Error('找不到任何一代实现：包内的 lib/impl.js 缺失')
      // 同版本也可能从 OTA 切到 npm：来源与 realpath 不同就必须重新装载。
      if (current && target.version === current.version && target.source === current.source && target.dir === current.hostPath) return status()

      await drain()
      const oldFiber = fiber
      const oldCurrent = current
      fiber = null
      current = null
      if (oldFiber) {
        try {
          await oldFiber.dispose()
        } catch (error) {
          // dispose 里的清理动作自己炸了：记下来，但不能因此不装新代。
          lastError = `卸载 ${oldCurrent?.version ?? '旧代'} 时出错：${error?.message || error}`
        }
      }
      try {
        const { loaded, fiber: nextFiber } = await activate(target)
        fiber = nextFiber
        loadedCurrent = loaded
        current = describe(loaded, target.dir)
        if (oldCurrent) previous = oldCurrent
        activatedAt = new Date().toISOString()
        lastError = null
        return status()
      } catch (error) {
        lastError = `装载 ${target.version} 失败：${error?.message || error}`
        if (oldCurrent) {
          // 回滚：把上一代装回去，尽量让插件保持可用。
          //
          // 顺序是刻意的：**先用内存里那份**（`loadedCurrent`），因为它一定还在；盘上那份
          // 可能已经被市场这次安装带走了（pnpm 换 store 目录），照版本号找会找空。
          try {
            if (loadedCurrent) {
              const { fiber: nextFiber } = await activateLoaded(loadedCurrent)
              fiber = nextFiber
              current = describe(loadedCurrent, oldCurrent.dir ?? null)
              activatedAt = new Date().toISOString()
            } else {
              const fallback = resolveGeneration(oldCurrent.version)
              if (fallback) {
                const { loaded, fiber: nextFiber } = await activate(fallback)
                fiber = nextFiber
                loadedCurrent = loaded
                current = describe(loaded, fallback.dir)
                activatedAt = new Date().toISOString()
              }
            }
          } catch (rollbackError) {
            lastError = `${lastError}；回滚到 ${oldCurrent.version} 也失败：${rollbackError?.message || rollbackError}`
          }
        }
        throw error
      }
    })().finally(() => {
      swapping = null
    })
    return swapping
  }

  /** 第一次激活；最高代装载失败时按优先级尝试保留的回退代。 */
  async function start(context) {
    ctx = context
    const candidates = resolveGenerations()
    if (!candidates.length) throw new Error('找不到任何一代实现：包内的 lib/impl.js 缺失')
    const failures = []
    for (const target of candidates) {
      try {
        const { loaded, fiber: startedFiber } = await activate(target)
        fiber = startedFiber
        loadedCurrent = loaded
        current = describe(loaded, target.dir)
        activatedAt = new Date().toISOString()
        lastError = failures.length
          ? `${failures.join('；')}；已回退到 ${target.version}（${target.source}）`
          : null
        return status()
      } catch (error) {
        failures.push(`装载 ${target.version}（${target.source}）失败：${error?.message || error}`)
      }
    }
    throw new Error(`所有可用插件实现均装载失败：${failures.join('；')}`)
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
    const oldFiber = fiber
    fiber = null
    current = null
    if (oldFiber) await oldFiber.dispose()
  }

  return {
    start,
    reload,
    detach,
    status,
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
      route.handler = async (req, res) => {
        inFlight += 1
        try {
          return await handler(req, res)
        } finally {
          inFlight = Math.max(0, inFlight - 1)
        }
      }
      return route
    },
  }
}

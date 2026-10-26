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
/** 等一代装载完成的上限。装载卡住（依赖永远不来）时不能把整个外壳拖死。 */
const ACTIVATE_TIMEOUT_MS = 20000
/** 首次装载全失败后的重试间隔与次数（重试理由见 `start()`）。 */
const START_RETRY_LIMIT = 6
/** 间隔可用环境变量压低，只给测试（与 `DSH_MOBILE_PROFILE_NODE_MODULES` 同款逃生口）。 */
const START_RETRY_MS = Number(process.env.DSH_MOBILE_START_RETRY_MS) > 0
  ? Number(process.env.DSH_MOBILE_START_RETRY_MS)
  : 30000

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
  /**
   * 最近一次「装上了、但新版自检没过，于是自己退回去」的记录。
   *
   * 为什么要它：这件事**不能靠手机按回滚** —— 装坏的后果是 App 连不上这台设备，那一刻
   * 手机上任何按钮都发不出去。所以退回是宿主自己做的，而手机只能在**下一次连上之后**
   * 读到这条已经发生过的事实（`lastApply.rolledBack` 就是从它来的）。
   */
  let lastRollback = null

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

      await drain()
      const oldFiber = fiber
      const oldCurrent = current
      // 旧的**模块本体**要在激活新代之前抓住：`loadedCurrent` 一旦被新代覆盖，回滚就只能
      // 拿到刚装坏的那一份（真机上表现为「自检没过、退回去的还是坏的那个」）。
      const oldLoaded = loadedCurrent
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
        // 装起来了不等于**手机要打的那批接口**可用：端口没绑上、守卫没挂上、某个 handler
        // 永远不回包，这些都要真打一发才看得见。所以换完之后问一次自己的 `/health`。
        //
        // 不过就自己退回去 —— 这一步刻意放在宿主里，不交给手机：装坏的后果正是 App
        // 连不上这台设备，那时候手机上一颗按钮都发不出去。
        if (options.selfCheck !== false && oldCurrent) {
          const alive = await checkSelfCheck()
          if (alive.ok === false) {
            const failure = `新版 ${target.version} 换上来之后没通过自检：${alive.reason}`
            // **先把刚装起来的新代卸掉**：它占着同一批路由路径，不卸就装不回旧代
            // （webserver: duplicate exact route）。这条是自检回滚与「装载直接抛错」两条路
            // 唯一的区别 —— 后者根本没有新 fiber 可卸。
            const brokenFiber = fiber
            fiber = null
            if (brokenFiber) {
              try { await brokenFiber.dispose() } catch { /* 新代自己卸不干净时，回滚仍然照试 */ }
            }
            await rollbackTo(oldCurrent, oldLoaded, failure)
            const error = new Error(failure)
            error.code = 'self_check_failed'
            throw error
          }
        }
        return status()
      } catch (error) {
        // 自检那条已经在上面退回过一次了，别退第二遍（第二遍会把刚装回去的旧代再卸一次）。
        // 但它记下的「退回也失败」那句话不能在这里被覆盖掉 —— 那才是真机上最要紧的一条。
        if (error?.code !== 'self_check_failed') {
          lastError = `装载 ${target.version} 失败：${error?.message || error}`
          if (oldCurrent) await rollbackTo(oldCurrent, oldLoaded, lastError)
        }
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
  async function start(context, options = {}) {
    ctx = context
    const log = typeof options.log === 'function' ? options.log : () => {}
    const candidates = resolveGenerations()
    if (!candidates.length) throw new Error('找不到任何一代实现：包内的 lib/impl.js 缺失')
    let lastFailure = ''
    for (let attempt = 1; attempt <= START_RETRY_LIMIT; attempt += 1) {
      const failures = []
      for (const target of candidates) {
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
          return status()
        } catch (error) {
          failures.push(`装载 ${target.version}（${target.source}）失败：${error?.message || error}`)
        }
      }
      lastFailure = `所有可用插件实现均装载失败：${failures.join('；')}`
      if (attempt >= START_RETRY_LIMIT) break
      lastError = `${lastFailure}（第 ${attempt} 次，${START_RETRY_MS / 1000}s 后重试）`
      log('warn', 'dsh-mobile-plugin: 装载失败，%d 秒后重试：%s', START_RETRY_MS / 1000, lastFailure)
      await sleep(START_RETRY_MS)
    }
    lastError = lastFailure
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

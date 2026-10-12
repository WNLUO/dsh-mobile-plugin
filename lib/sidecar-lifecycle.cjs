'use strict';

/**
 * sidecar 子进程的完整生命周期：起停、配置下发、自重启、健康轮询。
 *
 * 这些代码原本散在 apply() 里三段（状态变量、配置下发的串行化、自重启），中间还隔着
 * 一个 200 行的镜像推送调度器。它们共享同一批可变量（sidecarState / sidecarSnapshot /
 * restartInFlight / syncInFlight），拆到一处才看得清「谁改了什么」。
 *
 * 注意扩展名是 .cjs：包根声明 type=module，lib/ 下没有就近的 package.json，所以
 * lib/*.js 全是 ESM，只有 .cjs 是 CommonJS（同 sidecar-facade.cjs）。
 *
 * ⚠️ `sidecar` 是**会被整体替换**的 let（自重启换掉 facade 实例），所以对外一律给
 * 取值器或 accessor，绝不能把实例本身传出去——传出去就是一份永远指向旧实例的快照。
 */

const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { SidecarFacade } = require('./sidecar-facade.cjs');

const HEALTH_POLL_INTERVAL_MS = 10000;

/**
 * @param {object} deps
 * @param {import('cordis').Context} deps.ctx
 * @param {string} [deps.pluginLibDir] 本代实现所在的 `lib/` 目录。默认按本文件位置推；
 *   之所以要能注入，是因为实现现在住在代际目录（`lib/.live/<版本>/lib/`）里，
 *   `require.resolve` 会解析到代自己那一份，而调用方手上的目录才是最准的。
 * @param {() => string} deps.lanPortInUse 取值器：lanPortAdjusted/effectiveLanPort 会被重新赋值
 * @param {() => Promise<number>} deps.resolveLanPort
 * @param {(cfg: object) => Promise<object>} deps.buildConfig 把它组装的配置交给谁下发（index.js 组）
 */
function createSidecarLifecycle(deps) {
  const { ctx, lanPortInUse, resolveLanPort, buildConfig } = deps;

  const sidecarToken = randomBytes(32).toString('hex')
  // `let` 而非 `const`：sidecar 自重启要换掉整个实例（见 restartSidecar）。
  // 下面所有 `sidecar.xxx` 都是调用时读这个变量，换实例后自然跟着走——这也是
  // 刻意的：宁可让每次调用多一次变量查找，也不要把 facade 引用散进各个闭包，
  // 那样重启就一定有一半调用点还握着旧实例。
  // The child-process bridge is used by the sidecar transport; Cordis services remain injected read-only.
  let sidecarState = 'starting'
  let sidecarSnapshot = { tunnel: { state: 'off', error: null }, lan: { state: 'off', error: null } }
  // worker 意外退出时的唯一出口：把状态打回「不健康」，而不是让它冻在最后一帧。
  // 冻住的后果是 /api/relay/status 继续报 tunnel: connected / lan: listening，
  // 宿主于是照着「隧道是通的」去推镜像，一路 503；局域网端口上却早就没人监听。
  // status() 如实报「off + 原因」，至少人一眼能看出是没起来还是掉线了。
  //
  // 声明顺序是刻意的：这三个 const/let 必须排在 new SidecarFacade() 前面，因为构造
  // 时要把 markSidecarDown 交进去，箭头函数还没初始化就被引用会直接 TDZ 报错。
  const markSidecarDown = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    sidecarState = `error: ${message}`
    sidecarSnapshot = { tunnel: { state: 'off', error: message }, lan: { state: 'off', error: message } }
  }
  // 「隧道刚连上」的订阅者。声明必须排在 new SidecarFacade() 前面：构造时交进去的
  // applyTunnelState 会在 worker 报状态跳变时立刻用到它（和 markSidecarDown 同理）。
  const tunnelUpSubscribers = new Set()
  // 「隧道刚连上」的边沿判定只有这一处实现，两个来源共用：worker 的即时状态上报
  // （applyTunnelState）与 10s 健康轮询（权威但滞后）。共用是必须的——一次重连只能补推
  // 一次全量镜像，两个来源各自记边沿就会重复补推；而隧道「断又连」若整段落在两次轮询
  // 之间，轮询根本看不到跳变，只有即时上报能抓住它。
  let lastTunnelConnected = false
  const noteTunnelConnected = (connected) => {
    if (connected && !lastTunnelConnected) { for (const fn of tunnelUpSubscribers) fn() }
    lastTunnelConnected = connected
  }
  /**
   * worker 报来的状态跳变（lib/sidecar-facade-worker.cjs 的 publishState()）：立刻回写
   * sidecarSnapshot，不等 10s 健康轮询。
   *
   * 轮询仍然是权威（只有它能发现「worker 整个没了」——那时 IPC 也断了，没人会推），但它是
   * 滞后的：隧道真断之后宿主最多 10s 仍认为已连接，期间照推镜像、每次撞 sidecar-facade 的
   * 5s 超时，该会话的单飞门被占住，事件只能合并成一次补推。
   */
  const applyTunnelState = (message) => {
    if (!message || !message.tunnel) return
    sidecarSnapshot = { ...sidecarSnapshot, tunnel: message.tunnel, ...(message.lan ? { lan: message.lan } : {}) }
    noteTunnelConnected(message.tunnel.state === 'connected')
  }
  let sidecar = new SidecarFacade({ parentPort: ctx.webServer.port, token: sidecarToken, onDown: markSidecarDown, onState: applyTunnelState })
  // sidecar 自重启的账：几次、什么时候、上次成没成。自重启是运维动作（改完代码不想
  // 逼用户重启整个 DSH），出问题时「刚才那次重启到底把哪一段换掉了」必须查得到。
  let sidecarRestarts = 0
  let sidecarRestartedAt = 0
  let sidecarRestartError = null
  let restartInFlight = null

  // 隧道是否真的连上了中转。`sidecarSnapshot` 由 10s 一次的健康轮询回写，是权威状态；
  // `configure()` 返回的瞬时快照不算（那时 startTunnel 的 start() 还没 resolve）。
  const tunnelConnected = () => sidecarSnapshot?.tunnel?.state === 'connected'

  // 配置下发的串行化 + 合并。
  //
  // 每一次同步都会让 worker 完整 stopServices()+重启隧道与局域网代理，而
  // 控制面路由（toggle/regenerate/config/revoke-all）与 `settings.watch` 触发的
  // `applyServices()` 会为同一次修改各请求一次同步：旧实现于是每次都重启两轮，
  // 并且处理函数读到的还是重启**前**的 sidecarSnapshot。这里让并发/短时间内重复的
  // 请求复用同一个在飞 Promise，并记录一次待重跑，确保最终下发的是最新配置。
  let syncInFlight = null
  let syncQueued = false
  // 我们最近一次**下发给 worker** 的局域网端口（0 = 还没下发过）。它是 getOwnLanPort 的判据。
  let configuredLanPort = 0
  const applySidecarConfig = async () => {
    await resolveLanPort()
    const config = buildConfig(lanPortInUse())
    configuredLanPort = Number.isInteger(config.lanPort) ? config.lanPort : 0
    sidecarSnapshot = await sidecar.configure(config)
    sidecarState = 'healthy'
    return sidecarSnapshot
  }
  const syncSidecar = () => {
    if (syncInFlight) { syncQueued = true; return syncInFlight }
    syncInFlight = applySidecarConfig()
      .catch(error => {
        sidecarState = `error: ${error instanceof Error ? error.message : String(error)}`
        throw error
      })
      .finally(() => {
        syncInFlight = null
        if (syncQueued) { syncQueued = false; void syncSidecar().catch(() => undefined) }
      })
    return syncInFlight
  }

  // ── sidecar 自重启 ──────────────────────────────────────────────────
  //
  // 为什么要它：sidecar worker 是本插件 fork 出去的**子进程**，它的代码（worker 本体、
  // lan-proxy、relay/tunnel、relay/protocol）完全由磁盘决定，re-fork 一次就是新的。
  // 也就是说这一整层从来不需要重启 DSH 宿主——之前每次改完都要用户手动重启宿主，
  // 是白等的。facade 自己（sidecar-facade.cjs）跑在宿主进程里，re-fork 换不掉它，
  // 所以重启时额外把本包 lib/ 从 require 缓存里摘掉再 require 一遍，两层一起换新。
  //
  // 换不掉的：lib/index.js、lib/client.js、lib/mobile/* 这些宿主侧模块本身。它们已经
  // 在 fiber 上跑着，V8 里的引用摘不掉。status().sidecar.scope 把这件事如实报出来，
  // 免得以为「重启了」就等于「所有改动都生效了」。
  // 本代 `lib/` 目录。默认用本文件位置推（同目录就是 lib/），允许调用方覆盖成
  // 「当前活跃的那一代」——代际目录里的副本推出来的是它自己，两者通常相同，
  // 但显式传入能让「清缓存清的是不是在跑的那一份」这件事变得确定。
  const PLUGIN_LIB_DIR = (deps.pluginLibDir || __dirname).replace(/[\\/]+$/, '') + path.sep
  const purgePluginLibCache = () => {
    let purged = 0
    for (const key of Object.keys(require.cache)) {
      if (!key.startsWith(PLUGIN_LIB_DIR)) continue
      delete require.cache[key]
      purged += 1
    }
    return purged
  }
  const restartSidecar = async () => {
    // 串行化：两次并发重启会互相 stop 掉对方刚起的 worker。
    if (restartInFlight) return restartInFlight
    restartInFlight = (async () => {
      const before = { tunnel: sidecarSnapshot.tunnel, lan: sidecarSnapshot.lan, state: sidecarState }
      let purged = 0
      try {
        await sidecar.stop()
        purged = purgePluginLibCache()
        // 重新 require 的是 facade 及其依赖（relay/tunnel 等）——缓存已清，拿到的
        // 是磁盘上的新代码。worker 更是直接 re-fork，天然是新的。
        const Fresh = require('./sidecar-facade.cjs').SidecarFacade
        sidecar = new Fresh({ parentPort: ctx.webServer.port, token: sidecarToken, onDown: markSidecarDown })
        sidecarState = 'starting'
        await sidecar.start()
        await syncSidecar()
        sidecarState = 'healthy'
        sidecarRestarts += 1
        sidecarRestartedAt = Date.now()
        sidecarRestartError = null
        return { ok: true, before, after: { tunnel: sidecarSnapshot.tunnel, lan: sidecarSnapshot.lan, state: sidecarState }, purgedModules: purged }
      } catch (error) {
        sidecarRestartError = error instanceof Error ? error.message : String(error)
        sidecarState = `error: ${sidecarRestartError}`
        // 起不来就把状态如实留在 error，而不是假装成功。宿主侧后续的 /tunnel/send
        // 会因为没有 worker 而明确报 'sidecar facade is not running'。
        return { ok: false, error: sidecarRestartError, before, purgedModules: purged }
      } finally {
        restartInFlight = null
      }
    })()
    return restartInFlight
  }

  // ── 健康轮询 ─────────────────────────────────────────────────────────
  // 隧道/局域网状态的权威回写点（状态跳变的即时回写见上面的 applyTunnelState）。
  const onTunnelUp = (fn) => { tunnelUpSubscribers.add(fn); return () => tunnelUpSubscribers.delete(fn) }

  const start = () => {
    let disposed = false
    void sidecar.start().then(async () => {
      if (disposed) return
      await syncSidecar()
      sidecarState = 'healthy'
    }).catch(error => { sidecarState = `error: ${error instanceof Error ? error.message : String(error)}` })
    const healthTimer = setInterval(async () => {
      try {
        const st = await sidecar.request('/status')
        // 轮询拿到的才是权威状态，必须回写 sidecarSnapshot：`configure()` 返回的是
        // 瞬时快照，那时 startLan() 的 start() 还没 resolve，lan.state 恒为
        // 'connecting'。原来这次轮询只用来判断隧道连接跳变，结果被直接丢弃，于是
        // /api/relay/status 永远谎报局域网"没起来"，尽管 0.0.0.0:lanPort 早在监听。
        if (st) sidecarSnapshot = st
        // 边沿判定与即时上报共用（noteTunnelConnected）：这里只是权威兜底，
        // 隧道在两次轮询之间断又连时补上那一次全量补推。
        noteTunnelConnected(st?.tunnel?.state === 'connected')
      } catch (error) {
        // 原来这里是空的 `catch { }`：轮询打不通（worker 死了、端口没人听）时
        // 异常被吞掉，sidecarSnapshot 就永远冻在临死前那一帧，/api/relay/status
        // 于是继续报 tunnel: connected、lan: listening。这跟 worker 侧 tunnel 少一层
        // 身份守卫是同一类毛病——状态乐观会把后续判断一路带偏。偶发抖动会在下一个
        // 轮询周期自愈（10s），期间镜像不推而已，比一直谎报安全得多。
        markSidecarDown(error)
      }
    }, HEALTH_POLL_INTERVAL_MS)
    return () => { disposed = true; void sidecar.stop(); clearInterval(healthTimer) }
  }

  return {
    sidecarToken,
    start,
    syncSidecar,
    restartSidecar,
    onTunnelUp,
    tunnelConnected,
    /** ⚠️ 取值器：sidecar 会被自重启整体替换。 */
    getSidecar: () => sidecar,
    getSnapshot: () => sidecarSnapshot,
    getState: () => sidecarState,
    getRestarts: () => sidecarRestarts,
    getRestartedAt: () => sidecarRestartedAt,
    getRestartError: () => sidecarRestartError,
    /**
     * **对外报地址**用的局域网端口：以 sidecar 真正 bind 成功的那一个为准。
     *
     * 两条端口自适应会打架：宿主只在「配置端口被占」时换号并写回 state，sidecar 自己
     * 还会再探一次，真实端口只出现在它上报的 `lan.port` 里。只认宿主那一个的后果实测过：
     * 状态接口、connection-info、配对二维码都报 50933，实际监听 55583 —— 手机在家用
     * Wi-Fi 拿到死地址，只能退回公网中转。尚未 listen 完（快照没有 port）时才回落。
     */
    getAdvertisedLanPort: () => {
      const reported = sidecarSnapshot && sidecarSnapshot.lan ? sidecarSnapshot.lan.port : 0
      if (Number.isInteger(reported) && reported > 0) return reported
      return lanPortInUse()
    },
    /**
     * 「这个局域网端口是我们自己占着的」——就是**最近一次下发给 worker 的那个号**；没下发过是 0。
     *
     * 为什么不用快照来判：`lan.port` 走的是 worker 上报的状态帧，是**另一条消息**。刚
     * `configure` 完的那个窗口里快照还是上一个号（或还没绑完），此刻去试绑刚下发的号必然
     * 失败——那是自己占着自己，不是被别人占了。只认快照的话，紧接着的第二次同步就会把这个
     * 号判成「被占」、换个内核随手给的端口写回 relay.json，监听也跟着挪走（`/api/relay/config`
     * 改端口那条路由**一次会同步两遍**，第二遍正好落在这个窗口里；2026-10-11 真机实测，
     * 落盘端口 18787→22779→33091→17079→28223 一路漂，手机里存的地址就是这么废的）。
     *
     * 代价照实说：真的被别的程序占着时，这里也认这个号。那没关系——worker 自己 bind 失败会
     * 退到内核给的空闲端口并按**实绑值**上报，对外报的地址（getAdvertisedLanPort）跟着它走。
     */
    getOwnLanPort: () => configuredLanPort,
    markSidecarDown,
  }
}

module.exports = { createSidecarLifecycle };
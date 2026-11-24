/**
 * 插件入口（**稳定外壳**）。
 *
 * 这个文件是整条自更新链路的锚点，所以它必须尽量不变。真正的实现在**代**里：随包发布的
 * 那份是 `lib/impl.js`，市场装新版之后 profile 里那份是新一代（新 realpath）。
 * 外壳负责挑一代、装上去，并在更新到位后换过去，见 `lib/shell/runtime.js`。
 *
 * ## 为什么入口非得是「外壳 + 代」两半
 *
 * 宿主进程启动时就把 profile 的插件树定死了（Node 按 realpath 缓存模块）。要换实现，
 * 只能换**这个文件 import 的东西** —— 换掉它自己就得重启进程，而重启桌面端 DSH 会在用户
 * 不知情的情况下掐掉他正在跑的对话，这正是要避免的事。所以这里只留不会变的装载逻辑，
 * 变动频繁的部分全部搬进代。
 *
 * 这一层同时是**故障边界**：代装载失败时外壳回滚到上一代并把错误暴露出去，而不是让整个
 * 插件从宿主里消失（那会让手机连不上，且日志里只剩一行 pending）。
 *
 * ## 更新来源
 *
 * 正式 npm 更新由 `shell/updater.js` 处理（自动更新默认开启，面板可关）；紧急完整包由
 * `shell/device-ota.js` 经本机控制面激活，正式版成功接管前保留 OTA 回退包。
 * `updateState` 记录查装结果；对外的 `marketResult` 就是它的 `result`。装包前先让隧道助手
 * 松开平台包目录，装完按换代结果恢复，避免 Windows 上文件被占用导致连回滚都失败。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './shell/runtime.js'
import * as updater from './shell/updater.js'
import { installedPackageDir, installedVersion, profileNodeModules, snapshotRunningGeneration } from './shell/manager.js'
import { createDeviceOta } from './shell/device-ota.js'
import { installHostHalf } from './shell/half-route.js'
import { installTransportHosts } from './shell/transport-host.js'
import { createUpdateConsent } from './shell/update-consent.js'
import { createAutoUpdater } from './shell/auto-updater.js'
import { firstInstallNeedsRestart } from './shell/first-install.js'

export const name = 'dsh-mobile-plugin'
// 外壳同样只等 `webServer`：它不读 `sessions`，多注一个只是多一种「整行 pending」的理由。
export const inject = ['webServer']

/**
 * 装载当前代，并把「查 / 装 / 换代码」这套动作暴露成服务。
 *
 * 对照 `lib/impl.js` 的 `apply`：那边注册真正的移动 API，这里注册「装载它」。两份 effect
 * 各自归属自己那层 fiber —— 外壳被卸载时，代的 fiber 作为子节点一起 dispose。
 */
export function apply(ctx) {
  const runtime = createRuntime()
  // 传输进程（sidecar / FRP / 总控上报）由稳定外壳持有，跨代存活；细节在 shell/transport-host.js。
  installTransportHosts(ctx)
  const deviceOta = createDeviceOta({ installed: installedVersion, runtime })
  // 跑着的外壳的指纹。它必须在**启动时**算：之后盘上那份可能已经被市场换掉了。
  const runningShellHash = updater.shellFingerprint(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
  const updateState = {
    checking: false,
    lastCheckedAt: null,
    lastError: null,
    result: null,
    lastApply: null,
    appliedAt: null,
  }
  // 「有手机连着就先问一声」的状态机：自动更新 tick 用它决定装还是先停。
  const updateConsent = createUpdateConsent()
  const base = () => updater.marketBase(ctx.webServer?.port)
  const log = (level, message, ...rest) => {
    const fn = ctx.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, message, ...rest)
  }
  /** 取一个宿主服务，拿不到就当没有（更新的两道判据都要它，缺了只降级、不抛）。 */
  const hostService = key => {
    try { return typeof ctx.get === 'function' ? ctx.get(key) ?? null : null } catch { return null }
  }

  /** 查一次有没有新版。只记结果，装不装由开关或人来决定。 */
  async function check({ force = false } = {}) {
    if (updateState.checking) return updateState.result
    updateState.checking = true
    try {
      await deviceOta.reconcileOfficial()
      updateState.result = await updater.checkUpdate(base())
      updateState.lastError = null
    } catch (error) {
      updateState.result = null
      updateState.lastError = String(error?.message || error)
    } finally {
      updateState.checking = false
      updateState.lastCheckedAt = new Date().toISOString()
    }
    return updateState.result
  }

  /**
   * 装包前让隧道助手松开平台包目录：只有 **Windows** 会因为助手占着 exe 导致 pnpm 换不掉
   * 那个包（连恢复旧版都会一起失败）。其它平台没有这个文件锁，停掉助手只会白白断掉一条
   * 直连通道、整段装包时间都不在——所以只在 Windows 上停。停不动就照装（多一层保险，不是
   * 前置条件）；换代成功时新代会自己起助手，没换过去才在这里拉回来。
   */
  let tailcatPaused = false
  const tailcatCtl = () => hostService('dshMobileTailcatCtl')
  const pauseTailcat = async () => {
    if (process.platform !== 'win32') return
    const ctl = tailcatCtl()
    if (!ctl || typeof ctl.stop !== 'function') return
    try {
      await ctl.stop()
      tailcatPaused = true
    } catch (error) {
      log('warn', 'dsh-mobile-plugin: 更新前停隧道助手失败：%s', error?.message || error)
    }
  }
  const resumeTailcat = async () => {
    if (!tailcatPaused) return
    tailcatPaused = false
    const ctl = tailcatCtl()
    if (!ctl || typeof ctl.start !== 'function') return
    try {
      const state = typeof ctl.status === 'function' ? ctl.status() : null
      if (!state || state.running !== true) ctl.start()
    } catch (error) {
      log('warn', 'dsh-mobile-plugin: 更新后恢复隧道助手失败：%s', error?.message || error)
    }
  }

  /**
   * 装之前把正在跑的那一代备份进回退目录：包管理器一跑就没得备份了。失败不挡更新，只记一句。
   */
  const snapshotRunning = async () => {
    const status = runtime.status()
    const result = snapshotRunningGeneration(status)
    if (result?.created) log('info', 'dsh-mobile-plugin: 更新前已把 %s 复制进回退目录', status.version)
    else if (result?.error) log('warn', 'dsh-mobile-plugin: 回退副本没做成：%s', result.error)
    await pauseTailcat()
    return result
  }

  /**
   * 装新版（实现自己装，见 `shell/updater.js`），装完**就地换代**。编排、落账与「换不过来
   * 就重试」都在 `updater.performUpdate` 里 —— 入口只留装载逻辑，行数钉着。
   */
  async function applyUpdate(options = {}) {
    const { force = false, auto = false } = options
    // 真要装了：之前记的「待确认 / 推迟」就作废了（手动允许、或自动兜底都走到这儿）。
    updateConsent.clear()
    try {
      const result = await updater.performUpdate({ runtime, base, hostService, updateState, force, auto, log, beforeInstall: snapshotRunning, runningShellHash })
      // 换代成功后也补一次恢复：这条线路若因指纹未变而沿用了被暂停的旧 door，需要拉回来；
      // 真重建了/正在跑则 status.running 为真、resume 自动跳过。没换过去也把旧的拉回。
      await resumeTailcat()
      return result
    } catch (error) {
      await resumeTailcat()
      throw error
    }
  }

  /**
   * 自动更新编排（查新版 → 有人连着就先停 → 该装才装）：逻辑在 `shell/auto-updater.js`，
   * 外壳这里只把它接起来，并提供「跑着哪一版」「几条手机长连接」两个取值器。
   */
  const autoUpdater = createAutoUpdater({
    consent: updateConsent,
    check,
    applyUpdate,
    log,
    runningVersion: () => { try { return runtime.status()?.version ?? null } catch { return null } },
    activeMuxConnections: () => { try { const h = hostService('dshMobileTransportMux'); return h && typeof h.activeMuxConnections === 'number' ? h.activeMuxConnections : 0 } catch { return 0 } },
  })

  // 换代前要知道有没有请求在飞（见 runtime.drain）。webServer 没有中间件机制，所以包一层
  // register 把每条 handler 变成「进 +1 / 出 -1」（`wrapHandler` 认不出的形状原样放行）。
  //
  // 这层包装必须**可叠加**：别人后来也包一层时闭包着我们的包装，撤销时无条件还原会把
  // 别人的那层一起摘掉。所以只在「现在挂的就是我们这层」时才还原。
  ctx.effect(() => {
    const server = ctx.webServer
    const outer = server?.register
    const outerUpgrade = server?.registerUpgrade
    if (typeof outer !== 'function') return () => {}
    // 把真实服务器交给运行时做蓝绿分发：代注册的路由登记进分发表、由稳定分派器转发，换代时
    // 原子切换、不产生路由空窗、也不会撞 duplicate route。外壳自己的路由（非装载期）直挂。
    runtime.installDispatch(server, outer, outerUpgrade)
    const wrapper = function register(route) {
      return runtime.registerRoute(route, outer, this)
    }
    server.register = wrapper
    let upgradeWrapper = null
    if (typeof outerUpgrade === 'function') {
      upgradeWrapper = function registerUpgrade(route) {
        return runtime.registerUpgradeRoute(route, outerUpgrade, this)
      }
      server.registerUpgrade = upgradeWrapper
    }
    return () => {
      if (server.register === wrapper) server.register = outer
      if (upgradeWrapper && server.registerUpgrade === upgradeWrapper) server.registerUpgrade = outerUpgrade
      return runtime.detach()
    }
  }, 'dsh-mobile-plugin: generation runtime')

  const installedShellHash = () => updater.shellFingerprint(installedPackageDir())
  // 宿主半边的自检口（`shell/half-route.js`）：实现装载失败时整张控制面路由都不在，只有
  // 外壳还活着 —— 那是「它为什么没起来」唯一说得通的落点。
  ctx.effect(() => installHostHalf(ctx, runtime, { installedVersion, installedShellHash, runningShellHash }), 'dsh-mobile-plugin: host half self check')

  ctx.reflect.provide('dshMobilePluginRuntime', {
    status: () => ({
      ...runtime.status(),
      /** 盘上装着的版本（市场装完立刻变，和运行中的版本对照就能看出「要不要换」）。 */
      installedVersion: installedVersion(),
      runningShellHash,
      installedShellHash: installedShellHash(),
      shellChanged: (() => {
        const installed = installedShellHash()
        return installed !== null && runningShellHash !== null && installed !== runningShellHash
      })(),
      profileNodeModules: profileNodeModules(),
      autoUpdate: updater.autoUpdateEnabled(),
      autoIntervalMs: updater.AUTO_INTERVAL_MS,
      marketBase: base(),
      marketLastCheckedAt: updateState.lastCheckedAt,
      marketLastError: updateState.lastError,
      marketResult: updateState.result,
      lastApply: updateState.lastApply,
      appliedAt: updateState.appliedAt,
      /** 自动更新的「先问一声」现场：在等哪一版、等到什么时候、推迟到什么时候。 */
      pendingUpdate: updateConsent.status(),
      /** 第一次装进一台正在跑的 DSH、还没重启过：手机端据此要求重启一次（见 shell/first-install.js）。 */
      firstInstallPendingRestart: firstInstallNeedsRestart(),
    }),
    check,
    apply: applyUpdate,
    reload: version => runtime.reload(version),
    /** 就地把盘上这一份重新装载一遍：版本身份没变也照换（开发机改完代码用，见 runtime 的 reread）。 */
    reread: () => runtime.reload(undefined, { reread: true }),
    deviceOta,
    setAutoUpdate: enabled => {
      const value = updater.setAutoUpdate(enabled)
      log('info', 'dsh-mobile-plugin: 自动更新已%s', value ? '开启' : '关闭')
      return value
    },
    /** 「过一会儿」：按分钟推迟插件更新；手机在更新页点「以后再说」时调用。 */
    deferUpdate: minutes => updateConsent.snooze(minutes),
    /** 现在在等哪一版 / 推迟到什么时候（面板与手机诊断用）。 */
    consentStatus: () => updateConsent.status(),
  })

  runtime
    .start(ctx, { log })
    .then(() => {
      log('info', 'dsh-mobile-plugin: 已装载 %s（来源 %s）', runtime.status().version, runtime.status().source)
      // 每 2 分钟让已落盘的正式版接管 OTA，并补上「盘上比运行中新」的那次换代（补换代不
      // 受开关管：它不下载任何东西）；自动安装由开关控制，开着就不等正在跑的对话。
      const timer = setInterval(() => {
        deviceOta.reconcileOfficial()
          .then(() => updater.reconcileInstalledGeneration({ runtime, log }))
          .then(() => updater.autoUpdateEnabled() ? autoUpdater.tick() : null)
          .catch(error => {
            updateState.lastError = String(error?.message || error)
            log('warn', 'dsh-mobile-plugin: 更新检查失败：%s', updateState.lastError)
          })
      }, updater.AUTO_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      ctx.effect(() => () => clearInterval(timer), 'dsh-mobile-plugin: auto update timer')
      // 启动后延后一次：别和绑端口、连隧道抢带宽。
      if (updater.autoUpdateEnabled()) {

        const kick = setTimeout(() => {
          autoUpdater.tick().catch(error => {
            updateState.lastError = String(error?.message || error)
            log('warn', 'dsh-mobile-plugin: 启动时的自动更新失败：%s', updateState.lastError)
          })
        }, 10000)
        if (typeof kick.unref === 'function') kick.unref()
      } else {
        // 没开自动也查一次：用户打开面板之前就知道有没有新版。
        const kick = setTimeout(() => { check().catch(() => {}) }, 5000)
        if (typeof kick.unref === 'function') kick.unref()
      }
      return undefined
    })
    .catch(error => {
      log('error', 'dsh-mobile-plugin: 装载插件实现失败：%s', error?.message || error)
    })
}

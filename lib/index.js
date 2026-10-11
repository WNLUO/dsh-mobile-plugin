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
 * ## 更新从哪儿来（2026-10 改，2026-10-11 再分一刀）
 *
 * **查与装都归实现自己**：查直接问 npm 注册表、装在 profile 里跑它自己的包管理器
 * （`lib/update-registry.cjs` / `lib/update-install.cjs`），市场不再是这条路上的任何一环。
 * 装完会把 `<profile>/node_modules/dsh-mobile-plugin` 指向一个新的 store 目录，外壳照着新
 * realpath 重新 import 一代即可，**不需要重启 DSH**。自动更新（默认关）按 `AUTO_INTERVAL_MS`
 * 轮询，见 `shell/updater.js`。
 *
 * 这里那个 `updateState` 对象记的是「最近一次查/装的结果」。名字里别再叫 market：里面那份
 * 市场信息（`marketResult`）只是外壳从市场那条老路继承下来的兜底，装的时候用不到它。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './shell/runtime.js'
import * as updater from './shell/updater.js'
import { installedPackageDir, installedVersion, profileNodeModules } from './shell/manager.js'

export const name = 'dsh-mobile-plugin'
export const inject = ['webServer', 'sessions']

/**
 * 装载当前代，并把「查 / 装 / 换代码」这套动作暴露成服务。
 *
 * 对照 `lib/impl.js` 的 `apply`：那边签名也是 `(ctx)`，只是它注册的是真正的移动 API；
 * 这里注册的是「装载它」。两者的 effect 各自归属自己那层 fiber —— 外壳被卸载时，代的
 * fiber 作为它的子节点一起被 dispose，代里那些 `ctx.effect` 的清理动作照常执行。
 */
export function apply(ctx) {
  const runtime = createRuntime()
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
   * 装新版（实现自己装，见 `shell/updater.js`），装完**就地换代**。
   *
   * 手动与自动走的是同一条路：手动只是「现在就做一次」。装的那一步报的 `restartRequired` 一律
   * 不照做 —— 外壳自己换代码，这正是这个文件存在的全部理由。
   */
  async function applyUpdate({ force = false } = {}) {
    const outcome = await updater.installIfNeeded(base(), {
      force,
      // 宿主发布的包管理器优先（PATH 上那个的版本可能和 profile 的 store 对不上，实测
      // 10.x 装 11.x 的 profile 直接 `ERR_PNPM_UNEXPECTED_STORE`）；agents 是「有对话在跑
      // 就别换文件」那道闸的判据。自动更新永远不带 force。
      packageManager: () => hostService('profileContext')?.packageManager ?? null,
      agents: () => hostService('agents'),
    })
    let swapped = false
    let status = runtime.status()
    if (outcome.installed) {
      status = await runtime.reload()
      swapped = true
      log('info', 'dsh-mobile-plugin: 已就地换到 %s（无需重启 DSH）', status.version)
    } else if (outcome.state && outcome.state !== 'succeeded') {
      log('warn', 'dsh-mobile-plugin: 更新没有成功（%s）%s', outcome.state, outcome.failure?.message || '')
    }
    updateState.lastApply = { ...outcome, swapped }
    updateState.appliedAt = new Date().toISOString()
    if (outcome.installed) updateState.lastError = null
    return { ...outcome, swapped, status }
  }

  // 换代前要知道有没有请求在飞（见 runtime.drain）。宿主 webServer 没有中间件机制，所以
  // 这里包一层 register，把每条路由的 handler 变成「进 +1 / 出 -1」。包的时机在任何一代
  // 装载之前，且 `wrapHandler` 遇到不认识的形状会原样放行。
  ctx.effect(() => {
    const server = ctx.webServer
    const original = server?.register
    if (typeof original !== 'function') return () => {}
    server.register = function register(route) {
      return original.call(this, runtime.wrapHandler(route))
    }
    return () => {
      server.register = original
      return runtime.detach()
    }
  }, 'dsh-mobile-plugin: generation runtime')

  ctx.reflect.provide('dshMobilePluginRuntime', {
    status: () => ({
      ...runtime.status(),
      /** 盘上装着的版本（市场装完立刻变，和运行中的版本对照就能看出「要不要换」）。 */
      installedVersion: installedVersion(),
      /** 盘上那份的外壳指纹与跑着的对不上 = 新版本连外壳一起改了，那部分要等下次启动才生效。 */
      runningShellHash,
      installedShellHash: updater.shellFingerprint(installedPackageDir()),
      shellChanged: (() => {
        const installed = updater.shellFingerprint(installedPackageDir())
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
    }),
    check,
    apply: applyUpdate,
    reload: version => runtime.reload(version),
    setAutoUpdate: enabled => {
      const value = updater.setAutoUpdate(enabled)
      log('info', 'dsh-mobile-plugin: 自动更新已%s', value ? '开启' : '关闭')
      return value
    },
  })

  runtime
    .start(ctx)
    .then(() => {
      log('info', 'dsh-mobile-plugin: 已装载 %s（来源 %s）', runtime.status().version, runtime.status().source)
      // 自动更新：默认关。开了才轮询；每次都是「查一次 → 有新版就自己装 → 就地换代」。
      const timer = setInterval(() => {
        if (!updater.autoUpdateEnabled()) return
        applyUpdate().catch(error => {
          updateState.lastError = String(error?.message || error)
          log('warn', 'dsh-mobile-plugin: 自动更新失败：%s', updateState.lastError)
        })
      }, updater.AUTO_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      ctx.effect(() => () => clearInterval(timer), 'dsh-mobile-plugin: auto update timer')
      // 启动后延后一次：别和绑端口、连隧道抢带宽。
      if (updater.autoUpdateEnabled()) {
        const kick = setTimeout(() => {
          applyUpdate().catch(error => {
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

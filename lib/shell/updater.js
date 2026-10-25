/**
 * 更新编排：**查与装都归实现自己**，装完**就地换代**（不重启 DSH）。
 *
 * ## 为什么这件事归外壳做，而不是归面板（浏览器）
 *
 * 面板里那颗「更新」按钮只能覆盖「用户正开着页面点一下」这一种情形；自动更新的定义是
 * **没人看着也要发生**。所以轮询和「装完切换」都必须在宿主进程里做，面板只是给它一个开关。
 *
 * ## 装法住哪儿（2026-10-11 改）
 *
 * 从前「查」和「装」都是请 DSH 插件市场代劳的（打它的 HTTP 接口）。现在两件都归实现自己：
 * 查问 npm 注册表、装在 profile 里跑它自己的包管理器（`lib/update-registry.cjs` /
 * `lib/update-install.cjs`）。外壳**只从盘上那一代**把自装模块取进来跑（`installedInstaller`），
 * 所以换装法、换判定都不用等重启 —— 盘上换了，下一次自动更新就走新的。
 *
 * 下面那套市场实现是**兜底**，只在「盘上那一代还没有自装模块」时才走到（老一代、刚回滚到
 * 旧代）。自动更新宁可暂时还走老路，也不能直接坏掉；市场装完会报 `restartRequired: true`，
 * 而本插件有外壳可以自己换代，所以那条路里**故意不调它的重启**。
 *
 * 装完新一代是**新目录**（包管理器换链接），外壳照着新 realpath 重新 import 一代即可，见
 * `lib/shell/manager.js` 与 `lib/shell/runtime.js`。
 *
 * ## 兜底那条路不做的事
 *
 * 不下载、不解包、不校验、不写 profile —— 全是市场的职责。它只回答四个问题：有没有新版、
 * 请它装、装完了没、盘上现在是什么版本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installedPackageDir, installedVersion, profileNodeModules, compareVersion } from './manager.js'

const require_ = createRequire(import.meta.url)
const { dshHome } = require_('../shared/paths.js')


/**
 * 盘上那一代的「自己装」模块（`lib/update-install.cjs`）。
 *
 * 「装」这件事 2026-10-11 起归**实现**自己：在 profile 里跑它自己的包管理器，不再借道 DSH
 * 插件市场。外壳只负责把盘上那一代的模块取进来跑 —— 从**盘上**（不是外壳自己的目录）取，
 * 是为了「装法改了不用等重启」：市场以外的方式换掉那一代之后，下一次自动更新就走新装法。
 *
 * 取不到（老一代没这个文件、安装目录被判了不存在、模块加载失败）就返回 null，调用方退回
 * 下面那套市场实现 —— 自动更新宁可暂时还走老路，也不能直接坏掉。
 */
async function installedInstaller() {
  const dir = installedPackageDirSafe()
  if (!dir) return null
  const file = path.join(dir, 'lib', 'update-install.cjs')
  if (!fs.existsSync(file)) return null
  try {
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`)
    const fn = mod.installLatestIfNeeded ?? mod.default?.installLatestIfNeeded
    return typeof fn === 'function' ? fn : null
  } catch {
    return null
  }
}

/** `installedPackageDir()` 只是读个路径，读不到不该把自动更新整个抛掉。 */
function installedPackageDirSafe() {
  try {
    return installedPackageDir()
  } catch {
    return null
  }
}

/**
 * 外壳自己的指纹（`lib/index.js` + `lib/shell/*.js` 的内容哈希）。
 *
 * **外壳换不掉**：它在进程启动时被 Node 缓存，改它必须重启 DSH —— 而重启是被明令禁止的。
 * 所以「新版本连外壳一起改了」这件事**不会**在这次更新里生效：实现换成新的了，装载它的
 * 那层还是旧的。这本身通常无害（外壳的接口是加法式的），但用户有权知道，所以这里算一个
 * 指纹，把「盘上的外壳和跑着的外壳不一样」如实报给面板。
 *
 * 缺文件按空串算：拿不到指纹时报「没变」，免得每次开面板都喊一句要重启。
 */
export function shellFingerprint(pkgDir) {
  if (!pkgDir) return null
  const files = ['lib/index.js', 'lib/shell/runtime.js', 'lib/shell/manager.js', 'lib/shell/updater.js', 'lib/shell/device-ota.js', 'lib/shell/ota-package.js']
  const hash = createHash('sha256')
  let seen = 0
  for (const rel of files) {
    try {
      hash.update(rel).update(fs.readFileSync(path.join(pkgDir, rel)))
      seen += 1
    } catch {
      // 缺一个文件就少算一个：宁愿指纹弱一点，也不要在这里抛。
    }
  }
  return seen === 0 ? null : hash.digest('hex').slice(0, 16)
}

/** 本插件的 npm 包名（市场按它找依赖）。 */
export const PACKAGE_NAME = 'dsh-mobile-plugin'

/** 自动检查的间隔与「检查一次」的超时。 */
export const AUTO_INTERVAL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000
/** 等一次安装走完的上限：pnpm 装一个包 + 校验，给足但别无限等。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1000

/** 宿主自己的 web 端口 → 市场的本机地址。端口拿不到就别问（自动更新如实报不可用）。 */
export function marketBase(port) {
  const value = Number(port)
  if (!Number.isFinite(value) || value <= 0) return null
  return `http://127.0.0.1:${value}`
}

/** 市场接口的错误：把状态码、它给的稳定 code 与给人看的话一起带出来。 */
export class MarketError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'MarketError'
    this.status = status
    this.code = code
  }
}

/**
 * 调一次市场接口。
 *
 * 形状是**外部契约**，一律防御式读：拿不到就当「没这个能力」，绝不让外壳因此崩掉
 * （外壳崩掉等于插件从宿主里消失、手机连不上，是最贵的失败）。
 *
 * 不带 `Origin` 头：请求来自宿主进程而不是浏览器，本机来源由对端按 socket 判定。
 */
async function marketJson(base, route, init) {
  if (!base) throw new MarketError(0, 'market-unavailable', '拿不到本机 web 端口，问不了市场')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${base}/dsh-market/api/v1${route}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    })
  } catch (error) {
    throw new MarketError(0, 'market-unreachable', `插件市场不可达：${error?.message || error}`)
  } finally {
    clearTimeout(timer)
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const code = body?.error?.code || body?.code || `http-${response.status}`
    const message = body?.error?.message || body?.message || `市场返回 ${response.status}`
    throw new MarketError(response.status, code, message)
  }
  return body
}

/** 市场在不在、能不能代劳重启（我们不用后者，只为与面板口径一致）。 */
export async function capabilities(base) {
  const body = await marketJson(base, '/capabilities', { method: 'GET' })
  return {
    available: true,
    restartSupported: body?.restart?.supported === true,
  }
}

/**
 * 问有没有新版。`installedVersion` 为 null = 市场看不见这个包（多半不是 npm 装的）。
 *
 * 路径与字段与面板那份客户端（`React/src/lib/market.ts`）逐字对齐：同一个市场接口，
 * 两处写法不一致时踩的是「宿主能装、面板说看不见」这类最难查的偏差。
 */
export async function checkUpdate(base, name = PACKAGE_NAME, { force = false } = {}) {
  const body = await marketJson(base, `/updates?name=${encodeURIComponent(name)}${force ? '&force=1' : ''}`, { method: 'GET' })
  const update = body?.package || body || {}
  return {
    installedVersion: typeof update.installedVersion === 'string' ? update.installedVersion : null,
    latestVersion: typeof update.latestVersion === 'string' ? update.latestVersion : null,
    updateAvailable: update.updateAvailable === true,
    source: typeof update.source === 'string' ? update.source : null,
    channelSwitch: update.channelSwitch === true,
  }
}

/**
 * 这条链能不能自动更新。
 *
 * 市场只从注册表装包：本地 link / `file:` 装的那些（`source: 'linked'`）它一概拒绝
 * （`locally linked plugins update from their checkout`）。所以「自动更新」在那种机器上
 * **做不到**，而且必须**说出来** —— 否则用户开着开关等一晚上，什么都不会发生。
 */
export function updatableSource(source) {
  return source === 'npm'
}

/** 请市场去装。返回它的 operationId，供轮询。 */
export async function startUpdate(base, name = PACKAGE_NAME, { force = false } = {}) {
  const body = await marketJson(base, '/updates', {
    method: 'POST',
    body: JSON.stringify({ packageName: name, ...(force ? { force: true } : {}) }),
  })
  const operation = body?.operation || body || {}
  if (typeof operation.operationId !== 'string') {
    throw new MarketError(200, 'market-bad-response', '市场没有给出 operationId，无法跟踪这次更新')
  }
  return operation
}

/** 查一次操作结果。 */
export async function operation(base, operationId) {
  const body = await marketJson(base, `/operations?operationId=${encodeURIComponent(operationId)}`, { method: 'GET' })
  return body?.operation || body || {}
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rolled-back'])

/**
 * 一套完整的「装新版」：问市场、请它装、盯到终态。
 *
 * **不重启 DSH**：市场报的 `restartRequired` 只往上传，装完由外壳换代解决（见 index.js）。
 * 装完了但盘上版本没变（市场报成功、文件没落），这里如实返回 `installed: false`，不让调用方
 * 以为换过代码 —— 「状态说成功、代码没换」是这个仓库吃过最贵的一次亏。
 */
export async function installIfNeeded(base, { name = PACKAGE_NAME, force = false, auto = false, onEvent = () => {}, packageManager = () => null, agents = () => null, beforeInstall = null, now = Date.now } = {}) {
  const before = installedVersion()
  // 装归实现自己（2026-10-11 起）：盘上那一代里有 `update-install.cjs` 就走它。判定（有没有
  // 新版、`link:` 来源不碰、有 agent 在跑就先别换文件）也一并交给它，别在这里抄第二份 ——
  // 外壳的自动更新与面板那颗按钮必须是同一套判定，否则会出现「手动说有新版、自动说没有」。
  //
  // `auto` 也透下去：自动那一轮跳过「有对话在跑就先别装」那道闸（2026-10-25 用户拍板的取舍，
  // 见 `update-install.cjs` 文件头），但没有新版时它照样什么都不做。
  const selfInstall = await installedInstaller()
  if (selfInstall) {
    const outcome = await selfInstall({
      profileNodeModules: profileNodeModules(),
      force,
      auto,
      onEvent,
      // 宿主发布的包管理器（优先用它装）与 agents 服务（那道闸的判据）都从外壳这一层透下去：
      // 实现在代里，它没有宿主 ctx，只有外壳有。
      packageManager: packageManager(),
      agents: agents(),
      // 装之前把正在跑的那一代备份走：包管理器一跑，旧目录就没了。
      beforeInstall,
    })
    return {
      installed: outcome.installed === true,
      skipped: outcome.skipped === true,
      state: outcome.installed || outcome.skipped ? 'succeeded' : 'failed',
      beforeVersion: outcome.beforeVersion ?? before,
      installedVersion: outcome.installedVersion ?? before,
      // 外壳就地换代，市场那套「装完要重启」在本项目一律不照做。只为如实上报。
      restartRequired: false,
      refreshRequired: false,
      failure: outcome.failure ?? null,
      // 「有 agent 在跑」这类是「现在不行」，下个 tick 再试，不是坏了。
      retryable: outcome.retryable === true,
      command: outcome.command ?? null,
      check: outcome.check ?? null,
    }
  }
  const check = await checkUpdate(base, name, { force })
  // 兜底这条路（盘上那一代还没有自装模块）**不认 `auto`**：市场接口只有 `force` 这一档，
  // 而把 `force` 借给自动会连「有没有新版」一起跳过。宁可让它暂时还按老规矩在对话结束后装。
  if (check.source !== null && !updatableSource(check.source)) {
    // 本地 link / file: 装的：市场不会碰它（见 updatableSource）。如实返回，别去试。
    return {
      installed: false,
      skipped: true,
      reason: 'linked-source',
      detail: `这台机器上的插件是 ${check.source} 来源装的（本地目录 / tgz），市场只从注册表更新；要自动更新得先在插件市场里按包名重装一次切到 npm 来源`,
      beforeVersion: before,
      installedVersion: before,
      check,
    }
  }
  if (!check.updateAvailable && !force) {
    return { installed: false, skipped: true, beforeVersion: before, installedVersion: before, check }
  }
  const started = await startUpdate(base, name, { force })
  onEvent({ phase: 'started', operationId: started.operationId })
  const deadline = now() + INSTALL_TIMEOUT_MS
  let last = started
  while (!TERMINAL.has(last.state) && now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    last = await operation(base, started.operationId)
    onEvent({ phase: 'progress', state: last.state, operationId: started.operationId })
  }
  if (!TERMINAL.has(last.state)) {
    throw new MarketError(0, 'market-operation-timeout', `更新操作 ${started.operationId} 在 ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s 内没有结束`)
  }
  // 市场同一时刻只允许一个操作，有 agent 在跑时也会直接拒（`AGENTS_RUNNING`）—— 这类
  // 失败是「现在不行」，不是「坏了」：自动更新下个 tick 再试就好，别当成故障喊。
  const RETRYABLE_CODES = new Set(['OPERATION_BUSY', 'AGENTS_RUNNING', 'UPDATE_TIMEOUT', 'RELEASE_TOO_FRESH'])
  const retryable = typeof last.failure?.code === 'string' ? RETRYABLE_CODES.has(last.failure.code) : false
  const after = installedVersion()
  return {
    installed: last.state === 'succeeded' && after !== before && after !== null,
    state: last.state,
    operationId: started.operationId,
    beforeVersion: last.beforeVersion ?? before,
    installedVersion: after,
    // 市场认为要重启：本插件自己换代，**故意不照做**。留着上报给面板做说明。
    restartRequired: last.restartRequired === true,
    refreshRequired: last.refreshRequired === true,
    failure: last.failure || null,
    retryable,
    check,
  }
}

/**
 * 换代尝试的记账：同一个版本自动只试一次。
 *
 * 一个起不来的新版每 10 分钟把手机抖一下没有任何意义 —— 第一次失败之后就该停下，等人按
 * 那颗按钮（手动不受这个限制：那是「我知道，再来一次」）。进程重启后这份记录清零，
 * 而重启本来就会走一遍正常装载，不需要它。
 */
const swapAttempts = new Map()

/** 同一时刻只跑一次更新：自动轮询与手按按钮撞一起时，第二个直接等第一次的结果。 */
let applying = null

/**
 * 一次完整的更新：装（若需要）→ 换代 → 落账。
 *
 * 手动与自动走的是同一个函数 —— 自动只是「没人按」的那一种（`auto: true`）。
 * 账必须**成功失败都落**：这套东西最贵的一次教训是「状态说成功、代码没换」，第二贵的是
 * 「失败了但没人记得」，面板与手机都靠这本账判结果，漏落一次它们就永远停在上一次。
 */
export function performUpdate(options = {}) {
  if (applying) return applying
  applying = runUpdate(options).finally(() => { applying = null })
  return applying
}

async function runUpdate({ runtime, base, hostService = () => null, updateState, beforeInstall = null, log = () => {}, force = false, auto = false } = {}) {
  const status = () => {
    try { return runtime.status() ?? {} } catch { return {} }
  }
  const beforeVersion = installedVersion() ?? status().version ?? null
  const runningBefore = status().version ?? null
  let outcome
  try {
    outcome = await installIfNeeded(base, {
      force,
      auto,
      beforeInstall,
      packageManager: () => hostService('profileContext')?.packageManager ?? null,
      agents: () => hostService('agents'),
    })
  } catch (error) {
    // 装那步就炸了（注册表 / 网络 / 权限）：账照样要落，否则面板停在上一轮、手机那边
    // 只能等到超时才说得出「没成」。
    const message = String(error?.message || error)
    updateState.lastApply = {
      installed: false,
      skipped: false,
      state: 'failed',
      beforeVersion,
      installedVersion: beforeVersion,
      swapped: false,
      restartRequired: false,
      refreshRequired: false,
      retryable: false,
      failure: { code: 'install_failed', message },
    }
    updateState.appliedAt = new Date().toISOString()
    updateState.lastError = message
    throw error
  }

  const disk = installedVersion()
  // 要换代时换到**盘上那一份**：装成功了是它；「早就装上了、只是没换过来」也是它。
  const newerOnDisk = disk !== null && runningBefore !== null && compareVersion(disk, runningBefore) > 0
  let swapped = false
  let swapFailure = null
  let deferred = false
  /**
   * 换代之后自检没过、外壳自己退回去了。
   *
   * 判据与动作都在 `runtime.js`（它才知道新版到底装起来了没有），这里只把那条**已经发生
   * 过的事实**抄进这一轮的账。手机端不按回滚 —— 装坏的后果正是 App 连不上，那时候它按不了
   * 任何东西 —— 它只用这条记录在**下一次连上之后**如实显示「上次装失败了，已退回 X」。
   */
  let rollback = null
  if (outcome.installed === true || newerOnDisk) {
    const attempt = await swapTo(runtime, disk ?? runningBefore, { auto, log })
    swapped = attempt.swapped
    swapFailure = attempt.failure
    deferred = attempt.deferred === true
    rollback = attempt.rollback ?? null
  }
  const rolledBack = Boolean(rollback && rollback.ok)
  const lastApply = {
    ...outcome,
    installed: outcome.installed === true,
    swapped,
    state: rolledBack
      ? 'rolled-back'
      : swapFailure ? 'installed-not-swapped' : (outcome.state ?? (outcome.installed || outcome.skipped ? 'succeeded' : 'failed')),
    // 退回去了的话，真正失败的原因是自检那句话，而不是「换代码抛错」那个笼统说法。
    failure: rolledBack
      ? { code: 'self_check_failed', message: rollback.reason }
      : (swapFailure ?? outcome.failure ?? null),
    /** 装上了、但新版没通过自检，于是外壳自己退回了上一代。 */
    rolledBack,
    /** 退回之后跑着的版本（退成功才有）。 */
    runningAfterRollback: rolledBack ? (rollback.toVersion ?? null) : null,
    // 换代由外壳就地做，市场那套「装完要重启」在本项目一律不照做。只为如实上报。
    restartRequired: false,
    refreshRequired: false,
  }
  updateState.lastApply = lastApply
  updateState.appliedAt = new Date().toISOString()
  if (lastApply.installed && !swapFailure) updateState.lastError = null
  if (swapFailure && !deferred) {
    // 装上了、换不过来：抛给路由（桌面按 500 + `swap_failed` 说人话），账已经落了，
    // 手机读 status 也能立刻判出结果，不必等到超时。
    throw new Error(swapFailure.message)
  }
  return { ...lastApply, status: status() }
}

/**
 * 换到盘上那一代。
 *
 * 失败只回错误、不抛：调用方要先落账再决定要不要抛。`auto` 为真时同一版本只试一次
 * （见 `swapAttempts`），手动调用不受限制。
 */
async function swapTo(runtime, target, { auto = false, log = () => {} } = {}) {
  const key = String(target ?? '')
  const tried = swapAttempts.get(key) ?? 0
  if (auto && tried >= 1) {
    return {
      swapped: false,
      deferred: true,
      failure: {
        code: 'swap_deferred',
        message: `盘上的 ${key} 已经自动试过一次换代、没成：重启一次 DSH 才会用它，或者再按一次更新重试。`,
      },
    }
  }
  swapAttempts.set(key, Math.max(tried, 1))
  let rollback = null
  try {
    const status = await runtime.reload()
    swapAttempts.delete(key)
    // 外壳把「装起来了但自检没过、于是自己退回去」记在 `lastRollback` 上，而不是抛错
    // （它退成功了，进程还活着）。这里把它捞出来，交给这一轮的账 —— 手机端要读的就是它。
    rollback = status?.lastRollback ?? null
    if (rollback && rollback.ok) {
      log('warn', 'dsh-mobile-plugin: 新版自检没过，已退回 %s：%s', rollback.toVersion, rollback.reason)
      return {
        swapped: false,
        rollback,
        failure: { code: 'self_check_failed', message: rollback.reason },
      }
    }
    log('info', 'dsh-mobile-plugin: 已就地换到 %s（无需重启 DSH）', status?.version ?? key)
    return { swapped: true, status }
  } catch (error) {
    // 新版装载直接抛错：runtime 已经按老规矩回滚过一代了，那条回滚也记在 `lastRollback`。
    try { rollback = runtime.status()?.lastRollback ?? null } catch { rollback = null }
    return {
      swapped: false,
      rollback,
      failure: { code: 'swap_failed', message: `新版已经装到盘上（${key}），但换代码没成：${String(error?.message || error)}` },
    }
  }
}

/**
 * 盘上比运行中新：补一次换代。
 *
 * 什么时候会走到这里：上一次换代失败了（回滚到旧代继续跑，盘上已是新版），或者新版是别的
 * 途径装进来的（市场界面、手工装）。这两种情况下盘上的代码不会自己生效 —— 而这个插件存在
 * 的理由就是「不用重启 DSH」，所以它得自己补上这一步。
 */
export async function reconcileInstalledGeneration({ runtime, log = () => {} } = {}) {
  let running = null
  try { running = runtime.status()?.version ?? null } catch { return null }
  const disk = installedVersion()
  if (!disk || !running || compareVersion(disk, running) <= 0) return null
  // 不在这里喊话：真去换时 `swapTo` 会记成功、失败那条下面自己记。卡住的机器每 10 分钟
  // 一行「补一次换代」纯属噪声，而真相在 `lastApply`（面板「运行中 / 盘上」两列也在报）。
  const attempt = await swapTo(runtime, disk, { auto: true, log })
  if (attempt.failure && !attempt.deferred) log('warn', 'dsh-mobile-plugin: %s', attempt.failure.message)
  return attempt.status ?? null
}

/** 自动更新开关的落盘文件：`<DSH_HOME>/storages/mobile-plugin/auto-update.json`。 */
function autoUpdateFile() {
  return path.join(dshHome(), 'storages', 'mobile-plugin', 'auto-update.json')
}

/** 未设置过默认自动更新；显式关闭保持关闭，配置损坏时不改动盘上插件。 */
export function autoUpdateEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(autoUpdateFile(), 'utf8'))
    return raw?.enabled === true
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

/** 写开关。 */
export function setAutoUpdate(enabled) {
  const file = autoUpdateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ enabled: enabled === true }, null, 2)}\n`)
  return autoUpdateEnabled()
}

/** 开关文件的路径（诊断用）。 */
export function autoUpdateFilePath() {
  return autoUpdateFile()
}

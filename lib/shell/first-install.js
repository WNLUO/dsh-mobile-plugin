/**
 * 「第一次把这个插件装进一台正在跑的 DSH」的判定。
 *
 * 为什么要单独记一笔：DSH 会把新装的 bundle 热加载起来（HMR），于是插件一装上、进程没重启
 * 也能跑、手机也连得上 —— 但这一代没走过 DSH 的启动装载，桌面端那半（侧栏 / 设置页的外壳
 * 资源）还没真正就位。装完让人**完整重启一次 DSH** 才是干净的收尾，手机端据此给一句明确
 * 提示（见 `plugin/self` 的 `firstInstallPendingRestart`）。
 *
 * 判据只有两条，都取自现场、不猜：
 *   · 这个 profile 里**从没跑过**这个插件（`$DSH_HOME` 里没有落过标记）；
 *   · 盘上这份的落盘时间**晚于 DSH 进程启动** —— 说明它是进程起来之后才装进来的（HMR），
 *     而不是进程启动时就加载好的那一份。
 *
 * 第一次跑过就在 `$DSH_HOME` 里落一个标记：下次（重启之后）不再判成首次。装的时候 DSH 本来
 * 就关着（下次启动会自然加载）、或已经重启过，都不会命中，也就不会冒一个假的重启要求。
 * 取不到落盘时间（源码挂载 / 无头部署）一律按「不提示」处理 —— 宁可少提醒，不给假提醒。
 */

import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from '../shared/paths.js'
import { installedPackageDir } from './manager.js'

/** 首次跑过的标记文件（落在 `$DSH_HOME`）。多个 profile 共用一个 DSH_HOME 时按 profile 分开。 */
const MARKER = 'mobile-plugin-first-run.json'

/** 标记文件名：带上 profile 名，免得多套 profile 共用一个 DSH_HOME 时互相顶掉。 */
function markerName() {
  const profile = String(process.env.DSH_PROFILE || '').trim()
  return profile ? `mobile-plugin-first-run.${profile.replace(/[^\w.-]/g, '_')}.json` : MARKER
}

/**
 * 纯判定：只回答「要不要提示重启一次」。
 *
 * 拆出来是为了能在裸 Node 里被守卫直接钉住 —— 真实落盘时间与进程启动时间都在调用方取。
 *
 * @param {{seenBefore: boolean, installedBirthMs: number|null, processStartMs: number|null}} input
 * @returns {boolean}
 */
export function decideNeedsRestart({ seenBefore, installedBirthMs, processStartMs }) {
  if (seenBefore) return false
  if (!Number.isFinite(installedBirthMs) || !Number.isFinite(processStartMs)) return false
  return installedBirthMs > processStartMs
}

/** 本进程大概是什么时候起的：拿不到更准的口径，用它比落盘时间已经够。 */
function processStartMs() {
  const up = typeof process.uptime === 'function' ? process.uptime() : 0
  return Date.now() - (Number.isFinite(up) ? up : 0) * 1000
}

/** 盘上这份插件目录的创建时刻；没有 birthtime 的平台退回 ctime。取不到回 null。 */
function installedBirthMs(dir) {
  try {
    const stat = fs.statSync(dir)
    if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) return stat.birthtimeMs
    return Number.isFinite(stat.ctimeMs) && stat.ctimeMs > 0 ? stat.ctimeMs : null
  } catch {
    return null
  }
}

/** 本进程里只判一次：装载 / 换代都可能反复读状态，别让标记写一半、读一半。 */
let decided = null

/**
 * 这次装载是不是「第一次装、而且装的时候 DSH 正开着（还没重启过）」。
 *
 * 结果按进程缓存；顺带把「跑过一次」记进 `$DSH_HOME`，让重启后不再算首次。
 *
 * @returns {boolean}
 */
export function firstInstallNeedsRestart() {
  if (decided !== null) return decided
  const home = dshHome()
  const marker = path.join(home, markerName())
  let seenBefore = false
  try {
    seenBefore = fs.existsSync(marker)
  } catch {
    seenBefore = false
  }
  const dir = installedPackageDir()
  const needs = decideNeedsRestart({
    seenBefore,
    installedBirthMs: dir ? installedBirthMs(dir) : null,
    processStartMs: processStartMs(),
  })
  // 记下「跑过一次」。写不进去不挡任何事：顶多下次重启后再判一次（那时落盘时间已经早于进程
  // 启动，结果仍是 false），不会误报。
  if (!seenBefore) {
    try {
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(marker, JSON.stringify({ seenAt: new Date().toISOString(), needsRestart: needs }))
    } catch {
      /* 记不下来就算了 */
    }
  }
  decided = needs
  return decided
}

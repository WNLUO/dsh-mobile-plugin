/**
 * 代际装载器：把「插件实现」当成可以整代替换的东西。
 *
 * 起因：宿主进程启动时就把 profile 的插件树定死了，改一次插件代码就得**完整重启
 * DSH**（Node 缓存 realpath，换 profile 链接必须重启进程）。手机那边的主机是 systemd
 * 拉起来的，重启一条命令的事；桌面这边用户得自己退出再打开，而他不想每次都做这件事。
 *
 * ## 2026-10 改：代从哪儿来（从「OTA 写进 .live」改成「市场装进 profile」）
 *
 * 从前一代是 OTA 下载、解包、写进 `<pkg>/lib/.live/<releaseId>/`；分发交给 DSH 插件市场
 * 之后那套没了，但**换代的判据反而更简单**：市场在 profile 里跑 pnpm，装新版会把
 * `<profile>/node_modules/dsh-mobile-plugin` 这个链接指向**一个全新的 store 目录**：
 *
 *   <profile>/node_modules/dsh-mobile-plugin -> .pnpm/dsh-mobile-plugin@0.1.58/node_modules/dsh-mobile-plugin
 *
 * 「新目录 = 新 realpath = 新 URL」，正是当年必须靠 `.live/<releaseId>` 才能拿到的东西
 * （见 `importGeneration` 里 `?v=` 那一段：同一路径换代码是骗不过 ESM 缓存的）。所以这里
 * 只要**认出 profile 里当前装的是哪一份**，把它当成一代接上去就够了 —— 不需要拷贝、
 * 不需要下载，也不需要 sha256 校验（那是市场的活儿）。
 *
 * 一代 = 一个完整包目录，`package.json` 与 `lib/impl.js` 缺一不可：`lib/*.js` 内部有
 * 80 多处相对引用（`../shared/http-util` 之类），必须保持 `lib/` 这一层的相对结构；
 * 实现里还有 `require('../dsh-mobile-credentials/lib/credentials.js')` 这种跨包相对引用，
 * 而凭据包就嵌在插件包目录内部，所以一代是**自包含**的：回滚到旧代时连凭据版本一起
 * 回滚，不会出现「旧插件配新凭据」。
 *
 * 裸包名（`ws`、`@deepseek-ai/...`）依旧沿祖先目录解析：从 `<代>/lib` 往上会经过
 * `<代>/node_modules`、profile 的 `node_modules`，最终落在同一份插件自身依赖与 peer
 * 依赖上，与基础代解析到同一份 real path，不会出现两份实例。
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** CJS 模块缓存。实现树里 `lib/relay`、`lib/routes`、`lib/mobile` 都是 CJS。 */
const require_ = createRequire(import.meta.url)

/** 外壳自己所在目录（`<pkg>/lib`）；随包发布的那一代（基础代）相对它定位。 */
const LIB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** 外壳所在包根（进程启动时的那一代）。它可能在运行期间被 pnpm 换掉，所以只当兜底。 */
const BOOT_PKG_DIR = path.join(LIB_DIR, '..')
/** 随包发布的实现（进程启动时必然存在；被换掉之后就不一定了）。 */
const BASE_ENTRY = path.join(LIB_DIR, 'impl.js')
/** 本包名：profile 里找的就是它。 */
const PLUGIN_PKG = 'dsh-mobile-plugin'
/**
 * profile 的 `node_modules`。测试用 `DSH_MOBILE_PROFILE_NODE_MODULES` 指到临时目录
 * （与从前 `DSH_MOBILE_LIVE_DIR` 同一个用途）。
 */
const PROFILE_NODE_MODULES = process.env.DSH_MOBILE_PROFILE_NODE_MODULES || findProfileNodeModules()

/**
 * 从外壳自己的路径往上找 profile 的 `node_modules`。
 *
 * 两种装法都要认：
 *   · pnpm/市场装（`.pnpm/<ver>/node_modules/dsh-mobile-plugin`）—— 往上会**先后**经过
 *     内层 `<ver>/node_modules` 与外层 `<profile>/node_modules`，两处都有 `dsh-mobile-plugin`
 *     这个名字，取**最外层**那个才是「市场换版本时会动的那个链接」；
 *   · 老装法（`<profile>/node_modules/dsh-mobile-plugin` 是实体目录）—— 只有一层。
 *
 * 找不到就退回外壳所在包的上一层：那一刻等于「没有可换的代」，`listGenerations()` 只会
 * 列出基础代，换代接口如实报「盘上没有别的代」，不会假装成功。
 */
function findProfileNodeModules() {
  let dir = BOOT_PKG_DIR
  let found = null
  for (let i = 0; i < 8; i += 1) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    if (path.basename(dir) !== 'node_modules') continue
    if (fs.existsSync(path.join(dir, PLUGIN_PKG))) found = dir
  }
  return found || path.join(BOOT_PKG_DIR, '..')
}

/** 版本号比较：只认 `x.y.z` 形式的段，够用且不引依赖。 */
export function compareVersion(a, b) {
  const left = String(a || '0').split('-')[0].split('.').map(Number)
  const right = String(b || '0').split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0
    const r = Number.isFinite(right[i]) ? right[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

function readPackageVersion(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

/**
 * 列出所有可用的代。
 *
 * 两个来源：
 *   · `bundled` —— 外壳自己所在的包（进程启动时那一代）。它可能在运行期间被市场的 pnpm
 *     整个换掉甚至删掉，所以**盘上读不到就列不出来**；那种时候只剩内存里那份
 *     （`imported` 里缓存着），回滚也只能靠它。
 *   · `installed` —— profile 里当前装着的那一份（`node_modules/dsh-mobile-plugin` 的
 *     realpath）。市场装新版之后这里立刻就是新版本，而且它的 realpath 每次都可能不同，
 *     天然绕开 ESM 缓存（这正是当年要靠 `.live/<releaseId>` 才能拿到的东西）。
 *
 * 只做「结构齐不齐」的粗筛：`package.json` 与 `lib/impl.js` 缺一不可。半份拷贝（安装被
 * 打断）如果被当成可用代，下次换代就会用一份残缺的代码上线。
 *
 * @returns {Array<{version: string, entry: string, dir: string|null, pkgDir: string, source: 'bundled'|'installed'}>}
 */
export function listGenerations() {
  const generations = []
  const baseVersion = readPackageVersion(path.join(BOOT_PKG_DIR, 'package.json'))
  if (baseVersion && fs.existsSync(BASE_ENTRY)) {
    generations.push({ version: baseVersion, entry: BASE_ENTRY, dir: BOOT_PKG_DIR, pkgDir: BOOT_PKG_DIR, source: 'bundled' })
  }
  const installed = installedPackageDir()
  if (installed) {
    const entry = path.join(installed, 'lib', 'impl.js')
    const version = readPackageVersion(path.join(installed, 'package.json'))
    if (version && fs.existsSync(entry)) {
      generations.push({ version, entry, dir: installed, pkgDir: installed, source: 'installed' })
    }
  }
  return generations
}

/**
 * profile 里当前装着的那份插件包的**真实路径**。
 *
 * 必须用 realpath：pnpm 把包放在 store 里、`node_modules/dsh-mobile-plugin` 只是个链接，
 * 而 ESM/CJS 的缓存键与相对引用都按真实路径算。拿不到（没装、链接坏）返回 null。
 */
export function installedPackageDir() {
  try {
    return fs.realpathSync(path.join(PROFILE_NODE_MODULES, PLUGIN_PKG))
  } catch {
    return null
  }
}

/** profile 的 `node_modules`（诊断用）。 */
export function profileNodeModules() {
  return PROFILE_NODE_MODULES
}

/** 盘上装着的版本号；读不到返回 null（没装 / 装了一半 / 链接坏）。 */
export function installedVersion() {
  const dir = installedPackageDir()
  return dir ? readPackageVersion(path.join(dir, 'package.json')) : null
}

/**
 * 取版本号最高的代。
 *
 * `preferVersion` 命中时优先（用于回滚到指定的旧代）。**版本号相同时取装进来的那一代**
 * （`source: 'live'`），理由见下面 `delta === 0` 那一段 —— 这不是审美问题，是「同样报
 * 0.1.16，一个跑新代码一个跑旧代码」的分叉点。
 */
export function resolveGeneration(preferVersion) {
  const generations = listGenerations()
  if (!generations.length) return null
  if (preferVersion) {
    const preferred = generations.find(item => item.version === preferVersion)
    if (preferred) return preferred
  }
  return generations.reduce((best, item) => {
    const delta = compareVersion(item.version, best.version)
    if (delta > 0) return item
    // 同版本时必须取 `installed`。基础代（包内 `lib/impl.js`）的路径是**固定**的，而
    // `importGeneration` 的 `?v=` 只骗得过**入口** —— 入口里 `require('./relay/…')` 那些
    // CJS 子模块按解析后的真实路径命中缓存，query 传不下去；于是「profile 里的插件包被
    // pnpm 换过版本」之后再激活固定路径那一代，拿到的仍是进程启动时那份**旧**实现。
    // 实测过：完整安装之后再自更新，接口回 `installed: true, version: <新版>`，而实际跑
    // 的还是旧代码 —— 状态说成功、代码没换，是最坏的那种失败。
    // `installed` 那一代的 realpath 是新目录 = 新 URL，整棵树必然读到新代码。
    if (delta === 0 && item.source === 'installed' && best.source !== 'installed') return item
    return best
  })
}

/**
 * 一代要从 CJS 缓存里清掉的根目录。
 *
 * 一代是自包含的（插件包里嵌着 `dsh-mobile-credentials/`），所以清「代目录」+「插件包
 * 目录」+「嵌着的凭据包」三处就够。凭据包还可能落在与插件包**同级**的旧布局位置上
 * （以兄弟身份被 require），所以那条路也要清，否则换代后新实现会读到上一代的凭据模块。
 */
function evictionRoots(generation) {
  const pkgDir = generation.pkgDir || path.dirname(path.dirname(generation.entry))
  const roots = [generation.dir, pkgDir, path.join(pkgDir, 'dsh-mobile-credentials')]
  if (generation.dir) roots.push(path.join(generation.dir, 'dsh-mobile-credentials'))
  return roots
}

/**
 * 把一棵实现树从 CJS 缓存里清掉。
 *
 * **为什么必须有这一步**：代际入口靠 `?v=<时间戳>` 换 URL，但入口内部那些
 * `require('./relay/…')` 走的是 CJS 缓存（按解析后的真实路径索引），query 传不下去。
 * 于是「同一路径下的代码被换掉了」时，新入口会拿到旧子模块 —— 实测：改盘上的子模块、
 * 再 `import(entry?v=…)`，拿到的仍是旧值；先清缓存才拿到新值。
 *
 * 这个坑只在**同一个路径被第二次加载**时出现。正常 OTA 往 `lib/.live/<新 id>/` 里装，
 * 路径是新的，踩不到；但基础代（包内 `lib/impl.js`）路径固定 —— 只要 profile 里的插件包
 * 在运行期间被 pnpm 换过版本，换代回基础代就会拿到上一版实现：新路由没注册、
 * `appVersion` 报旧版本号，而状态里却写着新版本。
 */
function evictCommonJsTree(roots) {
  const prefixes = []
  for (const root of roots) {
    if (!root) continue
    let real = root
    try {
      // 缓存键是 realpath（macOS 上 `/tmp` 与 `/private/tmp` 是两个字符串，直接比会漏）。
      real = fs.realpathSync(root)
    } catch {
      // 目录已被删（半份拷贝被清理）时，按原样比一次。
    }
    prefixes.push(real.endsWith(path.sep) ? real : real + path.sep)
  }
  if (!prefixes.length) return
  for (const key of Object.keys(require_.cache)) {
    if (prefixes.some(prefix => key.startsWith(prefix))) delete require_.cache[key]
  }
}

/**
 * 动态 import 一个代。
 *
 * URL 上带 `?v=<时间戳>-<序号>`：同一路径重复 import 会命中 ESM 缓存，**加了 query 才会
 * 拿到新实例** —— 这正是「同一份文件在不重启进程的前提下换掉实现」的开关。已经加载
 * 过的代会被缓存住，回滚时不会再读第二遍盘。
 *
 * 但 query 只够换掉**入口**：入口内部 require 出来的 CJS 子模块仍按路径命中缓存，所以
 * import 之前必须先把这棵树的 CJS 缓存清掉（见 `evictCommonJsTree`）。
 */
const imported = new Map()

/** `?v=` 里的序号：同一毫秒内连换两代时，光有时间戳会撞进同一个 URL。 */
let importSeq = 0

export async function importGeneration(generation) {
  const cached = imported.get(generation.version)
  if (cached) return cached
  // 先把 CJS 缓存清干净再 import，否则「入口是新的、子模块还是旧的」，等于换了个半成品上去。
  evictCommonJsTree(evictionRoots(generation))
  importSeq += 1
  const url = `${pathToFileURL(generation.entry).href}?v=${Date.now()}-${importSeq}`
  const mod = await import(url)
  const apply = typeof mod?.apply === 'function' ? mod.apply : null
  if (!apply) {
    throw new Error(`${generation.entry} 没有导出 apply：这一代的结构不对（期望导出一个 apply(ctx, config) 函数）`)
  }
  const loaded = {
    version: generation.version,
    source: generation.source,
    dir: generation.dir,
    apply,
    // 代自己声明的依赖服务，转交给 `ctx.plugin()`。**不能丢**：`lib/impl.js` 的 inject
    // 是按运行时二选一的（旧运行时多一个 `apiProxy`），丢了会让它在新旧运行时上都取不到
    // `ctx.apiProxy`。测试里的假代不声明时为 undefined，由外壳兜底。
    inject: Array.isArray(mod?.inject) ? mod.inject : null,
    hostPath: generation.dir,
  }
  imported.set(generation.version, loaded)
  return loaded
}

/**
 * 把一份新装进来的代登记为「可加载」。
 *
 * 只清缓存不够：调用方（OTA）写完新目录后立刻要切过去，而 `listGenerations()` 每次都
 * 重读目录，所以这里只需要把该版本可能存在的旧缓存丢掉，强制下次 import 读新文件。
 */
export function invalidateGeneration(version) {
  if (version) imported.delete(version)
  else imported.clear()
}

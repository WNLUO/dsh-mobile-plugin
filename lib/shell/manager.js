/**
 * 代际装载器：把「插件实现」当成可以整代替换的东西。
 *
 * 起因：宿主进程启动时就把 profile 的插件树定死了，改一次插件代码就得**完整重启
 * DSH**（Node 缓存 realpath，换 profile 链接必须重启进程）。手机那边的主机是 systemd
 * 拉起来的，重启一条命令的事；桌面这边用户得自己退出再打开，而他不想每次都做这件事。
 *
 * ## 2026-10 改：npm 正式代与紧急 OTA 代并存
 *
 * 正式版本由 DSH 插件市场装进 profile；紧急 OTA 将完整包落在 `$DSH_HOME/plugin-ota/`，两者都由代际装载器切换。正式版本安装仍通过 profile 里的 pnpm 完成，安装新版会把
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
import { availableOta, configureOtaRoot, snapshotGeneration } from './device-ota.js'
import { movePath } from './ota-package.js'
import { dshHome } from '../shared/paths.js'

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
 * 三种来源：
 *   · `bundled` —— 外壳自己所在的包（进程启动时那一代）。它可能在运行期间被市场的 pnpm
 *     整个换掉甚至删掉，所以**盘上读不到就列不出来**；那种时候只剩内存里那份
 *     （`imported` 里缓存着），回滚也只能靠它。
 *   · `installed` —— profile 里当前装着的正式版本（`node_modules/dsh-mobile-plugin` 的
 *     realpath）。市场装新版之后这里立刻就是新版本，而且它的 realpath 每次都可能不同，
 *     天然绕开 ESM 缓存（这正是当年要靠 `.live/<releaseId>` 才能拿到的东西）。
 *   · `ota` —— `$DSH_HOME/plugin-ota/<version>/dsh-mobile-plugin` 的完整紧急包；正式版成功
 *     接管后才清理已覆盖的 OTA，以便激活失败时重启仍能从磁盘回退。
 *
 * 只做「结构齐不齐」的粗筛：`package.json` 与 `lib/impl.js` 缺一不可。半份拷贝（安装被
 * 打断）如果被当成可用代，下次换代就会用一份残缺的代码上线。
 *
 * @returns {Array<{version: string, entry: string, dir: string|null, pkgDir: string, source: 'bundled'|'installed'|'ota'}>}
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
  const otaGenerations = availableOta()
  generations.push(...otaGenerations)
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
 * 装之前把**正在跑的那一代**备份进回退目录（换代的保险，见 `device-ota.js` 的
 * `snapshotGeneration`：包管理器一跑就把旧目录带走了）。
 *
 * 只有「跑着的就是盘上装着的那一代」才备份 —— 跑 OTA 代时盘上那份不是活代码，复制它对不上号。
 * 返回 `snapshotGeneration` 的结果，拿不到就回 null（备份失败不该挡住更新）。
 */
export function snapshotRunningGeneration(running) {
  const dir = installedPackageDir()
  if (!dir || !running || !running.version || running.source !== 'installed') return null
  if (installedVersion() !== running.version) return null
  return snapshotGeneration(dir, running.version)
}

/**
 * 取版本号最高的代。
 *
 * `preferVersion` 命中时优先（用于回滚到指定的旧代）。**版本号相同时优先 installed，其次 ota，最后 bundled**；来源与目录也参与运行时代身份判定，不能只比版本号。
 */
export function resolveGenerations(preferVersion) {
  const generations = listGenerations().sort((a, b) => {
    const delta = compareVersion(b.version, a.version)
    if (delta !== 0) return delta
    const priority = { installed: 2, ota: 1, bundled: 0 }
    return priority[b.source] - priority[a.source]
  })
  if (!preferVersion) return generations
  const preferred = generations.find(item => item.version === preferVersion)
  return preferred ? [preferred, ...generations.filter(item => item !== preferred)] : generations
}

/** 取优先级最高的一代；同版正式安装胜过 OTA，再胜过随包版本。 */
export function resolveGeneration(preferVersion) {
  return resolveGenerations(preferVersion)[0] ?? null
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
 * OTA 包落到 `<profile>/.dsh-mobile-ota`（不再放 `<DSH_HOME>/plugin-ota`）。
 *
 * 宿主对模块解析有一层拦截：**`profiles/` 树内**的模块，裸包名会先按 profile 的
 * 本地包解析、再回落到宿主自己那份；树外的模块走原生解析。而宿主提供的那批 peer
 * （`@deepseek-ai/dsh-tools` 等）并不在 profile 的 `node_modules` 里 —— 所以 OTA 包
 * 一旦落在树外，那一代 `require('@deepseek-ai/dsh-tools')` 就是 MODULE_NOT_FOUND
 * （2026-10-17 真机：0.1.80 装载失败）。位置挪进 profile 后，OTA 代与装进来的那一代
 * 走同一条解析链，不必再靠调用点逐个打补丁。
 *
 * 老位置残留的包顺手搬过来：换代失败时它还是磁盘上的回退包，不能在升级路径上丢。
 */
function moveOtaRootIntoProfile() {
  if (path.basename(PROFILE_NODE_MODULES) !== 'node_modules') return
  const next = path.join(path.dirname(PROFILE_NODE_MODULES), '.dsh-mobile-ota')
  const legacy = path.join(dshHome(), 'plugin-ota')
  configureOtaRoot(next)
  try {
    if (!fs.existsSync(legacy) || fs.lstatSync(legacy).isSymbolicLink()) return
    fs.mkdirSync(next, { recursive: true })
    for (const entry of fs.readdirSync(legacy)) {
      const target = path.join(next, entry)
      if (fs.existsSync(target)) continue
      // 跨盘也能搬：`<DSH_HOME>` 与 profile 在 Windows 上很可能不在同一个盘，
      // 那时 rename 抛 EXDEV，整段迁移会静默失败、OTA 留在树外（依赖就解析不到了）。
      movePath(path.join(legacy, entry), target)
    }
    fs.rmSync(legacy, { recursive: true, force: true })
  } catch {
    // 搬不动就用老位置：那是「OTA 仍可下载但可能装不起来」，比让外壳启动失败强
  }
}

/**
 * 给 OTA 代补齐「裸包名怎么解析」。
 *
 * Node 只沿**自己的祖先目录**找 `node_modules`，而 OTA 落在
 * `<DSH_HOME>/plugin-ota/<version>/` —— 这条路径上没有任何一份 `node_modules`。于是
 * `lib/impl.js` 第一句 `import { z } from '@deepseek-ai/schemastery'` 就报
 * `Cannot find package`，一代整个装不起来（2026-10-17 真机：0.1.79 的 OTA 装载失败，
 * 外壳按规矩回滚到旧代，机器上什么都没变）。
 *
 * 修法是补上基础代本来就有、而 OTA 路径上没有的那两层软链：
 *   `<version>/node_modules`                    → profile 的 `node_modules`
 *   `<version>/dsh-mobile-plugin/node_modules`  → profile 里那份插件的 `node_modules`（pnpm 严格布局才有）
 * 从 `<version>/dsh-mobile-plugin/lib` 往上第一站就命中，解析到的是**同一份** peer 与依赖，
 * 与基础代的 real path 一致 —— 不会出现两份 cordis/schemastery。
 */
/** 外壳一启动就把 OTA 落盘位置定下来（见 moveOtaRootIntoProfile 的注释）。 */
moveOtaRootIntoProfile()

/**
 * 最近一次「给 OTA 代补依赖软链」的失败原因。
 *
 * 软链只是兜底（落在 profile 里的一代本来就能沿祖先目录解析到 profile 的依赖），可它
 * **在 Windows 默认没有权限建**。旧实现把失败静默吞掉，于是现场只剩一句
 * `Cannot find module`，看不出是缺依赖还是补链失败。记在这里，由状态接口如实报出来。
 */
let generationLinkError = null
export function generationModulesError() {
  return generationLinkError
}

function ensureGenerationModules(generation) {
  if (!generation || generation.source !== 'ota' || !generation.dir) return
  // 只认真正的 `node_modules`：`findProfileNodeModules()` 找不到时会回落到 profile 根，
  // 把那个当依赖目录链过去等于凭空造一层错的解析路径。
  if (path.basename(PROFILE_NODE_MODULES) !== 'node_modules' || !fs.existsSync(PROFILE_NODE_MODULES)) return
  const versionDir = path.dirname(generation.dir)
  const link = (target, at) => {
    try {
      if (fs.lstatSync(at).isSymbolicLink()) {
        if (fs.readlinkSync(at) === target) return
        fs.unlinkSync(at)
      } else {
        return // 已经是实体目录（有人手工铺过依赖）：不动它
      }
    } catch {
      // 还不存在，往下建
    }
    try {
      fs.symlinkSync(target, at, 'dir')
      generationLinkError = null
    } catch (error) {
      // Windows 默认没有建软链的权限（要开发者模式或管理员），这类失败**必须留痕**：
      // 否则现场只有一句 `Cannot find module`，看不出是缺依赖还是补链被拒。
      generationLinkError = `补依赖软链失败（${at} → ${target}）：${error && typeof error === 'object' ? error.code || error.message : error}`
      try { process.stderr.write(`[dsh-mobile-plugin] ${generationLinkError}\n`) } catch { /* ignore */ }
    }
  }
  link(PROFILE_NODE_MODULES, path.join(versionDir, 'node_modules'))
  const nested = path.join(PROFILE_NODE_MODULES, PLUGIN_PKG, 'node_modules')
  if (fs.existsSync(nested)) link(nested, path.join(versionDir, PLUGIN_PKG, 'node_modules'))
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
const generationCacheKey = generation => JSON.stringify([generation.source, generation.version, generation.entry])

/** `?v=` 里的序号：同一毫秒内连换两代时，光有时间戳会撞进同一个 URL。 */
let importSeq = 0

export async function importGeneration(generation) {
  const cacheKey = generationCacheKey(generation)
  const cached = imported.get(cacheKey)
  if (cached) return cached
  ensureGenerationModules(generation)
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
  imported.set(cacheKey, loaded)
  return loaded
}

/**
 * 把一份新装进来的代登记为「可加载」。
 *
 * 只清缓存不够：调用方（OTA）写完新目录后立刻要切过去，而 `listGenerations()` 每次都
 * 重读目录，所以这里只需要把该版本可能存在的旧缓存丢掉，强制下次 import 读新文件。
 */
export function invalidateGeneration(version) {
  if (!version) return imported.clear()
  for (const [key, loaded] of imported) if (loaded.version === version) imported.delete(key)
}

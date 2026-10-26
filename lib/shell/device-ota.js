/** 设备端临时插件 OTA：npm 保持正式来源，OTA 只落在 profile 里（见 storageRoot）。 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from '../shared/paths.js'
import { compareVersion, generationModulesError } from './manager.js'
import { movePath, readManifest, sha256Hex, unpackTarGz, verifyManifest } from './ota-package.js'
/**
 * OTA 包落在哪。
 *
 * 默认 `<DSH_HOME>/plugin-ota`，外壳知道 profile 在哪之后会把它挪进 profile 里面。原因是
 * DSH 宿主对 `profiles/` 树外的模块走原生解析，而宿主提供的 peer 不在 profile 的
 * node_modules 里，OTA 代第一句 require 就 MODULE_NOT_FOUND。落在 profile 里之后，OTA 代与
 * 装进来的那一代走同一条解析链。
 */
let storageRoot = ''
export function configureOtaRoot(dir) {
  if (typeof dir === 'string' && dir.length > 0) storageRoot = dir
}
const ROOT = () => storageRoot || path.join(dshHome(), 'plugin-ota')
const PACKAGE = 'dsh-mobile-plugin'
const RELAY = 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota'
const CHANNEL = 'stable'
const PLATFORM = process.platform
/**
 * 平台回落的兜底标记。
 *
 * 这个插件是纯 JS，同一份包在 Linux/macOS/Windows 上都能跑；但中转是按平台分发的，以前
 * 只发过 darwin 就意味着 Windows 机器永远查不到更新（`ok:false` 被当成「没有新版」）。
 * 约定：自己平台没包时再问一次 `any`，发布方也可以直接只发一份 `any`。
 */
const ANY_PLATFORM = 'any'
function validVersion(value) { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) }
function validPackageUrl(value) {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
/**
 * 列出盘上可用的 OTA 代。
 *
 * 两条容错都是必要的：**逐个条目自己 try**（一个残目录不能让整台机器的 OTA 全部不可见——
 * 旧实现把整个 map 包在一个 try 里，任何一份半拷贝都会让 `availableOta()` 返回空，表现为
 * 「更新装了但界面上永远没有新版」），以及**跳过点开头的目录**（`.staging-*` 是解包中途的
 * 暂存，不能当成一代）。
 */
function availableOta() {
  let items
  try { items = fs.readdirSync(ROOT(), { withFileTypes: true }) } catch { return [] }
  const found = []
  for (const item of items) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue
    try {
      const pkgDir = path.join(ROOT(), item.name, PACKAGE)
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
      if (pkg.name !== PACKAGE || !validVersion(pkg.version)) continue
      if (!fs.existsSync(path.join(pkgDir, 'lib', 'impl.js'))) continue
      found.push({ version: pkg.version, entry: path.join(pkgDir, 'lib', 'impl.js'), dir: pkgDir, pkgDir, source: 'ota' })
    } catch { /* 半份包 / 残目录：只跳过它自己 */ }
  }
  return found.sort((a, b) => compareVersion(b.version, a.version))
}
/** 清掉上次解包中途退出留下的暂存目录（断电 / 进程被杀时的残骸）。 */
function sweepStaging() {
  let items
  try { items = fs.readdirSync(ROOT(), { withFileTypes: true }) } catch { return }
  for (const item of items) {
    if (!item.isDirectory() || !item.name.startsWith('.staging-')) continue
    try { fs.rmSync(path.join(ROOT(), item.name), { recursive: true, force: true }) } catch { /* 下次再清 */ }
  }
}
function clearSuperseded(version) {
  if (!validVersion(version)) return
  for (const release of availableOta()) if (compareVersion(version, release.version) >= 0) fs.rmSync(path.dirname(release.pkgDir), { recursive: true, force: true })
}
/**
 * 把**正在跑的那一代**复制成一份能从盘上回退的包（`<root>/<version>/dsh-mobile-plugin`）。
 *
 * 为什么必须复制：包管理器装新版会把旧的 store 目录整个带走，旧代码从此只剩内存里那一份。
 * 新版装上了却起不来时，外壳当场回滚到内存里那份（看着一切正常）；可**下次重启**就只能拿
 * 盘上那份坏的去装载，所有代都失败 = 插件整个不在（手机连不上、面板也没有）。回退目录本来
 * 就是干这个的（`availableOta` 列出来，启动时按版本从高到低逐个试），缺的只是「有人往里放
 * 一份能跑的」。
 *
 * 调用点是「真正要装之前」（见 `updater.js` 的 `beforeInstall`），所以拿到的就是那份还在跑、
 * 还装得上的代码。`node_modules` 不复制：那是 profile 的依赖树，复制既慢又会被相对布局骗到；
 * 落在 profile 里的这一代与 OTA 代走同一条解析链（见 `manager.js` 的 `moveOtaRootIntoProfile`）。
 *
 * 不抛错：备份是「多一层保险」，它失败不该挡住一次更新 —— 原因如实回给调用方去记日志。
 */
export function snapshotGeneration(sourceDir, version) {
  if (!validVersion(version) || typeof sourceDir !== 'string' || !sourceDir) {
    return { created: false, error: '版本号或目录不可用' }
  }
  const target = path.join(ROOT(), version, PACKAGE)
  if (fs.existsSync(path.join(target, 'lib', 'impl.js'))) return { created: false, existing: true, dir: target }
  let source = sourceDir
  try {
    source = fs.realpathSync(sourceDir)
  } catch {
    return { created: false, error: '要备份的那一代已经读不到了' }
  }
  if (!fs.existsSync(path.join(source, 'lib', 'impl.js'))) return { created: false, error: '要备份的那一代缺 lib/impl.js' }
  fs.mkdirSync(ROOT(), { recursive: true })
  // 先落到 `.staging-*`（`availableOta` 与 `sweepStaging` 都按这个前缀跳过/回收），
  // 复制完整了再一次性改名为 `<version>`：半个包不能被当成一代。
  const staging = fs.mkdtempSync(path.join(ROOT(), '.staging-fallback-'))
  try {
    fs.cpSync(source, path.join(staging, PACKAGE), {
      recursive: true,
      // 软链接按实体复制：旧布局里凭据包有时是「与插件包同级」的链接，照着链子复制会在旧目录
      // 被删之后悬空 —— 这一份必须自己就装得起来，所以把链接指向的内容抄实。
      dereference: true,
      filter: entry => path.basename(entry) !== 'node_modules',
    })
    fs.rmSync(path.join(ROOT(), version), { recursive: true, force: true })
    movePath(staging, path.join(ROOT(), version))
    return { created: true, dir: target }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    return { created: false, error: String((error && error.message) || error) }
  }
}
export function createDeviceOta({ fetchImpl = fetch, installed = () => null, platform = PLATFORM, channel = CHANNEL, runtime = null } = {}) {
  async function reconcileOfficial() {
    const active = runtime?.status()
    const officialVersion = installed()
    if (!runtime || !validVersion(officialVersion)) return { switched: false, status: active ?? null }
    if (active?.source === 'installed') {
      // 只有「跑着的就是他盘上那一版」才算接管成功，这时才回收回退包。
      // 换代失败时跑着的仍是旧版、盘上已是新版 —— 那份副本是下次重启唯一的活路，不能删。
      if (active.version === officialVersion) clearSuperseded(officialVersion)
      return { switched: false, status: active }
    }
    if (active?.source !== 'ota' || !validVersion(active.version) || compareVersion(officialVersion, active.version) < 0) {
      return { switched: false, status: active ?? null }
    }
    const status = await runtime.reload()
    if (status?.source === 'installed' && status.version === officialVersion) clearSuperseded(officialVersion)
    return { switched: status?.source === 'installed', status }
  }
  /** 问一次中转「我该装哪个版本」；没有就返回 null（不抛）。 */
  async function latestFor(wanted) {
    const url = `${RELAY}/latest?platform=${encodeURIComponent(wanted)}&channel=${encodeURIComponent(channel)}`
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`OTA relay 返回 HTTP ${response.status}`)
    const body = await response.json()
    if (body?.ok !== true) return null
    const release = body.data
    if (!release || !validVersion(release.version)) return null
    // 回落来的包平台标记是 `any`；自己平台那份必须正好对上。
    if (release.platform !== wanted || release.channel !== channel) return null
    if (!validPackageUrl(release.packageUrl)) return null
    return release
  }
  async function check() {
    await reconcileOfficial()
    const release = (await latestFor(platform)) ?? (platform === ANY_PLATFORM ? null : await latestFor(ANY_PLATFORM))
    if (!release) throw new Error('OTA relay 没有提供匹配平台、stable channel、有效版本或 HTTPS 下载地址')
    const installedVersion = installed()
    const officialVersion = installedVersion
    const ota = availableOta()[0] || null
    const otaVersion = validVersion(release.version) ? release.version : null
    const newest = [ota?.version, otaVersion].filter(validVersion).sort((a, b) => compareVersion(b, a))[0] || null
    const absorbed = Boolean(validVersion(officialVersion) && newest && compareVersion(officialVersion, newest) >= 0 && runtime?.status()?.source !== 'ota')
    return { available: Boolean(newest && !absorbed && compareVersion(newest, installedVersion || '0.0.0') > 0), version: newest, platform: release.platform || platform, channel: release.channel || channel, installedVersion, otaVersion: ota?.version ?? null, officialVersion, absorbed, packageUrl: release.packageUrl, sha256: typeof release.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(release.sha256) ? release.sha256.toLowerCase() : null }
  }
  async function apply() {
    const info = await check()
    if (info.otaVersion && compareVersion(info.otaVersion, info.version) === 0) return { installed: true, version: info.version, source: 'ota', alreadyDownloaded: true }
    if (validVersion(info.officialVersion) && compareVersion(info.officialVersion, info.version) >= 0) return { installed: false, reason: 'npm-current-or-newer', version: info.officialVersion }
    // 暂存目录**建在目标根里面**，不是系统临时目录：最后一步要 rename 到 `<root>/<version>`，
    // 跨盘的 rename 在 Windows 上直接 EXDEV（系统临时目录常在 C:，而 profile 可能在别的盘）。
    fs.mkdirSync(ROOT(), { recursive: true })
    sweepStaging()
    const staging = fs.mkdtempSync(path.join(ROOT(), '.staging-'))
    try {
      const response = await fetchImpl(info.packageUrl)
      if (!response.ok) throw new Error(`OTA 下载失败：HTTP ${response.status}`)
      const raw = Buffer.from(await response.arrayBuffer())
      // 中转记了哈希就一定要对上：半个包、被中间层改过的包都在这里被挡住，而不是装上去再炸。
      if (info.sha256 && sha256Hex(raw) !== info.sha256) {
        throw new Error(`OTA 包校验失败：下载内容的 sha256 与中转记录不一致（预期 ${info.sha256}，实际 ${sha256Hex(raw)}）`)
      }
      unpackTarGz(raw, staging)
      const pkgDir = path.join(staging, PACKAGE)
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
      const version = pkg && pkg.version
      if (pkg.name !== PACKAGE || !validVersion(version)) throw new Error('OTA 包结构不完整：package.json 里的包名或版本不对')
      if (version !== info.version) throw new Error(`OTA 版本不匹配：预期 ${info.version}，实际 ${version}`)
      if (!fs.existsSync(path.join(pkgDir, 'lib', 'impl.js'))) throw new Error('OTA 包结构不完整：缺 lib/impl.js')
      // 有清单就逐项核对（缺文件 / 大小不符在**激活之前**失败）；老包没有清单，退回上面那两条判据。
      const manifest = readManifest(pkgDir)
      if (manifest) {
        if (manifest.version !== version) throw new Error(`OTA 包清单版本与 package.json 不一致（${manifest.version} ≠ ${version}）`)
        verifyManifest(pkgDir, manifest)
      }
      const releaseDir = path.join(ROOT(), version)
      fs.rmSync(releaseDir, { recursive: true, force: true })
      movePath(staging, releaseDir)
      return { installed: true, version, source: 'ota', verified: Boolean(manifest) }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }
  const status = () => {
    const installedVersion = installed()
    const active = runtime?.status() ?? null
    const ota = availableOta()[0] || null
    return { available: Boolean(ota && compareVersion(ota.version, installedVersion || '0.0.0') > 0), activeVersion: active?.version ?? installedVersion, otaVersion: ota?.version ?? null, officialVersion: installedVersion, absorbed: Boolean(installedVersion && ota && compareVersion(installedVersion, ota.version) >= 0 && active?.source !== 'ota'), channel, dependencyLinkError: generationModulesError() }
  }
  async function activate() {
    const outcome = await apply()
    if (!outcome.installed || !runtime) return { ...outcome, status: runtime?.status() ?? null }
    const next = await runtime.reload(outcome.version)
    return { installed: true, version: outcome.version, status: next }
  }
  return { status, check, apply: activate, reconcileOfficial }
}
export { availableOta, clearSuperseded }

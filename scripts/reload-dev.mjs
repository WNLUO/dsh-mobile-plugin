#!/usr/bin/env node
/**
 * 开发机：把仓库里的插件改动**装进 profile**，再让它**就地重新装载**（不重启 DSH）。
 *
 * 宿主加载的是 profile 里装着的那一份，而 profile 的依赖声明写的是一个 `file:` 指向的 tgz。
 * 逐份拷文件虽然能让就地重载生效，但**那份安装不是声明的产物**：重启时宿主按
 * `package.json` + `pnpm-lock.yaml` 重跑安装，装回来又是冻结的旧 tgz，表现是「热重载过了、
 * 重启又是旧版」。所以默认走 `npm pack` → 放进 profile → 声明与锁文件指过去 → 用运行时
 * 自带的 pnpm 装一遍 → 就地重载，装完盘上那份就是声明的那一份。profile 是 hoisted 布局、
 * `realpath` 不变，所以装完不用重启。
 *
 * 换得掉 `lib/impl.js` 及它 require 进来的一切；换不掉**外壳自己**（`lib/index.js` +
 * `lib/shell/*`），它们在进程启动时被 Node 缓存。`--only` 只拷指定文件、不落安装声明，
 * 重启会退回声明里那一份。端口默认扫本机监听端口，挑答得出 `/api/relay/status` 的宿主。
 *
 * 用法：`--dry-run` 只看会做什么、`--only <文件…>` 只推几个文件、`--port <端口>` 指定宿主。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeDrift, verifyReload } from './lib/reload-verdict.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN_PKG = 'dsh-mobile-plugin'
/** 开发包名带时间戳：保证每次装的是「刚打出来这一份」，而不是 pnpm 认出来的同名旧包。 */
const DEV_TARBALL_PREFIX = `${PLUGIN_PKG}-dev-`
/** profile 里留几份开发包与几份安装目录备份：回滚只要最近那几份。 */
const DEV_TARBALL_KEEP = 2
const DEV_BACKUP_KEEP = 3

const args = process.argv.slice(2)
const hasFlag = name => args.includes(`--${name}`)
const flagValue = name => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null
}
/** `--only <相对路径>` 可出现多次：只同步这几个文件。 */
const onlyFiles = () => args.reduce((out, item, index) => {
  if (item === '--only' && index + 1 < args.length) out.push(args[index + 1].replace(/^\.\//, ''))
  return out
}, [])
const DRY_RUN = hasFlag('dry-run')
const PARTIAL = onlyFiles().length > 0

const say = message => process.stdout.write(`${message}\n`)
const warn = message => process.stderr.write(`${message}\n`)

function fail(message) {
  warn(`✖ ${message}`)
  process.exit(1)
}

/** DSH 数据目录：`DSH_HOME` 可覆盖，缺省 `~/.dsh`（与 lib/shared/paths.js 同一口径）。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** profile 名：`DSH_PROFILE` 可覆盖；本机缺省就是 desktop。 */
function profileName() {
  return process.env.DSH_PROFILE || flagValue('profile') || 'desktop'
}

/** profile 根目录：读它的依赖声明，也把开发包放进去。 */
function profileDir() {
  return path.join(dshHome(), 'profiles', profileName())
}

/** profile 的 `node_modules/<插件>`：实体目录或链接都指到这里。 */
function installedLink() {
  return path.join(profileDir(), 'node_modules', PLUGIN_PKG)
}

/**
 * profile 里装着的那一份的**真实路径**。
 *
 * 必须走 realpath：pnpm 可能把包放在 store 里、`node_modules/<插件>` 只是个链接，而外壳装载
 * 与 CJS 缓存都按真实路径算（见 lib/shell/manager.js 的 installedPackageDir）。往链接那一层
 * 拷，改的是一份没人在读的影子。
 */
function installedDir() {
  try {
    return fs.realpathSync(installedLink())
  } catch {
    return null
  }
}

/** 运行时自带的 pnpm：profile 的依赖布局就是它装出来的，别换成系统里那个。 */
function runtimePnpm() {
  return path.join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 读某个目录里那份 package.json 的版本号，读不到回 null。 */
function packageVersion(dir) {
  if (!dir) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.version ?? null
  } catch {
    return null
  }
}

/** profile 的依赖声明原文（`file:` 那种 spec）。 */
function declaredSpec() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf8'))
    return String(raw?.dependencies?.[PLUGIN_PKG] ?? '')
  } catch {
    return ''
  }
}

/**
 * profile 的依赖声明里那个**冻结的安装包**是什么版本。
 *
 * 盘上那份一旦等于它、又不等于仓库，就说明这份开发版已经被某次重装打回安装包里的内容 ——
 * 判据取声明本身，不去猜构建产物。
 */
function installSpecVersion() {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/i.exec(declaredSpec())
  return match ? match[1] : null
}

/**
 * 要进 profile 的那批文件（相对包根）。
 *
 * 判据是**包自己的 `files` 白名单**（`npm pack --dry-run --json` 说了算），不是这里另抄一份
 * 规则：真正发出去的包就是按它收的，开发机装的必须是同一份。两端由
 * `test/reload-dev-scope.test.cjs` 钉住：该进包的一个不能漏，`React/` `test/` `scripts/`
 * `node_modules` 与 tgz 一个不能进。
 */
function packedFiles() {
  let raw
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PLUGIN_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    fail(`读不出包内容（npm pack --dry-run 失败）：${String(error?.stderr || error?.message || error).trim()}`)
  }
  const parsed = JSON.parse(raw)
  const list = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files
  if (!Array.isArray(list)) fail('npm pack --dry-run 没给出文件清单：这个 npm 版本不支持 --json？')
  return list.map(item => String(item.path))
}

/**
 * `--only` 那份清单里的相对路径要能在**包清单**里找到。
 *
 * 包白名单是「什么东西会随包发出去」的唯一判据：一个既不在仓库、也不在包里的路径，拷过去只是
 * 在 profile 里放一份谁都不会更新的孤儿文件，所以这里当场拒掉而不是照拷。`React/` 构建源码、
 * `test/`、`scripts/` 也因此在 --only 这条路上同样进不去。
 */
function ensurePackable(files, packed) {
  const known = new Set(packed)
  const bad = []
  for (const rel of files) {
    if (known.has(rel)) continue
    if (fs.existsSync(path.join(PLUGIN_ROOT, rel))) {
      bad.push(`${rel}（在仓库里，但不在这个包的 files 白名单里 —— 装了也不会随包走）`)
    } else {
      bad.push(`${rel}（仓库里没有这个文件）`)
    }
  }
  if (bad.length) fail(`--only 里这几个路径不能用：\n  ${bad.join('\n  ')}`)
}

const SHELL_FILES = new Set([
  'lib/index.js',
  'lib/shell/runtime.js',
  'lib/shell/manager.js',
  'lib/shell/updater.js',
  'lib/shell/device-ota.js',
  'lib/shell/ota-package.js',
])

const isShellFile = rel => SHELL_FILES.has(rel)

/** 找出宿主控制面监听的端口：挑答得出 `/api/relay/status` 的那个。 */
async function findHostPort() {
  const explicit = Number(flagValue('port'))
  if (Number.isInteger(explicit) && explicit > 0) return explicit

  const candidates = new Set()
  // macOS / Linux 都用 lsof（macOS 自带；Linux 多数发行版也有）。没有就退回默认端口。
  try {
    const raw = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of raw.split('\n')) {
      const m = /:(\d+) \(LISTEN\)$/.exec(line.trim())
      if (!m) continue
      const port = Number(m[1])
      if (port > 1024 && port < 65536) candidates.add(port)
    }
  } catch {
    // 没有 lsof：下面只试默认那几个。
  }
  for (const port of [3080, 52772]) candidates.add(port)

  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/relay/status`, { signal: AbortSignal.timeout(1200) })
      if (!res.ok) continue
      const body = await res.json()
      // 只认本插件自己答的那一份：别的本地服务也可能在 200 回一段 JSON。
      if (body && body.localPort) return port
    } catch {
      // 连不上就换下一个
    }
  }
  return null
}

/** 读宿主的状态视图（拿不到就 null）：用它判断「盘上外壳与跑着的一不一致」。 */
async function hostStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/relay/update/status`, { signal: AbortSignal.timeout(3000) })
    const body = await res.json()
    return body?.data ?? null
  } catch {
    return null
  }
}

/**
 * 要推进 profile 的东西**能不能被 Node 加载**。
 *
 * 判据只给 js 类：一个语法错误推进 profile，下一次换代就会装载失败、外壳回滚到旧代，
 * 表现成「同步完了但什么都没变」，而 `node --check` 一秒就能说清是哪一行。
 * 非 js（面板产物、preset、yml）不在这里管 —— 它们由各自的守卫（`panel-artifact` 等）钉。
 */
function syntaxProblems(files) {
  const bad = []
  for (const rel of files) {
    if (!/\.(js|cjs|mjs)$/.test(rel)) continue
    try {
      execFileSync(process.execPath, ['--check', rel], { cwd: PLUGIN_ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      bad.push({ rel, message: String(error?.stderr || error?.message || error).trim().split('\n').slice(0, 3).join('\n') })
    }
  }
  return bad
}

/** 算出「哪些文件与盘上不同」，先不动 —— 动手之前要先过语法这一关。 */
function planChanges(target, files) {
  const changed = []
  for (const rel of files) {
    let same = false
    try {
      same = fs.readFileSync(path.join(PLUGIN_ROOT, rel)).equals(fs.readFileSync(path.join(target, rel)))
    } catch {
      same = false
    }
    if (!same) changed.push(rel)
  }
  return changed
}

/**
 * 装完 / 拷完逐文件对账：范围是刚刚动过的那批文件。
 *
 * 版本号相同不代表内容相同（同号重打，或者 pnpm 拿缓存里的同名旧包顶回来），只有逐字节比
 * 一遍才能回答「盘上这份是不是我仓库里这份」。对账不过就是失败 —— 不能打 ✔。
 */
function driftedFrom(target, files) {
  return files.filter(rel => {
    try {
      return !fs.readFileSync(path.join(PLUGIN_ROOT, rel)).equals(fs.readFileSync(path.join(target, rel)))
    } catch {
      return true
    }
  })
}

/** 把 profile 的依赖声明改成指向某个 spec（其余字段原样保留），返回改动前原文。 */
function pointDeclarationAt(spec) {
  const file = path.join(profileDir(), 'package.json')
  const before = fs.readFileSync(file, 'utf8')
  const manifest = JSON.parse(before)
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PLUGIN_PKG]: spec }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return before
}

/** 旧开发包只留最近几份，别让 profile 里堆一辈子 tgz。 */
function pruneDevTarballs(keepName) {
  let names
  try {
    names = fs.readdirSync(profileDir())
  } catch {
    return
  }
  const mine = names
    .filter(name => name.startsWith(DEV_TARBALL_PREFIX) && name.endsWith('.tgz') && name !== keepName)
    .sort()
  for (const name of mine.slice(0, Math.max(0, mine.length - (DEV_TARBALL_KEEP - 1)))) {
    fs.rmSync(path.join(profileDir(), name), { force: true })
  }
}

/** 装之前把盘上那一份整个备份下来（装坏了还能拷回去）。失败不挡安装。 */
function backupInstalled(target) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const root = path.join(profileDir(), '.plugin-backups')
    const dir = path.join(root, `${PLUGIN_PKG}-dev-${packageVersion(target) ?? 'unknown'}-${stamp}`)
    fs.mkdirSync(root, { recursive: true })
    fs.cpSync(target, dir, { recursive: true })
    const mine = fs.readdirSync(root).filter(name => name.startsWith(`${PLUGIN_PKG}-dev-`)).sort()
    for (const name of mine.slice(0, Math.max(0, mine.length - DEV_BACKUP_KEEP))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
    return dir
  } catch (error) {
    warn(`（备份这次没做成，不影响安装：${error?.message || error}）`)
    return null
  }
}

/** 默认那条路：打包 → 放进 profile → 声明与锁文件指过去 → 运行时 pnpm 装一遍。 */
function installPackedPackage() {
  const pnpm = runtimePnpm()
  if (!fs.existsSync(pnpm)) {
    fail(`找不到运行时自带的 pnpm：${pnpm}。profile 的依赖布局是它装出来的，别用系统里那个。`)
  }

  const files = packedFiles()
  const target = installedDir()

  // 语法先过一遍再打包：一个坏文件装进 profile，换代时装载失败、外壳回滚旧代，
  // 现场表现成「同步完了但什么都没变」—— 比在这里停下难查得多。
  const bad = syntaxProblems(files)
  if (bad.length) {
    for (const item of bad) warn(`✖ ${item.rel} 语法不过：\n${item.message}`)
    fail(`有 ${bad.length} 个文件语法不过，什么都没装、也没有重载。修好再跑一次。`)
  }

  const changed = planChanges(target, files)
  const shellTouched = changed.filter(isShellFile)
  if (!changed.length) {
    say('没有文件变化（仓库那份与装着的这份逐字节一致）。')
  } else {
    say(`${DRY_RUN ? '（演练）会装' : '会装'}仓库这一份（包内共 ${files.length} 个文件，其中 ${changed.length} 个与盘上不同）：`)
    for (const rel of changed.slice(0, 40)) say(`  ${isShellFile(rel) ? '· 外壳 ' : '  '}${rel}`)
    if (changed.length > 40) say(`  … 另有 ${changed.length - 40} 个`)
  }
  if (DRY_RUN) return { files, changed, shellTouched, dryRun: true }

  // 备份只在真有东西要换的时候做：没有变化还要装一遍的话，备份只是白堆副本。
  const backup = changed.length ? backupInstalled(target) : null
  if (backup) say(`先备份了装的那一份：${backup}`)

  // 打包：产物先进临时目录，再改名搬进 profile —— 别把 tgz 留在仓库树里。
  const devName = `${DEV_TARBALL_PREFIX}${Date.now()}.tgz`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pack-'))
  try {
    const raw = execFileSync('npm', ['pack', '--pack-destination', tmpDir, '--json'], { cwd: PLUGIN_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const parsed = JSON.parse(raw)
    const packed = path.join(tmpDir, String((Array.isArray(parsed) ? parsed[0] : parsed)?.filename ?? ''))
    if (!fs.existsSync(packed)) throw new Error(`打包产物没找到：${packed}`)
    fs.copyFileSync(packed, path.join(profileDir(), devName))
  } catch (error) {
    fail(`打包失败：${error?.message || error}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // 依赖声明指过去；锁文件交给 pnpm 自己更新（手改会与它记的完整性字段对不上）。
  const manifestBefore = pointDeclarationAt(`file:${devName}`)

  try {
    execFileSync(process.execPath, [pnpm, 'install', '--no-frozen-lockfile'], { cwd: profileDir(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  } catch (error) {
    // 装不上：声明退回去，别留一个指向半份东西的安装表，下次启动会被它拖住。
    fs.writeFileSync(path.join(profileDir(), 'package.json'), manifestBefore)
    try {
      execFileSync(process.execPath, [pnpm, 'install', '--frozen-lockfile'], { cwd: profileDir(), stdio: ['ignore', 'ignore', 'ignore'] })
    } catch { /* 退不回去也要把原因说出来 */ }
    fs.rmSync(path.join(profileDir(), devName), { force: true })
    fail(`安装失败（依赖声明已经退回去了）：\n${String(error?.stdout || error?.stderr || error?.message || error).trim().split('\n').slice(-8).join('\n')}`)
  }

  pruneDevTarballs(devName)

  if (!packageVersion(installedDir())) fail('装完读不到盘上的版本号：这份安装不完整。')
  const drifted = driftedFrom(installedDir(), files)
  if (drifted.length) {
    fail(`装完盘上仍有 ${drifted.length} 个文件与仓库不一致（${drifted.slice(0, 5).join('、')}${drifted.length > 5 ? ' …' : ''}）：这次装的东西不对，别当成功。`)
  }

  return { files, changed, shellTouched, devName, dryRun: false }
}

/** `--only` 那条快路：只把这几个文件拷进 profile（不落进安装声明）。 */
function syncPartial(files) {
  ensurePackable(files, packedFiles())

  const target = installedDir()
  const changed = planChanges(target, files)
  const shellTouched = changed.filter(isShellFile)
  if (!changed.length) {
    say('这几个文件与盘上逐字节一致，没有变化。')
  } else {
    say(`${DRY_RUN ? '（演练）会拷' : '会拷'} ${changed.length} 个文件：`)
    for (const rel of changed) say(`  ${isShellFile(rel) ? '· 外壳 ' : '  '}${rel}`)
  }

  const bad = syntaxProblems(changed)
  if (bad.length) {
    for (const item of bad) warn(`✖ ${item.rel} 语法不过：\n${item.message}`)
    fail(`有 ${bad.length} 个文件语法不过，什么都没拷、也没有重载。修好再跑一次。`)
  }
  if (DRY_RUN) return { changed, shellTouched, dryRun: true }

  for (const rel of changed) {
    const to = path.join(target, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(PLUGIN_ROOT, rel), to)
  }

  const stuck = driftedFrom(target, changed)
  if (stuck.length) {
    fail(`拷过一遍之后，盘上仍有 ${stuck.length} 个文件与仓库不一致：${stuck.slice(0, 5).join('、')}${stuck.length > 5 ? ' …' : ''}\n  多半有别的东西同时在动这份安装（重装、或者另一个会话在跑同一件事）。停一下再跑。`)
  }
  return { changed, shellTouched, dryRun: false }
}

/**
 * 面板产物是**提交物**：`React/` 源码比 `lib/panel/index.html` 新，就说明产物不是这份源码的。
 *
 * 不能靠调用方记得「改 React 后先跑 build」—— 忘了的症状是界面一个像素都没变，而脚本照样报
 * 成功。所以放进这条路里：陈旧就重建，重建失败就什么都不装。
 */
const PANEL_ARTIFACT = path.join(PLUGIN_ROOT, 'lib', 'panel', 'index.html')
const PANEL_SOURCES = [
  'React/src',
  'React/index.html',
  'React/package.json',
  'React/vite.config.ts',
  'React/vite.demo.config.ts',
  'React/tsconfig.json',
  'React/tsconfig.app.json',
  'React/scripts/inline.mjs',
]

/** 一个路径（文件或目录）下所有文件的最新修改时间。 */
function newestMtime(rel) {
  let stat
  try { stat = fs.statSync(path.join(PLUGIN_ROOT, rel)) } catch { return 0 }
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of fs.readdirSync(path.join(PLUGIN_ROOT, rel), { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(rel, entry.name)))
  }
  return newest
}

/** 面板产物是否比前端源码旧（产物不存在也算旧）。 */
function panelIsStale() {
  let artifact
  try { artifact = fs.statSync(PANEL_ARTIFACT).mtimeMs } catch { return true }
  return PANEL_SOURCES.reduce((newest, rel) => Math.max(newest, newestMtime(rel)), 0) > artifact
}

/** 用运行时那个 pnpm 重建面板。构建不过就停下，别把旧产物当成新页面装进去。 */
function buildPanel() {
  const pnpm = runtimePnpm()
  if (!fs.existsSync(pnpm)) fail(`找不到运行时自带的 pnpm：${pnpm}，没法重建面板。`)
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'React', 'node_modules'))) {
    fail('React/ 还没装依赖，重建不了面板：先在 dsh-mobile-plugin/React 里跑 pnpm install --frozen-lockfile。')
  }
  say('面板产物比 React 源码旧，先重建面板…')
  try {
    execFileSync(process.execPath, [pnpm, 'run', 'build'], { cwd: path.join(PLUGIN_ROOT, 'React'), stdio: 'inherit' })
  } catch (error) {
    fail(`面板构建失败，什么都没装、也没有重载：${String(error?.message || error).trim()}`)
  }
  if (!fs.existsSync(PANEL_ARTIFACT)) fail('构建跑完却没有面板产物：这份构建没成，别往下走。')
}

async function main() {
  if (!installedDir()) {
    fail(`profile 里没装 ${PLUGIN_PKG}：${installedLink()} 不存在。先装一次（npm/市场），这条路之后才有意义。`)
  }
  say(`目标（宿主真正加载的那一份）：${installedDir()}`)

  // 先把「仓库 / 盘上 / 声明」三个版本摆出来：盘上为什么是旧的，答案通常就在这几行里。
  const repoVersion = packageVersion(PLUGIN_ROOT)
  for (const line of describeDrift({
    repoVersion,
    diskVersion: packageVersion(installedDir()),
    installVersion: installSpecVersion(),
  })) say(line)

  // 前端改了而产物没重建，是「热重载成功、界面没变」最常见的来源。默认路自己管这一步，
  // 不再靠调用方记得。`--only` 不动面板，所以也不重建。
  if (!PARTIAL && panelIsStale()) {
    if (DRY_RUN) say('（演练）面板产物比 React 源码旧：真跑会先重建面板再打包。')
    else buildPanel()
  }

  const run = PARTIAL ? syncPartial(onlyFiles()) : installPackedPackage()

  if (run.dryRun) {
    say(PARTIAL
      ? '\n演练结束，没有触发重载。'
      : `\n演练结束：会打包（${run.files.length} 个文件）→ 放进 profile → 依赖声明与锁文件指过去 → 运行时 pnpm install → 触发就地重载。`)
    return
  }

  const port = await findHostPort()
  if (!port) fail('找不到宿主的控制面端口（没有哪个本机端口答得出 /api/relay/status）。用 --port <端口> 指定。')
  say(`\n宿主控制面：http://127.0.0.1:${port}`)

  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/relay/reload-implementation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
  } catch (error) {
    fail(`调不到重载接口：${error?.message || error}`)
  }
  const body = await res.json().catch(() => null)

  if (!res.ok || !body || body.ok !== true) {
    // 401 / 404 在这套宿主上是「这条路由不存在」的统一说法（控制面对未知路径也回 401）。
    // 它只说明一件事：跑着的那个进程里**还没有这条路由** —— 也就是外壳还是旧的那一份。
    // 这是唯一需要重启一次的情形，必须和「装载失败」分开说。
    if (res.status === 401 || res.status === 404) {
      const status = await hostStatus(port)
      warn('✖ 这个宿主进程里还没有「就地重载」这条接口（新的一份已经装进去了，进程里跑的还是旧外壳）。')
      if (status?.shellChanged === true) {
        warn('  状态里也报了 shellChanged：盘上这份外壳和跑着的不一样。')
      }
      warn('\n  这次必须重启一次 DSH —— 之后这条路就一直在，改完代码只需要再跑这个脚本，不用重启。')
      process.exit(2)
    }
    // 409 = 没有外壳（实现被直接挂载），500 = 装载失败已回滚。两种都说清楚，别让人以为装完就好了。
    const code = body?.error?.code || `http-${res.status}`
    const message = body?.error?.message || '（宿主没有给出原因）'
    fail(`重载失败 [${code}]：${message}\n  盘上文件已经换了，但**运行中的还是旧代码**。修好原因再跑一次这个脚本。`)
  }

  const data = body.data || {}
  // 「跑着的 = 盘上的」才算数：装载失败外壳会把上一代装回去（接口照样答 200 的情形也有）；
  // 声明没跟上时，重启会把这一轮成果换回去 —— 那也不算成功。
  const verdict = verifyReload({
    repoVersion,
    diskVersion: packageVersion(installedDir()),
    runningVersion: data.version,
    lastError: data.lastError,
    partial: PARTIAL,
    declaredSpec: declaredSpec(),
    expectedSpec: PARTIAL ? null : `file:${run.devName}`,
  })
  if (!verdict.ok) {
    for (const item of verdict.failures) warn(`✖ ${item}`)
    fail('这次同步不算成功：盘上的文件和跑着的实现没对齐，或者重启会退回旧的一份。')
  }

  say(`✔ 已就地重新装载：${data.version}（来源 ${data.source ?? '?'}），盘上与仓库都是这一版${PARTIAL ? '' : '，profile 声明的也正是它'}`)
  if (run.changed.length) say(`  这次生效的改动：${run.changed.length} 个文件`)

  if (PARTIAL) {
    warn('\n⚠ `--only` 只把这几个文件推过去了，**没有落进 profile 的安装声明**。')
    warn('  重启 DSH 会退回声明里那一份。要让重启也保留，跑一次不带 --only 的。')
  }
  if (run.shellTouched.length) {
    warn('\n⚠ 这次还改了外壳（lib/index.js 或 lib/shell/*）。')
    warn('  外壳在进程启动时就被 Node 缓存了，换不掉 —— 上面那些实现改动已经生效，')
    warn('  但外壳那部分要重启一次 DSH 才会用上。改外壳属于少数情况，日常改代码不会碰到。')
  } else {
    say('\n不用重启 DSH，手机那边刷新一下就能看到。')
  }
}

main().catch(error => fail(String(error?.stack || error)))

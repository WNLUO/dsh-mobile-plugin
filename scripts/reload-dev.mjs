#!/usr/bin/env node
/**
 * 开发机：把仓库里的插件改动同步进 profile 那一份，再让它**就地重新装载**（不重启 DSH）。
 *
 * ## 为什么需要它
 *
 * 宿主加载的是 profile 里装着的那一份（见 docs/dev-map-parts/03-plugin.md 的 A3-42），
 * 不是仓库源码。改完仓库必须做两件事才看得见效果：
 *
 *   1. 把改动的文件拷进 `<profile>/node_modules/dsh-mobile-plugin/`（realpath，pnpm 的
 *      store 目录）；
 *   2. 让外壳把这一代重新装一遍 —— `POST /api/relay/reload-implementation`。
 *
 * 第 2 步以前没有：外壳的换代码判据是「版本身份变了没有」，而开发机改的是**同一个目录
 * 里的文件**，身份一点没变，于是触发多少次都是旧代码，只能重启 DSH。
 *
 * ## 它能做到什么、做不到什么
 *
 * 换得掉：`lib/impl.js` 以及它 require 进来的一切（路由、移动 API、relay、镜像……），
 * 也就是日常改动的几乎全部。
 *
 * 换不掉：**外壳自己**（`lib/index.js` + `lib/shell/*`）。它们在进程启动时被 Node 缓存，
 * 换掉它们只能重启。脚本会把这两种情况分开报：只动了实现 = 已生效；连外壳一起动了 =
 * 实现生效、外壳那部分仍要重启一次。
 *
 * ## 用法
 *
 *   node dsh-mobile-plugin/scripts/reload-dev.mjs                       # 同步整个包 + 重载
 *   node dsh-mobile-plugin/scripts/reload-dev.mjs --only lib/routes/x.js # 只同步这几个
 *   node dsh-mobile-plugin/scripts/reload-dev.mjs --dry-run             # 只看会拷哪些文件
 *   node dsh-mobile-plugin/scripts/reload-dev.mjs --port 52772
 *
 * ⚠ 默认会把包内**所有**与盘上不同的文件都拷过去（面板产物、preset、yml、内联凭据库都算，
 * 只有 `React/` 构建源码、`test/`、`scripts/`、依赖与 tgz 不进 profile）。仓库里同时可能有
 * 别的对话没做完的改动，所以默认行为适合「这一份仓库就是我想跑的样子」；只想推自己改的那
 * 几个文件时用 `--only`（可重复）。
 *
 * 端口默认自己找：扫本机监听端口，挑那个答得出 `/api/relay/status` 的宿主。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describeDrift, verifyReload } from './lib/reload-verdict.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PLUGIN_PKG = 'dsh-mobile-plugin'

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

/**
 * profile 里装着的那一份的**真实路径**。
 *
 * 必须走 realpath：pnpm 把包放在 store 里，`node_modules/dsh-mobile-plugin` 只是链接，
 * 而外壳装载与 CJS 缓存都按真实路径算（见 lib/shell/manager.js 的 installedPackageDir）。
 * 往链接那一层拷，改的是一份没人在读的影子。
 */
function installedDir() {
  const link = path.join(dshHome(), 'profiles', profileName(), 'node_modules', PLUGIN_PKG)
  try {
    return fs.realpathSync(link)
  } catch {
    return null
  }
}

/** profile 根目录：读它的依赖声明，用来解释「盘上为什么是旧的那一版」。 */
function profileDir() {
  return path.join(dshHome(), 'profiles', profileName())
}

/** 读某个目录里那份 package.json 的版本号，读不到回 null。 */
function packageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.version ?? null
  } catch {
    return null
  }
}

/**
 * profile 的依赖声明里那个**冻结的安装包**是什么版本。
 *
 * 开发机装的是 `file:` 指向某个 tgz（本机是 `dsh-mobile-plugin-0.1.93.tgz`）。盘上那份一旦
 * 等于它、又不等于仓库，就说明这份开发版已经被某次重装打回安装包里的内容 —— 判据取
 * 声明本身，不去猜构建产物。
 */
function installSpecVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf8'))
    const spec = String(raw?.dependencies?.[PLUGIN_PKG] ?? '')
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/i.exec(spec)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * 仓库里要同步的那批文件（相对包根）。
 *
 * **整个包的内容都同步，不只是 js**：2026-10-20 之前这里只收 js/cjs/mjs，于是
 * 面板产物（`lib/panel/index.html`）、`lib` 各子目录里那几份 `package.json`（CJS 声明）、
 * `config/agent-presets` 的 preset、`cordis.mobile-host.yml`、`host.js`、内联的凭据包全都
 * 推不过去 —— 改完这些再跑一次同步，界面上一点变化都没有，而脚本还报「已就地重新装载」。
 * 要的是「仓库这一份原样搬过去」，所以按排除法收：只跳过那些**不该进 profile**的东西
 * （构建源码、测试、脚本、依赖、打包出的 tgz），其余一律同步。
 *
 * 由 `test/reload-dev-scope.test.cjs` 钉住这张表的两端。
 */
const EXCLUDED_DIRS = new Set(['node_modules', 'React', 'test', 'scripts', 'dist', '.git'])
const EXCLUDED_FILES = new Set(['.gitignore', 'LICENSE', 'pnpm-lock.yaml'])
const EXCLUDED_SUFFIXES = ['.tgz', '.log', '.DS_Store']

function collectSourceFiles(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...collectSourceFiles(path.join(dir, entry.name), rel))
    } else {
      if (EXCLUDED_FILES.has(entry.name)) continue
      if (EXCLUDED_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) continue
      out.push(rel)
    }
  }
  return out
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

/** 算出「哪些文件与盘上不同」，先不拷 —— 拷之前要先过语法这一关。 */
function planChanges(target) {
  const only = onlyFiles()
  const files = only.length ? only : collectSourceFiles(PLUGIN_ROOT)
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

/** 真正拷过去（演练时什么都不做）。 */
function applyChanges(target, changed) {
  for (const rel of changed) {
    if (DRY_RUN) continue
    const to = path.join(target, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(PLUGIN_ROOT, rel), to)
  }
}

/**
 * 拷过去的东西**能不能被 Node 加载**。
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

async function main() {
  const target = installedDir()
  if (!target) {
    fail(`profile 里没装 ${PLUGIN_PKG}：${path.join(dshHome(), 'profiles', profileName(), 'node_modules', PLUGIN_PKG)} 不存在。先装一次（npm/市场），这条路之后才有意义。`)
  }
  say(`目标（宿主真正加载的那一份）：${target}`)

  // 先把「仓库 / 盘上 / 声明」三个版本摆出来：盘上为什么是旧的，答案通常就在这几行里。
  const repoVersion = packageVersion(PLUGIN_ROOT)
  for (const line of describeDrift({
    repoVersion,
    diskVersion: packageVersion(target),
    installVersion: installSpecVersion(),
  })) say(line)

  const changed = planChanges(target)
  const shellTouched = changed.filter(isShellFile)
  const implChanged = changed.filter(rel => !isShellFile(rel))

  if (!changed.length) {
    say('没有文件变化（仓库那份与装着的这份逐字节一致）。')
  } else {
    say(`${DRY_RUN ? '（演练）会拷' : '会拷'} ${changed.length} 个文件：`)
    for (const rel of changed) say(`  ${isShellFile(rel) ? '· 外壳 ' : '  '}${rel}`)
  }

  // 语法先过一遍再落盘：一个坏文件推进 profile，换代时装载失败、外壳回滚旧代，
  // 现场表现成「同步完了但什么都没变」—— 比在这里停下难查得多。
  const bad = syntaxProblems(changed)
  if (bad.length) {
    for (const item of bad) warn(`✖ ${item.rel} 语法不过：\n${item.message}`)
    fail(`有 ${bad.length} 个文件语法不过，什么都没拷、也没有重载。修好再跑一次。`)
  }

  applyChanges(target, changed)

  if (DRY_RUN) {
    say('\n演练结束，没有触发重载。')
    return
  }

  // 拷完再对一遍盘：写不进去、或者拷的这一刻有别的东西在改这份安装（重装 / 另一个会话
  // 同步），都会在这里露出来，而不是等到「界面没变」才去查。
  const stuck = planChanges(target)
  if (stuck.length) {
    fail(`拷过一遍之后，盘上仍有 ${stuck.length} 个文件与仓库不一致：${stuck.slice(0, 5).join('、')}${stuck.length > 5 ? ' …' : ''}\n  多半有别的东西同时在动这份安装（重装、或者另一个会话在跑同一件事）。停一下再跑。`)
  }
  const diskVersion = packageVersion(target)

  const port = await findHostPort()
  if (!port) {
    fail('找不到宿主的控制面端口（没有哪个本机端口答得出 /api/relay/status）。用 --port <端口> 指定。')
  }
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
      warn('✖ 这个宿主进程里还没有「就地重载」这条接口（文件已经拷进去了，进程里跑的还是旧外壳）。')
      if (status?.shellChanged === true) {
        warn('  状态里也报了 shellChanged：盘上这份外壳和跑着的不一样。')
      }
      warn('\n  这次必须重启一次 DSH —— 之后这条路就一直在，改完代码只需要再跑这个脚本，不用重启。')
      process.exit(2)
    }
    // 409 = 没有外壳（实现被直接挂载），500 = 装载失败已回滚。两种都说清楚，别让人以为拷完就好了。
    const code = body?.error?.code || `http-${res.status}`
    const message = body?.error?.message || '（宿主没有给出原因）'
    fail(`重载失败 [${code}]：${message}\n  盘上文件已经换了，但**运行中的还是旧代码**。修好原因再跑一次这个脚本。`)
  }

  const data = body.data || {}
  // 「跑着的 = 盘上的」才算数：装载失败外壳会把上一代装回去（接口照样答 200 的情形也有），
  // 盘上那份也可能刚被别处的安装换回冻结的 tgz 快照。两种都让这一轮判失败，而不是打一个 ✔。
  const verdict = verifyReload({
    repoVersion,
    diskVersion,
    runningVersion: data.version,
    lastError: data.lastError,
    partial: onlyFiles().length > 0,
  })
  if (!verdict.ok) {
    for (const item of verdict.failures) warn(`✖ ${item}`)
    fail('这次同步不算成功：盘上的文件已经换了，跑着的实现没跟上。')
  }

  say(`✔ 已就地重新装载：${data.version}（来源 ${data.source ?? '?'}），盘上与仓库都是这一版`)
  if (implChanged.length) say(`  这次生效的实现改动：${implChanged.length} 个文件`)

  if (shellTouched.length) {
    warn('\n⚠ 这次还改了外壳（lib/index.js 或 lib/shell/*）。')
    warn('  外壳在进程启动时就被 Node 缓存了，换不掉 —— 上面那些实现改动已经生效，')
    warn('  但外壳那部分要重启一次 DSH 才会用上。改外壳属于少数情况，日常改代码不会碰到。')
    warn('  重启之后第一件事是重跑这个脚本：重启会按 profile 的依赖把盘上那份重新装一遍。')
  } else {
    say('\n不用重启 DSH，手机那边刷新一下就能看到。')
  }
}

main().catch(error => fail(String(error?.stack || error)))

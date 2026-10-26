#!/usr/bin/env node
/**
 * 发布前的服务器体检：把插件同步到测试宿主上，真跑一遍再决定发不发。
 *
 * 本地单测只能证明「模块是对的」，证明不了「装进宿主进程后插件树能起来」。插件是 profile
 * 层 bundle，装错了的失败方式特别安静：进程还在、端口还开着，只是移动 API 少了几条路由，
 * 日志里一行 `pending`。
 *
 * 服务器 `/opt/dsh-mobile/` 上有一台**专用的** DSH 宿主（systemd `dsh-mobile-host`），
 * 启动器与插件本体分开：**启动器**（`host.js`、两层 patch、`config/`、内嵌凭据包）靠 rsync
 * 同步，就是那份源码树；**插件本体**在 profile 里走 npm/pnpm 安装，宿主按绝对路径挂它的
 * `lib/index.js`（稳定外壳），所以面板里也有「检查 / 立即更新」，更新不用重启宿主。
 *
 * 脚本干的是：同步启动器 → 重启 → 探针 → 扫日志，并核对**真正被挂载的是哪一份**（挂错了会
 * 出现「本地全绿、服务器上跑的还是老代码」这种最难查的现场）。
 *
 * 检查项：宿主机 / 远端目录 / node 版本三个前提；同步启动器（`--delete`，排除 node_modules
 * 与 `lib/.live`，插件本体不在这一步）；声明的依赖（含 peer）逐个解析，缺了才装（先确认远端
 * 有 pnpm）；静态 import 一次，证明找得到、语法过得去；重启后等 `/api/relay/status` 真的能答
 * （不是只听 `systemctl is-active`）；断言 `panelUrl` 在、`/api/relay/panel` 吐得出 HTML；
 * 扫日志命中致命模式就失败。
 *
 * 用法：`--skip-sync` 只跑探针、`--no-restart` 只登录看看、`--ssh HOST --port 3080`。
 * 退出码 0 = 全部通过；非 0 = 至少一项没过（消息里说明是哪一项）。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_SSH = 'SHIYAN'
const REMOTE_ROOT = '/opt/dsh-mobile'
const SERVICE = 'dsh-mobile-host'
const HOST_LOG = `${REMOTE_ROOT}/logs/host.log`
/** 只需同步插件包：凭据包嵌在它内部（插件用 `../dsh-mobile-credentials/…` 跨包 require）。 */
const PACKAGES = ['dsh-mobile-plugin']
/** 同步时要排除的本地/运行期状态。`lib/.live` 是自更新装进来的代，不是源码。 */
const SYNC_EXCLUDES = ['node_modules', '.live', '.git', '.DS_Store']

/**
 * 重启后日志里出现这些就是硬失败。
 *
 * 只匹配「插件树起不来 / 进程级异常 / 模块找不到」这类，不匹配运行时噪声：sidecar 的
 * 503、`tunnel closed: 1006` 在正常重连时也会出现，扫进来只会让人学会忽略这个检查。
 */
const FATAL_PATTERNS = [
  /plugin tree failed to load/,
  /failed to apply loader entry/,
  /uncaughtException/,
  /unhandledRejection/,
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /SyntaxError:/,
  /ReferenceError:/,
  /listen EADDRINUSE/,
]

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const sshHost = arg('ssh', DEFAULT_SSH)
const port = arg('port', '3080')

let step = 0
const say = (message) => console.log(`\n[${++step}] ${message}`)
const info = (message) => console.log(`    ${message}`)
const ok = (message) => console.log(`    ✓ ${message}`)

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** 在服务器上跑一条 shell 命令。`check` 为真是「必须成功」。 */
function ssh(command, { check = true } = {}) {
  const result = spawnSync('ssh', [sshHost, command], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) fail(`ssh ${sshHost} 失败：${result.error.message}`)
  if (check && result.status !== 0) {
    fail(`远端命令失败（exit ${result.status}）：${command}\n${(result.stderr || '').trim()}`)
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/** 远端一次执行多条命令，任意一条失败即整体失败（`set -e`）。 */
function sshScript(lines, opts) {
  return ssh(`set -e\n${lines.join('\n')}`, opts)
}

/**
 * 依赖：判据是「声明的包在远端解析得到吗」，不是「依赖字段变了没」。
 *
 * 曾经用依赖字段的哈希判断，结果在一次纯**重组**上误报：把宿主供给的那几十个
 * `@deepseek-ai/*` 从 `dependencies` 挪到 `peerDependencies` 会让哈希必变，但远端一个包都不缺
 * （那些包本来就在宿主自己的依赖树里），于是脚本在一台没装 pnpm 的服务器上直接失败。
 *
 * 真正要回答的问题是「插件 `require`/`import` 一个裸包名时会不会 MODULE_NOT_FOUND」，
 * 那就逐个解析一遍：`dependencies` 与 `peerDependencies` 都是运行时会被 import 的裸名
 * （`schemastery` 就住在 peer 里，`lib/impl.js` 直接 import 它）。
 */
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const LOCAL_PKG = join(ROOT, 'dsh-mobile-plugin', 'package.json')
const REMOTE_PKG = `${REMOTE_ROOT}/dsh-mobile-plugin/package.json`

const depHashExpr = (file) => `const p=require(${JSON.stringify(file)});const o={};for (const k of ${JSON.stringify(DEP_FIELDS)}) o[k]=p[k]||{};process.stdout.write(require('crypto').createHash('sha256').update(JSON.stringify(o)).digest('hex'))`
const localDepHash = () => spawnSync('node', ['-e', depHashExpr(LOCAL_PKG)], { encoding: 'utf8' }).stdout.trim()
const remoteDepHash = () => ssh(`node -e ${JSON.stringify(depHashExpr(REMOTE_PKG))}`, { check: false }).stdout.trim()

/** 本地声明了哪些包（三个依赖字段的并集）。 */
function declaredDeps() {
  const pkg = JSON.parse(readFileSync(LOCAL_PKG, 'utf8'))
  const names = new Set()
  for (const field of DEP_FIELDS) for (const name of Object.keys(pkg[field] || {})) names.add(name)
  return [...names].sort()
}

/**
 * 从远端那个文件出发逐个解析，打印解析不到的包名（JSON 数组）。
 *
 * 必须是**单行**：这段代码经 `node -e "<code>"` 送过去，而 shell 的双引号里 `\n` 保持
 * 字面量，node 收到的是源码里的一个反斜杠加 n，直接 `SyntaxError: Expected unicode escape`。
 */
const missingDepsExpr = (base, names) => `const { createRequire } = require('node:module'); const req = createRequire(${JSON.stringify(base)}); const missing = []; for (const name of ${JSON.stringify(names)}) { let found = false; for (const spec of [name, name + '/package.json']) { try { req.resolve(spec); found = true; break } catch {} } if (!found) missing.push(name) } process.stdout.write(JSON.stringify(missing))`
const remoteMissingDeps = (names) => {
  const base = `${REMOTE_ROOT}/dsh-mobile-plugin/lib/impl.js`
  const out = ssh(`node -e ${JSON.stringify(missingDepsExpr(base, names))}`, { check: false })
  try {
    return JSON.parse(out.stdout.trim())
  } catch {
    fail(`远端依赖探测返回了看不懂的内容：${out.stdout.trim().slice(0, 200)}${(out.stderr || '').trim()}`)
  }
}

function main() {
  // ── 1. 前提 ────────────────────────────────────────────────────────────
  say(`连服务器 ${sshHost}，确认宿主机与目录`)
  const probe = sshScript([
    `test -d ${REMOTE_ROOT}/dsh-mobile-plugin`,
    `test -d ${REMOTE_ROOT}/dsh-mobile-plugin/dsh-mobile-credentials`,
    `node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22) { console.error('node too old: '+process.versions.node); process.exit(1) }"`,
    'node -v',
    `systemctl is-active ${SERVICE} || true`,
    `wc -l < ${HOST_LOG} 2>/dev/null || echo 0`,
  ])
  const lines = probe.stdout.trim().split('\n')
  const logLinesBefore = Number(lines[lines.length - 1]) || 0
  ok(`node ${lines[lines.length - 3] ?? '?'}，日志基线 ${logLinesBefore} 行`)

  // ── 2. 同步 ────────────────────────────────────────────────────────────
  let depHashBefore = ''
  if (flag('skip-sync')) {
    say('跳过同步（--skip-sync）')
  } else {
    say('同步插件包（含内嵌的凭据包）到服务器')
    depHashBefore = remoteDepHash()
    for (const name of PACKAGES) {
      const excludes = SYNC_EXCLUDES.flatMap((item) => ['--exclude', item])
      const result = spawnSync('rsync', ['-a', '--delete', ...excludes, `${join(ROOT, name)}/`, `${sshHost}:${REMOTE_ROOT}/${name}/`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.status !== 0) fail(`rsync ${name} 失败：${(result.stderr || '').trim()}`)
      ok(`${name} 已同步`)
    }
    // 凭据包以前是 ${REMOTE_ROOT} 下的同级目录，现在嵌在插件包内；旧副本会让服务器上
    // 出现两份凭据代码，装完顺手清掉。
    ssh(`rm -rf ${REMOTE_ROOT}/dsh-mobile-credentials`, { check: false })
  }

  // ── 3. 依赖 ────────────────────────────────────────────────────────────
  {
    say('检查声明的依赖在服务器上是否都解析得到')
    const names = declaredDeps()
    let missing = remoteMissingDeps(names)
    if (missing.length === 0) {
      ok(`${names.length} 个依赖（含 peer）全部解析得到，不需要装依赖`)
    } else {
      info(`远端解析不到：${missing.join('、')}`)
      const hasPnpm = ssh('command -v pnpm || true', { check: false }).stdout.trim()
      if (!hasPnpm) {
        fail(
          `远端缺少依赖（${missing.join('、')}），但服务器上没有 pnpm。` +
            '请先装 pnpm 并跑 `pnpm install --frozen-lockfile`，或在服务器上手动补上这些包后重跑本脚本。',
        )
      }
      sshScript([`cd ${REMOTE_ROOT}/dsh-mobile-plugin`, 'pnpm install --frozen-lockfile'], { check: true })
      missing = remoteMissingDeps(names)
      if (missing.length > 0) fail(`装完依赖仍然解析不到：${missing.join('、')}`)
      ok('依赖已重装')
    }
    if (!flag('skip-sync')) {
      const before = depHashBefore.slice(0, 12) || '空'
      const now = localDepHash().slice(0, 12)
      if (before !== now) info(`（依赖字段的声明重组过：${before} → ${now}；上面的解析结果才是判据）`)
    }
  }

  // ── 4. 静态装载（在弹服务之前先把「模块找得到、语法过得去」验掉） ──────
  say('远端静态装载：实现 import 一次')
  // 入口就是实现（`main` / `exports['.']` 都指向 lib/impl.js），不用再单独 import 外壳。
  sshScript([
    `cd ${REMOTE_ROOT}/dsh-mobile-plugin`,
    `node --input-type=module -e "const m = await import('${REMOTE_ROOT}/dsh-mobile-plugin/lib/impl.js'); if (typeof m.apply !== 'function') { console.error('实现没有导出 apply'); process.exit(1) } console.log('impl ok ' + m.name)"`,
  ])
  ok('实现能装载')

  // ── 5. 重启并等它真的能答 ──────────────────────────────────────────────
  if (flag('no-restart')) {
    say('跳过重启（--no-restart）')
  } else {
    say(`重启 ${SERVICE}`)
    sshScript([`systemctl restart ${SERVICE}`])
    let lastBody = ''
    let ready = false
    for (let i = 0; i < 60; i += 1) {
      const status = ssh(`systemctl is-active ${SERVICE} || true`, { check: false }).stdout.trim()
      if (status !== 'active') {
        fail(`${SERVICE} 没有停在 active（实际 "${status}"）。用 journalctl -u ${SERVICE} -n 50 查看。`)
      }
      const body = ssh(`curl -fsS http://127.0.0.1:${port}/api/relay/status || true`, { check: false }).stdout.trim()
      lastBody = body
      if (body.startsWith('{')) { ready = true; break }
      spawnSync('sleep', ['1'])
    }
    if (!ready) fail(`重启后 /api/relay/status 60 秒内没有返回 JSON。最后拿到：${lastBody.slice(0, 200)}`)
    ok('服务已起，状态接口有应答')
  }

  // ── 6. 探针 ────────────────────────────────────────────────────────────
  say('探针：移动 API 的状态与自更新外壳')
  const statusBody = ssh(`curl -fsS http://127.0.0.1:${port}/api/relay/status`).stdout.trim()
  let status = null
  try {
    status = JSON.parse(statusBody)
  } catch {
    fail(`/api/relay/status 返回的不是 JSON：${statusBody.slice(0, 200)}`)
  }
  for (const key of ['enabled', 'instanceId', 'tunnel', 'lan', 'sidecar']) {
    if (!(key in status)) fail(`/api/relay/status 少了字段 ${key}：${statusBody.slice(0, 300)}`)
  }
  ok(`tunnel=${status.tunnel?.state} lan=${status.lan?.state} sidecar=${status.sidecar?.state} appVersion=${status.appVersion}`)

  // 真正跑的是哪一份？日志里那行是宿主自己报的（`host.js` 在装载前打印），
  // 也是「插件本体在 profile 里」这条路的唯一凭据 —— 它一旦退回源码树直挂，
  // 面板里的自更新就没了，而且本地怎么测都看不出来。
  {
    const mode = ssh(`grep -a '挂载方式' ${HOST_LOG} | tail -1 || true`, { check: false }).stdout.trim()
    if (!mode) {
      info(`日志里没有「挂载方式」那一行（老 host.js？）：${HOST_LOG}`)
    } else if (mode.includes('profile 里装的那份')) {
      ok(`挂载方式：${mode.replace(/^.*挂载方式\s*=\s*/, '')}`)
    } else {
      fail(`宿主挂在源码树上，不是 profile 里那份（面板里的自更新会没有）。日志：${mode}`)
    }
    // 外壳在不在：`/update/status` 的 `available` 就是它自报的。
    const shell = ssh(`curl -fsS http://127.0.0.1:${port}/api/relay/update/status || true`, { check: false }).stdout.trim()
    try {
      const view = JSON.parse(shell)?.data ?? {}
      if (view.available === true) ok(`自更新外壳：available=true，profile 里装着 ${view.installedVersion ?? '?'}`)
      else fail(`自更新外壳不在（available=${JSON.stringify(view.available)}）：面板里没有「检查 / 立即更新」那一套`)
    } catch {
      fail(`/api/relay/update/status 返回的不是 JSON：${shell.slice(0, 200)}`)
    }
  }

  if (typeof status.panelUrl !== 'string' || !/^https?:\/\//.test(status.panelUrl)) {
    fail(`/api/relay/status 没有给出绝对地址的 panelUrl：${JSON.stringify(status.panelUrl)}（设置菜单里那个链接就指着它）`)
  }
  const panel = ssh(`curl -fsS http://127.0.0.1:${port}/api/relay/panel`, { check: false })
  if (panel.status !== 0) fail(`/api/relay/panel 取不到（exit ${panel.status}）：${(panel.stderr || '').slice(0, 200)}`)
  if (!panel.stdout.includes('<div id="root">')) fail('面板页不像一份能跑的单文件页面（没有挂载点 #root）')
  ok(`panelUrl=${status.panelUrl}，面板页 ${panel.stdout.length} 字节`)

  // ── 7. 扫日志 ─────────────────────────────────────────────────────────
  say('扫重启之后的日志')
  const tail = ssh(`tail -n +${logLinesBefore + 1} ${HOST_LOG} 2>/dev/null || true`, { check: false }).stdout
  const hits = []
  for (const line of tail.split('\n')) {
    for (const pattern of FATAL_PATTERNS) {
      if (pattern.test(line)) { hits.push(line.trim()); break }
    }
  }
  if (hits.length) {
    console.error(`\n✗ 日志里有 ${hits.length} 行致命信息：`)
    for (const line of hits.slice(0, 20)) console.error(`    ${line}`)
    process.exit(1)
  }
  const fresh = tail.split('\n').filter((line) => line.trim()).length
  ok(`新增 ${fresh} 行日志，没有命中致命模式`)

  console.log('\n✓ 服务器体检通过。')
}

main()

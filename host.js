#!/usr/bin/env node
/**
 * Headless Cordis Host for the DSH mobile app.
 *
 * The repository used to ship an Electron desktop shell that owned the Host
 * process; the DSH mobile app never used that surface. This entry replaces it:
 * it boots the same upstream Cordis Host, composes the shipped DSH Web
 * bundle, and adds one plugin — the mobile API at `/api/mobile/v1`.
 *
 * The Host itself is upstream. `@deepseek-ai/dsh-app-boot#boot` mounts a
 * `cordis.yml` entry list, so the root list stays empty and every plugin is
 * contributed by a patch layer: the profile's bundle layers (dsh-base then
 * dsh-web-app), the profile's own `cordis.patch.yml`, and finally this
 * package's `cordis.patch.yml`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { installProcessGuard } from './lib/host-guard.cjs'
import { DIRECTORY_PICKER_ROW, TOOL_ROWS, pinInsertedRows, syncPresetDir } from './lib/host-compat.cjs'
import { dropBareNameSelfMounts } from './lib/host-patches.cjs'
import {
  assertEntriesActivated,
  boot,
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  initProfile,
  installFailLoud,
  loadLayeredEnv,
  loadOverlayPatches,
  loadProfile,
  PROFILE_TEMPLATES,
  readProfileCompatibility,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'

const BIN_NAME = 'dsh-mobile-plugin'
const PROFILE_NAME = process.env.DSH_MOBILE_PROFILE || 'mobile'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
// The bundle layer fallback resolves plugins out of the installing package's
// dependency closure, so the anchor must be this package's own manifest.
const INSTALL_ANCHOR = join(PACKAGE_DIR, 'package.json')

// The process-level error boundary goes up **before** anything else can throw or
// reject: Node >= 15 turns an unhandled rejection into a throw, so a single
// detached promise during boot (or later, from any background task) would
// otherwise take the whole DSH down with it. The host is long-lived and the
// desktop shell has no plugin isolation, so "one plugin bug" and "DSH crashed"
// are the same event unless something catches it here. The guard records each
// fault, keeps the process alive, and only exits on a genuine crash loop so
// `Restart=on-failure` can pull up a clean one.
const { guard: hostGuard } = installProcessGuard()

loadLayeredEnv(BIN_NAME)
const releaseFailLoud = installFailLoud(BIN_NAME)

try {
  const home = process.env.DSH_HOME
  const profileDir = resolveProfileDir(PROFILE_NAME, home)
  // Idempotent: an already-initialized profile keeps its own patch layer.
  initProfile(profileDir, PROFILE_TEMPLATES.web)
  const profile = loadProfile(BIN_NAME, PROFILE_NAME, INSTALL_ANCHOR, home, { userLayer: true })

  /**
   * 本插件是**装在这个 profile 里**的，还是「源码树直接跑」的？
   *
   * 这两种现场的挂载方式不一样，而差别全在「挂哪一份入口」上（2026-10-11 起两条都留着）：
   *
   *  - **装在 profile 里**（桌面端；服务器那台改成 `pnpm 装进 profile` 之后也是）→ 挂
   *    `<profile>/node_modules/dsh-mobile-plugin/lib/index.js`，也就是**稳定外壳**：
   *    查更新、装新版、就地换代那一套全在它手里，所以面板上才有「检查 / 立即更新」。
   *  - **源码树直接跑**（老的无头部署、开发时直接 `node host.js`）→ 插件**就是** Loader 自己
   *    正跑的那个包，没有任何人把它放进 `node_modules`，于是这一支挂随包发布的
   *    `lib/impl.js`（真正的实现）。代价是**没有外壳** → 那台的面板里更新不了，只能同步
   *    源码 + 重启宿主。
   *
   * **两处都走「绝对路径」而不是包名**：`cordis.patch.yml` 里那行按包名挂载是给桌面端用的，
   * 无头宿主这边解析不到 —— loader 是从**它自己所在的位置**解析包名的（实测报错原文：
   * `Cannot find package 'dsh-mobile-plugin' imported from <…>/@deepseek-ai/cordis-plugin-loader/lib/index.js`），
   * 而它在宿主自己的依赖树里，profile 里装的那份它根本看不见。而 loader 对解析失败不是留一条
   * 警告，是**整棵插件树加载失败**（服务器那台当年就是这么完全起不来的）。所以那行在无头宿主
   * 里一律摘掉，由这里按绝对路径插一行 —— 装没装 profile 决定的是**挂哪一份**，不是挂不挂。
   *
   * 判据取「profile 里有没有这个包」，不看环境变量、不看目录名：装没装是事实，改不了口径。
   */
  const installedDir = join(profileDir, 'node_modules', BIN_NAME)
  const selfInstalled = existsSync(join(installedDir, 'package.json'))
  const selfPatches = loadOverlayPatches(BIN_NAME, join(PACKAGE_DIR, 'cordis.patch.yml'))

  // An empty entry list is the composition root: upstream fills the tree from
  // the profile's bundle layers; every plugin arrives via a patch layer.
  const rootConfig = join(profileDir, 'cordis.root.yml')
  writeFileSync(rootConfig, '[]\n')

  /**
   * 官方工具行跟着**运行时**换代，本包不再自带一份钉死的副本。
   *
   * 这三个包（提问工具 / 交付文件工具 / 目录浏览后端）互相之间用精确版本咬死，
   * 而装载前的预检对不上的处理不是降级、是**整行禁用** —— 现象是手机上
   * 「模型说没有这个工具」「添加工作区列不出目录」，桌面上却一切正常。钉在哪一代
   * 都不对：官方每抬一次代，钉死的副本就失效一次，而一台机器上装的 DSH 是哪一代
   * 我们发版时并不知道。
   *
   * 判据直接用 `dsh-app-boot` 自己导出的 `evaluatePluginCompatibility`，与装载前那次
   * 预检**同源**：自己写一套 semver 只会让两边分叉，这里放过的行照样被预检禁掉。
   * 先问运行时那棵树，再问本包自带的那份，都不行就返回 null —— 那一行保持原样，
   * 交给官方预检去禁用并打印原因，等于退回旧行为，不会更差。
   */
  let runtimeRequire = null
  try {
    runtimeRequire = createRequire(new URL(import.meta.resolve('@deepseek-ai/dsh-app-boot')))
  } catch (error) {
    // 定位不到不是致命：下面每一行都会退回本包自带的那份，最差回归旧行为。
    process.stderr.write(`${BIN_NAME}: 定位不到运行时那棵依赖树（${error?.message || error}），这一轮只按本包自带的解析\n`)
  }
  const bundledRequire = createRequire(import.meta.url)
  const runtimeVersion = getDshRuntimeVersion()
  let exemptions = {}
  try {
    exemptions = readProfileCompatibility(profileDir).exemptions
  } catch (error) {
    process.stderr.write(`${BIN_NAME}: 读不了 profile 的兼容性豁免文件，这一轮按无豁免处理：${error?.message || error}\n`)
  }

  const resolveGeneration = (scope, require, name) => {
    if (!require) return null
    try {
      const manifestPath = require.resolve(`${name}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const issue = evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)
      if (issue !== undefined && !issue.exempted) return null
      return { scope, name, version: manifest.version, entry: require.resolve(name) }
    } catch {
      return null
    }
  }

  const pinnedRows = new Map()
  for (const { id, name } of [...TOOL_ROWS, DIRECTORY_PICKER_ROW]) {
    const hit = resolveGeneration('运行时', runtimeRequire, name)
      ?? resolveGeneration('本包自带', bundledRequire, name)
    if (hit) pinnedRows.set(id, hit)
    process.stderr.write(
      hit
        ? `${BIN_NAME}: ${name} → 用${hit.scope}的 ${hit.version}\n`
        : `${BIN_NAME}: ${name} 没解析到与 dsh ${runtimeVersion} 同代的一份，这一行维持原样（装载预检会说明它为什么被禁用）\n`,
    )
  }

  // 预设里的两行默认按裸名写：Loader 从它自己的位置解析，命中哪一份不由我们决定。
  // 解析到了同代的那份就改写一份副本给它，路径写死成那一份的入口。
  const presetRoots = {}
  for (const { id } of TOOL_ROWS) {
    const hit = pinnedRows.get(id)
    if (hit) presetRoots[id] = hit.entry
  }
  const presetDir = TOOL_ROWS.some(({ id }) => presetRoots[id] !== undefined)
    ? syncPresetDir(
      join(PACKAGE_DIR, 'config', 'agent-presets'),
      join(profileDir, '.mobile-agent-presets'),
      presetRoots,
    )
    : join(PACKAGE_DIR, 'config', 'agent-presets')

  // patch 层里的 insert 行按包名写（`cordis.mobile-host.yml` 的目录浏览器），
  // 同样换成解析到的那份入口。只改 insert：patch 里其它形态的 name 是断言，
  // 改它会让整条 patch 被静默跳过。
  const entryByName = {}
  for (const hit of pinnedRows.values()) entryByName[hit.name] = hit.entry

  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...dropBareNameSelfMounts(selfPatches, BIN_NAME),
    // 宿主专属的层（不开浏览器、目录选择器钉成 browse）。刻意不放进
    // cordis.patch.yml：那一层桌面 GUI 也会加载，而桌面操作者就坐在机器前，
    // 不需要把原生目录选择器换成远程用的 browse 交互。
    ...loadOverlayPatches(BIN_NAME, join(PACKAGE_DIR, 'cordis.mobile-host.yml')),
    // The mobile API is this very package. The Loader imports an entry by bare
    // name from its own location, and that location has no `dsh-mobile-plugin`,
    // so the row names the entry module by absolute path — profile 里装了就挂
    // 那份的外壳，没装就挂源码树自己的实现（见上）。
    {
      insert: [{
        id: 'mobile-api',
        name: selfInstalled
          ? join(installedDir, 'lib', 'index.js')
          : join(PACKAGE_DIR, 'lib/impl.js'),
        config: { enabled: true },
      }],
    },
    // The DSH Web bundle disables every agent-plane row (shell, files, search,
    // skills, goals, planning, compaction, delegation) and lets each session
    // mount a preset instead — but it leaves the roster's shipped root to
    // `apps/cli`'s `composeProfile`, which a headless host never runs. Point
    // the roster at this package's own `config/agent-presets` so `standard`
    // resolves; without this the roster is composed but empty and every
    // `session/new` fails with `agent-preset-not-found`, while disabling the
    // roster instead would leave the agent with no tools at all.
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: presetDir, trust: 'system' }],
      },
    },
  ]

  const pinnedPatches = pinInsertedRows(patches, entryByName)

  process.stderr.write(
    `${BIN_NAME}: 挂载方式 = ${selfInstalled ? `profile 里装的那份（${installedDir}，带稳定外壳，面板里能自更新）` : '源码树直挂（无外壳，更新靠同步源码 + 重启宿主）'}\n`,
  )

  const ctx = await boot(BIN_NAME, rootConfig, pinnedPatches, (hostCtx) => {
    // A headless mobile host has no command line: nothing passes flags and
    // nobody is watching a help screen. The web startup plugin still waits on
    // `cmdlineArgs` before it will provide `webStartup`, so the service must
    // exist with an empty argument list or the tree deadlocks.
    provideCmdline(hostCtx, {
      args: [],
      exit: (code) => {
        process.exitCode = code
      },
    })
  })
  await assertEntriesActivated(ctx, BIN_NAME)
  // 装载期结束，撤掉 installFailLoud 的兜底。
  //
  // 它自己的语义是对的：一个插件**装载**失败不该让宿主半死不活地上线，所以
  // 任何 unhandledRejection 都直接 exit(1)。但它注册在 process 上之后**一辈子
  // 不摘**（releaseFailLoud 在成功路径上从来没被调用过），而宿主是长驻进程——
  // 于是运行期任意一次游离 reject 都会走到它那里把进程带走。上一版提交
  // （ca60417）在真机上被这条打脸：账本记下了「未处理的 Promise 拒绝（已忽略）」，
  // 紧接着一行 `fatal load failure` 就把 PID 换掉了。
  //
  // 这里在 assertEntriesActivated 通过之后才撤：那一刻树已经确认全部激活
  //（激活失败的 entry 会在它内部 throw，进上面的 catch 走 boot failed），
  // 此后再出现的 reject 就不再是「装载失败」而是运行期故障，
  // 交给进程级错误边界记账 + 熔断。
  releaseFailLoud()
  process.stderr.write(`${BIN_NAME}: mobile host ready (profile ${PROFILE_NAME})\n`)
} catch (error) {
  process.stderr.write(`${BIN_NAME}: boot failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  await releaseFailLoud()
  process.exitCode = 1
}

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

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { installProcessGuard } from './lib/host-guard.cjs'
import { dropBareNameSelfMounts } from './lib/host-patches.cjs'
import {
  assertEntriesActivated,
  boot,
  initProfile,
  installFailLoud,
  loadLayeredEnv,
  loadOverlayPatches,
  loadProfile,
  PROFILE_TEMPLATES,
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

  // An empty entry list is the composition root: upstream fills the tree from
  // the profile's bundle layers; every plugin arrives via a patch layer.
  const rootConfig = join(profileDir, 'cordis.root.yml')
  writeFileSync(rootConfig, '[]\n')

  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...dropBareNameSelfMounts(loadOverlayPatches(BIN_NAME, join(PACKAGE_DIR, 'cordis.patch.yml')), BIN_NAME),
    // 宿主专属的层（不开浏览器、目录选择器钉成 browse）。刻意不放进
    // cordis.patch.yml：那一层桌面 GUI 也会加载，而桌面操作者就坐在机器前，
    // 不需要把原生目录选择器换成远程用的 browse 交互。
    ...loadOverlayPatches(BIN_NAME, join(PACKAGE_DIR, 'cordis.mobile-host.yml')),
    // The mobile API is this very package. The Loader imports an entry by bare
    // name from its own location, and `dsh-mobile-plugin` is not installed
    // there, so the row names the plugin's entry module by absolute path.
    { insert: [{ id: 'mobile-api', name: join(PACKAGE_DIR, 'lib/impl.js'), config: { enabled: true } }] },
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
        roots: [{ path: join(PACKAGE_DIR, 'config', 'agent-presets'), trust: 'system' }],
      },
    },
  ]

  const ctx = await boot(BIN_NAME, rootConfig, patches, (hostCtx) => {
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

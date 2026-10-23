#!/usr/bin/env node
/**
 * 版本号计算与外写：本仓库里「发布时自动 +1」这件事的唯一实现。
 *
 * 为什么要单独一个模块：这个仓库有两条完全独立的发布链，过去都没有自动抬版本——
 *   · 插件 OTA（dsh-hub.wnluo.com）：中转按 version_name 做 semver 比较，忘抬版本
 *     会被判成「没有更新」，包发出去了但没人会收到。
 *   · App OTA（app.wnluo.com）：版本坐标抄在三个文件里（app/package.json、
 *     app/src/version.ts、app/android/app/build.gradle），必须逐字一致；平台还按
 *     (应用,渠道,运行时,版本,构建号) 判重，沿用旧构建号会被直接拒绝。
 * 两条链都需要「读旧值 → 算新值 → 原样写回」，算法若各写一份，迟早会漂。
 *
 * 这个模块只做四件事，全部是纯函数 + 明确的文件读写，不联网：
 *   1. 解析并校验稳定版 SemVer；
 *   2. 按 patch|minor|major 抬一位；
 *   3. 把新版本号写回 package.json / version.ts / build.gradle（保留原文件格式）；
 *   4. 从 git 历史生成发布说明。
 *
 * 它**不**决定 App 的构建号：构建号必须比分发平台上已有的都大，那要联网查，
 * 由调用方（app/scripts/publish-app-ota.mjs）查完把结果传进来。
 *
 * 用 node dsh-mobile-plugin/scripts/bump-version.mjs --help 看命令行用法。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * App 的版本坐标文件：版本名要在三处一致，构建号在其中两处。
 *
 * 写成常量而不是各处写字面量，是因为 publish-app-ota.mjs 还要拿它判断「哪些改动
 * 只是坐标、不算原生改动」（那里的 COORD_ONLY_FILE）—— 两处必须指同一个文件，
 * 否则「抬版本写回哪里」与「哪些改动可以热更放行」会各说各话。
 */
export const APP_GRADLE_FILE = 'app/android/app/build.gradle'
/** iOS 的发布身份写在 Xcode 工程的构建配置里（target 与 project 各 Debug/Release 一份）。 */
export const APP_IOS_PBXPROJ_FILE = 'app/ios/DshApp.xcodeproj/project.pbxproj'
export const APP_COORD_FILES = ['app/package.json', 'app/src/version.ts', APP_GRADLE_FILE, APP_IOS_PBXPROJ_FILE]
/** 上面那些路径相对 app/ 的写法（读取与写回都从 app/ 起算）。 */
const APP_GRADLE_REL = APP_GRADLE_FILE.replace(/^app\//, '')
const APP_IOS_PBXPROJ_REL = APP_IOS_PBXPROJ_FILE.replace(/^app\//, '')

// 只接受稳定版 x.y.z。带 prerelease/build 元数据的版本号在这里没有语义：
// 两条链的客户端都比较 version_name 的大小，而 prerelease 的排序规则
// 与「发布顺序」不是一回事，放进来只会得到一个静默不更新的包。
const STABLE_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

// 与 publish-app-ota.mjs 里的坐标读取保持一致：只认单引号字面量。
// version.ts 是 TypeScript 源文件，这里刻意用正则而不是 import——它不能被
// 直接 require，且我们只改字面量、不执行它。
const VERSION_TS_APP_VERSION = /(APP_VERSION\s*=\s*')([^']*)(')/
const VERSION_TS_BUILD_NUMBER = /(APP_BUILD_NUMBER\s*=\s*')([^']*)(')/
// 同一行的第二组必须真的捕获到「紧跟在后面的那个引号」，否则像 versionNameSuffix "x"
// 这样的邻居行也会被这条正则匹配上。
const GRADLE_VERSION_CODE = /(\bversionCode\s+)(\d+)(\s*)$/m
const GRADLE_VERSION_NAME = /(\bversionName\s+")([^"]*)(")/
/** package.json 的顶层 "version" 字段：只认顶格两空格缩进的那一行，不碰依赖里的同名键。 */
const PKG_VERSION_FIELD = /(^ {2}"version"\s*:\s*")([^"]*)(")/m
// iOS 的坐标在 pbxproj 里有**多处**（target 与 project 各一份 Debug/Release），值必须处处
// 相同 —— 所以配 requireUniformField 而不是 requireUniqueField（后者要求恰好命中 1 处）。
const PBX_MARKETING_VERSION = /(MARKETING_VERSION = )([^;]+)(;)/
const PBX_CURRENT_PROJECT_VERSION = /(CURRENT_PROJECT_VERSION = )([^;]+)(;)/

/** 每个字段单独一条上限，与 App 的构建号刻度一致（major*1e6 + minor*1e3 + patch）。 */
const SEGMENT_MAX = 999

export function parseVersion(text) {
  const match = STABLE_SEMVER.exec(String(text ?? '').trim())
  if (match === null) {
    throw new Error(`版本号 ${JSON.stringify(text)} 不是稳定版 SemVer（要 x.y.z，不许带 -rc/.1 后缀）`)
  }
  const [, major, minor, patch] = match
  const parts = [major, minor, patch].map(Number)
  if (parts.some((n) => n > SEGMENT_MAX)) {
    throw new Error(`版本号 ${text} 超出构建号刻度（每段必须 <= ${SEGMENT_MAX}）`)
  }
  return { major: parts[0], minor: parts[1], patch: parts[2] }
}

export function formatVersion({ major, minor, patch }) {
  for (const [name, value] of [['major', major], ['minor', minor], ['patch', patch]]) {
    if (!Number.isInteger(value) || value < 0 || value > SEGMENT_MAX) {
      throw new Error(`${name}=${value} 不在 0..${SEGMENT_MAX} 范围内`)
    }
  }
  return `${major}.${minor}.${patch}`
}

/**
 * 抬一位。语义与 SemVer 一致：major 抬了把 minor/patch 归零，minor 抬了把 patch 归零。
 * level 只接受 patch|minor|major，不认识的值直接抛——宁可报错也不要默默按 patch 处理。
 */
export function nextVersion(current, level = 'patch') {
  const { major, minor, patch } = parseVersion(current)
  let next
  if (level === 'major') next = { major: major + 1, minor: 0, patch: 0 }
  else if (level === 'minor') next = { major, minor: minor + 1, patch: 0 }
  else if (level === 'patch') next = { major, minor, patch: patch + 1 }
  else throw new Error(`未知的抬升级别 ${JSON.stringify(level)}（只支持 patch | minor | major）`)
  return formatVersion(next)
}

/**
 * 读一个 package.json 的顶层 version（用正则，不用 JSON.stringify 回写，
 * 免得一次版本抬升顺带把整个文件的键序/缩进都重排一遍）。
 */
export async function readPackageVersion(dirOrPath, root = ROOT) {
  const path = dirOrPath.endsWith('package.json') ? resolve(root, dirOrPath) : join(root, dirOrPath, 'package.json')
  const text = await readFile(path, 'utf8')
  const match = PKG_VERSION_FIELD.exec(text)
  if (match === null) throw new Error(`${path} 里没找到顶层 version 字段`)
  parseVersion(match[2])
  return { path, version: match[2] }
}

/** 当前仓库里插件的版本号。插件 OTA 的 version_name 就是从这里来的。 */
export async function readPluginVersion(root = ROOT) {
  return (await readPackageVersion('dsh-mobile-plugin', root)).version
}

/**
 * 演示页上报的版本号。它是**源码里的硬编码**，不在 package.json 里，但守卫
 * （`test/demo-panel.test.cjs`）要求它与插件包逐字一致 —— 演示里出现一个不存在的
 * 版本号比不写更糟。抬号时一并改，比让每次发版都在 CI 里撞一次这条守卫好。
 */
export const PLUGIN_DEMO_VERSION_FILE = 'dsh-mobile-plugin/React/src/demo/host.ts'
const DEMO_VERSION_FIELD = /(export const DEMO_VERSION = ')(\d+\.\d+\.\d+)(')/

/**
 * 把插件版本号写回 dsh-mobile-plugin/package.json。
 *
 * 刻意不碰 pnpm-lock.yaml：pnpm 的锁文件只记录依赖树，不记录包自身的 version，
 * 改锁文件反而会让它与 package.json 漂开、--frozen-lockfile 直接失败。
 *
 * 同时把演示页的 `DEMO_VERSION` 一起改（见 PLUGIN_DEMO_VERSION_FILE）。
 */
export async function writePluginVersion(version, root = ROOT) {
  parseVersion(version)
  const { path, version: previous } = await readPackageVersion('dsh-mobile-plugin', root)
  const text = await readFile(path, 'utf8')
  await writeFile(path, replaceOnce(text, PKG_VERSION_FIELD, version, `${path} 的 version 字段`))

  const demoPath = resolve(root, PLUGIN_DEMO_VERSION_FILE)
  // 文件不在就不动：这个模块也会对着只有 package.json 的最小假跑（测试里就是），
  // 而演示页只是插件仓库里的一份源码，不是抬号本身的前提。
  if (existsSync(demoPath)) {
    const demoText = await readFile(demoPath, 'utf8')
    await writeFile(demoPath, replaceOnce(demoText, DEMO_VERSION_FIELD, version, `${demoPath} 的 DEMO_VERSION`))
  }

  return { path, previous, version }
}

/**
 * 解析「发布时指定的版本号」（--version）该不该写回仓库。
 *
 * 为什么必须写回、不能只钉清单里的 version_name：插件 OTA 清单的 plugins[].version
 * 是读各自 package.json 得来的（build-plugin-ota.mjs 的 collectPlugin），只改
 * version_name 会发出「清单说 0.1.23、包里 package.json 还是 0.1.22」的发行版，
 * 而中转只按 (id, platform, channel) 判重，不会替发布者发现这件事。
 *
 * @param {string} pinnedVersion --version 给的目标版本
 * @param {{ noBump?: boolean, root?: string }} [options]
 * @returns {Promise<{version: string, previous: string, wrote: boolean}>}
 */
export async function resolvePinnedVersion(pinnedVersion, { noBump = false, root = ROOT } = {}) {
  parseVersion(pinnedVersion)
  const previous = await readPluginVersion(root)
  if (pinnedVersion === previous) return { version: previous, previous, wrote: false }
  if (noBump) {
    throw new Error(`--version ${pinnedVersion} 与仓库版本 ${previous} 不一致，而 --no-bump 禁止写回：`
      + `这样发出去的包里 package.json 仍是 ${previous}，与清单的 version_name 矛盾。`
      + `去掉 --no-bump，或先把 dsh-mobile-plugin/package.json 改到 ${pinnedVersion}。`)
  }
  await writePluginVersion(pinnedVersion, root)
  return { version: pinnedVersion, previous, wrote: true }
}

export function bumpPluginVersion(current, level = 'patch') {
  return nextVersion(current, level)
}

/**
 * 读 App 三个坐标里的当前值。
 *
 * 三处必须一致，这里在读取阶段就把不一致暴露出来（而不是写回之后靠守卫发现）：
 * 不一致说明上一次发版只改了一部分，继续抬版本会把这个错误固化下去。
 */
/**
 * 取一个坐标字段的值，并要求它在文件里**恰好**出现一次。
 *
 * 命中 0 次说明声明被改成了变量或挪了地方，命中 2 次说明构建脚本里有第二处同类声明
 * ——两种情况下「静默只改第一处」都会让发布出去的坐标和仓库里写的不是同一个。
 * 读取和写回共用这一条，写回才能保证不会改了一半才发现有第二处。
 */
export function requireUniqueField(text, re, label) {
  const found = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]
  if (found.length !== 1) {
    throw new Error(found.length === 0
      ? `${label} 没找到，版本坐标对不上，拒绝发布`
      : `${label} 在文件里命中 ${found.length} 处（要求恰好 1 处），拒绝发布`)
  }
  return found[0][2]
}

/**
 * 取一个**允许多处、但值必须处处相同**的坐标字段（iOS 的 pbxproj 就是这种形状：
 * target 与 project 各一份 Debug/Release）。任一处不同即视为漂移 —— 那说明有人手改过
 * 其中一个构建配置，继续抬号会把这个错误固化下去。
 */
export function requireUniformField(text, re, label) {
  const found = [...text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))]
  if (found.length === 0) throw new Error(`${label} 没找到，版本坐标对不上，拒绝发布`)
  const values = found.map((m) => m[2])
  if (new Set(values).size !== 1) {
    throw new Error(`${label} 在文件里出现了 ${found.length} 处但取值不一致（${values.join(' vs ')}），拒绝发布`)
  }
  return values[0]
}

export async function readAppCoordinates(root = ROOT) {
  const appDir = join(root, 'app')
  const read = (p) => readFile(join(appDir, p), 'utf8')
  const [pkgText, versionTs, gradle, pbxproj] = await Promise.all([
    read('package.json'), read('src/version.ts'), read(APP_GRADLE_REL), read(APP_IOS_PBXPROJ_REL),
  ])

  const coordinates = {
    'app/package.json': requireUniqueField(pkgText, PKG_VERSION_FIELD, 'app/package.json 的 version'),
    'app/src/version.ts APP_VERSION': requireUniqueField(versionTs, VERSION_TS_APP_VERSION, 'app/src/version.ts 的 APP_VERSION'),
    'app/src/version.ts APP_BUILD_NUMBER': requireUniqueField(versionTs, VERSION_TS_BUILD_NUMBER, 'app/src/version.ts 的 APP_BUILD_NUMBER'),
    'app/android/app/build.gradle versionName': requireUniqueField(gradle, GRADLE_VERSION_NAME, 'build.gradle 的 versionName'),
    'app/android/app/build.gradle versionCode': requireUniqueField(gradle, GRADLE_VERSION_CODE, 'build.gradle 的 versionCode'),
    'app/ios/DshApp.xcodeproj/project.pbxproj MARKETING_VERSION': requireUniformField(pbxproj, PBX_MARKETING_VERSION, 'pbxproj 的 MARKETING_VERSION'),
    'app/ios/DshApp.xcodeproj/project.pbxproj CURRENT_PROJECT_VERSION': requireUniformField(pbxproj, PBX_CURRENT_PROJECT_VERSION, 'pbxproj 的 CURRENT_PROJECT_VERSION'),
  }
  const names = [
    coordinates['app/package.json'],
    coordinates['app/src/version.ts APP_VERSION'],
    coordinates['app/android/app/build.gradle versionName'],
    coordinates['app/ios/DshApp.xcodeproj/project.pbxproj MARKETING_VERSION'],
  ]
  if (new Set(names).size !== 1) {
    throw new Error(`App 版本名多处不一致，先修好再抬版本：\n${Object.entries(coordinates).map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`).join('\n')}`)
  }
  const builds = [
    coordinates['app/src/version.ts APP_BUILD_NUMBER'],
    coordinates['app/android/app/build.gradle versionCode'],
    coordinates['app/ios/DshApp.xcodeproj/project.pbxproj CURRENT_PROJECT_VERSION'],
  ]
  if (new Set(builds).size !== 1) {
    throw new Error(`App 构建号多处不一致（version.ts 的 APP_BUILD_NUMBER、build.gradle 的 versionCode、iOS 的 CURRENT_PROJECT_VERSION）：${builds.join(' vs ')}`)
  }
  parseVersion(names[0])
  if (!/^\d+$/.test(builds[0])) throw new Error(`App 构建号 ${JSON.stringify(builds[0])} 不是纯数字`)
  return { version: names[0], buildNumber: builds[0], coordinates }
}

/**
 * 把 App 的版本名写回三个坐标文件。
 *
 * buildNumber 是可选的：发 OTA 时它必须比平台上已有的都大（联网查，调用方传进来）；
 * 但如果只是想抬版本名而保留现有构建号，传 undefined 即可。
 *
 * 刻意**不**改 app/android/app/src/main/assets/dsh-build.json：那个文件声明的是
 * 「这个 APK 里内嵌了哪一版 JS」，只有重新打 APK 才会变。发 OTA 改动它等于对设备撒谎。
 * 同理不碰 RUNTIME_VERSION：它只有在原生层变化、必须出完整包时才抬，那是人的决定。
 */
export async function writeAppCoordinates({ version, buildNumber }, root = ROOT) {
  parseVersion(version)
  if (buildNumber !== undefined && !/^\d+$/.test(String(buildNumber))) {
    throw new Error(`App 构建号 ${JSON.stringify(buildNumber)} 不是纯数字`)
  }
  const appDir = join(root, 'app')
  const target = (p) => join(appDir, p)
  const written = []

  // 先把五个坐标全部读出来并校验唯一性，任何一处不合格都在**动笔之前**抛错：
  // 半途失败会留下「package.json 已抬、version.ts 没抬」的漂移状态，比直接拒绝更糟。
  await readAppCoordinates(root)

  const pkgPath = target('package.json')
  await writeFile(pkgPath, replaceOnce(await readFile(pkgPath, 'utf8'), PKG_VERSION_FIELD, version, 'app/package.json 的 version'))
  written.push(pkgPath)

  const versionTsPath = target('src/version.ts')
  let versionTs = await readFile(versionTsPath, 'utf8')
  versionTs = replaceOnce(versionTs, VERSION_TS_APP_VERSION, version, 'version.ts 的 APP_VERSION')
  if (buildNumber !== undefined) {
    versionTs = replaceOnce(versionTs, VERSION_TS_BUILD_NUMBER, String(buildNumber), 'version.ts 的 APP_BUILD_NUMBER')
  }
  await writeFile(versionTsPath, versionTs)
  written.push(versionTsPath)

  const gradlePath = target(APP_GRADLE_REL)
  let gradle = await readFile(gradlePath, 'utf8')
  gradle = replaceOnce(gradle, GRADLE_VERSION_NAME, version, 'build.gradle 的 versionName')
  if (buildNumber !== undefined) {
    gradle = replaceOnce(gradle, GRADLE_VERSION_CODE, String(buildNumber), 'build.gradle 的 versionCode')
  }
  await writeFile(gradlePath, gradle)
  written.push(gradlePath)

  const pbxPath = target(APP_IOS_PBXPROJ_REL)
  let pbxproj = await readFile(pbxPath, 'utf8')
  pbxproj = replaceUniform(pbxproj, PBX_MARKETING_VERSION, version, 'pbxproj 的 MARKETING_VERSION')
  if (buildNumber !== undefined) {
    pbxproj = replaceUniform(pbxproj, PBX_CURRENT_PROJECT_VERSION, String(buildNumber), 'pbxproj 的 CURRENT_PROJECT_VERSION')
  }
  await writeFile(pbxPath, pbxproj)
  written.push(pbxPath)

  return { written, version, buildNumber }
}

/**
 * 用正则替换一次，并要求恰好命中一次。
 * 命中 0 次说明目标行被改过（例如 gradle 里换成了变量），静默跳过会让「已抬版本」
 * 的假象一路传到发布；命中多次说明有第二处同类声明，必须让人来看。
 */
function replaceOnce(text, re, value, label) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const matches = [...text.matchAll(new RegExp(re.source, flags))]
  if (matches.length !== 1) {
    throw new Error(`${label} 在文件里命中 ${matches.length} 处（要求恰好 1 处），拒绝静默改写`)
  }
  return text.replace(re, (_all, prefix, _old, suffix) => `${prefix}${value}${suffix}`)
}

/**
 * 把「允许多处、但值一致」的坐标**全部**改写（iOS 的 pbxproj 有 4 处）。
 * 一致性已在 readAppCoordinates 阶段校验过，这里只负责不遗漏地写回：
 * 漏写一处就会得到「Debug 版新、Release 版旧」这种最难查的漂移。
 */
function replaceUniform(text, re, value, label) {
  const flags = `${re.flags.replace('g', '')}g`
  const matches = [...text.matchAll(new RegExp(re.source, flags))]
  if (matches.length === 0) throw new Error(`${label} 没找到，拒绝静默改写`)
  return text.replace(new RegExp(re.source, flags), (_all, prefix, _old, suffix) => `${prefix}${value}${suffix}`)
}

// ---------------------------------------------------------------------------
// 发布说明：从 git 历史里捞，给两条发布链的 release_notes 用。
// ---------------------------------------------------------------------------

function git(args, root = ROOT) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || '').trim() }
  return { ok: true, output: result.stdout.trim() }
}

/** 去掉 Conventional Commits 的类型前缀（feat(scope): 之类），只留人话。 */
export function stripConventionalPrefix(subject) {
  return subject
    .replace(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s*/, '')
    .trim()
}

/**
 * 生成发布说明。
 *
 * 优先用「上一个版本的 tag」当锚点（v<x.y.z> 或 <x.y.z>），拿不到就退回最近 count 条。
 * 不写文件，只返回文本与来源说明，由调用方决定是打印还是交给 request body。
 */
export function buildReleaseNotes(previousVersion, count = 30, root = ROOT) {
  const tags = git(['tag', '-l'], root)
  let anchor = null
  if (tags.ok) {
    const available = new Set(tags.output.split('\n').map((s) => s.trim()))
    anchor = [`v${previousVersion}`, previousVersion].find((name) => available.has(name)) ?? null
  }
  const args = anchor === null
    ? ['log', '--format=%s', `-${count}`, '--no-merges']
    : ['log', '--format=%s', `${anchor}..HEAD`, '--no-merges']
  const log = git(args, root)
  if (!log.ok) throw new Error(`读取 git 历史失败：${log.error}`)
  const subjects = [...new Set(log.output.split('\n').map(stripConventionalPrefix).filter(Boolean))]
  return {
    text: subjects.map((line) => `- ${line}`).join('\n'),
    source: anchor === null
      ? `没找到 tag v${previousVersion}/${previousVersion}，退回最近 ${count} 条提交`
      : `以上一个 tag ${anchor} 为锚点`,
  }
}

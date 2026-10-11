#!/usr/bin/env node
/**
 * 抬版本号：把插件或 App 的版本推到下一号，并把结果写回仓库。
 *
 * 存在的理由：这个仓库过去两条发布链都要人手改版本号，而两条链的失败方式都很隐蔽——
 *   · 插件：中转按 version_name 做 semver 比较，忘抬版本 → 包发出去了，但客户端
 *     永远判「没有更新」，没有任何报错。
 *   · App：版本名抄在三个文件里（app/package.json、app/src/version.ts、
 *     app/android/app/build.gradle），手改漏一处，构建出来的坐标就和设备上报的对不上；
 *     构建号还得比分发平台上已有的都大，手填旧号会被平台按重复坐标直接拒绝。
 * 两个发布脚本（publish-plugin-ota.mjs / publish-app-ota.mjs）在发布时也会调用同一个
 * 实现，所以「脚本发出去的版本」和「仓库里写的版本」不可能再不是同一个号。
 *
 * 用法：
 *   node dsh-mobile-plugin/scripts/bump-version.mjs                       # 插件补丁号 +1
 *   node dsh-mobile-plugin/scripts/bump-version.mjs --product app         # App 版本名 patch +1（构建号也 +1）
 *   node dsh-mobile-plugin/scripts/bump-version.mjs --level minor         # 抬小版本
 *   node dsh-mobile-plugin/scripts/bump-version.mjs --product app --build-number 221
 *   node dsh-mobile-plugin/scripts/bump-version.mjs --dry-run --notes     # 只预览，顺便看发布说明
 *
 * App 的构建号注意：本脚本在没给 --build-number 时只做「仓库里现有号 +1」。平台上
 * 已有的构建号可能更高（历史上有过仓库停在 190、平台已经到 220 的情况），所以
 * 真要发布时请用 publish-app-ota.mjs —— 它会先查平台再决定号。
 */
import { APP_COORD_FILES, buildReleaseNotes, nextVersion, readAppCoordinates, readPluginVersion, writeAppCoordinates, writePluginVersion } from './lib/version-bump.mjs'

export function parseArgs(argv) {
  const opts = { product: 'plugin', level: 'patch', dryRun: false, notes: false, notesCount: 30, buildNumber: undefined, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') opts.dryRun = true
    else if (token === '--notes') opts.notes = true
    else if (token === '--json') opts.json = true
    else if (token === '--product') opts.product = requireValue(argv, (i += 1), token)
    else if (token === '--level') opts.level = requireValue(argv, (i += 1), token)
    else if (token === '--build-number') opts.buildNumber = requireValue(argv, (i += 1), token)
    else if (token === '--notes-count') opts.notesCount = Number(requireValue(argv, (i += 1), token))
    else throw new Error(`未知参数 ${token}`)
  }
  if (!['plugin', 'app'].includes(opts.product)) throw new Error(`--product 只支持 plugin | app，收到 ${opts.product}`)
  if (!['patch', 'minor', 'major'].includes(opts.level)) throw new Error(`--level 只支持 patch | minor | major，收到 ${opts.level}`)
  return opts
}

function requireValue(argv, index, token) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${token} 后面要跟一个值`)
  return value
}

/**
 * 抬一次版本。**不写任何文件**，把「新版本号 + 要改哪些文件」交回给调用方。
 * 两个发布脚本先用它算号、再决定什么时候落盘；命令行包装见文件末尾。
 */
export async function planBump(product, level = 'patch', { buildNumber, root } = {}) {
  if (product === 'plugin') {
    const previous = await readPluginVersion(root)
    const version = nextVersion(previous, level)
    return { product, previous, version, buildNumber: undefined, files: ['dsh-mobile-plugin/package.json'] }
  }
  if (product !== 'app') throw new Error(`未知的发布物 ${product}`)
  const { version: previous, buildNumber: currentBuild } = await readAppCoordinates(root)
  const version = nextVersion(previous, level)
  const nextBuild = buildNumber === undefined ? String(Number(currentBuild) + 1) : String(buildNumber)
  if (!/^\d+$/.test(nextBuild)) throw new Error(`构建号 ${nextBuild} 不是纯数字`)
  if (Number(nextBuild) <= Number(currentBuild)) {
    throw new Error(`构建号必须往前抬：现在是 ${currentBuild}，给的是 ${nextBuild}。` +
      '平台按 (应用,渠道,运行时,版本,构建号) 判重，沿用旧号会被拒。')
  }
  return {
    product, previous, version, buildNumber: nextBuild,
    files: [...APP_COORD_FILES],
  }
}

/** 把 planBump 的结果落盘。 */
export async function applyBump(plan, { root } = {}) {
  if (plan.product === 'plugin') return writePluginVersion(plan.version, root)
  return writeAppCoordinates({ version: plan.version, buildNumber: plan.buildNumber }, root)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const plan = await planBump(opts.product, opts.level, { buildNumber: opts.buildNumber })
  const notes = opts.notes ? buildReleaseNotes(plan.previous, opts.notesCount) : null

  if (opts.dryRun) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...plan, dryRun: true, notes: notes?.text ?? null }, null, 2)}\n`)
      return
    }
    process.stdout.write(`[dry-run] ${plan.product}：${plan.previous} -> ${plan.version}` +
      `${plan.buildNumber === undefined ? '' : `（构建号 -> ${plan.buildNumber}）`}\n`)
    for (const file of plan.files) process.stdout.write(`  会改：${file}\n`)
    if (notes) process.stdout.write(`\n发布说明（${notes.source}）：\n${notes.text || '  （没抽到提交）'}\n`)
    return
  }

  await applyBump(plan)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, notes: notes?.text ?? null }, null, 2)}\n`)
    return
  }
  process.stdout.write(`已抬版本：${plan.product} ${plan.previous} -> ${plan.version}` +
    `${plan.buildNumber === undefined ? '' : `（构建号 ${plan.buildNumber}）`}\n`)
  for (const file of plan.files) process.stdout.write(`  ${file}\n`)
  if (notes) process.stdout.write(`\n发布说明（${notes.source}）：\n${notes.text || '  （没抽到提交）'}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('bump-version.mjs')) {
  main().catch((error) => {
    console.error(`bump-version: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

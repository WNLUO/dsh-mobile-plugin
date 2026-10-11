/**
 * 版本号自动抬升的守卫。
 *
 * 这一组测试盯的是「发布时会静默失败的那种错」：版本号算错、写漏文件、坐标漂开。
 * 两条发布链都不会因为版本号错了而报错——插件那条会被中转判成「没有更新」，
 * App 那条会被平台按重复坐标拒绝，两边都要等到线上才发现。
 *
 * 所以这里既测纯函数（抬升算法、SemVer 校验），也在临时目录里搭一份最小的
 * 仓库布局跑真实的读写，最后再对**本仓库当前的真实坐标**做一次自洽断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ROOT, buildReleaseNotes, nextVersion, parseVersion, readAppCoordinates,
  readPackageVersion, readPluginVersion, resolvePinnedVersion, stripConventionalPrefix,
  writeAppCoordinates, writePluginVersion,
} from './lib/version-bump.mjs'
import { planBump, parseArgs } from './bump-version.mjs'

// --- 纯函数：SemVer 解析与抬升 ------------------------------------------------

test('只接受稳定版 SemVer，带后缀或段数不对的一律拒绝', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion(' 0.0.1 '), { major: 0, minor: 0, patch: 1 })
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-rc.1', '1.2.3+build', '1.2.x', '', null, undefined]) {
    assert.throws(() => parseVersion(bad), /稳定版 SemVer/, `${JSON.stringify(bad)} 应被拒绝`)
  }
})

test('每一段都不许超过 999（构建号刻度按 1000 进制拼）', () => {
  // 999 -> 1000 会溢出刻度，必须报错而不是写一个拼不成构建号的版本出去。
  assert.throws(() => nextVersion('0.0.999', 'patch'), /999/)
  assert.throws(() => parseVersion('1.2.1000'), /稳定版 SemVer|构建号刻度/)
  assert.throws(() => nextVersion('0.999.5', 'minor'), /稳定版 SemVer|构建号刻度|999/)
})

test('抬升语义与 SemVer 一致：抬了低位就把低位归零', () => {
  assert.equal(nextVersion('0.1.18', 'patch'), '0.1.19')
  assert.equal(nextVersion('0.1.18', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.18', 'major'), '1.0.0')
  assert.equal(nextVersion('0.9.9', 'minor'), '0.10.0')
  assert.equal(nextVersion('9.9.9', 'patch'), '9.9.10')
  // 默认就是 patch：不传级别时也要能抬。
  assert.equal(nextVersion('0.1.18'), '0.1.19')
})

test('未知的抬升级别直接抛错，不默默按 patch 处理', () => {
  assert.throws(() => nextVersion('0.1.18', 'hotfix'), /未知的抬升级别/)
  assert.throws(() => nextVersion('0.1.18', ''), /未知的抬升级别/)
})

// --- 临时仓库：真实读写 ---------------------------------------------------------

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bump-fixture-'))
  await mkdir(join(root, 'dsh-mobile-plugin'), { recursive: true })
  await mkdir(join(root, 'app', 'src'), { recursive: true })
  await mkdir(join(root, 'app', 'android', 'app'), { recursive: true })
  await writeFile(join(root, 'dsh-mobile-plugin', 'package.json'), `${JSON.stringify({
    name: 'dsh-mobile-plugin', version: '0.1.18', type: 'module',
    dependencies: { ws: '8.18.0', qrcode: '1.5.4' },
  }, null, 2)}\n`)
  await writeFile(join(root, 'app', 'package.json'), `${JSON.stringify({
    name: 'app', version: '0.2.64', dependencies: { react: '19.2.3' },
  }, null, 2)}\n`)
  await writeFile(join(root, 'app', 'src', 'version.ts'), [
    "export const APP_VERSION = '0.2.64';",
    "export const PACKAGE_ID = 'com.dsh.mobile';",
    "export const RUNTIME_VERSION = '3';",
    "export const APP_BUILD_NUMBER = '190';",
    '',
  ].join('\n'))
  await writeFile(join(root, 'app', 'android', 'app', 'build.gradle'), [
    'android {',
    '    defaultConfig {',
    '        versionCode 190',
    '        versionName "0.2.64"',
    '        versionNameSuffix ""',
    '    }',
    '}',
    '',
  ].join('\n'))
  return root
}

test('插件版本写回只动 version 字段，其余字节原样保留', async () => {
  const root = await fixtureRoot()
  try {
    const before = await readFile(join(root, 'dsh-mobile-plugin', 'package.json'), 'utf8')
    const result = await writePluginVersion('0.1.19', root)
    const after = await readFile(join(root, 'dsh-mobile-plugin', 'package.json'), 'utf8')
    assert.equal(result.previous, '0.1.18')
    assert.equal(await readPluginVersion(root), '0.1.19')
    assert.equal(after, before.replace('"version": "0.1.18"', '"version": "0.1.19"'))
    // 依赖里的字符串版本号不能被误伤。
    assert.match(after, /"ws": "8\.18\.0"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--version 与仓库版本不一致时写回仓库，因为清单里的版本号取自 package.json', async () => {
  // 真出过一次：`--no-bump --version 0.1.23` 发出去的资产里 package.json 还是
  // 0.1.22，清单却写着 0.1.23 —— 中转只按 (id, platform, channel) 判重，不会拦。
  const root = await fixtureRoot()
  try {
    const resolved = await resolvePinnedVersion('0.1.23', { root })
    assert.deepEqual(resolved, { version: '0.1.23', previous: '0.1.18', wrote: true })
    assert.equal(await readPluginVersion(root), '0.1.23')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--version 与仓库版本一致时不动文件，也不报错', async () => {
  const root = await fixtureRoot()
  try {
    const before = await readFile(join(root, 'dsh-mobile-plugin', 'package.json'), 'utf8')
    const resolved = await resolvePinnedVersion('0.1.18', { root })
    assert.deepEqual(resolved, { version: '0.1.18', previous: '0.1.18', wrote: false })
    assert.equal(await readFile(join(root, 'dsh-mobile-plugin', 'package.json'), 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--version 与仓库版本不一致又禁止写回：拒绝发布，不发出自相矛盾的包', async () => {
  const root = await fixtureRoot()
  try {
    await assert.rejects(resolvePinnedVersion('0.1.23', { noBump: true, root }), /--no-bump[\s\S]*0\.1\.18[\s\S]*0\.1\.23/)
    // 拒绝之后仓库必须原样：不许改了一半再抛。
    assert.equal(await readPluginVersion(root), '0.1.18')
    // 非法版本号也走同一道关。
    await assert.rejects(resolvePinnedVersion('0.1.23-rc.1', { root }), /稳定版 SemVer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('App 三处坐标写回后仍然一致，且不碰构建元数据文件', async () => {
  const root = await fixtureRoot()
  try {
    await writeAppCoordinates({ version: '0.2.65', buildNumber: '221' }, root)
    const coords = await readAppCoordinates(root)
    assert.equal(coords.version, '0.2.65')
    assert.equal(coords.buildNumber, '221')

    const versionTs = await readFile(join(root, 'app', 'src', 'version.ts'), 'utf8')
    assert.match(versionTs, /APP_VERSION = '0\.2\.65'/)
    assert.match(versionTs, /APP_BUILD_NUMBER = '221'/)
    // 运行时版本是原生层的决定，抬版本号时绝不能顺手改。
    assert.match(versionTs, /RUNTIME_VERSION = '3'/)

    const gradle = await readFile(join(root, 'app', 'android', 'app', 'build.gradle'), 'utf8')
    assert.match(gradle, /versionCode 221/)
    assert.match(gradle, /versionName "0\.2\.65"/)
    // versionNameSuffix 不应被 versionName 那条正则连带匹配。
    assert.match(gradle, /versionNameSuffix ""/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只抬版本名而不给构建号时，构建号必须原样不动', async () => {
  const root = await fixtureRoot()
  try {
    await writeAppCoordinates({ version: '0.3.0' }, root)
    const coords = await readAppCoordinates(root)
    assert.equal(coords.version, '0.3.0')
    assert.equal(coords.buildNumber, '190')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('三处版本名漂开时，读取阶段就报错而不是继续抬版本', async () => {
  const root = await fixtureRoot()
  try {
    const path = join(root, 'app', 'src', 'version.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace("APP_VERSION = '0.2.64'", "APP_VERSION = '0.2.63'"))
    await assert.rejects(() => readAppCoordinates(root), /三处不一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('版本名与构建号不一致（version.ts 与 gradle 漂开）时拒绝', async () => {
  const root = await fixtureRoot()
  try {
    const path = join(root, 'app', 'android', 'app', 'build.gradle')
    await writeFile(path, (await readFile(path, 'utf8')).replace('versionCode 190', 'versionCode 191'))
    await assert.rejects(() => readAppCoordinates(root), /构建号两处不一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目标字段在文件里出现 0 次或 2 次都拒绝，不静默改写', async () => {
  const root = await fixtureRoot()
  try {
    const path = join(root, 'app', 'android', 'app', 'build.gradle')
    // 0 次：坐标被改成变量，读取阶段就要炸。
    await writeFile(path, (await readFile(path, 'utf8')).replace('versionName "0.2.64"', 'versionName someVersionVariable'))
    await assert.rejects(() => readAppCoordinates(root), /versionName 没找到/)

    // 2 次：构建脚本里一旦出现第二个坐标声明，写回就不能猜，必须报错。
    await writeFile(path, [
      'android {',
      '    defaultConfig {',
      '        versionCode 190',
      '        versionCode 190',
      '        versionName "0.2.64"',
      '    }',
      '}',
      '',
    ].join('\n'))
    await assert.rejects(() => readAppCoordinates(root), /命中 2 处/)
    await assert.rejects(() => writeAppCoordinates({ version: '0.2.65' }, root), /命中 2 处|恰好 1 处/)

    // 版本名出现两次时同样拒绝。
    await writeFile(path, [
      'android {',
      '    defaultConfig {',
      '        versionCode 190',
      '        versionName "0.2.64"',
      '        versionName "0.2.64"',
      '    }',
      '}',
      '',
    ].join('\n'))
    await assert.rejects(() => readAppCoordinates(root), /三处不一致|命中 2 处/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readPackageVersion 只认顶层的 version，不认依赖里的同名键', async () => {
  const root = await fixtureRoot()
  try {
    const path = join(root, 'app', 'package.json')
    await writeFile(path, '{\n  "name": "app",\n  "version": "0.2.64",\n  "dependencies": {\n    "version": "1.0.0"\n  }\n}\n')
    assert.equal((await readPackageVersion('app', root)).version, '0.2.64')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- 抬起计划：构建号必须往前 ------------------------------------------------

test('构建号只能往前抬，给一个不比现有大的号直接拒绝', async () => {
  // 用 fixture 而不是真实仓库：真实坐标每次发布都会变，断言写死版本号必然过一段时间就红。
  const root = await fixtureRoot()
  try {
    await assert.rejects(() => planBump('app', 'patch', { buildNumber: '1', root }), /构建号必须往前抬/)
    await assert.rejects(() => planBump('app', 'patch', { buildNumber: '190', root }), /构建号必须往前抬/)

    const plan = await planBump('app', 'patch', { buildNumber: '191', root })
    assert.equal(plan.previous, '0.2.64')
    assert.equal(plan.version, '0.2.65')
    assert.equal(plan.buildNumber, '191')

    // 不给号时按 fixture 里的 190 + 1。
    assert.equal((await planBump('app', 'patch', { root })).buildNumber, '191')

    // 插件侧的同一个入口，只抬版本名。
    const pluginPlan = await planBump('plugin', 'minor', { root })
    assert.equal(pluginPlan.previous, '0.1.18')
    assert.equal(pluginPlan.version, '0.2.0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('命令行参数：非法发布物与非法级别都要报错', () => {
  assert.throws(() => parseArgs(['--product', 'server']), /只支持 plugin \| app/)
  assert.throws(() => parseArgs(['--level', 'hotfix']), /只支持 patch \| minor \| major/)
  assert.throws(() => parseArgs(['--product']), /要跟一个值/)
  assert.deepEqual(parseArgs([]).product, 'plugin')
  assert.equal(parseArgs(['--product', 'app', '--build-number', '999']).buildNumber, '999')
})

// --- 发布说明 ------------------------------------------------------------------

test('发布说明去掉 Conventional Commits 前缀，并去掉重复条目', () => {
  assert.equal(stripConventionalPrefix('fix(app): 修白屏'), '修白屏')
  assert.equal(stripConventionalPrefix('feat(plugin/api)!: 换协议'), '换协议')
  assert.equal(stripConventionalPrefix('随便一句话'), '随便一句话')
  const notes = buildReleaseNotes('0.2.64', 5)
  assert.ok(notes.source.length > 0)
  for (const line of notes.text.split('\n').filter(Boolean)) assert.match(line, /^- /)
})

// --- 本仓库的真实坐标自洽 --------------------------------------------------------

test('本仓库当前的版本坐标是合法 SemVer，且 App 三处一致', async () => {
  const plugin = await readPluginVersion(ROOT)
  parseVersion(plugin)
  const coords = await readAppCoordinates(ROOT)
  parseVersion(coords.version)
  assert.match(coords.buildNumber, /^\d+$/)
})

test('插件 package.json 的 version 不与 pnpm-lock.yaml 挂钩（改了不该动锁文件）', async () => {
  const lock = await readFile(join(ROOT, 'dsh-mobile-plugin', 'pnpm-lock.yaml'), 'utf8')
  const plugin = await readFile(join(ROOT, 'dsh-mobile-plugin', 'package.json'), 'utf8')
  const version = JSON.parse(plugin).version
  // pnpm 的 lockfile 里 importers 段不记录包自身的 version；如果哪天记录了，
  // 抬版本就必须同步改锁文件，这条断言会提醒我们去更新 writePluginVersion。
  assert.doesNotMatch(lock.split('snapshots:')[0], new RegExp(`^\\s*version:\\s*'?${version.replace(/\./g, '\\.')}'?\\s*$`, 'm'))
})

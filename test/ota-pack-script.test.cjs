'use strict'
// 打包脚本的端到端守卫：跑一次 `scripts/pack-ota.mjs`，把它吐出来的包用**客户端的真
// 解包器**解开并核对清单。
//
// 为什么值得跑一次真的：这条链上最容易坏的是「打包」和「解包」两边对不上（以前就是
// 系统 tar 的 PAX 头 vs 手写解析器）。只测解包器测不出打包脚本自己写坏了头；而打包脚本
// 真跑一次要 npm 参与（文件清单来自 `npm pack --dry-run --json`），正好把「哪些文件
// 会进包」这件事也钉住——白名单漏收一个入口，就是这个测试先红。
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { readManifest, unpackTarGz, verifyManifest } = require('../lib/shell/ota-package.js')

const PLUGIN_ROOT = path.join(__dirname, '..')

test('pack-ota 产出能被客户端解包器完整还原，清单与 package.json 一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ota-pack-'))
  try {
    const out = path.join(dir, 'plugin.tgz')
    execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'pack-ota.mjs'), '--out', out, '--platform', 'any'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    const tgz = fs.readFileSync(out)
    assert.ok(tgz.length > 10000, `打得出来的包不该只有 ${tgz.length} 字节`)

    const unpacked = path.join(dir, 'unpacked')
    unpackTarGz(tgz, unpacked)
    const pkgDir = path.join(unpacked, 'dsh-mobile-plugin')
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const manifest = readManifest(pkgDir)
    assert.ok(manifest, '包里必须有清单：客户端靠它判断包完不完整')
    assert.equal(manifest.version, pkg.version)
    assert.equal(manifest.platform, 'any', '--platform any 要写进清单，客户端回落时据此判断')
    verifyManifest(pkgDir, manifest)

    const paths = manifest.files.map(item => item.path)
    for (const required of ['package.json', 'lib/impl.js', 'lib/index.js', 'lib/shell/ota-package.js']) {
      assert.ok(paths.includes(required), `清单里缺 ${required}`)
    }
    assert.ok(!paths.some(item => item.startsWith('test/')), '测试目录不该进 OTA 包')
    assert.ok(!paths.some(item => item.startsWith('scripts/')), '打包脚本自己不该进 OTA 包')
    // 清单里每一项都要真的在解出来的树里，且字节数对得上——verifyManifest 已经逐项核过，
    // 这里再确认「清单没漏掉包里的文件」（漏掉的那些客户端就查不出来了）。
    const actual = []
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name)
        if (entry.isDirectory()) walk(abs)
        else actual.push(path.relative(pkgDir, abs).split(path.sep).join('/'))
      }
    }
    walk(pkgDir)
    assert.deepEqual(actual.filter(item => item !== 'lib/ota-manifest.json').sort(), [...paths].sort(), '清单必须覆盖包里的每一个文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

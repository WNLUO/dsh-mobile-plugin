'use strict'
// OTA 包的解包/校验层。
//
// 现场（2026-10-17）：OTA 更新在真机上装不起来，报的是「找不到某个 JS 文件」或「OTA 包
// 结构不完整」。根因有两层：解包器只认普通文件（macOS 的 tar 带 PAX 扩展头就直接抛错），
// 而包里少一两个文件它又看不出来——于是装上去之后才在运行时缺模块。这里钉住两件事：
// 真实世界里的 tar（PAX / GNU 长名 / 截断 / 链接项）都要有明确结论，以及「清单核对」
// 必须在激活之前失败并点名缺的是哪个文件。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')

const { MANIFEST_PATH, movePath, readEntries, readManifest, unpackTarGz, verifyManifest } = require('../lib/shell/ota-package.js')
const { gzipTar, writeTar } = require('../scripts/lib/ota-tar.mjs')

function tempDir(prefix = 'dsh-ota-pkg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 手工造一条 tar 头（用来构造 writer 不会产出的特殊条目：PAX / 长名 / 链接）。 */
function rawEntry(type, name, content) {
  const data = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function packageEntries(version, extra = []) {
  const manifest = { version, files: [{ path: 'lib/impl.js', size: Buffer.byteLength('export function apply() {}') }] }
  return [
    { path: 'package/package.json', mode: 0o644, data: Buffer.from(JSON.stringify({ name: 'dsh-mobile-plugin', version })) },
    { path: 'package/lib/impl.js', mode: 0o644, data: Buffer.from('export function apply() {}') },
    { path: `package/${MANIFEST_PATH}`, mode: 0o644, data: Buffer.from(JSON.stringify(manifest)) },
    ...extra,
  ]
}

test('打包器写出来的包能被真解包器读回来，清单逐项通过', () => {
  const dir = tempDir()
  try {
    const tgz = gzipTar(writeTar(packageEntries('1.2.3')))
    unpackTarGz(tgz, dir)
    const pkgDir = path.join(dir, 'dsh-mobile-plugin')
    assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '1.2.3')
    assert.equal(fs.readFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'utf8'), 'export function apply() {}')
    const manifest = readManifest(pkgDir)
    assert.equal(manifest.version, '1.2.3')
    assert.equal(verifyManifest(pkgDir, manifest), 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('PAX 扩展头（macOS 的 tar 默认会带）里的长路径能被认出来', () => {
  const dir = tempDir()
  try {
    const longPath = `package/lib/${'nested/'.repeat(20)}deep.js`
    // PAX 记录带十进制长度前缀（`<len> path=<值>\n`），与真实 tar 一致。
    const body = `path=${longPath}\n`
    const pax = `${Buffer.byteLength(body) + String(Buffer.byteLength(body) + 1).length + 1} ${body}`
    const tgz = gzipTar(Buffer.concat([
      rawEntry('x', 'PaxHeader/deep.js', pax),
      // PAX 条目的下一项：name 字段随便填（真 tar 会截断成 100 字节），实际路径以 PAX 为准。
      rawEntry('0', 'package/lib/deep.js', 'module.exports = 1'),
      rawEntry('0', 'package/package.json', JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })),
      rawEntry('0', 'package/lib/impl.js', 'export function apply() {}'),
      Buffer.alloc(1024),
    ]))
    unpackTarGz(tgz, dir)
    const unpacked = path.join(dir, 'dsh-mobile-plugin', ...longPath.split('/').slice(1))
    assert.equal(fs.readFileSync(unpacked, 'utf8'), 'module.exports = 1', 'PAX 里的长路径必须落到正确位置')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('GNU 长文件名（L 条目）同样认得', () => {
  const dir = tempDir()
  try {
    const longPath = `package/lib/${'x'.repeat(120)}.js`
    const tgz = gzipTar(Buffer.concat([
      rawEntry('L', '././@LongLink', `${longPath}\0`),
      rawEntry('0', 'package/lib/short.js', 'module.exports = 2'),
      rawEntry('0', 'package/package.json', JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })),
      rawEntry('0', 'package/lib/impl.js', 'export function apply() {}'),
      Buffer.alloc(1024),
    ]))
    unpackTarGz(tgz, dir)
    assert.equal(fs.readFileSync(path.join(dir, 'dsh-mobile-plugin', longPath.slice('package/'.length)), 'utf8'), 'module.exports = 2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('截断的包要明确报「被截断」，不能装出一份残缺代', () => {
  const tgz = gzipTar(writeTar(packageEntries('1.2.3')))
  const cut = tgz.subarray(0, Math.floor(tgz.length / 2))
  assert.throws(() => readEntries(cut), /截断|unexpected end|incorrect header/i)
})

test('带软链接的包拒绝安装并说清原因（不静默跳过）', () => {
  const tgz = gzipTar(Buffer.concat([
    rawEntry('0', 'package/package.json', JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })),
    rawEntry('2', 'package/lib/link.js', '../outside.js'),
    Buffer.alloc(1024),
  ]))
  assert.throws(() => readEntries(tgz), /链接|设备条目/)
})

test('路径穿越与绝对路径一律拒绝', () => {
  const escape = gzipTar(Buffer.concat([
    rawEntry('0', 'package/../../etc/passwd', 'x'),
    Buffer.alloc(1024),
  ]))
  assert.throws(() => readEntries(escape), /越界|无效路径/)
})

test('清单里少一个文件：在激活之前失败，并把文件名写进错误', () => {
  const dir = tempDir()
  try {
    // 包里有 manifest 声明的两个文件，但实际只写入了一个。
    const manifest = { version: '1.0.0', files: [{ path: 'lib/impl.js', size: 26 }, { path: 'lib/mobile/gone.js', size: 10 }] }
    const tgz = gzipTar(writeTar([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })) },
      { path: 'package/lib/impl.js', data: Buffer.from('export function apply() {}') },
      { path: `package/${MANIFEST_PATH}`, data: Buffer.from(JSON.stringify(manifest)) },
    ]))
    unpackTarGz(tgz, dir)
    const pkgDir = path.join(dir, 'dsh-mobile-plugin')
    assert.throws(() => verifyManifest(pkgDir, readManifest(pkgDir)), /lib\/mobile\/gone\.js/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('没有清单的老包：readManifest 返回 null（退回旧判据，不把它判成坏的）', () => {
  const dir = tempDir()
  try {
    unpackTarGz(gzipTar(writeTar([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })) },
      { path: 'package/lib/impl.js', data: Buffer.from('export function apply() {}') },
    ])), dir)
    assert.equal(readManifest(path.join(dir, 'dsh-mobile-plugin')), null)
    assert.equal(verifyManifest(path.join(dir, 'dsh-mobile-plugin'), null), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('movePath 跨盘（rename 抛 EXDEV）时退回复制+删源，Windows 上也能装', () => {
  const root = tempDir()
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  fs.mkdirSync(path.join(src, 'dsh-mobile-plugin', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(src, 'dsh-mobile-plugin', 'lib', 'impl.js'), 'x')
  const realRename = fs.renameSync
  fs.renameSync = () => {
    const error = new Error('cross-device link not permitted')
    error.code = 'EXDEV'
    throw error
  }
  try {
    assert.equal(movePath(src, dst), 'copy')
  } finally {
    fs.renameSync = realRename
  }
  assert.equal(fs.readFileSync(path.join(dst, 'dsh-mobile-plugin', 'lib', 'impl.js'), 'utf8'), 'x')
  assert.equal(fs.existsSync(src), false, '复制成功后源目录必须清掉，否则每装一次多一份')
  fs.rmSync(root, { recursive: true, force: true })
})

test('可执行位在 POSIX 上要保留（脚本类文件）', () => {
  if (process.platform === 'win32') return
  const dir = tempDir()
  try {
    unpackTarGz(gzipTar(writeTar([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.0.0' })) },
      { path: 'package/lib/impl.js', data: Buffer.from('x') },
      { path: 'package/scripts/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
    ])), dir)
    const mode = fs.statSync(path.join(dir, 'dsh-mobile-plugin', 'scripts', 'run.sh')).mode & 0o777
    assert.equal(mode & 0o100, 0o100, '可执行位丢了，打包出来的工具就会变成不可执行')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

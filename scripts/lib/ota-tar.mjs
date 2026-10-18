/**
 * 写 ustar 归档（发布脚本用）。
 *
 * 为什么自己写而不是调系统 `tar`：这是跨平台发布链上最脏的一环。macOS 的 `tar` 默认带
 * PAX 扩展头与 xattr 条目，Windows 有没有 `tar` 得看版本，Linux 上 `--no-xattrs` 这些
 * 参数又各不相同——同一个包在三个人手里出来的是三种字节。这里只写 ustar：格式固定、
 * 三个平台一致、客户端那边也只需要认这一种（外加读得懂 PAX，见 `ota-package.js`）。
 *
 * 只支持普通文件（npm 包里不该有别的东西）。路径超过 100 字节时按 ustar 的 prefix 字段
 * 拆成「目录前缀 + 文件名」，再长就报错让人改结构，而不是悄悄写坏一个包。
 */

import zlib from 'node:zlib'

const BLOCK = 512

function octal(value, length) {
  // ustar 用八进制 ASCII 表示数字，末尾补 NUL；`length` 含这个 NUL。
  return `${Math.max(0, value).toString(8).padStart(length - 1, '0')}\0`
}

function splitPath(filePath) {
  const bytes = Buffer.byteLength(filePath)
  if (bytes <= 100) return { name: filePath, prefix: '' }
  // 从后往前找切点：prefix ≤ 155 字节、name ≤ 100 字节。
  for (let index = filePath.length - 1; index > 0; index -= 1) {
    if (filePath[index] !== '/') continue
    const prefix = filePath.slice(0, index)
    const name = filePath.slice(index + 1)
    if (!name) continue
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`路径太长，ustar 装不下：${filePath}（请缩短目录层级，或把文件挪到更浅的位置）`)
}

function header(entry, mtime) {
  const { name, prefix } = splitPath(entry.path)
  const data = entry.data ?? Buffer.alloc(0)
  const out = Buffer.alloc(BLOCK)
  out.write(name, 0, 100, 'utf8')
  out.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'ascii')
  out.write(octal(0, 8), 108, 8, 'ascii') // uid
  out.write(octal(0, 8), 116, 8, 'ascii') // gid
  out.write(octal(data.length, 12), 124, 12, 'ascii')
  out.write(octal(mtime, 12), 136, 12, 'ascii')
  out.write('        ', 148, 8, 'ascii') // 校验和先填空格
  out.write('0', 156, 1, 'ascii') // typeflag：普通文件
  out.write('ustar\0', 257, 6, 'ascii')
  out.write('00', 263, 2, 'ascii')
  out.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of out) sum += byte
  out.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return out
}

/**
 * @param {Array<{path: string, mode?: number, data?: Buffer}>} entries 路径用 posix 分隔
 * @returns {Buffer} tar（未压缩）
 */
export function writeTar(entries, { mtime = 0 } = {}) {
  const chunks = []
  for (const entry of entries) {
    chunks.push(header(entry, mtime))
    const data = entry.data ?? Buffer.alloc(0)
    if (data.length) {
      chunks.push(data)
      const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
      if (padding) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

/** tar → tgz。固定 gzip 参数，同一个输入在不同平台产出同样的字节（哈希可复现）。 */
export function gzipTar(tar) {
  return zlib.gzipSync(tar, { level: 9 })
}

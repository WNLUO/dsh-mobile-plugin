/**
 * OTA 包（npm tarball）的读取、校验与落盘。
 *
 * 这一层存在的唯一理由是「换一台机器也照样能装」：以前解包是 `device-ota.js` 里的六十行
 * 手写代码，只认普通文件和目录，遇到 PAX 扩展头（macOS 的 tar 默认会带）、GNU 长文件名、
 * 长路径就直接抛「不支持的 tar 项」；反过来，包里少几个文件它又看不出来，于是装上去之后
 * 才在某一代运行时报「找不到某个 JS 文件」。这里把两件事一起解决：
 *
 *  1. **解包要认得真实世界里的 tar**：ustar 的 prefix、PAX（`x` / `g`）、GNU 长名（`L` / `K`）
 *     都要能读；软链接、硬链接、设备文件要**明确拒绝**并说清原因（不静默跳过，否则会装出
 *     一个缺文件的代）。
 *  2. **装完要能证明它完整**：包里带一份 `lib/ota-manifest.json`（发布脚本生成，列出版本与
 *     每个文件的路径和字节数），解包后逐项核对。缺文件、大小不符都在**激活之前**失败，
 *     错误里直接点名是哪个文件。
 *
 * 手写 tar 解析而不是引依赖：这是发布链路上的一段自包含代码（OTA 包要能在一台刚装好
 * DSH 的机器上被解出来，不能要求它先装点别的），而 ustar 的头部格式是固定的 512 字节。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 清单在包内的相对路径（相对插件包根）。 */
export const MANIFEST_PATH = 'lib/ota-manifest.json'
/** tar 里所有条目都必须在这个目录下，否则不是 npm 包。 */
const ARCHIVE_PREFIX = 'package'

const BLOCK = 512
/** 文件条目的类型标记。ustar 规范允许 `\0` 表示普通文件（老实现会写 0x00）。 */
const TYPE_FILE = new Set(['0', '\u0000'])
const TYPE_DIR = '5'
const TYPE_PAX = 'x'
const TYPE_PAX_GLOBAL = 'g'
const TYPE_GNU_LONG_NAME = 'L'
const TYPE_GNU_LONG_LINK = 'K'

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

function readOctal(buffer, start, length) {
  const raw = readString(buffer, start, length).trim()
  if (!raw) return 0
  const value = Number.parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * 把 tar 里的路径规范成安全的相对段数组。
 *
 * 反斜杠**当分隔符处理**：tar 用的是 posix 路径，但包里真出现一个 `a\..\..\x` 这样的名字时，
 * 在 Windows 上它就是三个目录层级。统一按分隔符拆开再判 `..`，两个平台的结果才一致。
 */
function safeSegments(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/')
  if (!normalized || normalized.includes('\u0000')) throw new Error('OTA 包包含空路径或非法字符')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`OTA 包含绝对路径：${relPath}`)
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
  if (parts.includes('..')) throw new Error(`OTA 包含越界路径：${relPath}`)
  return parts
}

/**
 * PAX 扩展头里取 `path=`（其余键——size/mtime/uid 之类——对安装没有意义）。
 *
 * PAX 的每条记录是 `<十进制总长度> <键>=<值>\n`：长度写在前头，所以不能按空格切第一段
 * 当键名。按长度逐条前进，才不会把值里的空格或换行切坏。
 */
function paxPathOf(data) {
  const text = data.toString('utf8')
  let offset = 0
  let found = null
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space <= offset) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, offset + length).replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') found = record.slice(eq + 1)
    offset += length
  }
  return found
}

/**
 * 把一段 tgz/tar 解析成条目数组。
 *
 * @param {Buffer} input gzip 或裸 tar（按 gzip 魔数区分）
 * @returns {Array<{path: string, type: 'file'|'dir', mode: number, data: Buffer|null}>}
 */
export function readEntries(input) {
  const tar = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b ? zlib.gunzipSync(input) : input
  const entries = []
  let offset = 0
  // PAX / GNU 长名是「下一个条目」的修饰头，读完那一条就清掉。
  let pendingPath = null
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8) || 0o644
    const type = String.fromCharCode(header[156]) || '0'
    const start = offset + BLOCK
    const end = start + size
    if (end > tar.length) {
      throw new Error(`OTA 包被截断：条目 ${name || '(无名)'} 声明 ${size} 字节，包内不够`)
    }
    const data = tar.subarray(start, end)
    offset = start + Math.ceil(size / BLOCK) * BLOCK

    if (type === TYPE_PAX) {
      pendingPath = paxPathOf(data) ?? pendingPath
      continue
    }
    if (type === TYPE_PAX_GLOBAL) continue
    if (type === TYPE_GNU_LONG_NAME) {
      pendingPath = data.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    if (type === TYPE_GNU_LONG_LINK) continue
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      // 软链接/硬链接/设备文件一律拒绝：npm 包里不会有，出现了要么是包坏了要么是有人在
      // 拼接。静默跳过会让「这一代缺一个文件」在几个小时后才以别的方式暴露。
      throw new Error(`OTA 包里有链接或设备条目（${name}），拒绝安装；打包请用 npm pack，不要用系统 tar`)
    }
    // PAX / GNU 长名已经把整条路径写全了（含 `package/` 前缀），有它就不再拼 prefix。
    const fullPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    pendingPath = null
    const segments = safeSegments(fullPath)
    if (segments[0] !== ARCHIVE_PREFIX) {
      throw new Error(`OTA 包条目必须以 ${ARCHIVE_PREFIX}/ 打头：${fullPath}`)
    }
    const normalized = segments.join('/')
    if (type === TYPE_DIR) entries.push({ path: normalized, type: 'dir', mode, data: null })
    else if (TYPE_FILE.has(type)) entries.push({ path: normalized, type: 'file', mode, data })
    else throw new Error(`OTA 包里有不支持的条目类型 '${type}'（${name}）`)
  }
  if (!entries.length) throw new Error('OTA 包是空的：一个条目都没读出来')
  return entries
}

/**
 * 把包解到 `target/<packageName>`。
 *
 * 不解压到系统临时目录：见 `device-ota.js` 里对「暂存必须和目标同盘」的说明。
 *
 * @returns {{files: number}}
 */
export function unpackTarGz(input, target, { packageName = 'dsh-mobile-plugin' } = {}) {
  const entries = readEntries(input)
  let files = 0
  for (const entry of entries) {
    const rel = entry.path.split('/').slice(1)
    if (!rel.length) continue
    const dest = path.join(target, packageName, ...rel)
    if (entry.type === 'dir') {
      fs.mkdirSync(dest, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.data)
    // 可执行位只在 POSIX 上有意义；Windows 上 chmod 会变成只读标记，别去碰它。
    if (process.platform !== 'win32' && (entry.mode & 0o111)) {
      try { fs.chmodSync(dest, entry.mode & 0o777) } catch { /* 权限位丢了不影响 JS 加载 */ }
    }
    files += 1
  }
  return { files }
}

/**
 * 读包内清单。没有清单（老版本打的包）返回 null——那时退回旧的「有 package.json 与
 * impl.js 就算齐」判据，不让新代码把老包全判成坏的。
 */
export function readManifest(pkgDir) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(path.join(pkgDir, MANIFEST_PATH), 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string' || !Array.isArray(raw.files)) return null
  const files = raw.files.filter(item => item && typeof item.path === 'string' && item.path.length > 0)
  if (files.length !== raw.files.length) return null
  return { version: raw.version, platform: typeof raw.platform === 'string' ? raw.platform : null, files: files.map(item => ({ path: item.path, size: Number.isFinite(item.size) ? item.size : null })) }
}

/**
 * 逐项核对清单。缺文件 / 大小不符立刻抛错，并把**具体是哪个文件**写进消息——
 * 「找不到某个 JS 文件」这类模糊报错要在激活之前就变成可执行的结论。
 */
export function verifyManifest(pkgDir, manifest) {
  if (!manifest) return 0
  const problems = []
  for (const item of manifest.files) {
    const segments = safeSegments(item.path)
    const abs = path.join(pkgDir, ...segments)
    let stat
    try { stat = fs.statSync(abs) } catch { problems.push(`缺文件 ${item.path}`) }
    if (stat) {
      if (!stat.isFile()) problems.push(`不是普通文件 ${item.path}`)
      else if (item.size !== null && stat.size !== item.size) problems.push(`大小不符 ${item.path}（清单 ${item.size}，实际 ${stat.size}）`)
    }
    if (problems.length >= 5) break
  }
  if (problems.length) throw new Error(`OTA 包不完整，拒绝激活：${problems.join('；')}`)
  return manifest.files.length
}

/**
 * 移动/改名一个目录，跨盘也能成。
 *
 * `fs.renameSync` 在**同一文件系统**内是原子的，但 Windows 上系统临时目录与 DSH 数据目录
 * 很可能不在一个盘，那时它抛 `EXDEV`；Windows 还可能在目标被占用时抛 `EPERM`/`EACCES`。
 * 这条链上没有别的地方能兜住这类失败，所以在这里退化成本地复制再删源。
 */
export function movePath(src, dst) {
  try {
    fs.renameSync(src, dst)
    return 'rename'
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(code)) throw error
  }
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
  fs.rmSync(src, { recursive: true, force: true })
  return 'copy'
}

/** 下载内容的哈希。中转下发了 sha256 时用它把「拿到的包」和「发布的包」钉在一起。 */
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

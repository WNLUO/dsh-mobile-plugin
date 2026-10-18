#!/usr/bin/env node
/**
 * 打一个 OTA 包（并在需要时发布到中转）。
 *
 * 为什么要有这个脚本：以前文档里的做法是「系统 tar 打个包，curl 发上去」。那条路在三个
 * 平台上会出三种结果——macOS 默认带 PAX 扩展头（客户端旧的解包器直接不认，报「OTA 包
 * 结构不完整」）、Windows 上不一定有 tar、Linux 上一堆 `--no-xattrs` 参数各版本还不一样。
 * 而「发上去的包到底完整不完整」也没有任何校验：0.1.79 那次发布被中转截断到 64KB，接口
 * 还回 `ok:true`，客户端装到一半才炸。
 *
 * 现在这条链的每一步都有结论：
 *   1. 文件清单问 npm 要（`npm pack --dry-run --json`），**不再靠任何平台的 tar**；
 *   2. 往包里写一份 `lib/ota-manifest.json`（版本 + 每个文件的路径与字节数），客户端解包
 *      后逐项核对——缺文件、大小不符都会在激活之前失败并点名是哪个文件；
 *   3. 自检：用客户端的真解包器（`lib/shell/ota-package.js`）把这包解开、核对清单；
 *   4. 发布后再**下载回来**比一次 sha256（中转把哈希记在发布记录里，客户端也会校验）。
 *
 * 用法（在 dsh-mobile-plugin 目录下）：
 *   node scripts/pack-ota.mjs                      # 只打包，产物写到当前目录
 *   node scripts/pack-ota.mjs --out /tmp/x.tgz
 *   node scripts/pack-ota.mjs --platform any       # 纯 JS 包：一份包供三个系统
 *   node scripts/pack-ota.mjs --publish https://dsh-hub.wnluo.com --token <OTA 发布 token>
 *
 * 平台选项：默认用 `process.platform`（darwin / linux / win32），也可以用 `any` 发一份
 * 「三个平台通用」的包——客户端在自己平台没有包时会回落去问 `any`。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gzipTar, writeTar } from './lib/ota-tar.mjs'
import { MANIFEST_PATH, readManifest, sha256Hex, unpackTarGz, verifyManifest } from '../lib/shell/ota-package.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-mobile-plugin'

function parseArgs(argv) {
  const args = { platform: process.platform, channel: 'stable', out: null, publish: null, token: null }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${key} 需要一个值`)
      index += 1
      return value
    }
    if (key === '--out') args.out = next()
    else if (key === '--platform') args.platform = next()
    else if (key === '--channel') args.channel = next()
    else if (key === '--publish') args.publish = next().replace(/\/+$/, '')
    else if (key === '--token') args.token = next()
    else if (key === '--help' || key === '-h') args.help = true
    else throw new Error(`不认识的参数：${key}`)
  }
  return args
}

/** 问 npm 要「这个包会收哪些文件」——与 `npm publish` 收的完全同一份清单。 */
function npmFileList() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    // Windows 上 npm 是 npm.cmd，必须走 shell 才能执行。
    shell: process.platform === 'win32',
  })
  const parsed = JSON.parse(raw)
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  if (!info || !Array.isArray(info.files) || !info.files.length) throw new Error('npm 没有返回文件清单（npm pack --dry-run --json 的格式变了？）')
  return info.files.map(item => ({ path: String(item.path).replace(/\\/g, '/'), size: Number(item.size) || 0, mode: Number(item.mode) || 0o644 }))
}

function buildPackage({ platform }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version || ''))) throw new Error(`package.json 的版本不是 X.Y.Z：${pkg.version}`)
  const files = npmFileList()
  const paths = new Set(files.map(item => item.path))
  for (const required of ['package.json', 'lib/impl.js']) {
    if (!paths.has(required)) throw new Error(`要发布的内容里缺 ${required}——先在 package.json 的 files 里把它加回来`)
  }
  // 清单只记「发出去的每一个文件」，客户端照它核对；自己（清单文件）不在里面。
  const manifest = {
    version: pkg.version,
    platform,
    files: files
      .filter(item => item.path !== MANIFEST_PATH)
      .map(item => ({ path: item.path, size: item.size }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  }
  const entries = files
    .filter(item => item.path !== MANIFEST_PATH)
    .map(item => ({
      path: `package/${item.path}`,
      mode: item.mode,
      data: fs.readFileSync(path.join(PACKAGE_ROOT, ...item.path.split('/'))),
    }))
  entries.push({ path: `package/${MANIFEST_PATH}`, mode: 0o644, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') })
  const tgz = gzipTar(writeTar(entries))
  return { version: pkg.version, tgz, manifest }
}

/** 用客户端的真解包器自检一遍：打包脚本自己的 bug 不该等到装上机器才发现。 */
function selfCheck(tgz) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ota-selfcheck-'))
  try {
    unpackTarGz(tgz, dir)
    const pkgDir = path.join(dir, PACKAGE_NAME)
    const manifest = readManifest(pkgDir)
    if (!manifest) throw new Error('自检失败：包里读不到清单')
    verifyManifest(pkgDir, manifest)
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    if (pkg.version !== manifest.version) throw new Error('自检失败：清单版本与 package.json 不一致')
    return { files: manifest.files.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function publish({ base, token, tgz, version, platform, channel }) {
  if (!token) throw new Error('--publish 需要同时给 --token（中转的 OTA 发布 token）')
  const query = `?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}&version=${encodeURIComponent(version)}`
  const upload = await fetch(`${base}/api/desktop-plugins/ota/publish${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
    body: tgz,
  })
  const uploaded = await upload.json().catch(() => null)
  if (!upload.ok || uploaded?.ok !== true) throw new Error(`发布失败：HTTP ${upload.status} ${JSON.stringify(uploaded)}`)
  // 发布接口以前会**静默截断**（照 64KB 读、却回 ok:true）。所以这里核两件事：
  // 中转记下的大小与我们发的一致，以及它给的下载地址拿回来的字节哈希一致。
  if (Number(uploaded?.data?.size) !== tgz.length) throw new Error(`发布后大小不一致：本地 ${tgz.length}，中转 ${uploaded?.data?.size}`)
  if (typeof uploaded?.data?.sha256 === 'string' && uploaded.data.sha256 && uploaded.data.sha256 !== sha256Hex(tgz)) {
    throw new Error(`发布后哈希不一致：本地 ${sha256Hex(tgz)}，中转 ${uploaded.data.sha256}`)
  }
  const latestResponse = await fetch(`${base}/api/desktop-plugins/ota/latest?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`, { headers: { accept: 'application/json' } })
  const latest = await latestResponse.json().catch(() => null)
  if (latest?.ok !== true || latest?.data?.version !== version) throw new Error(`发布后 latest 没指向 ${version}：${JSON.stringify(latest)}`)
  const download = await fetch(latest.data.packageUrl)
  if (!download.ok) throw new Error(`下载回验失败：HTTP ${download.status}`)
  const back = Buffer.from(await download.arrayBuffer())
  if (sha256Hex(back) !== sha256Hex(tgz)) throw new Error(`下载回来的包与本地不一致（本地 ${sha256Hex(tgz)}，线上 ${sha256Hex(back)}）`)
  return { packageUrl: latest.data.packageUrl, size: back.length }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/pack-ota.mjs [--out <file>] [--platform darwin|linux|win32|any] [--channel stable] [--publish <中转基址> --token <token>]')
    return
  }
  const { version, tgz, manifest } = buildPackage({ platform: args.platform })
  const checked = selfCheck(tgz)
  const out = path.resolve(args.out || path.join(process.cwd(), `${PACKAGE_NAME}-${version}.tgz`))
  fs.writeFileSync(out, tgz)
  console.log(`版本      ${version}`)
  console.log(`平台      ${args.platform}`)
  console.log(`文件数    ${manifest.files.length}（自检通过，核对 ${checked.files} 项）`)
  console.log(`大小      ${tgz.length} 字节`)
  console.log(`sha256    ${sha256Hex(tgz)}`)
  console.log(`产物      ${out}`)
  if (args.publish) {
    const result = await publish({ base: args.publish, token: args.token, tgz, version, platform: args.platform, channel: args.channel })
    console.log(`已发布    ${result.packageUrl}（回下载 ${result.size} 字节，哈希一致）`)
  }
}

main().catch(error => {
  console.error(`pack-ota 失败：${error && error.message ? error.message : error}`)
  process.exit(1)
})

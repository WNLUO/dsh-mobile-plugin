/** 设备端临时插件 OTA：npm 保持正式来源，OTA 仅保存于 DSH home。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dshHome } from '../shared/paths.js'
import { compareVersion } from './manager.js'

const require_ = createRequire(import.meta.url)
const zlib = require_('node:zlib')
const ROOT = () => path.join(dshHome(), 'plugin-ota')
const PACKAGE = 'dsh-mobile-plugin'
const RELAY = 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota'
const CHANNEL = 'stable'
const PLATFORM = process.platform
function validVersion(value) { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) }
function validPackageUrl(value) {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
function availableOta() {
  try {
    return fs.readdirSync(ROOT(), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => {
      const pkgDir = path.join(ROOT(), item.name, PACKAGE)
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
      if (pkg.name !== PACKAGE || !validVersion(pkg.version) || !fs.existsSync(path.join(pkgDir, 'lib', 'impl.js'))) return null
      return { version: pkg.version, entry: path.join(pkgDir, 'lib', 'impl.js'), dir: pkgDir, pkgDir, source: 'ota' }
    }).filter(Boolean).sort((a, b) => compareVersion(b.version, a.version))
  } catch { return [] }
}
function clearSuperseded(version) {
  if (!validVersion(version)) return
  for (const release of availableOta()) if (compareVersion(version, release.version) >= 0) fs.rmSync(path.dirname(release.pkgDir), { recursive: true, force: true })
}
function unpackTarGz(buffer, target) {
  const tar = zlib.gunzipSync(buffer)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '')
    const rel = path.posix.join(prefix, name)
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8)
    const type = header[156]
    const start = offset + 512
    if (!rel.startsWith('package/') || rel.split('/').includes('..')) throw new Error('OTA 包含无效路径')
    if (type === 0 || type === 48) {
      const dest = path.join(target, PACKAGE, ...rel.split('/').slice(1))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, tar.subarray(start, start + size))
    } else if (type !== 53) throw new Error(`OTA 包包含不支持的 tar 项：${rel}`)
    offset = start + Math.ceil(size / 512) * 512
  }
  const pkgDir = path.join(target, PACKAGE)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.name !== PACKAGE || !validVersion(pkg.version) || !fs.existsSync(path.join(pkgDir, 'lib', 'impl.js'))) throw new Error('OTA 包结构不完整')
  return pkg.version
}

export function createDeviceOta({ fetchImpl = fetch, installed = () => null, platform = PLATFORM, channel = CHANNEL, runtime = null } = {}) {
  async function reconcileOfficial() {
    const active = runtime?.status()
    const officialVersion = installed()
    if (!runtime || !validVersion(officialVersion)) return { switched: false, status: active ?? null }
    if (active?.source === 'installed') {
      clearSuperseded(officialVersion)
      return { switched: false, status: active }
    }
    if (active?.source !== 'ota' || !validVersion(active.version) || compareVersion(officialVersion, active.version) < 0) {
      return { switched: false, status: active ?? null }
    }
    const status = await runtime.reload()
    if (status?.source === 'installed') clearSuperseded(officialVersion)
    return { switched: status?.source === 'installed', status }
  }
  async function check() {
    await reconcileOfficial()
    const url = `${RELAY}/latest?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`OTA relay 返回 HTTP ${response.status}`)
    const body = await response.json()
    const release = body?.data
    if (body?.ok !== true || !validVersion(release?.version) || release.platform !== platform || release.channel !== channel || !validPackageUrl(release.packageUrl)) throw new Error('OTA relay 没有提供匹配平台、stable channel、有效版本或 HTTPS 下载地址')
    const installedVersion = installed()
    const officialVersion = installedVersion
    const ota = availableOta()[0] || null
    const otaVersion = validVersion(release.version) ? release.version : null
    const newest = [ota?.version, otaVersion].filter(validVersion).sort((a, b) => compareVersion(b, a))[0] || null
    const absorbed = Boolean(validVersion(officialVersion) && newest && compareVersion(officialVersion, newest) >= 0 && runtime?.status()?.source !== 'ota')
    return { available: Boolean(newest && !absorbed && compareVersion(newest, installedVersion || '0.0.0') > 0), version: newest, platform: release.platform || platform, channel: release.channel || channel, installedVersion, otaVersion: ota?.version ?? null, officialVersion, absorbed, packageUrl: release.packageUrl }
  }
  async function apply() {
    const info = await check()
    if (info.otaVersion && compareVersion(info.otaVersion, info.version) === 0) return { installed: true, version: info.version, source: 'ota', alreadyDownloaded: true }
    if (validVersion(info.officialVersion) && compareVersion(info.officialVersion, info.version) >= 0) return { installed: false, reason: 'npm-current-or-newer', version: info.officialVersion }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-ota-'))
    try {
      const response = await fetchImpl(info.packageUrl)
      if (!response.ok) throw new Error(`OTA 下载失败：HTTP ${response.status}`)
      const version = unpackTarGz(Buffer.from(await response.arrayBuffer()), staging)
      if (version !== info.version) throw new Error(`OTA 版本不匹配：预期 ${info.version}，实际 ${version}`)
      const releaseDir = path.join(ROOT(), version)
      fs.mkdirSync(ROOT(), { recursive: true })
      fs.rmSync(releaseDir, { recursive: true, force: true })
      fs.renameSync(staging, releaseDir)
      return { installed: true, version, source: 'ota' }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }
  const status = () => {
    const installedVersion = installed()
    const active = runtime?.status() ?? null
    const ota = availableOta()[0] || null
    return { available: Boolean(ota && compareVersion(ota.version, installedVersion || '0.0.0') > 0), activeVersion: active?.version ?? installedVersion, otaVersion: ota?.version ?? null, officialVersion: installedVersion, absorbed: Boolean(installedVersion && ota && compareVersion(installedVersion, ota.version) >= 0 && active?.source !== 'ota'), channel }
  }
  async function activate() {
    const outcome = await apply()
    if (!outcome.installed || !runtime) return { ...outcome, status: runtime?.status() ?? null }
    const next = await runtime.reload(outcome.version)
    return { installed: true, version: outcome.version, status: next }
  }
  return { status, check, apply: activate, reconcileOfficial }
}
export { availableOta, clearSuperseded }

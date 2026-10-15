/** Device OTA downloads, unpacks, and activates a release without touching npm. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

function tarEntry(name, content) {
  const data = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12)
  header.write('00000000000\0', 136, 12)
  header[156] = 48
  header.write('ustar\0', 257, 6)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function archive(version) {
  const entries = [
    tarEntry('package/package.json', JSON.stringify({ name: 'dsh-mobile-plugin', version })),
    tarEntry('package/lib/impl.js', 'export function apply() {}'),
  ]
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

async function withHome(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-device-ota-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { await callback(home) }
  finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('device OTA checks relay latest and reports separate OTA/npm versions', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const calls = []
  const ota = createDeviceOta({
    platform: 'linux', channel: 'stable', installed: () => '1.2.0',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'linux', channel: 'stable', packageUrl: 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota/releases/1.3.0/package.tgz' } }) }
    },
  })
  const result = await ota.check()
  assert.match(calls[0].url, /\/latest\?platform=linux&channel=stable$/)
  assert.equal(result.officialVersion, '1.2.0')
  assert.equal(result.version, '1.3.0')
  assert.equal(result.available, true)
  assert.equal(result.packageUrl, 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota/releases/1.3.0/package.tgz')
  assert.equal(ota.status().activeVersion, '1.2.0')
}))

test('device OTA uses the Node platform identifier by default', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  let latestUrl = null
  const ota = createDeviceOta({
    installed: () => null,
    fetchImpl: async url => {
      latestUrl = url
      return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: process.platform, channel: 'stable', packageUrl: 'https://dsh-hub.wnluo.com/releases/1.3.0/package.tgz' } }) }
    },
  })
  await ota.check()
  assert.equal(new URL(latestUrl).searchParams.get('platform'), process.platform)
}))

test('device OTA rejects a release for a different platform or channel', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  for (const release of [
    { version: '1.3.0', platform: 'macos', channel: 'stable', packageUrl: 'https://dsh-hub.wnluo.com/releases/1.3.0/package.tgz' },
    { version: '1.3.0', platform: 'darwin', channel: 'beta', packageUrl: 'https://dsh-hub.wnluo.com/releases/1.3.0/package.tgz' },
  ]) {
    const ota = createDeviceOta({ platform: 'darwin', installed: () => null, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: release }) }) })
    await assert.rejects(ota.check(), /匹配平台、stable channel/)
  }
}))

test('device OTA accepts only the relay stable-version format', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const ota = createDeviceOta({ platform: 'darwin', installed: () => null, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: { version: '1.3.0-rc.1', platform: 'darwin', channel: 'stable', packageUrl: 'https://dsh-hub.wnluo.com/releases/1.3.0/package.tgz' } }) }) })
  await assert.rejects(ota.check(), /有效版本/)
}))

test('device OTA rejects non-HTTPS package addresses', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const ota = createDeviceOta({ platform: 'darwin', installed: () => null, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'darwin', channel: 'stable', packageUrl: 'http://dsh-hub.wnluo.com/releases/1.3.0/package.tgz' } }) }) })
  await assert.rejects(ota.check(), /HTTPS 下载地址/)
}))

test('formal npm reconciliation runs on schedule even when auto-install is disabled', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
  const timerStart = shell.indexOf('const timer = setInterval')
  const timerEnd = shell.indexOf('}, updater.AUTO_INTERVAL_MS)', timerStart)
  assert.notEqual(timerStart, -1)
  assert.notEqual(timerEnd, -1)
  const timer = shell.slice(timerStart, timerEnd)
  const reconcileAt = timer.indexOf('deviceOta.reconcileOfficial()')
  const autoUpdateAt = timer.indexOf('updater.autoUpdateEnabled()')
  assert.ok(reconcileAt >= 0 && autoUpdateAt >= 0 && reconcileAt < autoUpdateAt)
  const checkStart = shell.indexOf('async function check(')
  const applyStart = shell.indexOf('async function applyUpdate(', checkStart)
  assert.match(shell.slice(checkStart, applyStart), /await deviceOta\.reconcileOfficial\(\)/)
})

test('device OTA extracts into its release directory and activates through runtime reload', async () => withHome(async home => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const packageUrl = 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota/releases/1.3.0/package.tgz'
  const calls = []
  let reloaded = null
  const runtime = { status: () => ({ version: '1.2.0' }), reload: async version => { reloaded = version; return { version } } }
  const ota = createDeviceOta({
    platform: 'linux', channel: 'stable', installed: () => '1.2.0', runtime,
    fetchImpl: async url => {
      calls.push(url)
      if (url.includes('/latest?')) return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'linux', channel: 'stable', packageUrl } }) }
      return { ok: true, arrayBuffer: async () => archive('1.3.0') }
    },
  })
  const result = await ota.apply()
  const entry = path.join(home, 'plugin-ota', '1.3.0', 'dsh-mobile-plugin', 'lib', 'impl.js')
  assert.equal(calls[1], packageUrl)
  assert.equal(fs.readFileSync(entry, 'utf8'), 'export function apply() {}')
  assert.equal(reloaded, '1.3.0')
  assert.equal(result.installed, true)
  assert.equal(result.status.version, '1.3.0')
}))

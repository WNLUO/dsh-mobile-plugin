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

// ── 2026-10-17 之后补的健壮性守卫 ────────────────────────────────────────────

/** 带清单的包；`missing` 里的文件清单会声明但实际不写进去（模拟半个包）。 */
function manifestArchive(version, { missing = [] } = {}) {
  const impl = 'export function apply() {}'
  const files = [{ path: 'lib/impl.js', size: Buffer.byteLength(impl) }, ...missing.map(name => ({ path: name, size: 10 }))]
  const entries = [
    tarEntry('package/package.json', JSON.stringify({ name: 'dsh-mobile-plugin', version })),
    tarEntry('package/lib/impl.js', impl),
    tarEntry('package/lib/ota-manifest.json', JSON.stringify({ version, files })),
  ]
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

test('下载内容的 sha256 与中转记录不一致：拒绝安装，不留半份包', async () => withHome(async home => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const packageUrl = 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota/releases/1.3.0/package.tgz'
  const ota = createDeviceOta({
    platform: 'linux', channel: 'stable', installed: () => '1.2.0',
    fetchImpl: async url => {
      if (url.includes('/latest?')) {
        return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'linux', channel: 'stable', packageUrl, sha256: 'a'.repeat(64) } }) }
      }
      return { ok: true, arrayBuffer: async () => archive('1.3.0') }
    },
  })
  await assert.rejects(() => ota.apply(), /sha256|校验/)
  assert.equal(fs.existsSync(path.join(home, 'plugin-ota', '1.3.0')), false, '校验失败不许落下任何一代')
}))

test('自己的平台没有包时回落 any（纯 JS 包一份供三个系统）', async () => withHome(async () => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const seen = []
  const ota = createDeviceOta({
    platform: 'win32', channel: 'stable', installed: () => '1.2.0',
    fetchImpl: async url => {
      seen.push(url)
      if (url.includes('platform=win32')) return { ok: true, json: async () => ({ ok: false, reason: 'no release' }) }
      return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'any', channel: 'stable', packageUrl: 'https://relay.example.com/p.tgz' } }) }
    },
  })
  const result = await ota.check()
  assert.deepEqual(seen.map(url => new URL(url).searchParams.get('platform')), ['win32', 'any'])
  assert.equal(result.version, '1.3.0')
  assert.equal(result.platform, 'any', '回落来的包要把实际平台如实报出来，别谎称是自己平台的')
}))

test('包不完整（清单里有、实际缺）：激活前失败并点名缺哪个文件', async () => withHome(async home => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const packageUrl = 'https://dsh-hub.wnluo.com/api/desktop-plugins/ota/releases/1.3.0/package.tgz'
  let reloaded = false
  const runtime = { status: () => ({ version: '1.2.0', source: 'installed' }), reload: async () => { reloaded = true; return { version: '1.3.0' } } }
  const ota = createDeviceOta({
    platform: 'linux', channel: 'stable', installed: () => '1.2.0', runtime,
    fetchImpl: async url => {
      if (url.includes('/latest?')) return { ok: true, json: async () => ({ ok: true, data: { version: '1.3.0', platform: 'linux', channel: 'stable', packageUrl } }) }
      return { ok: true, arrayBuffer: async () => manifestArchive('1.3.0', { missing: ['lib/mobile/gone.js'] }) }
    },
  })
  await assert.rejects(() => ota.apply(), /lib\/mobile\/gone\.js/)
  assert.equal(reloaded, false, '包不完整就不该触发换代')
  assert.equal(fs.existsSync(path.join(home, 'plugin-ota', '1.3.0')), false)
}))

test('一个残目录 / 暂存目录不许把整台机器的 OTA 变成「没有新版」', async () => withHome(async home => {
  const { availableOta } = await import('../lib/shell/device-ota.js')
  const good = path.join(home, 'plugin-ota', '1.2.0', 'dsh-mobile-plugin')
  fs.mkdirSync(path.join(good, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.2.0' }))
  fs.writeFileSync(path.join(good, 'lib', 'impl.js'), 'export function apply() {}')
  // 半份包：目录在、package.json 是坏的。
  const broken = path.join(home, 'plugin-ota', '9.9.9', 'dsh-mobile-plugin')
  fs.mkdirSync(path.join(broken, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(broken, 'package.json'), '{ not json')
  // 解包中途留下的暂存目录。
  fs.mkdirSync(path.join(home, 'plugin-ota', '.staging-abc'), { recursive: true })
  const list = availableOta()
  assert.deepEqual(list.map(item => item.version), ['1.2.0'])
}))

// ── 换代保险：装之前把正在跑的那一代复制成一份「重启时能回退」的包 ──────────────

/** 造一份已经装好的代（自包含：package.json + lib/impl.js + 内联凭据包 + node_modules 噪声）。 */
function makeInstalledGeneration(root, version) {
  const pkgDir = path.join(root, `store-${version}`, 'dsh-mobile-plugin')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(pkgDir, 'dsh-mobile-credentials', 'lib'), { recursive: true })
  // 依赖树不该跟着复制：它属于 profile，复制过去又慢又会被相对布局骗到。
  fs.mkdirSync(path.join(pkgDir, 'node_modules', 'noise'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'node_modules', 'noise', 'index.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-mobile-plugin', version }))
  fs.writeFileSync(path.join(pkgDir, 'lib', 'impl.js'), 'export function apply() {}')
  fs.writeFileSync(path.join(pkgDir, 'dsh-mobile-credentials', 'lib', 'credentials.js'), 'module.exports = {}\n')
  return pkgDir
}

test('换代备份：把正在跑的那一代复制进回退目录，且是一份能装的完整包', async () => withHome(async home => {
  const { snapshotGeneration, availableOta } = await import('../lib/shell/device-ota.js')
  const source = makeInstalledGeneration(home, '1.2.0')
  const result = snapshotGeneration(source, '1.2.0')
  assert.equal(result.created, true)
  const target = path.join(home, 'plugin-ota', '1.2.0', 'dsh-mobile-plugin')
  assert.equal(result.dir, target)
  assert.equal(fs.existsSync(path.join(target, 'lib', 'impl.js')), true, '缺入口就不是一代，启动时试不起来');
  assert.equal(fs.existsSync(path.join(target, 'dsh-mobile-credentials', 'lib', 'credentials.js')), true, '一代是自包含的：凭据包要跟着走')
  assert.equal(fs.existsSync(path.join(home, 'plugin-ota', '1.2.0', 'node_modules')), false, '依赖树不复制')
  assert.deepEqual(availableOta().map(item => item.version), ['1.2.0'], '备份要出现在回退候选里，否则启动时根本不会去试它')
  // 已经有了就不要再抄一遍（每个 tick 都抄一次等于白耗盘）。
  assert.deepEqual(snapshotGeneration(source, '1.2.0'), { created: false, existing: true, dir: target })
}))

test('换代备份：源目录没了 / 版本号不像样就如实回错，不抛', async () => withHome(async () => {
  const { snapshotGeneration } = await import('../lib/shell/device-ota.js')
  assert.equal(snapshotGeneration('/nowhere/at/all', '1.2.0').created, false)
  assert.equal(snapshotGeneration('/nowhere/at/all', 'latest').created, false, '版本号不可用的目录名不能被造出来')
}))

// 换代失败后跑着的还是旧版、盘上已是新版 —— 这时回退包是重启后唯一的活路，不许清。
test('回退包回收：跑着的版本和盘上一致才清，换代失败时留着', async () => withHome(async home => {
  const { createDeviceOta } = await import('../lib/shell/device-ota.js')
  const fallback = path.join(home, 'plugin-ota', '1.2.0', 'dsh-mobile-plugin')
  fs.mkdirSync(path.join(fallback, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(fallback, 'package.json'), JSON.stringify({ name: 'dsh-mobile-plugin', version: '1.2.0' }))
  fs.writeFileSync(path.join(fallback, 'lib', 'impl.js'), 'export function apply() {}')

  let running = { source: 'installed', version: '1.2.0' }
  const ota = createDeviceOta({ installed: () => '1.3.0', runtime: { status: () => running, reload: async () => running } })

  // 换代失败：盘上 1.3.0、跑着 1.2.0。
  await ota.reconcileOfficial()
  assert.equal(fs.existsSync(fallback), true, '装上了没换过来时，那份副本是下次重启唯一的活路')

  // 换过来了：跑着的就是盘上那版，这时才回收。
  running = { source: 'installed', version: '1.3.0' }
  await ota.reconcileOfficial()
  assert.equal(fs.existsSync(path.join(home, 'plugin-ota', '1.2.0')), false, '接管成功后回退包该回收，不然盘上会一直堆着旧包')
}))

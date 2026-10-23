/**
 * 演示用的假宿主：把这一页会打的那组 `/api/relay/*` 全部就地答掉，一个字节都不出浏览器。
 *
 * 为什么要有它：这一页（引导页 + 主页）一进来就会真的写配置、开直连、换配对码 —— 拿它
 * 录屏等于拿正在用的那台机器当布景，录完手机就再也连不上了。所以演示版换掉的不是「界面」，
 * 而是**界面对面的那台宿主**：页面本身一行不改，看到的就是真的那一版。
 *
 * 隔离是结构性的，不是靠小心：
 *  - 唯一的出入口是 `installDemoHost()` 覆写的 `window.fetch`，它只认下面这张路由表；
 *    表里没有的路径直接抛「不发送真实请求」，**没有回落到真 fetch 的分支**，所以漏写一条
 *    的后果是那一次请求失败，而不是打到本机宿主上；
 *  - 状态全在内存里（`state`），刷新页面回到初始那份，不落盘、不碰 `relay.json`；
 *  - 二维码是仓库里预生成的三张假图（`qr-*.svg`），里面带的是 TEST-NET 文档地址，
 *    扫出来也连不到任何东西 —— 真实二维码**根本不在这份页面里**。
 *
 * 只有开发服务器会加载它（入口是 `React/demo.html`，正式产物只构建 `index.html`），
 * 所以 `lib/panel/index.html` 里没有演示分支 —— 这一条由 `test/demo-panel.test.cjs` 钉着。
 */
import type {
  AddressBook,
  ConfigPatch,
  PairingInfo,
  RevokeResult,
  StatusView,
} from '../lib/api.ts'

import qr1 from './qr-1.svg?raw'
import qr2 from './qr-2.svg?raw'
import qr3 from './qr-3.svg?raw'

/** 画面上报的那个版本。必须跟插件包一致，否则演示里会出现一个不存在的版本号（守卫钉着）。 */
export const DEMO_VERSION = '0.1.100'

/** 固定的演示身份。名字走真机也会有的那种，不写「演示」二字。 */
const DEMO_NAME = 'Studio-Mac'
const DEMO_INSTANCE = '6d1f0c9a4b27'
const DEMO_PLATFORM = 'darwin'
const DEMO_OS_VERSION = '15.3'
const DEMO_ARCH = 'arm64'
/** 直连端口：与真机默认值一致。 */
const DEMO_LAN_PORT = 18787
/** 局域网地址走 TEST-NET-1（192.0.2.0/24），扫码 / 手填都到不了任何机器。 */
const DEMO_LAN_ADDRESS = '192.0.2.40'

/** 三张预生成的假二维码，按配对码对上；重新生成就在这三张里轮。 */
const FAKE_QR: { code: string; svg: string }[] = [
  { code: '314059', svg: qr1 },
  { code: '482913', svg: qr2 },
  { code: '760284', svg: qr3 },
]

/** 演示状态：形状与宿主 `/api/relay/status` 一致，页面按真接口的字段读。 */
type DemoState = {
  enabled: boolean
  onboarded: boolean
  name: string
  relayUrl: string
  pairingCode: string
  pairingPolicy: 'code' | 'deny'
  lanEnabled: boolean
  lanPort: number
  preferredLanAddress: string
  autoUpdate: boolean
  qrIndex: number
}

/**
 * 起始那一屏。
 *
 * 缺省是「还没配过」= 打开就是引导页（录屏从引导开始）；带 `?scene=settings` 时是
 * 「已经配好了」= 直接进主页，用来单独挑主页那一屏。判据只看演示页自己的地址栏，
 * 共享的 `Root.tsx` 一个字都不用改。
 */
function initial(): DemoState {
  const configured = new URLSearchParams(window.location.search).get('scene') === 'settings'
  return {
    // 从「还没配过」开始：这样打开就是引导页，配完才进主页（用户要的演示流程）。
    enabled: configured,
    onboarded: configured,
    name: DEMO_NAME,
    relayUrl: configured ? 'https://relay.example.com' : '',
    pairingCode: FAKE_QR[0].code,
    pairingPolicy: 'code',
    // 直连一开始就开着（真机默认也是开着的），但隧道 / 监听要按「启用」之后才算起来。
    lanEnabled: true,
    lanPort: DEMO_LAN_PORT,
    preferredLanAddress: '',
    autoUpdate: false,
    qrIndex: 0,
  }
}

const state = initial()

/** 演示里出现的时刻：固定一份，别让画面上的「最近一次检查」每次刷新都往前跳。 */
const DEMO_TIME = new Date('2026-10-20T10:30:00+08:00')
const iso = (offsetMinutes = 0) => new Date(DEMO_TIME.getTime() + offsetMinutes * 60_000).toISOString()

function qrOfCurrent(): string {
  return (FAKE_QR.find((item) => item.code === state.pairingCode) ?? FAKE_QR[state.qrIndex]).svg
}

function lanUrls(): string[] {
  return state.lanEnabled ? [`http://${DEMO_LAN_ADDRESS}:${state.lanPort}`] : []
}

/** 与宿主 `createStatusView` 同形；页面读到的就是这个。 */
function statusView(): StatusView {
  const tunnelUp = state.enabled && state.relayUrl !== ''
  const lanUp = state.enabled && state.lanEnabled
  return {
    enabled: state.enabled,
    instanceId: DEMO_INSTANCE,
    pairingCode: state.pairingCode,
    relayUrl: state.relayUrl,
    name: state.name,
    pairingPolicy: state.pairingPolicy,
    os: 'macOS',
    platform: DEMO_PLATFORM,
    osVersion: DEMO_OS_VERSION,
    arch: DEMO_ARCH,
    appVersion: DEMO_VERSION,
    localPort: 19387,
    tunnel: {
      state: tunnelUp ? 'connected' : 'off',
      error: null,
    },
    lan: {
      enabled: state.lanEnabled,
      port: state.lanPort,
      requestedPort: state.lanPort,
      state: !state.lanEnabled ? 'off' : lanUp ? 'listening' : 'starting',
      error: null,
      adjusted: false,
    },
    sidecar: {
      state: 'healthy',
      scope: { worker: 'restartable', facade: 'restartable', host: 'needs-host-restart' },
      restarts: 0,
      restartedAt: 0,
      restartError: null,
    },
    mirror: { pushedAt: DEMO_TIME.getTime(), ok: true, error: null },
    onboarded: state.onboarded,
    lastMobileAt: 0,
    panelUrl: 'http://127.0.0.1:5274/demo.html',
  }
}

/** 地址库：一块有线的局域网地址，另有一条走不通的公网地址（扫码只带局域网那条）。 */
function addressBook(): AddressBook {
  return {
    ok: true,
    port: state.lanPort,
    preferred: state.preferredLanAddress,
    lan: [{ address: DEMO_LAN_ADDRESS, url: `http://${DEMO_LAN_ADDRESS}:${state.lanPort}`, interface: 'en0', family: 'IPv4' }],
    public: [{ address: '203.0.113.9', url: `http://203.0.113.9:${state.lanPort}`, interface: 'en0', family: 'IPv4' }],
  }
}

function pairingInfo(): PairingInfo {
  return {
    ok: true,
    name: state.name,
    relayUrl: state.relayUrl,
    lanUrls: lanUrls(),
    pairingCode: state.pairingCode,
    lanPort: state.lanPort,
    lanPortAdjusted: false,
    svg: qrOfCurrent(),
  }
}

/** 宿主那四条更新接口的状态：都在、都是正常值，画面上跟真机一模一样。 */
function updateStatus() {
  return {
    available: true,
    version: DEMO_VERSION,
    installedVersion: DEMO_VERSION,
    source: 'npm',
    previousVersion: null,
    activatedAt: iso(-310),
    lastError: null,
    inFlight: 0,
    swapping: false,
    autoUpdate: state.autoUpdate,
    autoIntervalMs: 10 * 60 * 1000,
    marketBase: null,
    marketLastCheckedAt: iso(-12),
    marketLastError: null,
    marketResult: null,
    lastApply: null,
    appliedAt: null,
    runningShellHash: null,
    installedShellHash: null,
    shellChanged: false,
  }
}

function applyConfig(patch: ConfigPatch) {
  if (typeof patch.relayUrl === 'string') state.relayUrl = patch.relayUrl.trim()
  if (typeof patch.lanEnabled === 'boolean') state.lanEnabled = patch.lanEnabled
  if (Number.isInteger(patch.lanPort) && (patch.lanPort ?? 0) >= 1024 && (patch.lanPort ?? 0) <= 65535) {
    state.lanPort = patch.lanPort as number
  }
  if (typeof patch.name === 'string' && patch.name.trim()) state.name = patch.name.trim()
  if (patch.pairingPolicy === 'code' || patch.pairingPolicy === 'deny') state.pairingPolicy = patch.pairingPolicy
  if (typeof patch.preferredLanAddress === 'string') state.preferredLanAddress = patch.preferredLanAddress.trim()
  return statusView()
}

function body(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(init.body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** 一条路由：返回 Response，取不到就说明这张表漏了这一条。 */
function route(pathname: string, init?: RequestInit): Response | null {
  const method = String(init?.method ?? 'GET').toUpperCase()
  const patch = body(init) as ConfigPatch

  if (pathname === '/api/relay/status' && method === 'GET') return json(statusView())
  if (pathname === '/api/relay/addresses' && method === 'GET') return json(addressBook())
  if (pathname === '/api/relay/pairing' && method === 'GET') {
    // 与宿主同口径：没启用远程控制时这一条回 409，二维码那块自己会说出来。
    if (!state.enabled) return json({ ok: false, error: '请先启用远程控制并保存配置' }, 409)
    return json(pairingInfo())
  }
  // 引导页那一步会同时写 relayUrl 与 lanEnabled；与宿主一样，只认白名单字段。
  if (pathname === '/api/relay/config' && method === 'POST') return json(applyConfig(patch))
  if (pathname === '/api/relay/toggle' && method === 'POST') {
    state.enabled = Boolean(body(init).enabled)
    return json(statusView())
  }
  if (pathname === '/api/relay/onboarded' && method === 'POST') {
    state.onboarded = true
    return json(statusView())
  }
  if (pathname === '/api/relay/regenerate' && method === 'POST') {
    state.qrIndex = (state.qrIndex + 1) % FAKE_QR.length
    state.pairingCode = FAKE_QR[state.qrIndex].code
    return json(statusView())
  }
  if (pathname === '/api/relay/reconnect' && method === 'POST') return json(statusView())
  if (pathname === '/api/relay/restart-sidecar' && method === 'POST') {
    return json({ ok: true, status: statusView() })
  }
  if (pathname === '/api/relay/revoke-all' && method === 'POST') {
    const result: RevokeResult = { ok: true, revoked: 0, revokedRelay: 0, revokedLocal: 0 }
    return json(result)
  }
  if (pathname === '/api/relay/check-port' && method === 'POST') {
    const port = Number(body(init).port)
    const inRange = Number.isInteger(port) && port >= 1024 && port <= 65535
    return json({ ok: true, port: inRange ? port : null, available: inRange, ours: false, listening: state.enabled && state.lanEnabled, currentPort: state.lanPort })
  }
  if (pathname === '/api/relay/probe-relays' && method === 'POST') {
    // 测速结果固定给一个「通」，不编随机数：演示里只需要看见「有几个入口、这条最快」。
    const urls = Array.isArray(body(init).urls) ? (body(init).urls as string[]) : []
    return json({ ok: true, results: urls.filter((u) => typeof u === 'string').map((url, index) => ({ url, ms: 38 + index * 12 })) })
  }

  if (pathname === '/api/relay/update/status' && method === 'GET') return json({ ok: true, data: updateStatus() })
  if (pathname === '/api/relay/update/check' && method === 'POST') {
    return json({
      ok: true,
      data: {
        update: { installedVersion: DEMO_VERSION, latestVersion: DEMO_VERSION, updateAvailable: false, source: 'npm', checkedAt: iso() },
        status: updateStatus(),
      },
    })
  }
  if (pathname === '/api/relay/update/apply' && method === 'POST') {
    return json({ ok: true, data: { installed: false, skipped: true, state: 'succeeded', beforeVersion: DEMO_VERSION, installedVersion: DEMO_VERSION, swapped: false, restartRequired: false, refreshRequired: false, failure: null, status: updateStatus() } })
  }
  if (pathname === '/api/relay/update/auto' && method === 'POST') {
    state.autoUpdate = Boolean(body(init).enabled)
    return json({ ok: true, data: { enabled: state.autoUpdate, status: updateStatus() } })
  }
  if (pathname === '/api/relay/update/ota/status' && method === 'GET') {
    return json({ ok: true, data: { available: false, activeVersion: null, otaVersion: null, officialVersion: DEMO_VERSION, absorbed: false, channel: 'stable' } })
  }
  if (pathname === '/api/relay/update/ota/check' && method === 'POST') {
    return json({ ok: true, data: { update: { available: false, version: null, platform: DEMO_PLATFORM, channel: 'stable' }, status: { available: false, activeVersion: null, otaVersion: null, officialVersion: DEMO_VERSION, absorbed: false, channel: 'stable' } } })
  }
  if (pathname === '/api/relay/update/ota/apply' && method === 'POST') {
    return json({ ok: true, data: { installed: false, version: null, status: { available: false, activeVersion: null, otaVersion: null, officialVersion: DEMO_VERSION, absorbed: false, channel: 'stable' } } })
  }

  return null
}

/**
 * 把 `window.fetch` 换成演示宿主。
 *
 * 表里没有的路径一律抛错 —— **刻意不留回落分支**：这条页面上任何一处漏写，结果都是那一次
 * 请求失败，而不是悄悄打到正在用的那台宿主上。`/dsh-market/*` 也在这张表之外，所以更新卡
 * 永远走宿主那四条，不会去问市场。
 */
export function installDemoHost(): void {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const pathname = raw.startsWith('http://') || raw.startsWith('https://') ? new URL(raw).pathname : new URL(raw, window.location.origin).pathname
    const response = route(pathname, init)
    if (!response) throw new TypeError(`演示模式没有这条接口（不会发送真实请求）：${pathname}`)
    return response
  }
  window.fetch = handler as typeof window.fetch
}

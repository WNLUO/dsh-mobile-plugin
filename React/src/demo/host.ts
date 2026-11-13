/**
 * 演示用的假宿主：把这一页会打的那组 `/api/relay/*` 全部就地答掉，一个字节都不出浏览器。
 *
 * 这一页（引导页 + 主页）一进来就会真的写配置、开直连、换配对码 —— 拿它录屏等于拿正在用的
 * 那台机器当布景。所以演示版换掉的不是「界面」，而是**界面对面的那台宿主**。
 *
 * 隔离是结构性的：唯一出入口是 `installDemoHost()` 覆写的 `window.fetch`，它只认下面这张
 * 路由表，表里没有的路径直接抛「不发送真实请求」，**没有回落到真 fetch 的分支**；状态全在
 * 内存里，刷新回到初始那份，不落盘；二维码是预生成的假图，带 TEST-NET 文档地址。
 *
 * 只有开发服务器会加载它（入口是 `React/demo.html`，正式产物只构建 `index.html`），
 * 这一条由 `test/demo-panel.test.cjs` 钉着。
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
export const DEMO_VERSION = '0.5.47'

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
  /** 手填的直连地址（`manualLanUrl`），与宿主同名设置项。 */
  manualLanUrl: string
  /** 手填的 IPv6 直连地址（`manualIpv6Url`），与宿主同名设置项。 */
  manualIpv6Url: string
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
  // `scene=console` 是「配过之后进控制台」那一幕：那种状态下宿主得说「配过了」，
  // 否则控制台会因为它自己的分流把画面换成引导页。
  const configured = ['settings', 'console'].includes(new URLSearchParams(window.location.search).get('scene') ?? '')
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
    manualLanUrl: '',
    manualIpv6Url: '',
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

/**
 * 演示用的设备清单：三台，正好把那张卡的三种口径各演一遍。
 *
 * 一台在线的加密安卓（局域网，5 分钟内来过）、一台两天前经中转来过的 iPhone、
 * 一台 `legacy` 为真的旧记录（名字为空 —— 界面该写「未知设备」，而且吊销文案该
 * 换成「旧的通行证仍可能在到期前可用」那一句）。`serverNow` 跟着 `DEMO_TIME` 走，
 * 相对时间才不会每次刷新都往前跳。
 *
 * `revokedCount` 要与 `deviceHistory()` 的行数一致：面板拿它决定折叠行说几台、
 * 以及一台活设备都没有时这张卡还摆不摆。
 */
function deviceList() {
  const now = DEMO_TIME.getTime()
  return {
    ok: true,
    serverNow: now,
    revokedCount: deviceHistory().devices.length,
    devices: [
      {
        deviceId: 'demo-android-1',
        name: 'Pixel 8',
        platform: 'android',
        osVersion: '15',
        appVersion: DEMO_VERSION,
        boundAt: now - 2 * 24 * 60 * 60 * 1000,
        lastSeenAt: now - 40 * 1000,
        lastChannel: 'lan',
        legacy: false,
        encrypted: true,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      },
      {
        deviceId: 'demo-ios-2',
        name: 'iPhone 16',
        platform: 'ios',
        osVersion: '19.2',
        appVersion: DEMO_VERSION,
        boundAt: now - 9 * 24 * 60 * 60 * 1000,
        lastSeenAt: now - 2 * 24 * 60 * 60 * 1000,
        lastChannel: 'relay',
        legacy: false,
        encrypted: true,
        expiresAt: now + 21 * 24 * 60 * 60 * 1000,
      },
      {
        // 旧式：没有名字、没有设备密钥、也从没连过（`lastSeenAt: 0`）。
        deviceId: 'demo-legacy-3',
        name: '',
        platform: 'android',
        osVersion: '',
        appVersion: '',
        boundAt: now - 60 * 24 * 60 * 60 * 1000,
        lastSeenAt: 0,
        lastChannel: '',
        legacy: true,
        encrypted: false,
        expiresAt: 0,
      },
    ],
  }
}

/**
 * 演示用的「历史 · 已解绑」：两台，正好把两种结局各演一遍。
 *
 * 一台是三天前亲手解除绑定的（`kind: 'revoked'`，带着 `revokedAt`），一台是通行证自然到期
 * （`kind: 'expired'`，`revokedAt` 为 0、结局时刻取 `expiresAt`）。名下的 `bindings` 故意给
 * 一台 2 条：那条「另有 N 条」的徽标与活设备行是同一套口径。
 */
function deviceHistory() {
  const now = DEMO_TIME.getTime()
  return {
    ok: true,
    serverNow: now,
    devices: [
      {
        deviceId: 'demo-revoked-4',
        name: 'iPad Air',
        model: 'iPad Air (M2)',
        platform: 'ios',
        osVersion: '18.4',
        appVersion: DEMO_VERSION,
        boundAt: now - 18 * 24 * 60 * 60 * 1000,
        lastSeenAt: now - 5 * 24 * 60 * 60 * 1000,
        lastChannel: 'relay',
        revokedAt: now - 3 * 24 * 60 * 60 * 1000,
        expiresAt: 0,
        kind: 'revoked' as const,
        bindings: 2,
      },
      {
        // 自然到期：从没连过（`lastSeenAt: 0`），结局时刻看 `expiresAt`。
        deviceId: 'demo-expired-5',
        name: '',
        model: 'Xiaomi 9',
        platform: 'android',
        osVersion: '11',
        appVersion: '',
        boundAt: now - 40 * 24 * 60 * 60 * 1000,
        lastSeenAt: 0,
        lastChannel: '',
        revokedAt: 0,
        expiresAt: now - 10 * 24 * 60 * 60 * 1000,
        kind: 'expired' as const,
        bindings: 1,
      },
    ],
  }
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
    // Tailcat 隧道：演示里当作「助手装好、已就绪」，与真宿主同形状（真机 `available` 为假时
    // 引导页会显示「不可用」）。地址是编的，只求状态那一行显示正常，没有可用的隧道。
    tailcat: {
      available: true,
      enabled: true,
      running: state.enabled,
      ready: state.enabled,
      address: state.enabled ? 'demo-tailcat-node.example' : '',
      paired: state.enabled ? 1 : 0,
      error: '',
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
    // 与自检那一份同一口径：配上之后手机「四分钟前来过」，没配过就是从来没来过。
    lastMobileAt: state.enabled ? DEMO_TIME.getTime() - 4 * 60_000 : 0,
    panelUrl: 'http://127.0.0.1:5274/demo.html',
  }
}

/** 地址库：一块有线的局域网地址，另有一条走不通的公网地址（扫码只带局域网那条）。 */
function addressBook(): AddressBook {
  return {
    ok: true,
    port: state.lanPort,
    preferred: state.preferredLanAddress,
    // 两条手填地址与真宿主同一形状：空串 = 没填，弹窗据此预填。
    manual: state.manualLanUrl,
    manualIpv6: state.manualIpv6Url,
    lan: [{ address: DEMO_LAN_ADDRESS, url: `http://${DEMO_LAN_ADDRESS}:${state.lanPort}`, interface: 'en0', family: 'IPv4' }],
    public: [{ address: '203.0.113.9', url: `http://203.0.113.9:${state.lanPort}`, interface: 'en0', family: 'IPv4' }],
  }
}

/**
 * `/api/relay/selfcheck` 的假应答：形状与宿主一致，页面按真接口的字段读。
 *
 * 演示有两幕：还没配过时直连没起来（`not-listening`）、手机也没来过；配上之后直连在听、
 * 隧道连着、手机四分钟前来过（`ok`）。`appPath` 故意写成 Homebrew 那种带版本号的长路径，
 * 弹窗里该只露文件名。
 */
function selfCheck() {
  const tunnelUp = state.enabled && state.relayUrl !== ''
  const lanUp = state.enabled && state.lanEnabled
  const lastMobileAt = state.enabled ? DEMO_TIME.getTime() - 4 * 60_000 : 0
  const idle = lastMobileAt === 0
  const verdict = !lanUp ? 'not-listening' : idle ? 'network' : 'ok'
  return {
    ok: true,
    checkedAt: DEMO_TIME.getTime(),
    platform: DEMO_PLATFORM,
    verdict,
    listening: {
      state: lanUp ? 'listening' : 'off',
      port: state.lanPort,
      urls: lanUrls(),
      portAdjusted: false,
    },
    tunnel: { state: tunnelUp ? 'connected' : 'off', relayUrl: state.relayUrl || null },
    firewall: {
      supported: true,
      enabled: true,
      allowsApp: true,
      appPath: '/opt/homebrew/Cellar/node/26.8.1/bin/node',
      reason: null,
    },
    mobile: { lastMobileAt, idle },
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
  if (typeof patch.manualLanUrl === 'string') state.manualLanUrl = patch.manualLanUrl.trim().replace(/\/+$/, '')
  if (typeof patch.manualIpv6Url === 'string') state.manualIpv6Url = patch.manualIpv6Url.trim().replace(/\/+$/, '')
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
function route(pathname: string, init?: RequestInit, search = new URLSearchParams()): Response | null {
  const method = String(init?.method ?? 'GET').toUpperCase()
  const patch = body(init) as ConfigPatch

  if (pathname === '/api/relay/status' && method === 'GET') return json(statusView())
  if (pathname === '/api/relay/addresses' && method === 'GET') return json(addressBook())
  // 连接自检：页面只在开弹窗（或手机 30 分钟没来过）时打这一条，`?force=1` 也答同一份。
  if (pathname === '/api/relay/selfcheck' && method === 'GET') return json(selfCheck())
  // 设备清单与解除绑定：面板那张卡自己轮询这一条，演示里也得答，否则整卡不出现。
  // `?history=1` 是同一路径的另一个回答（已解绑的历史），与宿主同一个 query 口径。
  if (pathname === '/api/relay/devices' && method === 'GET') {
    return json(search.get('history') === '1' ? deviceHistory() : deviceList())
  }
  if (pathname === '/api/relay/devices/revoke' && method === 'POST') {
    const target = String(body(init).deviceId || '')
    const revoked = target ? 1 : 0
    return json({ ok: true, revoked, closed: 0 })
  }
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
    const url = new URL(raw, window.location.origin)
    const response = route(url.pathname, init, url.searchParams)
    if (!response) throw new TypeError(`演示模式没有这条接口（不会发送真实请求）：${url.pathname}`)
    return response
  }
  window.fetch = handler as typeof window.fetch
}

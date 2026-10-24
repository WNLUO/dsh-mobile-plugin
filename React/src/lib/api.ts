/**
 * 控制面客户端：只碰 `/api/relay/*` 这一组本机接口。
 *
 * 这页读的是宿主已有的那份契约（`../lib/routes/control-plane.js`），不新增任何端点：
 * 所有接口只放行本机来源，所以浏览器直接打开也能用，不需要 token。
 * 开发时靠 Vite 的 `/api` 代理打到 DSH 网页端口；打包后由宿主自己把这页发出来，
 * 同源，路径一个字都不用改。
 */

import { t } from './i18n/index.ts'

export type PairingPolicy = 'code' | 'deny'

export type TunnelSnapshot = {
  state: string
  error: string | null
  /** 命中中转的拒绝文案时才出现，见 ../lib/relay/status.js 的 TUNNEL_ADMISSION。 */
  registerSecretRequired?: boolean
  instanceNotAllowed?: boolean
  admissionHint?: 'register-secret' | 'instance-allowlist'
}

export type StatusView = {
  enabled: boolean
  instanceId: string
  pairingCode: string
  relayUrl: string
  name: string
  pairingPolicy: PairingPolicy
  os: string
  platform: string
  osVersion: string
  arch: string
  appVersion: string
  localPort: number
  tunnel: TunnelSnapshot
  lan: {
    enabled: boolean
    port: number
    requestedPort: number
    state: string
    error: string | null
    adjusted: boolean
  }
  sidecar: {
    state: string
    scope: { worker: string; facade: string; host: string }
    restarts: number
    restartedAt: number
    restartError: string | null
  }
  mirror: { pushedAt: number; ok: boolean; error: string | null }
  /** 这台机器走过首次接入引导了没有（落盘在 relay.json 里，见 ../lib/relay/core.js）。 */
  onboarded?: boolean
  /**
   * 面板页自己的绝对地址，宿主在 `/api/relay/status` 上补的（只有这条本机路由带它）。
   * 客户端半边拿它渲染「打开配置页面」的链接：必须是绝对 http(s)，相对地址在桌面版里
   * 会被解析成 `dsh-app://` 而点不开。
   */
  panelUrl?: string
  /**
   * 最近一次「手机上真的来过」的时刻（毫秒，0 = 从来没来过）。宿主在移动端守卫里记的，
   * 也只有本机这条状态路由带它。引导最后一页靠它把「等手机扫码」变成真结论。
   * **老宿主没有这个字段**：那时它是 `undefined`，界面不能假装自己在等一个永远等不到的信号。
   */
  lastMobileAt?: number
}

/** `/api/relay/addresses` 里一条地址。 */
export type AddressEntry = {
  address: string
  url: string
  interface?: string
  family?: string
}

/**
 * `/api/relay/addresses` 的回答：这台机器检测到的地址，按**局域网 / 公网 / IPv6**分开。
 *
 * 宿主刻意分成三份（见插件侧 `lib/relay/lan-network.cjs` 的三个函数）：局域网那份是
 * RFC1918，公网那份排掉了回环、链路本地、CGNAT、基准测试这些拨不通的段，IPv6 那份是
 * **全球单播**（`2000::/3`，排掉 6to4 / Teredo / 文档段）—— 手机不在同一个网络时唯一
 * 可能拨到的那一类。界面据此告诉用户「手机里该填哪个」，而不是把一份混在一起的列表丢给他。
 */
export type AddressBook = {
  ok?: boolean
  /** 宿主当前在用的直连端口（界面上被用户改过时以输入框为准）。 */
  port: number
  /**
   * 用户选中的「手机优先用这条」（设置项 `preferredLanAddress`，空串 = 没选过）。
   *
   * 它只是**回显**：选择真正生效的地方是二维码与 `/connection-info` 里那份候选顺序
   * （宿主按它把选中的排到最前，其余继续当兜底）。老宿主没有这个字段。
   */
  preferred?: string
  lan: AddressEntry[]
  public: AddressEntry[]
  /**
   * IPv6 全球单播候选（老宿主没有这个字段，读成空数组）。
   *
   * **只显示、不能选**：这一份由手机侧拿它和公网中转**实测比速度**来择优，宿主不替它排，
   * 所以它不参与 `preferred`（那个选择只作用于上面两份）。`address` 是裸地址，`url`
   * 才带方括号 —— 拼 URL 的地方别自己拿 `address` 去拼（见 `AddressPicker` 的 `urlOf`）。
   */
  ipv6?: AddressEntry[]
}

export type PairingInfo = {
  ok: true
  name: string
  relayUrl: string
  lanUrls: string[]
  pairingCode: string
  lanPort: number
  lanPortAdjusted: boolean
  svg: string
}

export type RevokeResult = {
  ok: boolean
  revoked: number
  revokedRelay: number
  revokedLocal: number
}

/**
 * `/api/relay/devices` 里的一台设备：同一台手机重配几次，宿主按 `deviceId` 聚成一行
 * （见 `dsh-mobile-credentials/lib/credentials.js` 的 `listDevices`）。
 *
 * 这里**没有** `hash` / `hostToken` / `deviceKey`：那些是凭据与密钥材料，宿主刻意不往面板回。
 */
export type RelayDevice = {
  deviceId: string
  /** 旧记录没存名字时是空串 —— 界面显示「未知设备」。 */
  name: string
  /** `ios` / `android` / `linux` / `darwin` / `win32` 这类，宿主报什么就是什么。 */
  platform: string
  osVersion: string
  appVersion: string
  /** 毫秒时间戳；取这台设备名下最早那条记录。 */
  boundAt: number
  /** 毫秒时间戳；0 = 从没连过。 */
  lastSeenAt: number
  /** `relay` / `lan` / 空串（最近那条记录没记通道）。 */
  lastChannel: string
  /**
   * 这台设备名下还有**不带设备密钥**的活记录。
   *
   * 那种凭据没有设备身份，单台吊销杀不掉它（旧的通行证在到期前仍可用），所以这一位
   * 决定解除绑定的确认文案能不能写「立即失效」。
   */
  legacy: boolean
  /** 这条会话走加密（带设备密钥的记录才走逐请求签名）。 */
  encrypted: boolean
  expiresAt: number
}

/** `GET /api/relay/devices` 的回答。`serverNow` 是算「几分钟前」的同一台机器基准。 */
export type DeviceList = {
  ok: true
  serverNow: number
  devices: RelayDevice[]
}

/** `POST /api/relay/devices/revoke` 的回答：吊销了几条凭据、断开了几条已建立的流。 */
export type DeviceRevokeResult = {
  ok: boolean
  revoked: number
  closed: number
}

/**
 * `/api/relay/check-port` 的回答：本机现在能不能监听这个端口。
 *
 * 宿主侧是真去 bind 一次（和局域网代理挑端口用同一把探针），所以 `available: true`
 * 就意味着「完成并启用」时不会 EADDRINUSE。它**只回答本机**：外网能不能连、
 * 防火墙放没放行，它不知道，界面别替它说。
 */
export type PortCheck = {
  ok?: boolean
  /** 问的那个端口；输入不在 1024–65535 里时是 null。 */
  port: number | null
  available: boolean
  /** true = 这个端口正是本机当前在监听的直连端口（是我们自己占着，不是被别的程序占）。 */
  ours?: boolean
  /** 本机的直连监听现在开着没有。 */
  listening?: boolean
  /** 本机的直连端口（已解析过的实际值）。 */
  currentPort?: number
  /**
   * 为什么不能用。`out-of-range` = 不在 1024–65535；`host-web-port` = 这是 DSH 自己的
   * 网页端口（不能拿它当直连端口，否则等于把桌面 GUI 挂到手机上）。
   */
  reason?: 'out-of-range' | 'host-web-port' | string
}

/** `/api/relay/config` 只认这几个字段，其余一律忽略（宿主侧白名单）。 */
export type ConfigPatch = {
  relayUrl?: string
  lanEnabled?: boolean
  lanPort?: number
  name?: string
  pairingPolicy?: PairingPolicy
  registerSecret?: string
  /**
   * 手机优先用哪条地址（IPv4 字面量）。空串是合法值，表示「不指定，按宿主自己的排序」——
   * 所以它跟 `name` 不一样，不会被宿主当成「没填」丢掉。
   */
  preferredLanAddress?: string
}

export class ApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 控制面的错误有两种形状：对象（`{code, message}`，如 `update_needs_restart`）
 * 与字符串（`/api/relay/pairing` 的 409 给的就是一句中文）。两种都要认出来。
 */
async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const raw = (payload as { error?: unknown } | null)?.error
  if (typeof raw === 'string' && raw) return new ApiError(raw, `http_${response.status}`, response.status)
  if (raw && typeof raw === 'object') {
    const detail = raw as { code?: unknown; message?: unknown }
    const code = typeof detail.code === 'string' && detail.code ? detail.code : `http_${response.status}`
    const message =
      typeof detail.message === 'string' && detail.message ? detail.message : t('panel.net.requestFailed', { status: response.status })
    return new ApiError(message, code, response.status)
  }
  return new ApiError(t('panel.net.requestFailed', { status: response.status }), `http_${response.status}`, response.status)
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw await toApiError(response)
  return (await response.json()) as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw await toApiError(response)
  return (await response.json()) as T
}

/** 界面上的错误一律走这里：网络层自己抛的 TypeError 也得变成一句人话。 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message || t('panel.net.requestFailedNoStatus')
  return String(error)
}

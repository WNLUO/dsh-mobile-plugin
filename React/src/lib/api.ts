/**
 * 控制面客户端：只碰 `/api/relay/*` 这一组本机接口。
 *
 * 这页读的是宿主已有的那份契约（`../lib/routes/control-plane.js`），不新增任何端点：
 * 所有接口只放行本机来源，所以浏览器直接打开也能用，不需要 token。
 * 开发时靠 Vite 的 `/api` 代理打到 DSH 网页端口；打包后由宿主自己把这页发出来，
 * 同源，路径一个字都不用改。
 */

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

/** `/api/relay/config` 只认这几个字段，其余一律忽略（宿主侧白名单）。 */
export type ConfigPatch = {
  relayUrl?: string
  lanEnabled?: boolean
  lanPort?: number
  name?: string
  pairingPolicy?: PairingPolicy
  registerSecret?: string
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
      typeof detail.message === 'string' && detail.message ? detail.message : `请求失败（HTTP ${response.status}）`
    return new ApiError(message, code, response.status)
  }
  return new ApiError(`请求失败（HTTP ${response.status}）`, `http_${response.status}`, response.status)
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
  if (error instanceof Error) return error.message || '请求失败'
  return String(error)
}

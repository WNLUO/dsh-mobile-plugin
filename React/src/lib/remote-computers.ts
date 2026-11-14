/** 远程电脑控制面契约、访问租期与本机浏览器打开方式。 */
import { ApiError, apiGet, apiPost } from './api.ts'
import { t } from './i18n/index.ts'

export type RemoteComputerRoute = { url: string; channel: string }
export type RemoteComputer = {
  id: string
  name: string
  instanceId: string
  mode: string
  channel: string | null
  url: string | null
  latencyMs: number | null
  state: 'idle' | 'connecting' | 'connected' | 'offline' | 'expired' | 'revoked'
  expiresAt: number | null
  lastError?: string
  lastErrorCode?: string | null
  routes: RemoteComputerRoute[]
}
export type AuthorizedComputer = {
  deviceId: string
  name: string
  platform: string
  lastSeenAt: number
  createdAt: number
}
export type RemoteComputerList = {
  ok: boolean
  devices: RemoteComputer[]
  authorizedComputers: AuthorizedComputer[]
  serverNow: number
}
export type RemoteComputerInvite = { ok: boolean; invite: string; expiresAt: number }
type RemoteComputerOpen = { ok: boolean; url: string; expiresAt: number }

/** 远程模块仅按错误码取词，不把服务端原始错误文本带进其他语言。 */
export function remoteErrorText(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : ''
  const keys: Record<string, string> = {
    'credentials-unavailable': 'errorAuth', REMOTE_AUTH: 'errorAuth', REMOTE_REVOKED: 'errorAuth',
    REMOTE_EXPIRED: 'errorExpired', REMOTE_TIMEOUT: 'errorTimeout', REMOTE_CONNECT: 'errorConnect',
    REMOTE_INVITATION: 'errorInvitation', REMOTE_OPEN_URL: 'invalidOpenUrl',
    REMOTE_POPUP: 'popupBlocked', REMOTE_EXTERNAL_OPEN: 'externalOpenFailed',
  }
  return t(keys[code] ? `panel.remote.${keys[code]}` : 'panel.remote.failed')
}

const BASE = '/api/relay/remote-computers'
export const REMOTE_LEASE_WARNING_MS = 5 * 60 * 1000

export const remoteComputers = {
  list: () => apiGet<RemoteComputerList>(BASE),
  invite: () => apiPost<RemoteComputerInvite>(`${BASE}/invite`, {}),
  add: (invite: string) => apiPost<{ ok: boolean; device: RemoteComputer }>(`${BASE}/add`, { invite }),
  open: (id: string) => apiPost<RemoteComputerOpen>(`${BASE}/open`, { id }),
  renew: (id: string) => apiPost<{ ok: boolean; expiresAt: number }>(`${BASE}/renew`, { id }),
  stop: (id: string) => apiPost<{ ok: boolean }>(`${BASE}/stop`, { id }),
  remove: (id: string) => apiPost<{ ok: boolean }>(`${BASE}/remove`, { id }),
  mode: (id: string, mode: string) => apiPost<{ ok: boolean }>(`${BASE}/mode`, { id, mode }),
  probe: (id: string) => apiPost<{ ok: boolean }>(`${BASE}/probe`, { id }),
  revoke: (deviceId: string) => apiPost<{ ok: boolean }>(`${BASE}/revoke`, { deviceId }),
}

/** 续期只延长仍在有效期内的访问；到期、撤权后只能重新打开。 */
export function remoteLease(device: Pick<RemoteComputer, 'state' | 'expiresAt'>, now: number) {
  const remainingMs = Math.max(0, (device.expiresAt ?? 0) - now)
  const active = remainingMs > 0 && device.state !== 'expired' && device.state !== 'revoked'
  return { active, remainingMs, warning: active && remainingMs <= REMOTE_LEASE_WARNING_MS }
}

/** 手动挡只列这台电脑已有的通道，不在前端生成地址。 */
export function remoteModes(routes: RemoteComputerRoute[]): string[] {
  return ['auto', ...new Set(routes.map((route) => route.channel).filter((channel) => channel && channel !== 'auto'))]
}

/** 一次性入口只能交给本机代理；拒绝其他主机、协议和 URL 中的账号密码。 */
export function trustedRemoteUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ApiError(t('panel.remote.invalidOpenUrl'), 'REMOTE_OPEN_URL', 0)
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw new ApiError(t('panel.remote.invalidOpenUrl'), 'REMOTE_OPEN_URL', 0)
  }
  return url.href
}

/** 普通网页预开窗口；桌面壳通过同源顶层导航交系统浏览器。 */
export async function openRemoteComputer(id: string): Promise<RemoteComputerOpen> {
  const browser = window.location.protocol === 'http:' || window.location.protocol === 'https:'
  const target = browser ? window.open('about:blank', '_blank') : null
  if (browser && !target) throw new ApiError(t('panel.remote.popupBlocked'), 'REMOTE_POPUP', 0)
  try {
    if (target) target.opener = null
    const result = await remoteComputers.open(id)
    const url = trustedRemoteUrl(result.url)
    if (target) target.location.replace(url)
    else {
      try {
        const top = window.top
        if (!top || top.location.origin !== window.location.origin) throw new Error('origin')
        top.location.href = url
      } catch {
        throw new ApiError(t('panel.remote.externalOpenFailed'), 'REMOTE_EXTERNAL_OPEN', 0)
      }
    }
    return result
  } catch (error) {
    target?.close()
    throw error
  }
}

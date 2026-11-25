/** 远程电脑控制契约与有证据的网络、助手恢复诊断。 */
// 2026-11-19：回退浏览器时把「没装桌面端」和「壳没起来」分开标记，前者单独提示；新增错误码补上词条映射。
// 2026-11-25：壳熬过宽限后才崩的，经清单轮询取一次性标记补开浏览器；正常关窗不带标记。
import { ApiError, apiGet, apiPost } from './api.ts'
import { t } from './i18n/index.ts'

export type RemoteComputerRoute = { url: string; channel: string }
/** 逐条线路探活结果：只读，不选中也不改访问状态。 */
export type RemoteComputerDiagnoseRoute = {
  channel: string
  url: string
  ok: boolean
  latencyMs: number | null
  errorCode: string | null
}
export type RemoteComputerDiagnose = { ok: boolean; routes: RemoteComputerDiagnoseRoute[] }
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
  /** 桌面窗口此刻是否还连着；关掉后回到未打开状态。 */
  attached: boolean
  /** 这一帧清单里壳是否刚异常退出（一次性，取走即清）。 */
  shellCrashed?: boolean
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
/**
 * 打开结果：`shellOpened:false` 表示桌面壳没起来（已退回浏览器），`shellMissing:true` 表示本机压根
 * 没装桌面端（同样已退回浏览器）——两种情况界面提示不同，不能混成一种静默。
 */
type RemoteComputerOpen = { ok: boolean; url: string; expiresAt: number; shellOpened?: boolean; shellMissing?: boolean }

/** 远程模块仅按错误码取词，不把服务端原始错误文本带进其他语言。 */
export function remoteErrorText(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : ''
  const keys: Record<string, string> = {
    'credentials-unavailable': 'errorAuth', REMOTE_AUTH: 'errorAuth', REMOTE_REVOKED: 'errorAuth',
    REMOTE_EXPIRED: 'errorExpired', REMOTE_TIMEOUT: 'errorTimeout', REMOTE_CONNECT: 'errorConnect',
    REMOTE_PROXY: 'errorProxy', REMOTE_PROXY_CONFIGURED: 'errorProxyConfigured',
    REMOTE_INTERCEPTED: 'errorIntercepted', REMOTE_HELPER_RESTARTING: 'errorHelperRestarting',
    REMOTE_INVITATION: 'errorInvitation', REMOTE_OPEN_URL: 'invalidOpenUrl',
    REMOTE_POPUP: 'popupBlocked', REMOTE_EXTERNAL_OPEN: 'externalOpenFailed',
    REMOTE_VERSION: 'errorVersion', SHELL_UNAVAILABLE: 'shellUnavailable',
    REMOTE_UNAVAILABLE: 'errorUnavailable', REMOTE_NOT_FOUND: 'errorNotFound',
    'bad-invite': 'errorInvitation', 'bad-id': 'errorBadRequest', 'bad-mode': 'errorBadRequest',
  }
  return t(keys[code] ? `panel.remote.${keys[code]}` : 'panel.remote.failed')
}

const BASE = '/api/relay/remote-computers'
export const REMOTE_LEASE_WARNING_MS = 5 * 60 * 1000

export const remoteComputers = {
  list: () => apiGet<RemoteComputerList>(BASE),
  // 生成一次性绑定信息 / 线路检测都可能被宿主拖住：带上超时，免得弹窗停在一片空白或一直转圈。
  invite: () => apiPost<RemoteComputerInvite>(`${BASE}/invite`, {}, { timeoutMs: 15_000 }),
  add: (invite: string) => apiPost<{ ok: boolean; device: RemoteComputer }>(`${BASE}/add`, { invite }),
  open: (id: string) => apiPost<RemoteComputerOpen>(`${BASE}/open`, { id }),
  openShell: (id: string) => apiPost<RemoteComputerOpen>(`${BASE}/open-shell`, { id }),
  diagnose: (id: string) => apiPost<RemoteComputerDiagnose>(`${BASE}/diagnose`, { id }, { timeoutMs: 20_000 }),
  remove: (id: string) => apiPost<{ ok: boolean }>(`${BASE}/remove`, { id }),
  mode: (id: string, mode: string) => apiPost<{ ok: boolean }>(`${BASE}/mode`, { id, mode }),
  revoke: (deviceId: string) => apiPost<{ ok: boolean }>(`${BASE}/revoke`, { deviceId }),
}

/** 续期只延长仍在有效期内的访问；到期、撤权后只能重新打开。 */
export function remoteLease(device: Pick<RemoteComputer, 'state' | 'expiresAt'>, now: number) {
  const remainingMs = Math.max(0, (device.expiresAt ?? 0) - now)
  const active = remainingMs > 0 && device.state !== 'expired' && device.state !== 'revoked'
  return { active, remainingMs, warning: active && remainingMs <= REMOTE_LEASE_WARNING_MS }
}

/** 手动挡只列这台电脑已有的通道，不在前端生成地址。direct 与局域网同为本机直连，不单独作为可选线路露出。 */
export function remoteModes(routes: RemoteComputerRoute[]): string[] {
  return ['auto', ...new Set(routes.map((route) => route.channel).filter((channel) => channel && channel !== 'auto' && channel !== 'direct'))]
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

/** 桌面端不可用只认「没装平台包」和「宿主还没有这条接口」，其余错误照旧抛。 */
function shellUnavailable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === 'SHELL_UNAVAILABLE' || error.status === 404 || error.status === 405 || error.status === 0
  }
  return error instanceof TypeError
}

/** 优先拉起随插件分发的桌面端窗口；没装桌面端时沿用默认打开方式。 */
export async function openRemoteComputer(id: string): Promise<RemoteComputerOpen> {
  try {
    const result = await remoteComputers.openShell(id)
    trustedRemoteUrl(result.url)
    // 壳进程没起来（闪退 / 缺运行库）仍是 200，不当作错误：直接转浏览器打开，并带上标记让界面提示。
    if (result.shellOpened === false) return { ...(await openInBrowser(id)), shellOpened: false }
    return result
  } catch (error) {
    if (!shellUnavailable(error)) throw error
    // 本机没装桌面端（或宿主还没这条接口）：退回默认方式打开，单独标记，界面上要说清是没装、
    // 而不是壳没起来——以前这条会被静默吞掉，用户永远看不到提示。
    return { ...(await openInBrowser(id)), shellMissing: true }
  }
}

/** 清单里带一次性「壳晚崩」标记的设备；窗口仍连着时不补开，避免还有桌面可用时弹浏览器。 */
export function crashedShellIds(list: RemoteComputerList): string[] {
  return (list.devices ?? []).filter((device) => device.shellCrashed && !device.attached).map((device) => device.id)
}

/** 壳熬过宽限后才崩：沿同一条浏览器通道补开，和起手闪退的回退走同一实现。 */
export async function recoverCrashedShell(id: string): Promise<RemoteComputerOpen> {
  return openInBrowser(id)
}

/** 普通网页预开窗口；桌面壳通过同源顶层导航交系统浏览器。 */
async function openInBrowser(id: string): Promise<RemoteComputerOpen> {
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

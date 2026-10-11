/**
 * DSH 插件市场的公共更新接口（`/dsh-market/api/v1/*`，市场文档标注为 v1 / beta）。
 *
 * 为什么这页要直接调市场、而不是自己发 npm：插件的更新从 2026-10 起**只有一条路** ——
 * 市场负责在 profile 里跑 pnpm、校验落盘版本、留回滚点、并在需要时重启 DSH。插件自己
 * 再去 shell 出去装一遍，等于把市场那套（版本核验、release-age 策略、回滚、重启守卫）
 * 抄一遍，抄漏一处就是「装了个不是最新的版本」。所以这里只做三件事：问有没有更新、
 * 请市场去装、盯操作结果。
 *
 * 形状都是外部契约，按**防御式**读：拿不到就当「没有这个能力」，绝不让面板崩。
 */

/** 市场 v1 的路径前缀。文档承诺 v1 会通过 capabilities 暴露 endpoints，这里只用固定路径 + 能力探测。 */
const MARKET = '/dsh-market/api/v1'

/** 本插件的 npm 包名（`package.json` 的 name，市场按它找依赖）。 */
export const PACKAGE_NAME = 'dsh-mobile-plugin'

export type MarketCapabilities = {
  /** 市场可用（探测通过）。false 时整张卡片退化成一句「去设置 → 插件 里更新」。 */
  available: boolean
  /** 能不能由市场代劳重启 DSH。不支持时必须把重启按钮藏起来（文档明确要求）。 */
  restartSupported: boolean
}

export type MarketUpdate = {
  /** profile 里装着的版本；null = 市场看不见这个包（例如不是 npm 来源装的）。 */
  installedVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  /** 来源种类（`npm` / `git` / …）。不是 npm 就说明那台机器还是老装法，得先换过来。 */
  source: string | null
}

export type MarketFailure = { code: string; message: string; retryable: boolean }

export type MarketOperation = {
  operationId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'rolled-back'
  beforeVersion: string | null
  installedVersion: string | null
  restartRequired: boolean
  refreshRequired: boolean
  failure: MarketFailure | null
}

/** 市场接口的错误：把 HTTP 状态、市场给的稳定 code 与给人看的话一起带出来。 */
export class MarketError extends Error {
  status: number

  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'MarketError'
    this.status = status
    this.code = code
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${MARKET}${path}`, {
      // 同源 fetch 默认带 cookie（有登录的宿主靠它认人），这里写出来是为了别哪天被改动掉。
      credentials: 'same-origin',
      ...init,
    })
  } catch (err) {
    throw new MarketError(0, 'market_unreachable', `连不上插件市场：${String((err as Error)?.message || err)}`)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const record = asRecord(body)
    const failure = asRecord(record.failure)
    const code = asString(failure.code) ?? (typeof record.error === 'string' ? record.error : `HTTP ${response.status}`)
    const message = asString(failure.message) ?? asString(record.error) ?? `插件市场返回 HTTP ${response.status}`
    throw new MarketError(response.status, code, message)
  }
  return body
}

/** 探测市场在不在、能不能代劳重启。404 / 401 都算「这台机器上没有可用的市场接口」。 */
export async function marketCapabilities(): Promise<MarketCapabilities> {
  try {
    const body = asRecord(await request('/capabilities'))
    const restart = asRecord(body.restart)
    return { available: true, restartSupported: restart.supported === true }
  } catch {
    return { available: false, restartSupported: false }
  }
}

/** 问这个包有没有更新。`force` 绕开市场的短缓存（人点了「检查更新」时才用）。 */
export async function marketCheckUpdate(name = PACKAGE_NAME, force = false): Promise<MarketUpdate> {
  const query = `?name=${encodeURIComponent(name)}${force ? '&force=1' : ''}`
  const record = asRecord(await request(`/updates${query}`))
  const pkg = asRecord(record.package ?? record)
  return {
    installedVersion: asString(pkg.installedVersion),
    latestVersion: asString(pkg.latestVersion),
    updateAvailable: pkg.updateAvailable === true,
    source: asString(pkg.source),
  }
}

/** 请市场去装。返回操作记录，调用方拿着 operationId 轮询。 */
export async function marketStartUpdate(name = PACKAGE_NAME, force = false): Promise<MarketOperation> {
  const body = asRecord(await request('/updates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageName: name, ...(force ? { force: true } : {}) }),
  }))
  return normalizeOperation(asRecord(body.operation), name)
}

/** 查一次操作结果。 */
export async function marketOperation(operationId: string): Promise<MarketOperation> {
  const body = asRecord(await request(`/operations?operationId=${encodeURIComponent(operationId)}`))
  return normalizeOperation(asRecord(body.operation ?? body), operationId)
}

/** 请市场重启 DSH（只在 `capabilities.restartSupported` 为真时才允许调）。 */
export async function marketRestart(): Promise<void> {
  await request('/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

/** 把操作的形状收敛成我们需要的那几格，缺的给安全默认值。 */
function normalizeOperation(raw: Record<string, unknown>, fallbackId: string): MarketOperation {
  const failure = asRecord(raw.failure)
  const code = asString(failure.code)
  return {
    operationId: asString(raw.operationId) ?? fallbackId,
    state: (asString(raw.state) ?? 'running') as MarketOperation['state'],
    beforeVersion: asString(raw.beforeVersion),
    installedVersion: asString(raw.installedVersion),
    restartRequired: raw.restartRequired === true,
    refreshRequired: raw.refreshRequired === true,
    failure: code
      ? { code, message: asString(failure.message) ?? code, retryable: failure.retryable === true }
      : null,
  }
}

/** 操作还在跑吗（要轮询）。 */
export const operationRunning = (operation: MarketOperation | null): boolean =>
  operation !== null && (operation.state === 'queued' || operation.state === 'running')

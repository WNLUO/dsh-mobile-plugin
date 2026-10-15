/**
 * 「插件更新」走宿主新接口的客户端：`/api/relay/update/{status,check,apply,auto}`。
 *
 * ## 四个接口，两种性质
 *
 * `check` 是**只读的**：插件自己去问 npm 注册表有没有新版（不经过市场，也不要求外壳在
 * 场），所以它在任何宿主上都答得出来。`apply` / `auto` 会真的装东西、换运行中的实现，
 * 那件事归外壳与市场；`status` 只是把外壳那本账读出来。
 *
 * ## 为什么不让浏览器直接调市场
 *
 * 从前面板自己打 `/dsh-market/api/v1/*`（那份仍在 `lib/market.ts` 里，只在宿主连这几条
 * 都没有时才用）。问题是**自动更新没法由页面负责**：轮询得在宿主进程里跑，装完还得有人
 * 把运行中的实现换掉。这两件事都在宿主（`lib/shell/updater.js` 装、`lib/shell/runtime.js`
 * 换代），面板只负责显示与开关，所以手动更新也一起走这条宿主的同一条路。
 *
 * ## 形状
 *
 * 四条接口统一是 `{ ok, data?, error?: { code, message } }`。`data` 里那几格全是外部契约，
 * 一律**防御式**读：拿不到就当没有，绝不让面板因此崩（崩了这张卡就永远打不开）。
 * 唯一例外是 `available`：它决定整张卡走宿主还是退化回市场（见 `updateEndpointMissing`）。
 *
 * ## 降级
 *
 * 老版本宿主没有这四条（404），**不会有** `available: false` —— 那是新宿主在告诉我
 * 「这一版装的是没外壳的实现」。两种都算「宿主这边装不了新版本」，但给用户的话不一样。
 */
import { ApiError } from './api.ts'

export const UPDATE_PATHS = {
  status: '/api/relay/update/status',
  check: '/api/relay/update/check',
  apply: '/api/relay/update/apply',
  auto: '/api/relay/update/auto',
  otaStatus: '/api/relay/update/ota/status',
  otaCheck: '/api/relay/update/ota/check',
  otaApply: '/api/relay/update/ota/apply',
} as const

export type OtaStatusView = {
  available: boolean
  activeVersion: string | null
  otaVersion: string | null
  officialVersion: string | null
  absorbed: boolean
  channel: string
}

export type OtaCheckView = { available: boolean; version: string | null; platform: string | null; channel: string }

async function otaRequest<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const body = await request(path, method === 'POST' ? { method, body: JSON.stringify({}) } : { method })
  return (body.data ?? body) as T
}

export const otaStatus = () => otaRequest<OtaStatusView>(UPDATE_PATHS.otaStatus)
export const otaCheck = () => otaRequest<{ update: OtaCheckView; status: OtaStatusView }>(UPDATE_PATHS.otaCheck, 'POST')
export const otaApply = () => otaRequest<{ installed: boolean; version: string | null; status: OtaStatusView }>(UPDATE_PATHS.otaApply, 'POST')

/** 最近一次「问 npm 有没有新版」的结果（`check` 的 `update`；外壳那份 `marketResult` 同形）。 */
export type MarketUpdateView = {
  installedVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  /** 来源（npm / link / tgz）。只有市场知道，市场不在时为空 —— 与「有没有新版」无关。 */
  source: string | null
  /** 这一次查询的时间（宿主给的 ISO 串）。外壳那份结果里没有这一格。 */
  checkedAt: string | null
}

/** 最近一次「装新版」的结果（宿主 `lastApply`，也是 `apply` 的 `data`）。 */
export type ApplyOutcomeView = {
  installed: boolean | null
  /** 没有新版可装、直接跳过时为 true（这时候 `state` 也是 succeeded）。 */
  skipped: boolean | null
  state: string | null
  beforeVersion: string | null
  installedVersion: string | null
  /** 装完由外壳就地换了代（不需要重启 DSH）。 */
  swapped: boolean | null
  /** 市场认为要重启。外壳**故意不照做**（它自己换代），留着只为如实上报。 */
  restartRequired: boolean | null
  refreshRequired: boolean | null
  failure: { code: string; message: string } | null
}

/** `/update/status` 的 `data`。`available: false` 时宿主只给这两个字段（都是 null）。 */
export type UpdateStatusView = {
  /** false = 这一版没有可换代的外壳（老版本直接挂载上来的），整张卡要退化。 */
  available: boolean
  /** 外壳实际装载的那一代（= 跑着的版本）。 */
  version: string | null
  /** 盘上装着的版本。市场装完立刻变，和 `version` 对照就能看出「要不要换」。 */
  installedVersion: string | null
  source: string | null
  previousVersion: string | null
  activatedAt: string | null
  lastError: string | null
  /** 在飞请求数（换代前它要归零）。 */
  inFlight: number
  /** 正在换代。 */
  swapping: boolean
  autoUpdate: boolean
  autoIntervalMs: number
  marketBase: string | null
  marketLastCheckedAt: string | null
  marketLastError: string | null
  marketResult: MarketUpdateView | null
  lastApply: ApplyOutcomeView | null
  appliedAt: string | null
  runningShellHash: string | null
  installedShellHash: string | null
  /** true = 新版本连外壳一起改了，那部分要等下次启动 DSH 才生效。 */
  shellChanged: boolean
}

/** `apply` 的 `data`：装的结果，外加一份新的状态快照。 */
export type ApplyResultView = ApplyOutcomeView & { status: UpdateStatusView | null }

/** 宿主自己说「这一版没法就地换代」（409 + `update_unavailable`）。 */
export const NO_SHELL_CODE = 'update_unavailable'

/** 自动更新的间隔兜底：宿主没给（老接口）时按 10 分钟说，反正文案里要报分钟数。 */
export const DEFAULT_AUTO_INTERVAL_MS = 10 * 60 * 1000

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    // 与 `api.ts` 同源直连：这组接口只放行本机来源，不需要 token。
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const record = asRecord(payload)
  const error = asRecord(record.error)
  if (!response.ok) {
    const code = asString(error.code) ?? `http_${response.status}`
    const message = asString(error.message) ?? `宿主返回 HTTP ${response.status}`
    throw new ApiError(message, code, response.status)
  }
  return record
}

/**
 * 这个错误是不是「这一版宿主根本没有这四条接口」。
 *
 * 404 是判断依据；另外把「响应不是 JSON」也算进来 —— 老宿主上这几条路径会落到别的
 * 处理里（HTML 错误页、空响应），那种情况同样只说明「办不了」，不该弹个红框吓人。
 */
export function updateEndpointMissing(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 404
  return error instanceof SyntaxError
}

/** 这个错误是不是宿主明说「这一版没有可换代的外壳」。 */
export function updateUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === NO_SHELL_CODE
}

function normalizeMarketUpdate(raw: unknown): MarketUpdateView | null {
  const record = asRecord(raw)
  if (Object.keys(record).length === 0) return null
  return {
    installedVersion: asString(record.installedVersion),
    latestVersion: asString(record.latestVersion),
    updateAvailable: record.updateAvailable === true,
    source: asString(record.source),
    checkedAt: asString(record.checkedAt),
  }
}

function normalizeApply(raw: unknown): ApplyOutcomeView {
  const record = asRecord(raw)
  const failure = asRecord(record.failure)
  const code = asString(failure.code)
  return {
    installed: asBool(record.installed),
    skipped: asBool(record.skipped),
    state: asString(record.state),
    beforeVersion: asString(record.beforeVersion),
    installedVersion: asString(record.installedVersion),
    swapped: asBool(record.swapped),
    restartRequired: asBool(record.restartRequired),
    refreshRequired: asBool(record.refreshRequired),
    failure: code ? { code, message: asString(failure.message) ?? code } : null,
  }
}

function normalizeStatus(raw: unknown): UpdateStatusView {
  const record = asRecord(raw)
  return {
    available: record.available === true,
    version: asString(record.version),
    installedVersion: asString(record.installedVersion),
    source: asString(record.source),
    previousVersion: asString(record.previousVersion),
    activatedAt: asString(record.activatedAt),
    lastError: asString(record.lastError),
    inFlight: asNumber(record.inFlight) ?? 0,
    swapping: record.swapping === true,
    autoUpdate: record.autoUpdate === true,
    autoIntervalMs: asNumber(record.autoIntervalMs) ?? DEFAULT_AUTO_INTERVAL_MS,
    marketBase: asString(record.marketBase),
    marketLastCheckedAt: asString(record.marketLastCheckedAt),
    marketLastError: asString(record.marketLastError),
    marketResult: normalizeMarketUpdate(record.marketResult),
    lastApply: record.lastApply ? normalizeApply(record.lastApply) : null,
    appliedAt: asString(record.appliedAt),
    runningShellHash: asString(record.runningShellHash),
    installedShellHash: asString(record.installedShellHash),
    shellChanged: record.shellChanged === true,
  }
}

/** 读一次更新状态。`available: false` 时后面那些字段都是缺省值。 */
export async function updateStatus(): Promise<UpdateStatusView> {
  const body = await request(UPDATE_PATHS.status)
  return normalizeStatus(body.data)
}

/**
 * 强制查一次市场（绕开市场的短缓存），并顺手带回一份状态快照。
 *
 * `update` 可能是 null：宿主查市场失败时它把 `marketResult` 清空、错误另记在
 * `marketLastError` 里，这里如实把两者一起交给卡片去说。
 */
export async function updateCheck(): Promise<{ update: MarketUpdateView | null; status: UpdateStatusView | null }> {
  const body = await request(UPDATE_PATHS.check, { method: 'POST', body: JSON.stringify({}) })
  const data = asRecord(body.data)
  return {
    update: normalizeMarketUpdate(data.update),
    status: data.status ? normalizeStatus(data.status) : null,
  }
}

/** 请宿主装新版并就地换代。这一步可能要装好几分钟（pnpm 装 + 校验）。 */
export async function updateApply(force = false): Promise<ApplyResultView> {
  const body = await request(UPDATE_PATHS.apply, { method: 'POST', body: JSON.stringify({ force }) })
  const data = asRecord(body.data)
  const status = asRecord(data.status)
  return {
    ...normalizeApply(data),
    status: Object.keys(status).length > 0 ? normalizeStatus(status) : null,
  }
}

/** 自动更新开关。返回宿主真正落盘的值（不是我们请求的那个）。 */
export async function updateAuto(enabled: boolean): Promise<{ enabled: boolean; status: UpdateStatusView | null }> {
  const body = await request(UPDATE_PATHS.auto, { method: 'POST', body: JSON.stringify({ enabled }) })
  const data = asRecord(body.data)
  return {
    enabled: data.enabled === true,
    status: data.status ? normalizeStatus(data.status) : null,
  }
}

/** 界面要的「此刻在忙什么」，把宿主的几个字段合成一句。 */
export function busyTextOf(status: UpdateStatusView | null): 'idle' | 'swapping' | 'in-flight' {
  if (!status) return 'idle'
  if (status.swapping) return 'swapping'
  if (status.inFlight > 0) return 'in-flight'
  return 'idle'
}

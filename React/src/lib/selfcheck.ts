/**
 * 连接自检（`GET /api/relay/selfcheck`）的取数层：什么时候发、发几次、结论怎么读。
 *
 * **为什么不能跟着页面每三秒一次的状态轮询去拉**：宿主每答一次都要开子进程去问系统防火墙，
 * 一次自检就是一次 fork。所以这里只有两个入口 ——
 *   · 人点开自检弹窗（以及弹窗里那颗「重新自检」，带 `?force=1` 跳过宿主的 30 秒缓存）；
 *   · 手机三十分钟没来过时的后台补一次，按 `AUTO_MIN_INTERVAL_MS` 节流：来回切页、
 *     组件重挂载都不会再发。
 *
 * 结论照宿主给的 `verdict` 说，**不自己另判一套**；`unknown` 就是查不到，界面不许把它写成正常。
 * 「手机三十分钟没来过」由 `status.lastMobileAt` 判，老宿主没有这个字段时不猜、也不自动请求。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { apiGet, ApiError, errorText, type SelfCheck } from './api.ts'
import { timeText, type Tone } from './format.ts'
import { t } from './i18n/index.ts'

/** 手机超过这么久没来过就算「大概没连上」。 */
export const MOBILE_IDLE_MS = 30 * 60 * 1000
/** 后台自检的最小间隔（与宿主那 30 秒缓存不是一回事：这一层挡住的是「换页就再拉一次」）。 */
const AUTO_MIN_INTERVAL_MS = 5 * 60 * 1000
/** 开弹窗时缓存这么新就直接用，不再为一次窗外动作开一个子进程。 */
const FRESH_MS = 15 * 1000

/** 上次的结论，跨页面共用（引导页与主页是两个组件，但打的是同一台宿主）。 */
let cached: SelfCheck | null = null
let cachedAt = 0
let autoAt = 0
let inflight: Promise<SelfCheck> | null = null

/**
 * 手机看起来是不是「三十分钟没来过」。
 *
 * `lastMobileAt` 缺失（老宿主）时返回 false —— 看不见就不自动发请求，也不替它下结论。
 */
export function mobileLooksIdle(lastMobileAt: number | undefined): boolean {
  if (typeof lastMobileAt !== 'number' || !Number.isFinite(lastMobileAt)) return false
  if (lastMobileAt === 0) return true
  return Date.now() - lastMobileAt > MOBILE_IDLE_MS
}

/**
 * 发一次自检。
 *
 * `force` 走 `?force=1`（宿主跳过自己的 30 秒缓存），只由「重新自检」那颗按钮传；
 * 不 force 时同一时刻只留一个在飞的请求，开弹窗与后台补查撞上就共用它。
 */
function request(force: boolean): Promise<SelfCheck> {
  if (!force && inflight) return inflight
  const run = (async () => {
    const next = await apiGet<SelfCheck>(
      force ? '/api/relay/selfcheck?force=1' : '/api/relay/selfcheck',
    )
    cached = next
    cachedAt = Date.now()
    return next
  })()
  if (!force) {
    inflight = run
    void run.finally(() => {
      if (inflight === run) inflight = null
    })
  }
  return run
}

export type SelfCheckView = {
  /** 最近一次结论；`null` = 这次会话还没查过。 */
  data: SelfCheck | null
  /** 正有一个请求在飞（弹窗里显示「检查中…」）。 */
  checking: boolean
  /** 接口没做成的那句话。 */
  error: string
  /** 宿主上还没有这条接口（老插件 404）：界面上说「还没这条」，不假装自检失败。 */
  missing: boolean
  /** 开弹窗那一刻调：缓存够新就不重发。 */
  ensure: () => void
  /** 弹窗里那颗「重新自检」：无条件重发，且跳过宿主的缓存。 */
  refresh: () => void
}

/**
 * 自检的取数 + 缓存 + 自动补查。
 *
 * `mobileIdle` 由调用方按 `status.lastMobileAt` 算好（见 `mobileLooksIdle`）：
 * 它从 false 变 true 的那一次才值得在后台补一次 —— 手机刚来过就什么也不做。
 */
export function useSelfCheck(mobileIdle: boolean): SelfCheckView {
  const [data, setData] = useState<SelfCheck | null>(cached)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(async (force: boolean) => {
    if (!force && cached && Date.now() - cachedAt < FRESH_MS) {
      setData(cached)
      return
    }
    setChecking(true)
    try {
      const next = await request(force)
      if (!alive.current) return
      setData(next)
      setError('')
      setMissing(false)
    } catch (err) {
      if (!alive.current) return
      // 老宿主没有这条路由：那是「还没这条接口」，不是「自检挂了」。
      setMissing(err instanceof ApiError && err.status === 404)
      setError(errorText(err))
    } finally {
      if (alive.current) setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!mobileIdle) return
    if (Date.now() - autoAt < AUTO_MIN_INTERVAL_MS) return
    if (cached && Date.now() - cachedAt < FRESH_MS) return
    autoAt = Date.now()
    void run(false)
  }, [mobileIdle, run])

  return {
    data,
    checking,
    error,
    missing,
    ensure: useCallback(() => void run(false), [run]),
    refresh: useCallback(() => void run(true), [run]),
  }
}

/** `verdict` 的严重程度：只有 `ok` 是正常；`unknown` 是「查不到」，也不许当正常。 */
export function verdictTone(verdict: string): Tone {
  if (verdict === 'ok') return 'ok'
  if (verdict === 'unknown') return 'warn'
  return 'error'
}

const VERDICT_KEYS: Record<string, { long: string; short: string }> = {
  ok: { long: 'panel.selfcheck.verdict.ok', short: 'panel.selfcheck.short.ok' },
  'not-listening': {
    long: 'panel.selfcheck.verdict.notListening',
    short: 'panel.selfcheck.short.notListening',
  },
  'firewall-blocked': {
    long: 'panel.selfcheck.verdict.firewallBlocked',
    short: 'panel.selfcheck.short.firewallBlocked',
  },
  unknown: { long: 'panel.selfcheck.verdict.unknown', short: 'panel.selfcheck.short.unknown' },
  network: { long: 'panel.selfcheck.verdict.network', short: 'panel.selfcheck.short.network' },
}

/** 清单下面那句总结（整句）。 */
export function verdictText(verdict: string): string {
  return t(VERDICT_KEYS[verdict]?.long ?? 'panel.selfcheck.verdict.unknown')
}

/** 主页连接卡那一行（短句，一行放得下）。 */
export function verdictBrief(verdict: string): string {
  return t(VERDICT_KEYS[verdict]?.short ?? 'panel.selfcheck.short.unknown')
}

/** 主页连接卡最后那一行的文字与颜色：正常灰、异常红、查不到黄。 */
export function selfCheckRow(view: Pick<SelfCheckView, 'data' | 'checking' | 'missing'>): {
  tone: Tone
  text: string
} {
  if (view.data) return { tone: verdictTone(view.data.verdict), text: verdictBrief(view.data.verdict) }
  if (view.checking) return { tone: 'off', text: t('panel.selfcheck.checking') }
  if (view.missing) return { tone: 'warn', text: t('panel.selfcheck.unknown') }
  return { tone: 'off', text: t('panel.selfcheck.notChecked') }
}

/** 引导页清单里那一行「防火墙放不放行」。 */
export function firewallRow(check: SelfCheck | null): { tone: Tone; text: string; detail?: string } {
  if (!check) return { tone: 'off', text: t('panel.selfcheck.notChecked') }
  const firewall = check.firewall
  const name = fileName(firewall.appPath)
  // 问系统没拿到，或者这台系统上根本没有可查的防火墙：如实说查不到，别写成正常。
  if (!firewall.supported || firewall.enabled === null) {
    return { tone: 'warn', text: t('panel.selfcheck.unknown') }
  }
  // 防火墙开着才谈「放没放行」；关着的时候 `allowsApp` 有没有值都不影响结论。
  if (firewall.enabled === false) {
    return { tone: 'off', text: t('panel.selfcheck.firewallOff'), ...(name ? { detail: name } : {}) }
  }
  if (firewall.allowsApp === false) {
    return { tone: 'error', text: t('panel.selfcheck.blocked'), ...(name ? { detail: name } : {}) }
  }
  if (firewall.allowsApp === true) {
    return { tone: 'ok', text: t('panel.selfcheck.allowed'), ...(name ? { detail: name } : {}) }
  }
  return { tone: 'warn', text: t('panel.selfcheck.unknown') }
}

/** 引导页清单里那一行「手机最近来过没有」。 */
export function mobileRow(
  check: SelfCheck | null,
  lastMobileAt: number | undefined,
): { tone: Tone; text: string; detail?: string } {
  const at = typeof check?.mobile?.lastMobileAt === 'number' ? check.mobile.lastMobileAt : lastMobileAt
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return { tone: 'off', text: t('panel.selfcheck.notChecked') }
  }
  if (at === 0) return { tone: 'warn', text: t('panel.selfcheck.mobileNever') }
  const idle = typeof check?.mobile?.idle === 'boolean' ? check.mobile.idle : mobileLooksIdle(at)
  if (idle) return { tone: 'warn', text: t('panel.selfcheck.mobileIdle'), detail: timeText(at) }
  return { tone: 'ok', text: t('panel.selfcheck.mobileRecent'), detail: timeText(at) }
}

/** 「直连监听」那几种状态：复用已有的状态词，认不出的原样透出。 */
export function listeningText(state: string): string {
  const keys: Record<string, string> = {
    listening: 'panel.lan.listening',
    off: 'panel.status.off',
    error: 'panel.lan.error',
  }
  return keys[state] ? t(keys[state]) : state
}

/**
 * 长路径只取文件名：宿主进程可能是 nvm / Homebrew 那种带版本号的深路径，
 * 整条铺进弹窗会把一行撑成两行。Windows 的反斜杠也认。
 */
export function fileName(path: string): string {
  const text = String(path ?? '').trim()
  if (!text) return ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

// 健康采样在飞互斥，关窗结果作废，并纳入当前自建中转。
/**
 * 「公用中转面板」弹窗：列出当前所有内置公用中转地址，每条一带当前延迟和一条最近十几次
 * 采样的心电图（2026-11-19 用户要求）。
 *
 * 为什么由宿主代测：浏览器直连那些域名会被 CORS 挡住，读到的是浏览器拦截而不是真实耗时；
 * 宿主那条 `/api/relay/probe-relays` 先认 `/healthz` 再认 `service` 字段，超时照实报 null。
 * 这里只管按时取样、把 null 画成断开的折线，不在前端另算一套「可用」判据。
 *
 * 取样节奏：开窗先来一轮，之后每 PROBE_INTERVAL_MS 一轮，关窗即停 —— 不把探测挂在面板
 * 根部常驻，那样用户没在看也在每几秒打一轮外网。每轮结果按 URL 并进这份历史，最多留
 * HISTORY_POINTS 个点，滚动着画。
 */
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useEffect, useRef, useState } from 'react'

import { apiPost, errorText } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { PUBLIC_RELAYS } from '../lib/links.ts'
import { latencyLevel, latencySparklinePath } from '../lib/latency-sparkline.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前已配置的中转地址：命中内置清单时标出「使用中」，自建地址不在这份清单里，自然不出现。 */
  activeUrl: string
}

type ProbeResult = { url: string; ms: number | null; service?: string; version?: string }

/** 取样间隔与窗口大小，与 App「选择线路」的节奏同量级（秒级、十几次采样）。 */
const PROBE_INTERVAL_MS = 5_000
const HISTORY_POINTS = 14
/** 一条心电图的画框尺寸（面板比手机宽，拉长一点看得清起伏）。 */
const SPARK_WIDTH = 132
const SPARK_HEIGHT = 28

function latencyColorClass(level: ReturnType<typeof latencyLevel>): string {
  if (level === 'fast') return 'text-success'
  if (level === 'ok') return 'text-warning'
  if (level === 'slow') return 'text-destructive'
  return 'text-foreground-muted'
}

function strokeColor(level: ReturnType<typeof latencyLevel>): string {
  if (level === 'fast') return '#16a34a'
  if (level === 'ok') return '#d97706'
  if (level === 'slow') return '#dc2626'
  return '#9ca3af'
}

function formatLatency(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

export function PublicRelayPanelDialog({ open, onOpenChange, activeUrl }: Props) {
  // 每条地址各自一条采样序列；key 是 URL，值是被裁到 HISTORY_POINTS 的滚动窗口。
  const [history, setHistory] = useState<Record<string, (number | null)[]>>({})
  const [error, setError] = useState('')
  /** 开窗期间在飞的一轮用 ref 串起来，关窗时把定时器清掉、让在飞的那一轮作废。 */
  const inFlightRef = useRef(false)
  const targets = PUBLIC_RELAYS.map((item) => item.url)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open) {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }
    let alive = true
    setError('')
    // 只测内置公用地址：自建中转是不是活的，归它自己那一栏的「检测」管，混进这张清单
    // 会让「公用中转面板」显示一条并不公用的地址。
    const urls = PUBLIC_RELAYS.map((item) => item.url)
    // 开窗先画一条空基线（每个地址一个 null 占位），探测回来再填。
    setHistory(Object.fromEntries(urls.map((url) => [url, [null]])))

    async function probe() {
      if (!alive || inFlightRef.current) return
      inFlightRef.current = true
      try {
        // 短超时：一次挂住的探测不能让面板静默冻结。超时就当这一拍采样为 null（下面的 catch
        // 会补一个 null 点并清掉 inFlight，下一拍照常继续）。
        const res = await apiPost<{ ok: boolean; results: ProbeResult[] }>('/api/relay/probe-relays', { urls }, { timeoutMs: 8_000 })
        if (!alive) return
        const byUrl = new Map((res.results || []).map((item) => [item.url, item.ms]))
        setHistory((previous) => {
          const next: Record<string, (number | null)[]> = {}
          for (const url of urls) {
            const series = previous[url] || []
            next[url] = [...series, byUrl.get(url) ?? null].slice(-HISTORY_POINTS)
          }
          return next
        })
        setError('')
      } catch (err) {
        if (alive) {
          setHistory((previous) => Object.fromEntries(urls.map((url) => [url, [...(previous[url] || []), null].slice(-HISTORY_POINTS)])))
          setError(errorText(err))
        }
      } finally {
        inFlightRef.current = false
      }
    }

    void probe()
    timerRef.current = setInterval(() => { void probe() }, PROBE_INTERVAL_MS)
    return () => {
      alive = false
      // 在飞标记留给那一发的 finally 清：探测带了超时，挂住的请求最终会落地并复位，
      // 不会把下一轮永久挡住；这里若提前复位，会让上一发还没回来就并发再发一次，破坏「同一时刻只一个在飞」。
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('panel.relay.panelTitle')}</DialogTitle>
        </DialogHeader>
        {/* 高度封顶、列表内滚动：公用中转会越来越多，别让条目把弹窗撑到屏幕外。 */}
        <DialogBody className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
          <p className="mb-2 text-xs text-foreground-muted">{t('panel.relay.panelHint')}</p>
          {targets.map((url) => {
            const item = { url }
            const series = history[item.url] || [null]
            const latest = series[series.length - 1] ?? null
            const level = latencyLevel(latest)
            const path = latencySparklinePath(series, SPARK_WIDTH, SPARK_HEIGHT)
            const inUse = item.url === activeUrl
            return (
              <div
                key={item.url}
                className="flex items-center justify-between gap-3 rounded-md border border-border-muted px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-sm">{item.url}</span>
                  {inUse ? <span className="text-xs text-primary">{t('panel.relay.selected')}</span> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {path ? (
                    <svg width={SPARK_WIDTH} height={SPARK_HEIGHT} aria-hidden="true">
                      <path d={path} stroke={strokeColor(level)} strokeWidth={1.5} fill="none" />
                    </svg>
                  ) : null}
                  <span className={`w-16 text-right text-sm tabular-nums ${latencyColorClass(level)}`}>
                    {formatLatency(latest)}
                  </span>
                </div>
              </div>
            )
          })}
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('panel.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

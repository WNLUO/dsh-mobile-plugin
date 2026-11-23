/**
 * 网络面板：顶卡右列那张卡，照用户给的样式——四个指标 + 带网格的双曲线。
 *
 * 数字全部来自当前中转的真实延迟采样（宿主代测，浏览器直连会被 CORS 挡）：橙线是每次
 * 实测，绿线是最近三次的滑动平均。纵轴钉死 0..500ms、超过贴顶，不由这一窗样本自己撑
 * 刻度 —— 否则一次尖峰会把平时几十毫秒的点压成一条直线。没有流量接口就不摆流量数字。
 */
import { Card } from '@appica/ui-react/card'
import { useEffect, useRef, useState } from 'react'

import { apiPost, type StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

type Sample = { ms: number | null; at: number }
type ProbeResult = { url: string; ms: number | null }

const PROBE_INTERVAL_MS = 5_000
const HISTORY_POINTS = 14
const GRID_MAX_MS = 500
const GRID_STEPS = 5
const WIDTH = 300
const HEIGHT = 200

function formatMs(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

function toY(ms: number): number {
  const value = Math.min(GRID_MAX_MS, Math.max(0, ms))
  return HEIGHT - (value / GRID_MAX_MS) * HEIGHT
}

/** 线性刻度的折线；null 断开不连过去，area 模式下从首点落到底边闭合。 */
function seriesPath(values: readonly (number | null)[], area: boolean): string {
  if (!values.some((value) => typeof value === 'number' && Number.isFinite(value))) return ''
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0
  const parts: string[] = []
  let firstX = 0
  let lastX = 0
  let drawing = false
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      drawing = false
      return
    }
    const x = values.length > 1 ? index * step : WIDTH / 2
    const y = toY(value)
    if (drawing) parts.push(`L${x.toFixed(1)} ${y.toFixed(1)}`)
    else {
      firstX = x
      parts.push(`M${x.toFixed(1)} ${y.toFixed(1)}`)
    }
    lastX = x
    drawing = true
  })
  if (area && parts.length > 0) parts.push(`L${lastX.toFixed(1)} ${HEIGHT} L${firstX.toFixed(1)} ${HEIGHT} Z`)
  return parts.join(' ')
}

export function NetworkPanel({ status }: { status: StatusView }) {
  const url = status.relayUrl || ''
  const [history, setHistory] = useState<Sample[]>([])
  /** 同一时刻只留一轮在飞；卸载时让在飞的那一发自己落地，不复位这个标记。 */
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!url) {
      setHistory([])
      return undefined
    }
    let alive = true
    setHistory([{ ms: null, at: Date.now() }])

    async function probe() {
      if (!alive || inFlightRef.current) return
      inFlightRef.current = true
      try {
        const res = await apiPost<{ ok: boolean; results: ProbeResult[] }>(
          '/api/relay/probe-relays',
          { urls: [url] },
          { timeoutMs: 8_000 },
        )
        if (!alive) return
        const ms = res.results?.find((item) => item.url === url)?.ms ?? null
        setHistory((previous) => [...previous, { ms, at: Date.now() }].slice(-HISTORY_POINTS))
      } catch {
        if (alive) setHistory((previous) => [...previous, { ms: null, at: Date.now() }].slice(-HISTORY_POINTS))
      } finally {
        inFlightRef.current = false
      }
    }

    void probe()
    const timer = window.setInterval(() => { void probe() }, PROBE_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [url])

  const valid = history
    .map((sample) => sample.ms)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
  const current = history.length > 0 ? (history[history.length - 1].ms ?? null) : null
  const average = valid.length > 0 ? valid.reduce((sum, ms) => sum + ms, 0) / valid.length : null
  const minimum = valid.length > 0 ? Math.min(...valid) : null
  const maximum = valid.length > 0 ? Math.max(...valid) : null
  const measured = history.map((sample) => sample.ms)
  const smoothed = history.map((_, index) => {
    const window = history.slice(Math.max(0, index - 2), index + 1)
      .map((sample) => sample.ms)
      .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
    return window.length > 0 ? window.reduce((sum, ms) => sum + ms, 0) / window.length : null
  })

  const times = history.length > 0
    ? [history[0].at, history[Math.floor((history.length - 1) / 2)].at, history[history.length - 1].at]
    : []

  return (
    <Card frame="solid" className="h-full min-h-0 p-3">
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="grid shrink-0 grid-cols-4 gap-1.5">
          {[
            { key: 'panel.network.current', value: current, dot: 'bg-success' },
            { key: 'panel.network.average', value: average, dot: 'bg-warning' },
            { key: 'panel.network.min', value: minimum, dot: 'bg-foreground-muted' },
            { key: 'panel.network.max', value: maximum, dot: 'bg-destructive' },
          ].map((item) => (
            <div key={item.key} className="rounded-md border border-border-muted px-2 py-1.5 text-[10px] leading-tight">
              <span className={`mr-1 inline-block size-1.5 shrink-0 rounded-full ${item.dot}`} />
              <span className="text-foreground-muted">{t(item.key)}</span>{' '}
              <span className="tabular-nums">{formatMs(item.value)}</span>
            </div>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 gap-1.5">
          <div className="flex shrink-0 flex-col justify-between py-0.5 text-[9px] tabular-nums text-foreground-muted">
            {Array.from({ length: GRID_STEPS + 1 }, (_, index) => (GRID_STEPS - index) * (GRID_MAX_MS / GRID_STEPS)).map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
          <svg className="h-full min-h-0 w-full" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="network-measured" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="network-smoothed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
              </linearGradient>
            </defs>
            {Array.from({ length: GRID_STEPS + 1 }, (_, index) => index * (HEIGHT / GRID_STEPS)).map((y) => (
              <line key={y} x1="0" y1={y} x2={WIDTH} y2={y} stroke="#6b7280" strokeOpacity="0.45" strokeDasharray="4 4" />
            ))}
            <path d={seriesPath(smoothed, true)} fill="url(#network-smoothed)" />
            <path d={seriesPath(measured, true)} fill="url(#network-measured)" />
            <path d={seriesPath(smoothed, false)} stroke="#22c55e" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" />
            <path d={seriesPath(measured, false)} stroke="#f59e0b" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>

        <div className="flex shrink-0 justify-between pl-6 text-[9px] tabular-nums text-foreground-muted">
          {times.map((at, index) => <span key={`${at}-${index}`}>{clock(at)}</span>)}
        </div>
      </div>
    </Card>
  )
}

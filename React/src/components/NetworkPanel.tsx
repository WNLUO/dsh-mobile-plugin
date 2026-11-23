/**
 * 网络面板：放在顶卡右列的容器，里面每块各画各的——先看延迟曲线，再看流量占位。
 *
 * 延迟由宿主代测（浏览器直连外网会被 CORS 挡，读到的是拦截不是真实耗时），这里只按时
 * 取样、把 null 画成断开的线，不在前端另算一套「通没通」。取样节奏与公用中转面板同量级，
 * 但只测当前在用的那一条中转：这张卡回答的是「我这条路现在快不快」，不是「哪条公用最快」。
 *
 * 流量这块目前没有真实接口：宿主所有路由里只有收件文件的磁盘占用，没有网络字节数。
 * 明确写「暂无统计」而不是摆一个看起来像真的数字。
 */
import { Card } from '@appica/ui-react/card'
import { useEffect, useRef, useState } from 'react'

import { apiPost, errorText, type StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import {
  latencyColorClass,
  latencyLevel,
  latencySparklinePath,
  latencyStrokeColor,
} from '../lib/latency-sparkline.ts'

type ProbeResult = { url: string; ms: number | null }

const PROBE_INTERVAL_MS = 5_000
const HISTORY_POINTS = 14
const SPARK_WIDTH = 220
const SPARK_HEIGHT = 40

function formatLatency(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

export function NetworkPanel({ status }: { status: StatusView }) {
  const url = status.relayUrl || ''
  const [history, setHistory] = useState<(number | null)[]>([])
  const [error, setError] = useState('')
  /** 同一时刻只留一轮在飞；卸载时让在飞的那一发自己落地，不复位这个标记。 */
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!url) {
      setHistory([])
      return undefined
    }
    let alive = true
    setHistory([null])
    setError('')

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
        setHistory((previous) => [...previous, ms].slice(-HISTORY_POINTS))
        setError('')
      } catch (err) {
        if (alive) {
          setHistory((previous) => [...previous, null].slice(-HISTORY_POINTS))
          setError(errorText(err))
        }
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

  const latest = history.length > 0 ? (history[history.length - 1] ?? null) : null
  const level = latencyLevel(latest)
  const path = latencySparklinePath(history, SPARK_WIDTH, SPARK_HEIGHT)

  return (
    <Card frame="solid">
      <div className="flex flex-col gap-3 p-4">
        <h3 className="text-sm font-medium">{t('panel.network.title')}</h3>

        <section className="flex flex-col gap-2 rounded-md border border-border-muted p-3">
          <div className="text-xs text-foreground-muted">{t('panel.network.latencyTitle')}</div>
          {url ? (
            <>
              <svg width={SPARK_WIDTH} height={SPARK_HEIGHT} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} aria-hidden="true">
                {path ? <path d={path} stroke={latencyStrokeColor(level)} strokeWidth={1.5} fill="none" /> : null}
              </svg>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                <span className="text-foreground-muted">{t('panel.network.latencyHint')}</span>
                <span className={`tabular-nums ${latencyColorClass(level)}`}>{formatLatency(latest)}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-foreground-muted">{t('panel.network.noRelay')}</p>
          )}
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
        </section>

        <section className="flex flex-col gap-1 rounded-md border border-border-muted p-3">
          <div className="text-xs text-foreground-muted">{t('panel.network.trafficTitle')}</div>
          <p className="text-xs text-foreground-subtle">{t('panel.network.trafficEmpty')}</p>
        </section>
      </div>
    </Card>
  )
}

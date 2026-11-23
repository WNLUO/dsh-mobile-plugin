/**
 * 网络面板：顶卡右列那张卡，只画当前中转的延迟折线，不摆文字。
 *
 * 容器高度交给外层 grid 拉齐左列（Card 用 h-full），里面就一条 svg，没有内衬容器。
 * 延迟由宿主代测（浏览器直连外网会被 CORS 挡，读到的是拦截不是真实耗时），这里只按时
 * 取样、把 null 画成断开的线，不在前端另算一套「通没通」。只测当前在用的那一条中转。
 */
import { Card } from '@appica/ui-react/card'
import { useEffect, useRef, useState } from 'react'

import { apiPost, type StatusView } from '../lib/api.ts'
import { latencyLevel, latencySparklinePath, latencyStrokeColor } from '../lib/latency-sparkline.ts'

type ProbeResult = { url: string; ms: number | null }

const PROBE_INTERVAL_MS = 5_000
const HISTORY_POINTS = 14
const SPARK_WIDTH = 220
const SPARK_HEIGHT = 40

export function NetworkPanel({ status }: { status: StatusView }) {
  const url = status.relayUrl || ''
  const [history, setHistory] = useState<(number | null)[]>([])
  /** 同一时刻只留一轮在飞；卸载时让在飞的那一发自己落地，不复位这个标记。 */
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!url) {
      setHistory([])
      return undefined
    }
    let alive = true
    setHistory([null])

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
      } catch {
        if (alive) setHistory((previous) => [...previous, null].slice(-HISTORY_POINTS))
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
  const path = latencySparklinePath(history, SPARK_WIDTH, SPARK_HEIGHT)

  return (
    <Card frame="solid" className="h-full min-h-0 p-4">
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {path ? (
          <path
            d={path}
            stroke={latencyStrokeColor(latencyLevel(latest))}
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </Card>
  )
}

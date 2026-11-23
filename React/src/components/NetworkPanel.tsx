/**
 * 网络面板：顶卡右列那张卡，手机↔本机这条连接的实时流速。
 *
 * 数据来自宿主 `/api/relay/traffic`（累计字节 + 最近每秒的快照序列，见
 * `lib/relay/traffic-stats.cjs`）。口径从本机看：上行 = 本机发出去（总发送），
 * 下行 = 本机收进来（总接收）。
 *
 * 画法是一条「流」：横轴按真实时间铺开，每帧把「现在」当右边界、把最近一分钟的历史往左推，
 * 于是点是一帧一帧往左流动的，而不是每一秒硬跳一下。最新一拍还没到时，沿上一档速率把线
 * 平推到现在（缓冲/外推），下一拍到了再接到真实值上——这就是常见的实时曲线流动方式。
 *
 * 纵轴量程单独维护：只有峰值明显变大才抬高、明显变小才收窄（迟滞），两次变化之间是缓动的，
 * 所以刻度不会随每秒的数据抖动。
 */
// 2026-11-23 用户要求：实时上下行流量、图标标签、平滑流动曲线（按时间连续滚动）、量程迟滞稳定、高度对齐二维码区。
import { Card } from '@appica/ui-react/card'
import { useEffect, useRef } from 'react'

import { getTraffic, type StatusView, type TrafficSample } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

type Point = { x: number; y: number }
type Render = {
  upSeg: string
  downSeg: string
  upArea: string
  downArea: string
  max: number
  currentUp: number
  currentDown: number
  sentTotal: number
  receivedTotal: number
  left: number
  mid: number
  right: number
  hasData: boolean
}

const GRID_STEPS = 5
const WIDTH = 300
const HEIGHT = 200
/** 横轴窗口：最近一分钟。 */
const WINDOW_MS = 60_000
/** 纵轴最小量程：没流量时也留一个 1 KB/s 的底。 */
const MIN_SCALE_BYTES_PER_SEC = 1024
const POLL_INTERVAL_MS = 1000
/** 量程缓动时间常数（秒）：约半秒内从旧量程平滑过渡到新量程。 */
const AXIS_TAU_SECONDS = 0.35
/** 纵向缓动时间常数（秒）：新的一拍约 0.25 秒流到目标值。 */
const VERTICAL_TAU_SECONDS = 0.25
const RENDER_FPS = 30

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

/** 速率带单位：B/s、KB/s、MB/s、GB/s。 */
function formatRate(bytesPerSec: number): string {
  const value = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0
  if (value < 1024) return `${Math.round(value)}B/s`
  if (value < 1024 * 1024) return `${trimFixed(value / 1024, value < 10 * 1024 ? 1 : 0)}KB/s`
  if (value < 1024 * 1024 * 1024) return `${trimFixed(value / 1024 / 1024, 1)}MB/s`
  return `${trimFixed(value / 1024 / 1024 / 1024, 2)}GB/s`
}

/** 累计总量带单位：B、KB、MB、GB。 */
function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value < 1024) return `${Math.round(value)}B`
  if (value < 1024 * 1024) return `${trimFixed(value / 1024, value < 10 * 1024 ? 1 : 0)}KB`
  if (value < 1024 * 1024 * 1024) return `${trimFixed(value / 1024 / 1024, 1)}MB`
  return `${trimFixed(value / 1024 / 1024 / 1024, 2)}GB`
}

/** 纵轴刻度：紧凑写法，不带 `/s`。 */
function formatTick(bytesPerSec: number): string {
  if (!(bytesPerSec > 0)) return '0'
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)}B`
  if (bytesPerSec < 1024 * 1024) return `${trimFixed(bytesPerSec / 1024, bytesPerSec < 10 * 1024 ? 1 : 0)}K`
  if (bytesPerSec < 1024 * 1024 * 1024) return `${trimFixed(bytesPerSec / 1024 / 1024, 1)}M`
  return `${trimFixed(bytesPerSec / 1024 / 1024 / 1024, 1)}G`
}

/** 把量程收成一个好看的 1/2/5 × 10ⁿ。 */
function niceMax(peak: number): number {
  const target = Math.max(peak, MIN_SCALE_BYTES_PER_SEC)
  const exponent = Math.floor(Math.log10(target))
  const base = 10 ** exponent
  const ratio = target / base
  const step = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10
  return step * base
}

function toY(value: number, max: number): number {
  const clamped = Math.min(max, Math.max(0, value))
  return HEIGHT - (clamped / max) * HEIGHT
}

/** 用 Catmull-Rom 转三次贝塞尔，把折线磨成平滑曲线。 */
function smoothPath(points: Point[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  const parts = [`M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`]
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    parts.push(`C${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`)
  }
  return parts.join(' ')
}

function areaOf(points: Point[]): string {
  if (points.length === 0) return ''
  const line = smoothPath(points)
  const first = points[0]
  const last = points[points.length - 1]
  return `${line} L${last.x.toFixed(1)} ${HEIGHT} L${first.x.toFixed(1)} ${HEIGHT} Z`
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

/**
 * 用「现在」当右边界，把最近一分钟的累计快照算成一条会流动的速率曲线。
 *
 * 横轴：相邻两个快照的累计差 / 间隔 = 那一段的速率；按真实时间铺开，时间往前走整条线就
 * 往左平移。末尾沿最后一档速率平推到现在，让线始终贴住右边界。
 *
 * 纵轴：每个点的速率不是一到就定死，而是从上一档的当前值出发，按时间常数缓动到目标值
 * （约 0.25 秒），这样新的一拍是「流上去 / 流下来」，不会原地闪一下。
 */
function stepRender(samples: TrafficSample[], now: number, axisMax: number, anim: Map<number, { up: number; down: number }>, easeK: number): Render {
  const left = now - WINDOW_MS
  const upPoints: Point[] = []
  const downPoints: Point[] = []
  let prevUp = 0
  let prevDown = 0
  let currentUp = 0
  let currentDown = 0
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1]
    const current = samples[i]
    if (current.at < left) continue
    const seconds = (current.at - previous.at) / 1000
    if (!(seconds > 0)) continue
    const sentDelta = current.sentBytes - previous.sentBytes
    const receivedDelta = current.receivedBytes - previous.receivedBytes
    const targetUp = sentDelta >= 0 ? sentDelta / seconds : 0
    const targetDown = receivedDelta >= 0 ? receivedDelta / seconds : 0
    let point = anim.get(current.at)
    if (!point) {
      // 首次载入（缓存空）直接对齐，避免整条线从 0 涨起来；此后的新一拍从上一档的当前值
      // 起步，再缓动到目标值——纵向也是流上去 / 流下来的。
      const first = anim.size === 0
      point = { up: first ? targetUp : prevUp, down: first ? targetDown : prevDown }
      anim.set(current.at, point)
    }
    point.up += (targetUp - point.up) * easeK
    point.down += (targetDown - point.down) * easeK
    if (Math.abs(targetUp - point.up) < Math.max(1, targetUp * 0.001)) point.up = targetUp
    if (Math.abs(targetDown - point.down) < Math.max(1, targetDown * 0.001)) point.down = targetDown
    prevUp = point.up
    prevDown = point.down
    currentUp = point.up
    currentDown = point.down
    const x = Math.min(WIDTH, Math.max(0, ((current.at - left) / WINDOW_MS) * WIDTH))
    upPoints.push({ x, y: toY(point.up, axisMax) })
    downPoints.push({ x, y: toY(point.down, axisMax) })
  }
  if (upPoints.length > 0) {
    upPoints.push({ x: WIDTH, y: toY(currentUp, axisMax) })
    downPoints.push({ x: WIDTH, y: toY(currentDown, axisMax) })
  }
  // 窗口外的旧点从缓存里清掉，别无限涨。
  for (const at of anim.keys()) if (at < left - 5000) anim.delete(at)
  const lastSample = samples[samples.length - 1]
  return {
    upSeg: smoothPath(upPoints),
    downSeg: smoothPath(downPoints),
    upArea: areaOf(upPoints),
    downArea: areaOf(downPoints),
    max: axisMax,
    currentUp,
    currentDown,
    sentTotal: lastSample?.sentBytes ?? 0,
    receivedTotal: lastSample?.receivedBytes ?? 0,
    left,
    mid: left + WINDOW_MS / 2,
    right: now,
    hasData: upPoints.length > 1,
  }
}

const ICON_CLASS = 'size-3.5 shrink-0'
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** 上行：向上箭头。 */
function IconUp() {
  return <svg {...ICON_PROPS} className={ICON_CLASS}><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
}
/** 下行：向下箭头。 */
function IconDown() {
  return <svg {...ICON_PROPS} className={ICON_CLASS}><path d="M12 5v14" /><path d="M5 12l7 7 7-7" /></svg>
}
/** 总发送：箭头指向一条基线，表示「累计发出」。 */
function IconSent() {
  return <svg {...ICON_PROPS} className={ICON_CLASS}><path d="M12 15V4" /><path d="M6 9l6-6 6 6" /><path d="M4 20h16" /></svg>
}
/** 总接收：箭头落向一条基线，表示「累计收到」。 */
function IconReceived() {
  return <svg {...ICON_PROPS} className={ICON_CLASS}><path d="M12 4v11" /><path d="M6 10l6 6 6-6" /><path d="M4 20h16" /></svg>
}

export function NetworkPanel({ status }: { status: StatusView }) {
  const seed = status.traffic
  const samplesRef = useRef<TrafficSample[]>(seed ? [{ at: Date.now(), sentBytes: seed.sentBytes, receivedBytes: seed.receivedBytes }] : [])
  const axisTargetRef = useRef(0)
  const axisDrawRef = useRef(MIN_SCALE_BYTES_PER_SEC)
  const axisInitRef = useRef(false)
  const animRef = useRef<Map<number, { up: number; down: number }>>(new Map())

  // 直接改 DOM 的句柄：曲线和数字每帧都变，走命令式更新，别让 React 每帧重渲染整棵子树
  // （那正是拖动窗口时卡顿 / 闪烁的来源）。
  const upSegRef = useRef<SVGPathElement | null>(null)
  const downSegRef = useRef<SVGPathElement | null>(null)
  const upAreaRef = useRef<SVGPathElement | null>(null)
  const downAreaRef = useRef<SVGPathElement | null>(null)
  const valueRefs = useRef<Array<HTMLSpanElement | null>>([])
  const tickRefs = useRef<Array<HTMLSpanElement | null>>([])
  const timeRefs = useRef<Array<HTMLSpanElement | null>>([])

  const paint = (view: Render) => {
    if (upSegRef.current && upSegRef.current.getAttribute('d') !== view.upSeg) upSegRef.current.setAttribute('d', view.upSeg)
    if (downSegRef.current && downSegRef.current.getAttribute('d') !== view.downSeg) downSegRef.current.setAttribute('d', view.downSeg)
    if (upAreaRef.current && upAreaRef.current.getAttribute('d') !== view.upArea) upAreaRef.current.setAttribute('d', view.upArea)
    if (downAreaRef.current && downAreaRef.current.getAttribute('d') !== view.downArea) downAreaRef.current.setAttribute('d', view.downArea)

    const values = [formatRate(view.currentUp), formatRate(view.currentDown), formatBytes(view.sentTotal), formatBytes(view.receivedTotal)]
    valueRefs.current.forEach((el, index) => {
      if (el && el.textContent !== values[index]) el.textContent = values[index]
    })

    const max = view.max > 0 ? view.max : MIN_SCALE_BYTES_PER_SEC
    tickRefs.current.forEach((el, index) => {
      const text = formatTick((GRID_STEPS - index) * (max / GRID_STEPS))
      if (el && el.textContent !== text) el.textContent = text
    })

    const times = view.hasData ? [view.left, view.mid, view.right] : []
    timeRefs.current.forEach((el, index) => {
      const text = times[index] === undefined ? '' : clock(times[index])
      if (el && el.textContent !== text) el.textContent = text
    })
  }

  // 每秒拉一次序列；失败就保留上一份。数据只进 ref，不 setState（避免每秒重渲染）。
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const payload = await getTraffic()
        if (alive && Array.isArray(payload.samples) && payload.samples.length > 0) samplesRef.current = payload.samples
      } catch { /* 保留上一份 */ }
    }
    void pull()
    const timer = window.setInterval(() => { void pull() }, POLL_INTERVAL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  // 常驻帧循环：按真实时间把曲线往左流、把量程和纵向值缓动到目标，然后命令式写回 DOM。
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastPaint = 0
    const loop = (ts: number) => {
      const dt = Math.max(0, (ts - last) / 1000)
      last = ts
      const samples = samplesRef.current
      const now = Date.now()

      // 量程：按窗口峰值定目标，迟滞（明显变大才抬、明显变小才收），再缓动追上。
      const windowStart = now - WINDOW_MS
      let peak = 0
      for (let i = 1; i < samples.length; i += 1) {
        const previous = samples[i - 1]
        const current = samples[i]
        if (current.at < windowStart) continue
        const seconds = (current.at - previous.at) / 1000
        if (!(seconds > 0)) continue
        const upRate = (current.sentBytes - previous.sentBytes) / seconds
        const downRate = (current.receivedBytes - previous.receivedBytes) / seconds
        if (upRate > peak) peak = upRate
        if (downRate > peak) peak = downRate
      }
      if (!axisInitRef.current) {
        if (samples.length > 0) {
          axisTargetRef.current = niceMax(peak)
          axisDrawRef.current = axisTargetRef.current
          axisInitRef.current = true
        }
      } else if (peak > axisTargetRef.current * 1.02) {
        axisTargetRef.current = niceMax(peak)
      } else if (peak < axisTargetRef.current * 0.5) {
        axisTargetRef.current = niceMax(peak)
      }
      const axisEase = 1 - Math.exp(-dt / AXIS_TAU_SECONDS)
      axisDrawRef.current += (axisTargetRef.current - axisDrawRef.current) * axisEase

      if (ts - lastPaint >= 1000 / RENDER_FPS) {
        const frameSeconds = (ts - lastPaint) / 1000
        lastPaint = ts
        const verticalEase = 1 - Math.exp(-frameSeconds / VERTICAL_TAU_SECONDS)
        paint(stepRender(samples, now, axisDrawRef.current || MIN_SCALE_BYTES_PER_SEC, animRef.current, verticalEase))
      }
      raf = window.requestAnimationFrame(loop)
    }
    raf = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  const items = [
    { key: 'panel.network.up', icon: <IconUp />, tone: 'text-warning' },
    { key: 'panel.network.down', icon: <IconDown />, tone: 'text-success' },
    { key: 'panel.network.totalSent', icon: <IconSent />, tone: 'text-foreground-muted' },
    { key: 'panel.network.totalReceived', icon: <IconReceived />, tone: 'text-foreground-muted' },
  ]

  return (
    <Card frame={false} inset={false} className="h-full min-h-0 px-1" contentProps={{ className: 'border-0' }}>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="grid shrink-0 grid-cols-4 gap-1">
          {items.map((item, index) => (
            <div
              key={item.key}
              title={t(item.key)}
              className="flex items-center justify-center gap-1 rounded-md border border-border-muted px-1 py-1.5 text-[10px] leading-tight"
            >
              <span className={item.tone}>{item.icon}</span>
              <span className="tabular-nums" ref={(el) => { valueRefs.current[index] = el }} />
              <span className="sr-only">{t(item.key)}</span>
            </div>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 gap-1.5">
          <div className="flex shrink-0 flex-col justify-between py-0.5 text-[9px] tabular-nums text-foreground-muted">
            {Array.from({ length: GRID_STEPS + 1 }, (_, index) => (
              <span key={index} ref={(el) => { tickRefs.current[index] = el }} />
            ))}
          </div>
          <svg className="h-full min-h-0 w-full" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="network-up" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="network-down" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
              </linearGradient>
            </defs>
            {Array.from({ length: GRID_STEPS + 1 }, (_, index) => index * (HEIGHT / GRID_STEPS)).map((y) => (
              <line key={y} x1="0" y1={y} x2={WIDTH} y2={y} stroke="#6b7280" strokeOpacity="0.45" strokeDasharray="4 4" />
            ))}
            <path ref={downAreaRef} fill="url(#network-down)" />
            <path ref={upAreaRef} fill="url(#network-up)" />
            <path ref={downSegRef} stroke="#22c55e" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" />
            <path ref={upSegRef} stroke="#f59e0b" strokeWidth={2} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>

        <div className="flex shrink-0 justify-between pl-6 text-[9px] tabular-nums text-foreground-muted">
          {[0, 1, 2].map((index) => (
            <span key={index} ref={(el) => { timeRefs.current[index] = el }} />
          ))}
        </div>
      </div>
    </Card>
  )
}

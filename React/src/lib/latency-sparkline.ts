/**
 * 公用中转测速曲线的刻度与路径（纯函数，无 React / DOM）。
 *
 * 照 App「选择线路」那一行的同一把尺子搬过来：刻度钉死，不由这一轮的样本撑。
 * 一次 5000ms 的尖峰不许把旁边 10ms 的点压成一条直线；100ms 以内占七成高度，
 * 100–600ms 折进剩下三成，600ms 以上贴底。没测出来的那一轮留断开，不连线过去 ——
 * 把一次失败画成「突然变快」是这张图最不该撒的谎。
 *
 * 与 App 那份（services/viewmodels/latency-sparkline.ts）各有一份是刻意的：这是两个进程
 * （RN 设备 / 面板网页），面板这边只引纯函数、不碰 App 的打包，免得为了一段几十行的尺子
 * 把整包依赖拖进来。改刻度时两边一起改。
 */

/** 刻度拐点与封顶：拐点以下放大，拐点以上压缩，封顶以上一律贴底。 */
export const SPARK_FAST_MS = 100
export const SPARK_CEILING_MS = 600
const FAST_SHARE = 0.7
const Y_PADDING = 2

/** 毫秒 → 0..1 的纵向比例（0 在顶、1 在底）。超出封顶的一律回 1。 */
export function latencyRatio(valueMs: number): number {
  const ms = Number.isFinite(valueMs) && valueMs > 0 ? valueMs : 0
  if (ms >= SPARK_CEILING_MS) return 1
  if (ms <= SPARK_FAST_MS) return (ms / SPARK_FAST_MS) * FAST_SHARE
  return FAST_SHARE + ((ms - SPARK_FAST_MS) / (SPARK_CEILING_MS - SPARK_FAST_MS)) * (1 - FAST_SHARE)
}

/** 一串采样点折成 SVG path 的 d；null / 非有限值是断开，不连过去。 */
export function latencySparklinePath(
  points: readonly (number | null)[],
  width: number,
  height: number,
): string {
  const values = points.map((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null,
  )
  if (!values.some((value) => value !== null)) return ''
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  const drawHeight = Math.max(1, height - Y_PADDING * 2)
  const parts: string[] = []
  let drawing = false
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false
      return
    }
    const x = values.length > 1 ? index * stepX : width / 2
    const y = Y_PADDING + latencyRatio(value) * drawHeight
    parts.push(`${drawing ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    drawing = true
  })
  return parts.join(' ')
}

/** 快 / 一般 / 慢三档的色档，与 App 同一口径（<=100 快、<=600 一般、其余慢）。 */
export function latencyLevel(valueMs: number | null): 'fast' | 'ok' | 'slow' | 'none' {
  if (typeof valueMs !== 'number' || !Number.isFinite(valueMs)) return 'none'
  if (valueMs <= SPARK_FAST_MS) return 'fast'
  if (valueMs <= SPARK_CEILING_MS) return 'ok'
  return 'slow'
}

/** 档位 → 文字色（面板两处画延迟的地方共用这一份）。 */
export function latencyColorClass(level: ReturnType<typeof latencyLevel>): string {
  if (level === 'fast') return 'text-success'
  if (level === 'ok') return 'text-warning'
  if (level === 'slow') return 'text-destructive'
  return 'text-foreground-muted'
}

/** 档位 → 折线描边色。 */
export function latencyStrokeColor(level: ReturnType<typeof latencyLevel>): string {
  if (level === 'fast') return '#16a34a'
  if (level === 'ok') return '#d97706'
  if (level === 'slow') return '#dc2626'
  return '#9ca3af'
}

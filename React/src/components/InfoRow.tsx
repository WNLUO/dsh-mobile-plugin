import type { ReactNode } from 'react'

import { cn, toneDot, toneText, type Tone } from '../lib/format.ts'

/** 一枚小圆点，颜色说明这一行此刻好不好。 */
export function Dot({ tone }: { tone: Tone }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', toneDot[tone])} aria-hidden />
}

type InfoRowProps = {
  label: string
  /** 行首那枚点；不传就不画。 */
  tone?: Tone
  mono?: boolean
  children: ReactNode
}

/**
 * 只读信息行：左边标签、右边值。
 *
 * 用 `<dl>` 的语义，但每一行自己成对，方便按接口字段拼装——
 * 原来的设置页签也是这么排的，所以字段顺序照抄，别按自己的喜好重排。
 */
export function InfoRow({ label, tone, mono, children }: InfoRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2 last:border-b-0">
      <dt className="shrink-0 text-sm text-foreground-muted">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-sm break-all',
          mono ? 'font-mono text-xs text-foreground-strong' : 'text-foreground',
          tone && toneText[tone],
        )}
      >
        {children}
      </dd>
    </div>
  )
}

export function InfoList({ children }: { children: ReactNode }) {
  return <dl className="mt-1">{children}</dl>
}

/** 值 + 一枚状态点，用于「隧道 已连接」这类行。 */
export function ToneValue({ tone, text, detail }: { tone: Tone; text: string; detail?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
      <Dot tone={tone} />
      <span>{text}</span>
      {detail ? <span className="text-xs text-foreground-muted">{detail}</span> : null}
    </span>
  )
}

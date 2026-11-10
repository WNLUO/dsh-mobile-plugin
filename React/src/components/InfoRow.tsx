/**
 * 只读信息行：左边标签、右边值。`hint` 给了就在标签右边挂一颗问号，说明收进悬浮提示。
 */
import { Tooltip, TooltipContent, TooltipTrigger } from '@appica/ui-react/tooltip'
import type { ReactNode } from 'react'

import { cn, toneDot, toneText, type Tone } from '../lib/format.ts'
import { QuestionMark } from './QuestionMark.tsx'

/** 一枚小圆点，颜色说明这一行此刻好不好。 */
export function Dot({ tone }: { tone: Tone }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', toneDot[tone])} aria-hidden />
}

type InfoRowProps = {
  label: string
  /**
   * 这一行到底在说什么。给了就不在行里摊开一句话，改成标签右边一颗问号：
   * 鼠标悬浮或键盘聚焦时出提示，说明长的行（比如权限档位、自动审阅）不再把卡片撑高。
   */
  hint?: string
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
 *
 * **标签可以收缩、可以折行**：原先写的是 `shrink-0`，遇到德语 / 法语 / 葡语那种长标签
 * （"Berechtigungsstufe"、"Niveau de permissions"）时它会一点都不让，把右边的值挤到
 * 卡片外面被裁掉 —— 1024 两栏时那一栏只有 210px，现场是法语「权限档位」只露出「Com」。
 * 现在标签按比例分宽度、放不下就折行，值那边仍是 `break-all` 兜底，两边都留在卡里。
 */
export function InfoRow({ label, hint, tone, mono, children }: InfoRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-muted py-2 last:border-b-0">
      <dt className="min-w-0 flex-1 text-sm text-foreground-muted">
        {hint ? (
          <span className="inline-flex items-center gap-1">
            {label}
            {/* 说明挂在标签旁边，不摊在行里：长的说明会把卡片撑高、把下面的行顶下去。
                按钮本身是文字色的问号，悬浮与键盘聚焦都出提示，读屏读到的是 `title`。 */}
            <Tooltip>
              <TooltipTrigger
                delay={250}
                render={
                  <button
                    type="button"
                    aria-label={hint}
                    title={hint}
                    className="shrink-0 cursor-pointer text-foreground-muted transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none motion-reduce:transition-none"
                  >
                    <QuestionMark />
                  </button>
                }
              />
              <TooltipContent className="max-w-72">
                <p>{hint}</p>
              </TooltipContent>
            </Tooltip>
          </span>
        ) : (
          label
        )}
      </dt>
      <dd
        className={cn(
          'min-w-0 shrink-0 text-right text-sm break-all',
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

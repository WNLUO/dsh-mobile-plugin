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
  /**
   * 紧跟在标签右边的一枚自定义小控件（比如一颗点开弹窗的说明图标）。`hint` 走悬浮提示，
   * 这个走调用方自己给的交互；两者可以同时给，会按「标签 · 说明图标 · 问号」的顺序排。
   */
  labelExtra?: ReactNode
  /** 行首那枚点；不传就不画。 */
  tone?: Tone
  mono?: boolean
  /** 一行不折：标签和值都不换行（放横向滚动的窄栏里用）。 */
  nowrap?: boolean
  children: ReactNode
}

/**
 * 只读信息行：左边标签、右边值。
 *
 * 用 `<dl>` 的语义，但每一行自己成对，方便按接口字段拼装——
 * 原来的设置页签也是这么排的，所以字段顺序照抄，别按自己的喜好重排。
 *
 * **两侧都要能收缩，但不能让任一侧归零**：标签原先写 `shrink-0`，长德语标签会把右边的值
 * 挤出卡片；后来改成 `min-w-0` 又反过来——宿主报一长串错误时值不缩，标签被挤成竖排单字。
 * 现在标签给最小宽度、值限最大占比并允许折行，两边都留得住。长错误最多两行（见 ToneValue），
 * 全文放 title 里，行高不会被任意长度的动态文案撑爆。
 */
export function InfoRow({ label, hint, labelExtra, tone, mono, nowrap, children }: InfoRowProps) {
  return (
    <div className={cn('flex justify-between gap-4 border-b border-border-muted py-2 last:border-b-0', nowrap ? 'items-center whitespace-nowrap' : 'items-baseline')}>
      <dt className={nowrap ? 'shrink-0 text-xs text-foreground-muted' : 'min-w-[5.5rem] flex-1 text-sm text-foreground-muted'}>
        {hint || labelExtra ? (
          <span className="inline-flex items-center gap-1">
            {label}
            {labelExtra}
            {hint ? (
              /* 说明挂在标签旁边，不摊在行里：长的说明会把卡片撑高、把下面的行顶下去。
                 按钮本身是文字色的问号，悬浮与键盘聚焦都出提示，读屏读到的是 `title`。 */
              <Tooltip>
                <TooltipTrigger
                  delay={250}
                  render={
                    // 悬停提示由 `Tooltip` 负责，别再同时挂原生 `title`（会出现两个提示）。
                    // 14px 图标本体太窄，用内边距撑出可点热区，再用负外边距抵消占位、不动版式。
                    <button
                      type="button"
                      aria-label={hint}
                      className="-m-1 inline-flex shrink-0 cursor-pointer items-center justify-center p-1 text-foreground-muted transition-colors duration-200 hover:text-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      <QuestionMark />
                    </button>
                  }
                />
                <TooltipContent className="max-w-72">
                  <p>{hint}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        ) : (
          label
        )}
      </dt>
      <dd
        className={cn(
          'text-right text-sm',
          nowrap ? 'shrink-0 whitespace-nowrap text-xs' : 'min-w-0 max-w-[62%] break-words',
          mono ? 'font-mono text-xs text-foreground-strong' : 'text-foreground',
          tone && toneText[tone],
        )}
      >
        {children}
      </dd>
    </div>
  )
}

/** 整卡两列对齐用：信息行统一最小高度，左右两列的行才能落在同一条水平线上。 */
export const EVEN_ROWS = '[&>div]:min-h-9'

/**
 * 同一张卡里左右两列**逐行对齐**用（2026-11-20 用户指出顶卡右列行高不齐）。
 *
 * `EVEN_ROWS` 只给 36px 下限，行里塞了按钮的那几行会被内容撑到 44-49px，开关行却停在
 * 36-40px —— 一列里高低不一，两列之间越往下错得越多。这里把内边距让给行高自己分配：
 * 行统一 48px 且垂直居中，内容再多也只长它自己那一行（多行文案不会因此被裁）。
 */
export const ALIGNED_ROWS = '[&>div]:min-h-12 [&>div]:py-0 [&>div]:items-center'

export function InfoList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('mt-1', className)}>{children}</dl>
}

/** 值 + 一枚状态点，用于「隧道 已连接」这类行。 */
export function ToneValue({ tone, text, detail }: { tone: Tone; text: string; detail?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
      <Dot tone={tone} />
      <span>{text}</span>
      {detail ? (
        <span className="line-clamp-2 text-xs text-foreground-muted" title={detail}>
          {detail}
        </span>
      ) : null}
    </span>
  )
}

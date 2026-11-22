// 一条「点进去」的入口行：地区卡与服务商卡共用同一份样式，免得两处各写一套。
import type { ReactNode } from 'react'

export function ProviderCard({ icon, title, hint, onClick }: {
  /** 左边那枚图标（服务商 / 地区各用自己的，尺寸由这里定）。 */
  icon: ReactNode
  title: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 cursor-pointer items-center gap-3 rounded-lg border border-border-muted px-3 py-3 text-left transition-colors hover:bg-background-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex size-7 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-foreground-strong">{title}</span>
        <span className="text-xs text-foreground-muted">{hint}</span>
      </span>
      <svg viewBox="0 0 24 24" className="ml-auto size-4 shrink-0 text-foreground-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  )
}

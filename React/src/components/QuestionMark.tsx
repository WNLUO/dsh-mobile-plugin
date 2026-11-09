/**
 * 一枚小问号：16px 描边圆圈 + 问号，和面板其它图标同重量。
 *
 * 它只负责「有这个形状」，说明文字由调用方给（`title` / 悬浮提示 / 弹窗都行）——
 * 引导页那颗点开弹窗，配对卡那两行是鼠标悬浮出提示。
 */
export function QuestionMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className ?? 'size-3.5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.3 6.1a1.75 1.75 0 0 1 3.4.55c0 1.15-1.7 1.35-1.7 2.55" />
      <path d="M8 11.5h.01" />
    </svg>
  )
}

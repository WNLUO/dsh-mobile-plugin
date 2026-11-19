/**
 * 一枚小感叹号：16px 描边圆圈 + 竖杠与点，和面板其它图标（见 QuestionMark）同重量。
 *
 * 它只负责「有这个形状」，点开后是什么由调用方决定 —— 配对卡的「自动上报网络地址」那行
 * 用它当说明入口，点开是一层弹窗（比悬浮提示能放下更多字）。
 */
export function InfoMark({ className }: { className?: string }) {
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
      <path d="M8 4.8v4.4" />
      <path d="M8 11.4h.01" />
    </svg>
  )
}

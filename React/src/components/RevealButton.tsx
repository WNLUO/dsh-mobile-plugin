// 显示与隐藏使用眼睛图标，操作对象保留在悬停提示和无障碍名中。
/**
 * 值旁边的显示 / 隐藏按钮，沿用面板的 ghost 小号图标按钮。
 * 图标表示下一步操作：眼睛显示，划线眼睛隐藏。
 */

import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'

type Props = {
  /** 现在看得见吗。可见时按钮变成「隐藏」。 */
  on?: boolean
  /** 遮的是哪一样东西（「中转地址」），用于提示和无障碍名。 */
  what: string
  /** 操作文字；不给就按 `on` 写成「隐藏 / 显示」。 */
  label?: string
  className?: string
  /** 没有值可揭时传 true：别给一颗点了没反应的按钮。 */
  disabled?: boolean
  onClick: () => void
}

export function RevealButton({ on, what, label, className, disabled, onClick }: Props) {
  const text = label ?? t(on ? 'panel.common.hide' : 'panel.common.show')
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label={`${text}${what}`}
      title={`${text}${what}`}
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {on ? (
          <>
            <path d="m3 3 18 18M10.58 10.59a2 2 0 0 0 2.83 2.82" />
            <path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c7 0 10 7 10 7a14.5 14.5 0 0 1-3.17 4.36M6.61 6.61A16.77 16.77 0 0 0 2 12s3 7 10 7a10.94 10.94 0 0 0 5.39-1.39" />
          </>
        ) : (
          <>
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
          </>
        )}
      </svg>
    </Button>
  )
}

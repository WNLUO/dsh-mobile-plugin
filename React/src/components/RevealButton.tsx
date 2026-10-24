/**
 * 一处「明文摆着、可当场遮上」的值旁边那颗小按钮。
 *
 * 形状照抄「局域网直连」弹窗里「修改」那颗：`variant="ghost" size="sm"` 的文字按钮，
 * 跟在值的后面。库里有的组件不许手搓，眼睛图标整套（画法、可访问名、按下态）都是
 * 自己发明的第二套语言 —— 同一个面板里两种「揭开」长得不一样，比没有更糟。
 *
 * 文字写「显示 / 隐藏」而不是图标：旁边已经有「已隐藏」「还没取到地址」这类说明，
 * 文字按钮读起来是一句话，图标还得让人猜。
 *
 * 遮的是哪一样东西用 `what` 说明，拼进无障碍名（「显示二维码」那类）；可见文字保持短，
 * 免得把这一行撑开。
 */

import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'

type Props = {
  /** 现在看得见吗。可见时按钮变成「隐藏」。 */
  on?: boolean
  /** 遮的是哪一样东西（「中转地址」），只用于无障碍名。 */
  what: string
  /** 可见文字；不给就按 `on` 写成「隐藏 / 显示」。 */
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
      size="sm"
      className={className}
      aria-label={`${text}${what}`}
      disabled={disabled}
      onClick={onClick}
    >
      {text}
    </Button>
  )
}

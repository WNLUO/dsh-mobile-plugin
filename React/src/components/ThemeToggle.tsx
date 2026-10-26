/**
 * 页面右上角的日间 / 夜间切换按钮。
 *
 * 主题由 Appica 的 `ThemeProvider` 管，默认「跟随系统」，选择存在 localStorage。
 * **这份存储按来源（协议 + 主机 + 端口）隔离**：开发地址与正式入口各存各的，同一台机器上
 * 两边可能一个白天一个黑夜，这个按钮只拧得动当前来源。
 *
 * 图标手画：库里没有图标集，`Button` 基类那条
 * `[&_svg:not([class*='stroke-'])]:stroke-[1.85]` 会补描边宽度，所以 `fill="none"`。
 * 渲染的是「点下去会变成什么」，图标本身就是下一步的预告，配同样意思的 `aria-label`。
 *
 * **坐标不归这里管**：这颗与语言按钮共用 `components/TopRightActions.tsx` 那个落脚点，
 * 别在这里再套 `fixed`，否则两颗按钮各算各的边距。
 */

import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'
import { useTheme } from '@appica/ui-react/hooks/use-theme'

function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  )
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const label = dark ? t('panel.theme.toDay') : t('panel.theme.toNight')

  return (
    <Button
      variant="soft"
      size="icon-md"
      className="pointer-events-auto rounded-full shadow-sm"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}

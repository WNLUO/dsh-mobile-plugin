/**
 * 页面右上角的日间 / 夜间切换按钮。
 *
 * 主题由 Appica 的 `ThemeProvider` 管，默认「跟随系统」，选择存在浏览器 localStorage 的
 * 一个键里。**这份存储按来源（协议 + 主机 + 端口）隔离**：开发地址 `127.0.0.1:5273` 与
 * 正式入口（宿主那条 `/api/relay/panel`）是两个来源，各存各的，所以同一台机器上两边可能
 * 一个白天一个黑夜。这个按钮就是给人就地拧过来的，一处拧不动另一处。
 *
 * 图标手画：库里只有组件、没有图标集，而这一页既有的图标（`JoinGroupButton` 的微信标）
 * 也是手写的 SVG。这两颗是描边图标，走 `stroke` 上色，所以 `fill="none"`；描边宽度不用
 * 自己写 —— `Button` 基类那条 `[&_svg:not([class*='stroke-'])]:stroke-[1.85]` 会补上
 * （实心标才需要显式带 `stroke-` 类挡掉它，那是微信标那边的事）。
 *
 * 渲染的是「点下去会变成什么」：现在是夜间就给太阳，反之给月亮，所以按钮的图标本身就是
 * 下一步的预告，配上同样意思的 `aria-label` / `title`。
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
    <div className="pointer-events-none fixed end-6 top-6 z-40">
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
    </div>
  )
}

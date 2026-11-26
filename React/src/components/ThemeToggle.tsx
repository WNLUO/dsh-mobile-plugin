/**
 * 面板的日夜按钮：跟随 DSH → 日间 → 夜间，三档轮换。
 *
 * 主题由 lib/shell-theme.ts 管：默认跟随 DSH 父窗口的同源记号，手动选择存 localStorage，
 * 按来源隔离（开发地址与正式入口各存各的）。控制台这一页刻意不挂 Appica 的 ThemeProvider，
 * 它往 <html> 写 light/dark 会盖掉跟随父窗口那套。
 *
 * 图标手画：库里没有图标集，`Button` 基类那条
 * `[&_svg:not([class*='stroke-'])]:stroke-[1.85]` 会补描边宽度，所以 `fill="none"`。
 * 渲染的是「点下去会变成什么」，图标本身就是下一步的预告，配同样意思的 `aria-label`。
 * 按钮由各页顶栏自己挂，这里不钉坐标。
 */

import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'
import { setShellThemeOverride, shellThemeOverride, useShellTheme, type ShellTheme } from '../lib/shell-theme.ts'

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

/** 三档里的「跟随 DSH」：半亮半暗的圆，表示让父窗口 / 系统决定。 */
function FollowIcon() {
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
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * 控制台那一窗用的日夜按钮（三档轮换）：跟随 DSH → 日间 → 夜间 → 跟随 DSH。
 *
 * 之前只有「日间 / 夜间」两档：按过一次就写下手动选择，再也回不到「跟随 DSH」。
 * 现在把那颗「跟随」补成一档，按到它就把手动覆盖清掉（`setShellThemeOverride(null)`）。
 * 图标表示**下一次按下去会变成什么**，配同样意思的提示，所以三档都点得回来。
 */
export function ConsoleThemeToggle() {
  const theme = useShellTheme()
  const override = shellThemeOverride()
  // 下一档：跟随中 → 切到「当前的另一档」（立刻看到变化）；手动日间 → 夜间；手动夜间 → 跟随。
  const next: 'follow' | ShellTheme = override === null ? (theme === 'dark' ? 'light' : 'dark') : override === 'light' ? 'dark' : 'follow'
  const label =
    next === 'follow' ? t('panel.theme.follow') : next === 'light' ? t('panel.theme.toDay') : t('panel.theme.toNight')

  return (
    <Button
      variant="ghost"
      size="icon-md"
      className="pointer-events-auto"
      aria-label={label}
      title={label}
      onClick={() => setShellThemeOverride(next === 'follow' ? null : next)}
    >
      {next === 'follow' ? <FollowIcon /> : next === 'light' ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}

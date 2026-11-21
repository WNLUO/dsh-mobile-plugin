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
 *
 * 形态是纯图标的 ghost 按钮：不带浅灰底、圆角片与阴影，颜色走主题 token，日夜间自动跟着变。
 */

import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'
import { useTheme } from '@appica/ui-react/hooks/use-theme'
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

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const label = dark ? t('panel.theme.toDay') : t('panel.theme.toNight')

  return (
    <Button
      variant="ghost"
      size="icon-md"
      className="pointer-events-auto"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}

/**
 * 控制台那一窗用的日夜按钮。
 *
 * 与上面那颗的区别只有一处**数据来源**：那一颗拧的是面板自己的主题键（`ThemeProvider`），
 * 而控制台那一窗的主题跟着 DSH 走（见 `lib/shell-theme.ts`），所以它拧的是那份「手动优先」
 * 的选择：按下之后这一窗不再跟随父窗口，直到重新选回跟随（清掉那个键）。
 *
 * 单独一颗而不是给上面那颗加开关：上面那颗在**每一条别的页**上都要有 `ThemeProvider` 才
 * 拿得到 `setTheme`，而控制台那一页刻意没挂它（见 `main.tsx` 里那段说明）。
 */
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

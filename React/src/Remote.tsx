/**
 * 远程电脑独立页（`/api/relay/panel/remote`）：2026-11-17 从控制台主页抽出。
 *
 * 桌面侧边栏手机图标右边那颗电脑图标点开的就是这一页；标题、操作按钮与卡片都由
 * （`RemoteComputersCard`）一并渲染，这里只负责页面容器，让它独占一屏。
 */
// 2026-11-20：内嵌窗的窗口按钮（浏览器打开 / 关闭）改由页面层渲染一次，卡片不再自己挂。
// 2026-11-21：远程电脑页补上语言与日夜切换（与引导页、控制台同一套按钮）。
import { LanguageMenu } from './components/LanguageMenu.tsx'
import { PanelWindowActions } from './components/PanelWindowActions.tsx'
import { RemoteComputersCard } from './components/RemoteComputersCard.tsx'
import { ConsoleThemeToggle } from './components/ThemeToggle.tsx'

export function Remote() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
      <div className="flex items-center justify-end gap-1">
        <LanguageMenu />
        <ConsoleThemeToggle />
        <PanelWindowActions />
      </div>
      <RemoteComputersCard />
    </main>
  )
}

/**
 * 远程电脑独立页（`/api/relay/panel/remote`）：2026-11-17 从控制台主页抽出。
 *
 * 桌面侧边栏手机图标右边那颗电脑图标点开的就是这一页；卡片本身与主页那版是同一份
 * （`RemoteComputersCard`），只是这里让它独占一屏，不再和配对、连接状态挤在控制台里。
 */
import { PanelWindowActions } from './components/PanelWindowActions.tsx'
import { RemoteComputersCard } from './components/RemoteComputersCard.tsx'
import { t } from './lib/i18n/index.ts'

export function Remote() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-foreground-strong">{t('panel.remote.title')}</h1>
        <div className="flex flex-wrap items-center gap-1">
          <PanelWindowActions />
        </div>
      </header>
      <RemoteComputersCard />
    </main>
  )
}

/**
 * 远程电脑独立页（`/api/relay/panel/remote`）：2026-11-17 从控制台主页抽出。
 *
 * 桌面侧边栏手机图标右边那颗电脑图标点开的就是这一页；卡片本身与主页那版是同一份
 * （`RemoteComputersCard`），只是这里让它独占一屏，不再和配对、连接状态挤在控制台里。
 * 顶栏留一颗返回控制台的入口：这一页在 DSH 的弹窗里打开，关窗等于回到原处，但从浏览器
 * 直接进来时得有路回去。
 */
import { Button } from '@appica/ui-react/button'

import { PanelWindowActions } from './components/PanelWindowActions.tsx'
import { RemoteComputersCard } from './components/RemoteComputersCard.tsx'
import { t } from './lib/i18n/index.ts'

/** 推控制台地址：文档相对，兼容反代子路径与桌面壳的 `dsh-app://app/`。 */
function consoleUrl(): string {
  try {
    const base = new URL(document.baseURI)
    base.pathname = base.pathname.replace(/\/remote\/?$/, '/console')
    base.search = ''
    base.hash = ''
    return base.href
  } catch {
    return ''
  }
}

export function Remote() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-foreground-strong">{t('panel.remote.title')}</h1>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => { window.location.href = consoleUrl() }}>
            {t('panel.remote.backConsole')}
          </Button>
          <PanelWindowActions />
        </div>
      </header>
      <RemoteComputersCard />
    </main>
  )
}

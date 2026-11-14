/**
 * 面板这一页的**分流**：按地址后缀决定渲染哪一屏。
 *
 * 四条地址由宿主吐同一份 HTML（`lib/routes/control-plane.js` 那几条 `/api/relay/panel*`），
 * 差别全在这里：`/panel` 自己问宿主配过没有、`/panel/setup` 强制引导、`/panel/settings`
 * 强制主页、`/panel/debug` 强制调试页（桌面端那颗手机图标点开的就是它，见 `Debug.tsx`）。
 * 认后缀用 `endsWith`：这一页可能挂在反代给的子路径下，前缀变了不该把几条路弄丢。
 */
// 首屏状态请求结束后才报告就绪；失败显示原因，并允许原地重新载入。
import { Button } from '@appica/ui-react/button'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import { App } from './App.tsx'
import { Console } from './Console.tsx'
import { Debug } from './Debug.tsx'
import { Onboarding } from './Onboarding.tsx'
import { apiGet, errorText, type StatusView } from './lib/api.ts'
import { reportPanelState } from './lib/panel-load.ts'
import { t } from './lib/i18n/index.ts'

/**
 * 分流：走引导还是进插件主页。
 *
 * 四条地址都由宿主同一份 HTML 承载，差别只在这里认的后缀：
 * - `.../api/relay/panel`           什么都不强制：问宿主，`status.onboarded` 或
 *   `status.enabled` 为真就进主页。宿主说了算（标志落在 relay.json 里），不用
 *   localStorage——换个浏览器、清一次缓存都不该让引导重来一遍。`enabled` 也算
 *   「配过了」：老机器升级上来时 relay.json 里没有那个键，它们本来就在正常用。
 * - `.../api/relay/panel/setup`     强制先走引导，走完才进主页（想再看一遍流程时用）。
 * - `.../api/relay/panel/settings`  强制进主页，跳过引导（演示 / 排查时用）。
 * - `.../api/relay/panel/debug`     强制进调试页，什么都不问（那块屏本来就是给排障看的，
 *   状态读不到时更得进得去）。
 *
 * 用 `endsWith` 而不是全等：这一页挂在中转/宿主给的某个前缀下面，前缀变了不该把几条路弄丢。
 */
export function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  const forcedSetup = path.endsWith('/setup')
  const forcedSettings = path.endsWith('/settings')
  /** `/api/relay/panel/debug`：调试页（桌面端点那颗手机图标弹的就是它）。 */
  const forcedDebug = path.endsWith('/debug')
  /** `/api/relay/panel/console`：控制台那一窗（点手机图标进来的第一屏，见 `Console.tsx`）。 */
  const forcedConsole = path.endsWith('/console')
  /** null = 首屏状态尚未返回；请求失败时显示错误与重新载入入口。 */
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [startupError, setStartupError] = useState('')
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (startupError) reportPanelState('error', startupError)
    else if (forcedSetup || forcedSettings || forcedDebug || (configured !== null && !(forcedConsole && configured))) reportPanelState('ready')
  }, [configured, startupError, forcedSetup, forcedSettings, forcedDebug, forcedConsole])

  useEffect(() => {
    if (forcedSetup || forcedSettings || forcedDebug) return undefined
    let alive = true
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        if (alive) setConfigured(current.onboarded === true || current.enabled === true)
      } catch (error) {
        if (alive) setStartupError(errorText(error))
      }
    })()
    return () => {
      alive = false
    }
  }, [forcedSetup, forcedSettings, forcedDebug])

  if (startupError) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-5">
        <p className="text-sm text-error" role="alert">{startupError}</p>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          {t('panel.console.reload')}
        </Button>
      </main>
    )
  }

  if (forcedSettings) return <App />

  if (forcedDebug) return <Debug />

  // 控制台那一窗也要先问一句「这台机器配过没有」：第一次装的人点进来该先走引导
  // （扫码 + 下载 App 那三步），配过的人直接进控制台。等状态回来之前先不画，
  // 否则会先闪一下控制台再跳成引导。
  if (forcedConsole) {
    if (configured === null) {
      return (
        <main className="flex min-h-screen items-center justify-center gap-2 p-6 text-sm text-foreground-muted">
          <Spinner />
          {t('panel.shell.loading')}
        </main>
      )
    }
    if (!configured) return <Onboarding onDone={() => setConfigured(true)} />
    return <Console />
  }

  if (forcedSetup) return entered ? <App /> : <Onboarding onDone={() => setEntered(true)} />

  if (configured === null) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 p-6 text-sm text-foreground-muted">
        <Spinner />
        {t('panel.shell.loading')}
      </main>
    )
  }

  if (!configured && !entered) return <Onboarding onDone={() => setEntered(true)} />
  return <App />
}
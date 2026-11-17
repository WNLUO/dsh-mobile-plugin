/**
 * 面板这一页的**分流**：按地址后缀决定渲染哪一屏。
 *
 * 几条地址由宿主吐同一份 HTML（`lib/routes/control-plane.js` 那几条 `/api/relay/panel*`），
 * 差别全在这里：`/panel` 自己问宿主配过没有、`/panel/setup` 强制引导、`/panel/settings`
 * 强制主页、`/panel/debug` 强制调试页。
 *
 * **主页只有控制台这一版**（`Console.tsx`）：原先另有一版网页设置页（`App.tsx`），
 * 2026-11-15 收成一套，根地址与各入口统一进控制台。认后缀用 `endsWith`：这一页可能挂在
 * 反代给的子路径下，前缀变了不该把几条路弄丢。
 */
// 首屏状态请求结束后才报告就绪；失败显示原因，并允许原地重新载入。
import { Button } from '@appica/ui-react/button'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import { Console } from './Console.tsx'
import { Debug } from './Debug.tsx'
import { Onboarding } from './Onboarding.tsx'
import { Remote } from './Remote.tsx'
import { apiGet, errorText, type StatusView } from './lib/api.ts'
import { reportPanelState } from './lib/panel-load.ts'
import { t } from './lib/i18n/index.ts'

/**
 * 分流：走引导还是进控制台。
 *
 * - `.../api/relay/panel`、`.../api/relay/panel/console`
 *                                   问宿主，`status.onboarded` 或 `status.enabled` 为真就进控制台。
 *   宿主说了算（标志落在 relay.json 里），不用 localStorage——换个浏览器、清一次缓存都不该
 *   让引导重来一遍。`enabled` 也算「配过了」：老机器升级上来时 relay.json 里没有那个键，
 *   它们本来就在正常用。
 * - `.../api/relay/panel/setup`     强制先走引导，走完才进控制台（想再看一遍流程时用）。
 * - `.../api/relay/panel/settings`  强制进控制台，跳过引导（演示 / 排查时用）。
 * - `.../api/relay/panel/debug`     强制进调试页，什么都不问（那块屏本来就是给排障看的，
 *   状态读不到时更得进得去）。
 *
 * 用 `endsWith` 而不是全等：这一页挂在某个前缀下面，前缀变了不该把几条路弄丢。
 */
export function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  const forcedSetup = path.endsWith('/setup')
  const forcedSettings = path.endsWith('/settings')
  /** `/api/relay/panel/debug`：调试页（桌面端那颗手机图标的次级入口）。 */
  const forcedDebug = path.endsWith('/debug')
  /** `/api/relay/panel/remote`：远程电脑独立页（桌面端那颗电脑图标点开的那一窗）。 */
  const forcedRemote = path.endsWith('/remote')
  /** 除强制引导 / 强制主页 / 调试页 / 远程电脑页之外（含根地址与 `/console`）都要先问宿主配过没有。 */
  const needsStatus = !forcedSetup && !forcedSettings && !forcedDebug && !forcedRemote
  /** null = 首屏状态尚未返回；请求失败时显示错误与重新载入入口。强制主页直接当作已配过。 */
  const [configured, setConfigured] = useState<boolean | null>(forcedSettings ? true : null)
  const [startupError, setStartupError] = useState('')
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (startupError) reportPanelState('error', startupError)
    else if (!needsStatus || configured !== null) reportPanelState('ready')
  }, [configured, startupError, needsStatus])

  useEffect(() => {
    if (!needsStatus) return undefined
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
  }, [needsStatus])

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

  if (forcedDebug) return <Debug />
  if (forcedRemote) return <Remote />

  if (forcedSetup) return entered ? <Console /> : <Onboarding onDone={() => setEntered(true)} />

  if (configured === null) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 p-6 text-sm text-foreground-muted">
        <Spinner />
        {t('panel.shell.loading')}
      </main>
    )
  }

  if (!configured && !entered) return <Onboarding onDone={() => setEntered(true)} />
  return <Console />
}

/**
 * 面板这一页的**分流**：按地址后缀决定渲染哪一屏。
 *
 * 几条地址由宿主吐同一份 HTML（`lib/routes/control-plane.js` 那几条 `/api/relay/panel*`），
 * 差别全在这里：`/panel` 自己问宿主配过没有、`/panel/setup` 强制引导、`/panel/settings`
 * 强制主页、`/panel/remote` 进远程电脑页。原先还有 `/panel/debug` 调试页，2026-11-17 删除。
 *
 * **主页只有控制台这一版**（`Console.tsx`）：原先另有一版网页设置页（`App.tsx`），
 * 2026-11-15 收成一套，根地址与各入口统一进控制台。认后缀用 `endsWith`：这一页可能挂在
 * 反代给的子路径下，前缀变了不该把几条路弄丢。
 */
// 首屏状态请求结束后才报告就绪；失败显示原因、重启建议与重新载入入口。
import { Button } from '@appica/ui-react/button'
import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import { Console } from './Console.tsx'
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
 * - `.../api/relay/panel/remote`    强制进远程电脑独立页。
 *
 * 用 `endsWith` 而不是全等：这一页挂在某个前缀下面，前缀变了不该把几条路弄丢。
 */
export function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  const forcedSetup = path.endsWith('/setup')
  const forcedSettings = path.endsWith('/settings')
  /** `/api/relay/panel/remote`：远程电脑独立页（桌面端那颗电脑图标点开的那一窗）。 */
  const forcedRemote = path.endsWith('/remote')
  /** 除强制引导 / 强制主页 / 远程电脑页之外（含根地址与 `/console`）都要先问宿主配过没有。 */
  const needsStatus = !forcedSetup && !forcedSettings && !forcedRemote
  /** null = 首屏状态尚未返回；请求失败时显示错误与重新载入入口。强制主页直接当作已配过。 */
  const [configured, setConfigured] = useState<boolean | null>(forcedSettings ? true : null)
  /** null = 还没问到。真 = 第一次装进正在跑的 DSH、还没完整重启：只给「请重启」拦截页。 */
  const [firstInstallPendingRestart, setFirstInstallPendingRestart] = useState<boolean | null>(null)
  const [startupError, setStartupError] = useState('')
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (startupError) reportPanelState('error', startupError)
    else if (!needsStatus || configured !== null) reportPanelState('ready')
  }, [configured, startupError, needsStatus])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        if (!alive) return
        // 首装待重启对「强制进某屏」也要判：三处入口统一拦，用户不会先钻进控制台/引导页。
        setFirstInstallPendingRestart(current.firstInstallPendingRestart === true)
        if (needsStatus) setConfigured(current.onboarded === true || current.enabled === true)
      } catch (error) {
        if (!alive) return
        // 强制入口（演示 / 排查）读不到状态就照常进去；普通入口仍旧报错停下。
        if (needsStatus) setStartupError(errorText(error))
        else setFirstInstallPendingRestart(false)
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
        <p className="text-sm text-foreground-muted">{t('panel.shell.restartHint')}</p>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          {t('panel.console.reload')}
        </Button>
      </main>
    )
  }

  if (firstInstallPendingRestart === null) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 p-6 text-sm text-foreground-muted">
        <Spinner />
        {t('panel.shell.loading')}
      </main>
    )
  }

  // 第一次装进正在跑的 DSH、还没完整重启：桌面那半外壳资源还没就位，控制台 / 引导页 / 远程
  // 电脑页都不该进来。统一给一张「请重启」的拦截页，挑明怎么重启。
  if (firstInstallPendingRestart) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-base font-medium text-foreground-strong" role="alert">{t('panel.shell.restartHint')}</p>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          {t('panel.console.reload')}
        </Button>
      </main>
    )
  }

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

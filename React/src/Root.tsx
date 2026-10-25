import { Spinner } from '@appica/ui-react/spinner'
import { useEffect, useState } from 'react'

import { App } from './App.tsx'
import { Onboarding } from './Onboarding.tsx'
import { apiGet, type StatusView } from './lib/api.ts'
import { t } from './lib/i18n/index.ts'

/**
 * 分流：走引导还是进插件主页。
 *
 * 三条地址都由宿主同一份 HTML 承载，差别只在这里认的后缀：
 * - `.../api/relay/panel`           什么都不强制：问宿主，`status.onboarded` 或
 *   `status.enabled` 为真就进主页。宿主说了算（标志落在 relay.json 里），不用
 *   localStorage——换个浏览器、清一次缓存都不该让引导重来一遍。`enabled` 也算
 *   「配过了」：老机器升级上来时 relay.json 里没有那个键，它们本来就在正常用。
 * - `.../api/relay/panel/setup`     强制先走引导，走完才进主页（想再看一遍流程时用）。
 * - `.../api/relay/panel/settings`  强制进主页，跳过引导（演示 / 排查时用）。
 *
 * 用 `endsWith` 而不是全等：这一页挂在中转/宿主给的某个前缀下面，前缀变了不该把两条路弄丢。
 */
export function Root() {
  const path = window.location.pathname.replace(/\/+$/, '')
  const forcedSetup = path.endsWith('/setup')
  const forcedSettings = path.endsWith('/settings')
  /** null = 还没问到宿主。读不到状态就当「配过了」，把错误交给主页去说，别卡在加载上。 */
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (forcedSetup || forcedSettings) return undefined
    let alive = true
    void (async () => {
      try {
        const current = await apiGet<StatusView>('/api/relay/status')
        if (alive) setConfigured(current.onboarded === true || current.enabled === true)
      } catch {
        if (alive) setConfigured(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [forcedSetup, forcedSettings])

  if (forcedSettings) return <App />

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
// 2026-11-27：服务商线路标题右边的中国/国际标签，按界面语言定默认，切标签换专属面板。
/**
 * 「服务商线路」区（2026-11-27 重做）：标题右边两个标签，下面直接铺对应地区的专属面板。
 *
 * 默认标签按**界面语言**猜：中文 / 繁体默认中国，其余默认国际。用户点过一次标签后，
 * 以手动选择为准（记在 localStorage），免得改个界面语言就把人切到另一边。这一步只决定
 * 面板默认露哪边，用户随时能点回去；不是"识别成海外就锁死"。
 *
 * 面板内容在 `ProviderRegionPanel.tsx`：中国给 zeronews 账号概览，国际给 Cloudflare 状态。
 * 原来的「地区入口卡」收掉了——现在面板本身就是入口，详细配置按钮直接进服务商页。
 */
import { useState } from 'react'

import type { StatusView } from '../lib/api.ts'
import { cn } from '../lib/format.ts'
import { t } from '../lib/i18n/index.ts'
import { usePanelLanguage } from '../lib/i18n/use-language.ts'
import type { NetworkProvider, NetworkRegion } from '../lib/network-region.ts'
import { ProviderRegionPanel } from './ProviderRegionPanel.tsx'

const REGION_CHOICE_KEY = 'dsh-mobile-plugin:provider-region-choice'

/** 界面语言 → 默认地区：中文 / 繁体归国内，其余归国际。 */
function defaultRegionOf(language: string): NetworkRegion {
  return language === 'zh-Hans' || language === 'zh-Hant' ? 'cn' : 'global'
}

/** 用户手动选过就记住；没选过跟着语言走。 */
function savedRegion(): NetworkRegion | null {
  try {
    const raw = localStorage.getItem(REGION_CHOICE_KEY)
    return raw === 'cn' || raw === 'global' ? raw : null
  } catch {
    return null
  }
}

export function NetworkRegions({ status, onOpenProvider }: {
  status: StatusView
  /** 面板「详细配置」：进对应服务商的配置页。 */
  onOpenProvider: (provider: NetworkProvider) => void
}) {
  const language = usePanelLanguage()
  const [chosen, setChosen] = useState<NetworkRegion | null>(savedRegion)
  // 没手动选过时直接按当前语言算，语言一变这边跟着变；选过之后记住用户的选择。
  const region = chosen ?? defaultRegionOf(language)

  const pick = (next: NetworkRegion) => {
    setChosen(next)
    try { localStorage.setItem(REGION_CHOICE_KEY, next) } catch { /* 记不住不影响本次 */ }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground-strong">{t('panel.region.title')}</span>
        <div className="flex items-center gap-1 rounded-md border border-border-muted p-0.5">
          {(['cn', 'global'] as NetworkRegion[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => pick(value)}
              className={cn(
                'cursor-pointer rounded px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                region === value
                  ? 'bg-primary-subtle text-foreground-strong'
                  : 'text-foreground-muted hover:bg-background-muted',
              )}
              aria-pressed={region === value}
            >
              {t(value === 'cn' ? 'panel.providerRegion.tabChina' : 'panel.providerRegion.tabGlobal')}
            </button>
          ))}
        </div>
      </div>

      <ProviderRegionPanel region={region} status={status} onOpenDetail={onOpenProvider} />
    </div>
  )
}

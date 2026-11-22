// 国际线路页：先选服务商，再进它自己的配置页。目前只有 Cloudflare。
/**
 * 「国际」地区页（2026-11-23 用户要求：地区下面再按服务商分页）。
 *
 * 现在这里只有 Cloudflare 一家：匿名隧道，不用账号、不分地区。以后加别的国际服务商就多
 * 一张卡、多一页，不用动主配置页，也不用动这一页的结构。
 *
 * 返回按钮回主配置页（`#network`），地址由外层 Console 换。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'

import { t } from '../lib/i18n/index.ts'
import { providersOfRegion } from '../lib/network-region.ts'
import type { NetworkProvider } from '../lib/network-region.ts'
import { ProviderCard } from './ProviderCard.tsx'
import { PROVIDER_LOOK } from './ProviderLook.tsx'

type Props = {
  open: boolean
  /** 返回（false）回主配置页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  /** 点某一家服务商：进它自己的配置页。 */
  onOpenProvider: (provider: NetworkProvider) => void
}

export function GlobalLinesPage({ open, onOpenChange, onOpenProvider }: Props) {
  if (!open) return null

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.pairing.openConfig')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.region.global')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.region.globalPageHint')}</p>
          {providersOfRegion('global').map((provider) => (
            <ProviderCard
              key={provider}
              icon={PROVIDER_LOOK[provider].icon}
              title={t(PROVIDER_LOOK[provider].name)}
              hint={t(PROVIDER_LOOK[provider].hint)}
              onClick={() => onOpenProvider(provider)}
            />
          ))}
        </div>
      </Card>
    </>
  )
}

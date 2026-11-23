// 中国线路页：先选服务商，再进它自己的配置页。这里只做入口，不做配置。
/**
 * 「中国」地区页（2026-11-23 用户要求：地区下面再按服务商分页）。
 *
 * 为什么这一层要存在：国内目前有两家（ZeroNews、节点小宝），后面还会加。把两家的配置直接
 * 摊在这一页，第三家一来就又是一整屏；每家一页之后，新服务商只是多一张卡，别人家那页一个字
 * 都不用动。
 *
 * 返回按钮回首页（网络配置铺在首页），地址由外层 Console 换。
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
  /** 返回（false）回首页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  /** 点某一家服务商：进它自己的配置页。 */
  onOpenProvider: (provider: NetworkProvider) => void
}

export function ChinaLinesPage({ open, onOpenChange, onOpenProvider }: Props) {
  if (!open) return null

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.pairing.openConfig')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.region.china')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.region.chinaPageHint')}</p>
          {providersOfRegion('cn').map((provider) => (
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

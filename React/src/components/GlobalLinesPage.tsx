// 国际线路页：目前只有 Cloudflare 匿名隧道，不用注册，海外用户直接能用。
/**
 * 「国际线路」子页（2026-11-23 用户要求：线路按地区分页）。
 *
 * 现在这里只有 Cloudflare 一条：它是匿名隧道，不用账号、不分地区。以后加别的国际服务商就
 * 往这一页里接，不用动主配置页。
 *
 * 内容本身与「连接状态」卡那行的管理弹窗共用 `CloudflarePanel`，两处说的是同一件事。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'

import type { StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'

type Props = {
  open: boolean
  /** 返回（false）；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 动作之后刷新一次宿主状态（连接状态卡那行也跟着变）。 */
  onChanged: () => void
}

export function GlobalLinesPage({ open, onOpenChange, status, onChanged }: Props) {
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
        <div className="flex flex-col gap-4 p-4">
          <p className="text-xs leading-5 text-foreground-muted">{t('panel.region.globalPageHint')}</p>
          <CloudflarePanel status={status} onChanged={onChanged} />
        </div>
      </Card>
    </>
  )
}

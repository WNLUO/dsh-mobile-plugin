// Cloudflare 线路页：匿名隧道开关与状态。内容与连接卡的管理弹窗共用 CloudflarePanel。
/**
 * Cloudflare 的配置页（2026-11-23 用户要求：地区下面按服务商分页）。
 *
 * 这条线路没有账号、没有地址要填，只有一个开关与一行状态；真正的内容在 `CloudflarePanel`
 * 里，和连接状态卡那行的「管理」弹窗是同一份实现。
 *
 * 返回按钮回「国际」页（`#network/global`）。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'

import type { StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'

type Props = {
  open: boolean
  /** 返回（false）回地区页；换页由外层按 hash 处理。 */
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 动作之后刷新一次宿主状态（连接状态卡那行也跟着变）。 */
  onChanged: () => void
}

export function CloudflarePage({ open, onOpenChange, status, onChanged }: Props) {
  if (!open) return null

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.region.global')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.provider.cloudflare')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <CloudflarePanel status={status} onChanged={onChanged} />
        </div>
      </Card>
    </>
  )
}

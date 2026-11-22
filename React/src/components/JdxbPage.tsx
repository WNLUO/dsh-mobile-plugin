// 节点小宝线路页：装设备端、绑账号、填外网地址。内容仍是 JdxbLineCard 那一张卡。
/**
 * 节点小宝的配置页（2026-11-23 用户要求：地区下面按服务商分页）。
 *
 * 这一卡原来长在网络配置页底部，逻辑与文案都没动，只是搬过来单独成一页 —— 它自己的状态、
 * 安装、绑定、保存地址都在这张卡里，页面这一层只管标题与返回。
 *
 * 返回按钮回「中国」页（`#network/cn`）。
 */
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'

import { t } from '../lib/i18n/index.ts'
import { JdxbLineCard } from './JdxbLineCard.tsx'

export function JdxbPage({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!open) return null

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          ← {t('panel.region.china')}
        </Button>
        <h2 className="text-base font-medium text-foreground-strong">{t('panel.provider.jdxb')}</h2>
      </div>

      <Card frame="solid">
        <div className="flex flex-col gap-3 p-4">
          <JdxbLineCard />
        </div>
      </Card>
    </>
  )
}

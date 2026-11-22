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

import editServiceShot from '../assets/jdxb-edit-service.jpg'
import type { StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { JdxbLineCard } from './JdxbLineCard.tsx'
import { LineGuide } from './LineGuide.tsx'

export function JdxbPage({ open, onOpenChange, status }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 宿主状态：只借局域网端口，步骤里要告诉人把「网页服务」指向哪个端口。 */
  status: StatusView
}) {
  if (!open) return null

  // 四步对应「装 → 绑 → 建网页服务 → 填地址」，顺序不能换：后一步依赖前一步的结果。
  const steps = [
    { title: t('panel.guide.jdxb.step1'), body: t('panel.guide.jdxb.step1Body') },
    { title: t('panel.guide.jdxb.step2'), body: t('panel.guide.jdxb.step2Body') },
    { title: t('panel.guide.jdxb.step3'), body: t('panel.guide.jdxb.step3Body', { port: status.lan.port }) },
    { title: t('panel.guide.jdxb.step4'), body: t('panel.guide.jdxb.step4Body') },
  ]

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
          <LineGuide
            steps={steps}
            aside={(
              <figure className="flex flex-col gap-1">
                <img
                  src={editServiceShot}
                  alt={t('panel.guide.jdxb.caption')}
                  className="w-full rounded-md border border-border-muted"
                />
                <figcaption className="text-xs leading-5 text-foreground-muted">{t('panel.guide.jdxb.caption')}</figcaption>
              </figure>
            )}
          />
          <JdxbLineCard />
        </div>
      </Card>
    </>
  )
}

// Cloudflare 兜底隧道的管理弹窗：内容取自 CloudflarePanel，与「国际线路」页共用同一份实现。
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'

import type { StatusView } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'
import { CloudflarePanel } from './CloudflarePanel.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 宿主当前状态：Cloudflare 那一格从这里读（老宿主没有就是 null）。 */
  status: StatusView
  /** 动作之后通知外层刷新一次 `/api/relay/status`（连接卡那行也跟着变）。 */
  onChanged?: () => void
}

export function CloudflareDialog({ open, onOpenChange, status, onChanged }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.cloudflare.title')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <CloudflarePanel status={status} onChanged={onChanged} />
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('panel.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

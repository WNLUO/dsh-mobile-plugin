/**
 * 全局弹窗：挂在页面最外层，引导页与控制面板页都会先弹这一扇。
 *
 * 内容目前是占位，文案住在 `lib/i18n/messages/global-dialog.ts`；真实内容定了只改字典，
 * 这一层不用动。关闭状态留在组件自己身上：本次会话关掉就不再弹，刷新页面重来 —— 与
 * `PublicRelayNoticeDialog` 同一套行为，不落 localStorage。
 */
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { useState } from 'react'

import { t } from '../lib/i18n/index.ts'

export function GlobalDialog() {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDismissed(true) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.globalDialog.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="text-sm leading-6 text-foreground-muted">
          {t('panel.globalDialog.body')}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="primary" onClick={() => setDismissed(true)}>
            {t('panel.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

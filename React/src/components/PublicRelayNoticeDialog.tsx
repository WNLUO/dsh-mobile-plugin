/**
 * 公用中转体验用户的提示弹窗：挂在主页根部，进来就弹一次，可关闭。
 *
 * 现阶段是**强制显示**（用户 2026-11-18 定的：先过样式，触发条件以后再接）。
 * 将来接条件时只替换 `useState(true)` 那一处判据 —— 判据应照 App 的
 * `viewmodels/public-relay`：有没有一台启用中的设备绑在公用中转上。组件本身不碰设备表，
 * 也不写盘，关掉只改本组件内的状态，刷新再来一次。
 *
 * 文案走字典（与 App 的 `notice.publicRelay.*` 同一段话，前缀换成面板的 `panel.`），
 * 正文是一整段带空行的长句，靠 `whitespace-pre-line` 还原分段 —— 不拆成多条键。
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

export function PublicRelayNoticeDialog() {
  // 强制显示：先过样式，触发条件以后接（见文件头）。
  const [open, setOpen] = useState(true)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.publicRelayNotice.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
          {t('panel.publicRelayNotice.body')}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('panel.publicRelayNotice.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

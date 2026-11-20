/**
 * 公用中转体验用户的提示弹窗：挂在主页根部，进来就弹一次，可关闭。
 *
 * 只在公用中转处于**启用状态**时显示（用户 2026-11-18 要求）：`visible` 由 Console 拿
 * `status.relayUrl` 问 `isPublicRelayUrl` 得来 —— 用户切到自建 / 清空 relayUrl 而停用公用
 * 后，`visible` 为假，这一扇直接不渲染，不必每次进来还要看到。判据与网络配置那栏同源，
 * 组件自己不算。
 *
 * 文案走字典（与 App 的 `notice.publicRelay.*` 同一段话，前缀换成面板的 `panel.`），
 * 正文是一整段带空行的长句，靠 `whitespace-pre-line` 还原分段 —— 不拆成多条键。
 *
 * 底部两颗按钮：「网络配置」直接去开网络配置弹窗（由调用方把那扇窗的开关传进来），
 * 「我已知晓」只关这一扇。前者先关自己再开配置窗，避免两扇叠在一起。
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

type Props = {
  /** 公用中转当前是否启用（Console 从 status.relayUrl 判）。停用时整扇不渲染。 */
  visible: boolean
  /** 打开网络配置弹窗（Console 里那扇的开关）。 */
  onOpenConfig: () => void
}

export function PublicRelayNoticeDialog({ visible, onOpenConfig }: Props) {
  // 每扇弹窗自己的「我知道了」状态：关掉后本次会话不再弹，刷新重来。
  const [dismissed, setDismissed] = useState(false)
  // 公用停用时直接不渲染——用户已切自建，没必要再提醒。关过也不再弹。
  if (!visible || dismissed) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDismissed(true) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.publicRelayNotice.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="whitespace-pre-line text-sm leading-6 text-foreground-muted">
          {t('panel.publicRelayNotice.body')}
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { setDismissed(true); onOpenConfig() }}>
            {t('panel.pairing.openConfig')}
          </Button>
          <Button variant="primary" onClick={() => setDismissed(true)}>
            {t('panel.publicRelayNotice.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

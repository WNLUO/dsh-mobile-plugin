// 2026-11-25：兜底仍不可用时的一次性端口冲突弹窗，引导页与主页共用。
/**
 * 端口冲突弹窗：只在后端给出「自动绕不开 / 兜底仍不可用」的原因码时弹。
 *
 * 弹窗只说三件事：端口被占、插件已经做了什么、还剩哪一步只能用户做。具体动作不在这里
 * 执行（结束进程、改穿透软件里的目标地址都不是本机面板能代替的），只给一颗按钮打开
 * 现有的端口设置弹窗 —— 不另做一份端口输入。
 *
 * 同一个原因码只弹一次：关掉之后记下这个码，直到它消失（或换成别的原因）才再弹。
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
import { useEffect, useState } from 'react'

import type { LanFallbackReason } from '../lib/api.ts'
import { t } from '../lib/i18n/index.ts'

/** 需要用户出手的原因码；端口已被自动绕开、或兜底正好可用时不骚扰。 */
export type PortConflictReason = Extract<LanFallbackReason, 'port-locked' | 'external-target' | 'cloudflare-unavailable' | 'zeronews-stale'>

/** 后端的原因码只在上面那四种里才弹，其余（含老宿主的空串）一律不用。 */
export function portConflictReason(reason: LanFallbackReason): PortConflictReason | '' {
  return reason === 'port-locked' || reason === 'external-target' || reason === 'cloudflare-unavailable' || reason === 'zeronews-stale'
    ? reason
    : ''
}

type Props = {
  /** 已经筛过的当前原因码；空串表示没有问题。 */
  reason: PortConflictReason | ''
  /** 弹窗里点名用的入口端口（专属入口优先）。 */
  port: number
  /** 打开现有的端口设置弹窗；引导页没有那扇窗，省略时只给指引不摆按钮。 */
  onOpenPortSettings?: () => void
}

export function PortConflictDialog({ reason, port, onOpenPortSettings }: Props) {
  /** 最近一次被用户关掉的原因码；换一个原因就重新给一次提示。 */
  const [dismissed, setDismissed] = useState<PortConflictReason | ''>('')

  // 原因消失后清掉记忆：同一个问题再次出现时还得说一次。
  useEffect(() => {
    if (reason === '') setDismissed('')
  }, [reason])

  const open = reason !== '' && reason !== dismissed
  const portText = String(port || 51887)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(reason)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('panel.portConflict.title')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-sm text-foreground-muted">{t('panel.portConflict.intro', { port: portText })}</p>
          {reason ? (
            <>
              <p className="text-sm text-foreground">{t(`panel.portConflict.auto.${reason}`)}</p>
              <p className="text-sm text-foreground">{t(`panel.portConflict.todo.${reason}`, { port: portText })}</p>
            </>
          ) : null}
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDismissed(reason)}>
            {t('panel.common.close')}
          </Button>
          {onOpenPortSettings ? (
            <Button
              variant="primary"
              onClick={() => {
                setDismissed(reason)
                onOpenPortSettings()
              }}
            >
              {t('panel.portConflict.openPort')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

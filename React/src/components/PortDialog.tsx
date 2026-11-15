/**
 * 「修改局域网端口」弹窗：只改一个数字，别的都不做。
 *
 * 入口在「配对与二维码」的「局域网端口」那一行的「修改」文字按钮上 —— 端口平时只是报个数，
 * 摊一个输入框和保存按钮在卡片里，会让人以为不改点东西就关不掉。
 *
 * 地址不在这扇窗里：候选、手填直连、IPv6 全归「网络配置」，两处各改一半迟早对不上。
 *
 * 端口默认沿用；只有已配对手机均支持发现且入口发布成功时才允许占用后换号。
 * 这里只校验输入范围，实际绑定与占用判断由宿主统一处理。
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
import { Field, FieldLabel } from '@appica/ui-react/field'
import { Input } from '@appica/ui-react/input'
import { useEffect, useState } from 'react'

import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前的首选端口（宿主记的那一份，不是「实际在用」的那个）。 */
  port: number
  busy: string
  onSave: (port: number) => void
}

const PORT_MIN = 1024
const PORT_MAX = 65535

export function PortDialog({ open, onOpenChange, port, busy, onSave }: Props) {
  const [portText, setPortText] = useState(String(port))

  // 开窗那一刻灌一次当前值：status 每 3 秒换一个对象，把它当依赖会把正在敲的字冲掉。
  useEffect(() => {
    if (!open) return
    setPortText(String(port))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  const text = portText.trim()
  const value = Number(text)
  const valid = text !== '' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX
  const canSave = valid && busy === ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('panel.pairing.portTitle')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="relay-lan-port">{t('panel.pairing.port')}</FieldLabel>
            <Input
              inputProps={{ id: 'relay-lan-port', inputMode: 'numeric' }}
              value={portText}
              onChange={(event) => setPortText(event.target.value)}
            />
          </Field>
          <p className="text-xs text-foreground-muted">{t('panel.pairing.portHint')}</p>
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy !== ''} onClick={() => onOpenChange(false)}>
            {t('panel.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => onSave(value)}>
            {t('panel.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

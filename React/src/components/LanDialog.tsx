/**
 * 「局域网直连」弹窗：只报运行状态 + 改直连端口。
 *
 * 地址那一块（网卡候选、手填的直连 / IPv6 地址）已经搬到同页的「网络配置」弹窗：
 * 四条地址在一起改才不会互相踩，两个入口各改一半迟早对不上。这里在状态下面留一句
 * 指路，不再摆任何能写地址的控件。
 *
 * 端口那一行平时只报「当前端口」和一个「修改」文字按钮（用户要求）：这扇窗九成时间是拿来看
 * 状态的，把输入框和保存按钮一直摊着，反而让人以为不改点东西就关不掉。
 */
import { Button } from '@appica/ui-react/button'
import { t } from '../lib/i18n/index.ts'
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

import type { ConfigPatch, StatusView } from '../lib/api.ts'
import { lanText, lanTone } from '../lib/format.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
  onSave: (patch: ConfigPatch) => void
}

const PORT_MIN = 1024
const PORT_MAX = 65535

export function LanDialog({ open, onOpenChange, status, busy, onSave }: Props) {
  const [portText, setPortText] = useState(String(status.lan.requestedPort))
  /** 点了「修改」才进编辑态；关窗／取消都退回去。 */
  const [editing, setEditing] = useState(false)

  // 开窗那一刻灌一次当前值：status 每 3 秒换一个对象，把它当依赖会把正在敲的字冲掉。
  useEffect(() => {
    if (!open) return
    setPortText(String(status.lan.requestedPort))
    setEditing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  const text = portText.trim()
  // 空着就是「不改动」这个端口；填了就必须是范围内的整数。
  const port = text === '' ? null : Number(text)
  const portValid = port === null || (Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX)
  const canSave = portValid && busy === ''

  function submit() {
    if (!canSave) return
    const patch: ConfigPatch = {}
    if (port !== null) patch.lanPort = port
    onSave(patch)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('panel.connection.lan')}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <InfoList>
            <InfoRow label={t('panel.lanDialog.state')} tone={lanTone(status.lan.state, status.lan.enabled)}>
              <ToneValue
                tone={lanTone(status.lan.state, status.lan.enabled)}
                text={lanText(status.lan.state, status.lan.enabled)}
                {...(status.lan.error ? { detail: status.lan.error } : {})}
              />
            </InfoRow>
            <InfoRow label={t('panel.lanDialog.port')} mono>
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <span>{status.lan.enabled ? status.lan.port : '—'}</span>
                {status.lan.enabled && status.lan.adjusted ? (
                  <span className="font-sans text-xs text-foreground-muted">{t('panel.pairing.portFallback')}</span>
                ) : null}
                {editing ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                    {t('panel.common.edit')}
                  </Button>
                )}
              </span>
            </InfoRow>
          </InfoList>

          {/* 指路：地址归「网络配置」，这扇窗只留状态与端口，别两处都能改。 */}
          <p className="text-xs text-foreground-muted">{t('panel.lanDialog.addressHint')}</p>

          {editing ? (
            <Field>
              <FieldLabel htmlFor="relay-lan-port">{t('panel.connection.lanPort')}</FieldLabel>
              <Input
                inputProps={{ id: 'relay-lan-port', inputMode: 'numeric' }}
                value={portText}
                placeholder={t('panel.lanDialog.unchanged')}
                onChange={(event) => setPortText(event.target.value)}
              />
            </Field>
          ) : null}
        </DialogBody>

        {/* 用户要求：改端口这件事平时收起来，点了「修改」才出输入框和这两个按钮。 */}
        {editing ? (
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy === 'lan'}
              onClick={() => {
                setPortText(String(status.lan.requestedPort))
                setEditing(false)
              }}
            >
              {t('panel.common.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={submit}>
              {t('panel.common.save')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

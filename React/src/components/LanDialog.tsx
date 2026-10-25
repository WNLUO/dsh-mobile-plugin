/**
 * 「局域网直连」弹窗：地址与状态是重点，直连端口也归这里改。
 *
 * 地址那一行用共用的 `AddressPicker`：它按检测出来的那一份给标签（局域网 / 公网），并就地能选
 * 「手机优先用哪条」——一台机器好几块网卡时，选中的那条会被宿主排到候选最前（配对卡上是同一个
 * 选择器，两处共用一份口径，免得各写一遍迟早飘开）。
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

import type { AddressBook, ConfigPatch, StatusView } from '../lib/api.ts'
import { lanText, lanTone } from '../lib/format.ts'
import { AddressPicker } from './AddressPicker.tsx'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 宿主在二维码里给的那串地址：拿不到地址库（老宿主）时退回它，只显示不能选。 */
  lanUrls: string[]
  /** 宿主枚举的地址库（`/api/relay/addresses`，带网卡名和当前选中的那条），拿不到就是 null。 */
  addressBook: AddressBook | null
  busy: string
  onSave: (patch: ConfigPatch) => void
  /** 「手机优先用这条」：点了就存、不关窗，所以和上面那个带保存按钮的 `onSave` 分开。 */
  onSavePreferred: (address: string) => void
}

const PORT_MIN = 1024
const PORT_MAX = 65535

/**
 * 局域网直连：地址是这次要看的重点，端口配置也归这里。
 *
 * 为什么把地址从「连接状态」那一行搬进弹窗（用户要求）：一台机器可能同时接了好几个网段，
 * 地址是一串、不是一个，塞进那一行只会把卡片撑变形；端口也一样，它是「直连这件事」的配置，
 * 跟中转地址、配对策略那些没有关系，所以从「中转配置」里挪过来，改完不用在两张窗之间跳。
 *
 * 端口那一行平时只报「当前端口」和一个「修改」文字按钮（用户要求）：这扇窗九成时间是拿来看
 * 地址的，把输入框和保存按钮一直摊着，反而让人以为不改点东西就关不掉。
 */
export function LanDialog({ open, onOpenChange, status, lanUrls, addressBook, busy, onSave, onSavePreferred }: Props) {
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

  function cancelEdit() {
    setPortText(String(status.lan.requestedPort))
    setEditing(false)
  }

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
            {/*
              地址与「手机优先用哪条」合成一行（原来是一个只读列表 + 一个下拉）：它们本来就是
              同一件事——选中的那条要能被认出来，选的动作也得落在同一条上。类型标签与可选范围
              由 AddressPicker 给（局域网 / 公网，与宿主 advertisedCandidates 同口径）。
              直连关着时不摆：那时的地址是残留，选它没有意义。
            */}
            <InfoRow label={t('panel.pairing.phoneAddress')}>
              {status.lan.enabled ? (
                <AddressPicker
                  book={addressBook}
                  port={status.lan.port}
                  value={addressBook?.preferred ?? ''}
                  busy={busy !== ''}
                  onChange={onSavePreferred}
                  fallbackUrls={lanUrls}
                />
              ) : (
                <span className="font-sans text-foreground-muted">{t('panel.onboarding.lanOff')}</span>
              )}
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
            <Button variant="outline" disabled={busy === 'lan'} onClick={cancelEdit}>
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

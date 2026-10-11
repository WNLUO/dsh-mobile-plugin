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

import type { ConfigPatch, StatusView } from '../lib/api.ts'
import { lanText, lanTone } from '../lib/format.ts'
import { InfoList, InfoRow, ToneValue } from './InfoRow.tsx'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  /** 宿主枚举出来的局域网地址（来自 /api/relay/pairing），可能一个都没有。 */
  lanUrls: string[]
  busy: string
  onSave: (patch: ConfigPatch) => void
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
export function LanDialog({ open, onOpenChange, status, lanUrls, busy, onSave }: Props) {
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
          <DialogTitle>局域网直连</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <InfoList>
            <InfoRow label="状态" tone={lanTone(status.lan.state, status.lan.enabled)}>
              <ToneValue
                tone={lanTone(status.lan.state, status.lan.enabled)}
                text={lanText(status.lan.state, status.lan.enabled)}
                {...(status.lan.error ? { detail: status.lan.error } : {})}
              />
            </InfoRow>
            <InfoRow label="局域网地址" mono>
              {lanUrls.length > 0 ? (
                <span className="flex flex-col items-end gap-0.5">
                  {lanUrls.map((url) => (
                    <span key={url}>{url}</span>
                  ))}
                </span>
              ) : (
                <span className="font-sans text-foreground-muted">
                  {status.lan.enabled ? '还没取到，关掉再打开这扇窗会重取一次' : '局域网直连已关闭'}
                </span>
              )}
            </InfoRow>
            <InfoRow label="当前端口" mono>
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <span>{status.lan.enabled ? status.lan.port : '—'}</span>
                {status.lan.enabled && status.lan.adjusted ? (
                  <span className="font-sans text-xs text-foreground-muted">（首选端口被占用，已自动改用）</span>
                ) : null}
                {editing ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                    修改
                  </Button>
                )}
              </span>
            </InfoRow>
          </InfoList>

          {editing ? (
            <Field>
              <FieldLabel htmlFor="relay-lan-port">局域网端口</FieldLabel>
              <Input
                inputProps={{ id: 'relay-lan-port', inputMode: 'numeric' }}
                value={portText}
                placeholder="留空表示不改动"
                onChange={(event) => setPortText(event.target.value)}
              />
            </Field>
          ) : null}
        </DialogBody>

        {/* 用户要求：改端口这件事平时收起来，点了「修改」才出输入框和这两个按钮。 */}
        {editing ? (
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy === 'lan'} onClick={cancelEdit}>
              取消
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={submit}>
              保存
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

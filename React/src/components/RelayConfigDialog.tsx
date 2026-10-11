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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@appica/ui-react/select'
import { Switch } from '@appica/ui-react/switch'
import { useEffect, useState } from 'react'

import type { ConfigPatch, PairingPolicy, StatusView } from '../lib/api.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
  onSave: (patch: ConfigPatch) => void
}

// Base UI 的 Select.Value 拿不到 items 就只肯显示原始值（会显示成 code），
// 所以这里必须把「值 → 标签」再写一遍给它。
const PAIRING_POLICY_ITEMS: { value: PairingPolicy; label: string }[] = [
  { value: 'code', label: '凭配对码允许' },
  { value: 'deny', label: '一律拒绝新设备' },
]

/**
 * 中转配置。原来是常驻的一张卡，现在收进弹窗：这些值改一次就很少再动，
 * 摆在页面上占掉半屏。
 *
 * 按用户要求，窗里只留标签和控件，一句说明文字都不留（连标题下那句也删了）：
 * 这些字段的意思对用的人来说是自明的，说明文字只会把弹窗撑高。
 * 唯一的例外是「留空表示不改动」——那是注册密钥输入框的 placeholder，属于控件本身。
 *
 * 局域网端口按用户要求挪到「局域网直连」弹窗：它是直连自己的配置，跟中转地址、
 * 配对策略这些不是一回事，跟着直连的地址一起看才顺手。
 */
export function RelayConfigDialog({ open, onOpenChange, status, busy, onSave }: Props) {
  const [name, setName] = useState(status.name)
  const [relayUrl, setRelayUrl] = useState(status.relayUrl)
  const [lanEnabled, setLanEnabled] = useState(status.lan.enabled)
  const [pairingPolicy, setPairingPolicy] = useState<PairingPolicy>(status.pairingPolicy)
  const [registerSecret, setRegisterSecret] = useState('')

  // 只在开窗那一刻灌一次当前值：status 每 3 秒换一个对象，
  // 把它当依赖会让正在敲的字被轮询覆盖掉。
  useEffect(() => {
    if (!open) return
    setName(status.name)
    setRelayUrl(status.relayUrl)
    setLanEnabled(status.lan.enabled)
    setPairingPolicy(status.pairingPolicy)
    setRegisterSecret('')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上：只认 open
  }, [open])

  const secretDirty = registerSecret.trim() !== ''
  const canSave = name.trim() !== '' && busy === ''

  function submit() {
    if (!canSave) return
    const patch: ConfigPatch = {
      name: name.trim(),
      relayUrl: relayUrl.trim(),
      lanEnabled,
      pairingPolicy,
    }
    // 密钥是敏感值：留空表示「不动它」，绝不把空串写回去（那等于关掉注册密钥）。
    if (secretDirty) patch.registerSecret = registerSecret.trim()
    onSave(patch)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>中转配置</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="relay-name">设备名</FieldLabel>
            <Input
              inputProps={{ id: 'relay-name' }}
              value={name}
              placeholder="手机里显示的名字"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="relay-url">中转地址</FieldLabel>
            <Input
              inputProps={{ id: 'relay-url', className: 'font-mono' }}
              value={relayUrl}
              placeholder="https://example.com"
              onChange={(event) => setRelayUrl(event.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-md bg-background-muted px-3 py-2">
            <div className="text-sm text-foreground">局域网直连</div>
            <Switch
              size="md"
              checked={lanEnabled}
              onCheckedChange={setLanEnabled}
              aria-label="局域网直连"
            />
          </div>

          <Field>
            <FieldLabel>配对策略</FieldLabel>
            <Select
              items={PAIRING_POLICY_ITEMS}
              value={pairingPolicy}
              onValueChange={(value) => setPairingPolicy(value as PairingPolicy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">凭配对码允许</SelectItem>
                <SelectItem value="deny">一律拒绝新设备</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="relay-register-secret">注册密钥</FieldLabel>
            <Input
              type="password"
              inputProps={{ id: 'relay-register-secret' }}
              value={registerSecret}
              placeholder="留空表示不改动"
              onChange={(event) => setRegisterSecret(event.target.value)}
              clearable
              onClear={() => setRegisterSecret('')}
            />
          </Field>
        </DialogBody>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy === 'config'} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

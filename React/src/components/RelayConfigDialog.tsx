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
import { useEffect, useRef, useState } from 'react'

import type { ConfigPatch, PairingPolicy, StatusView } from '../lib/api.ts'
import { PUBLIC_RELAYS } from '../lib/links.ts'
import { t } from '../lib/i18n/index.ts'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: StatusView
  busy: string
  onSave: (patch: ConfigPatch) => void
}

// Base UI 的 Select.Value 拿不到 items 就只肯显示原始值（会显示成 code），
// 所以这里必须把「值 → 标签」再写一遍给它。
const PAIRING_POLICY_ITEMS: { value: PairingPolicy; labelKey: string }[] = [
  { value: 'code', labelKey: 'panel.pairing.policyCode' },
  { value: 'deny', labelKey: 'panel.pairing.policyDeny' },
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
  /** 弹窗打开时的落焦目标：容器自己，不是第一个输入框（见下面 `initialFocus`）。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)

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
      {/* `initialFocus` 指向弹窗容器本身：Base UI 默认会把焦点放到第一个可聚焦元素上，
          这里就是「设备名」那个输入框——一打开就选中了、光标在闪，用户想先点别的地方
          还得先把它点掉。焦点仍旧进到弹窗里（读屏与 Esc 都靠它），只是不落在输入框。 */}
      <DialogContent className="max-w-xl" initialFocus={dialogRef}>
        <DialogHeader>
          <DialogTitle>{t('panel.connection.relayUrl')}</DialogTitle>
        </DialogHeader>

        {/* `tabIndex={-1}` 让容器可以被程序聚焦（且不进 Tab 顺序）。
            套一层 div 是因为 `DialogBody` 不接受 ref。 */}
        <div ref={dialogRef} tabIndex={-1} className="outline-none">
        <DialogBody className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="relay-name">{t('panel.connection.deviceName')}</FieldLabel>
            <Input
              inputProps={{ id: 'relay-name' }}
              value={name}
              placeholder={t('panel.relay.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="relay-url">{t('panel.connection.relayUrl')}</FieldLabel>
            <Input
              inputProps={{ id: 'relay-url', className: 'font-mono' }}
              value={relayUrl}
              placeholder="https://example.com"
              onChange={(event) => setRelayUrl(event.target.value)}
            />
            {/* 公用中转的入口清单。引导页里那条是自动填好的，用户从没记过地址，
                进了主界面想换回来只能凭记忆敲——所以这里把清单摆出来点选。
                清单与引导页共用 `PUBLIC_RELAYS`，加一台两边自动跟上；
                数量会涨，所以定高滚动，别把弹窗顶长。
                点一下只填地址，不改其它字段——「保存配置」才真正落盘。 */}
            <div className="mt-1.5 rounded-md bg-background-muted px-3 py-2">
              <p className="text-xs text-foreground-muted">{t('panel.links.publicRelay')}</p>
              <div className="mt-1 max-h-[112px] overflow-y-auto">
                <div className="flex flex-col gap-0.5">
                  {PUBLIC_RELAYS.map((item) => {
                    const picked = relayUrl.trim() === item.url
                    return (
                      <button
                        key={item.url}
                        type="button"
                        onClick={() => setRelayUrl(item.url)}
                        className={`flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-left ${
                          picked ? 'bg-background' : 'hover:bg-background'
                        }`}
                      >
                        <span className="font-mono text-xs text-foreground">{item.url}</span>
                        <span className="shrink-0 text-xs text-foreground-muted">
                          {picked ? t('panel.relay.selected') : t(item.nameKey)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRelayUrl('')}
                disabled={relayUrl.trim() === ''}
                className="mt-1.5 text-xs text-foreground-muted underline-offset-2 hover:underline disabled:opacity-40"
              >
                {t('panel.relay.clear')}
              </button>
            </div>
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-md bg-background-muted px-3 py-2">
            <div className="text-sm text-foreground">{t('panel.connection.lan')}</div>
            <Switch
              size="md"
              checked={lanEnabled}
              onCheckedChange={setLanEnabled}
              aria-label={t('panel.connection.lan')}
            />
          </div>

          <Field>
            <FieldLabel>{t('panel.pairing.policy')}</FieldLabel>
            <Select
              items={PAIRING_POLICY_ITEMS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
              value={pairingPolicy}
              onValueChange={(value) => setPairingPolicy(value as PairingPolicy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">{t('panel.pairing.policyCode')}</SelectItem>
                <SelectItem value="deny">{t('panel.pairing.policyDeny')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="relay-register-secret">{t('panel.connection.registerSecret')}</FieldLabel>
            <Input
              type="password"
              inputProps={{ id: 'relay-register-secret' }}
              value={registerSecret}
              placeholder={t('panel.lanDialog.unchanged')}
              onChange={(event) => setRegisterSecret(event.target.value)}
              clearable
              onClear={() => setRegisterSecret('')}
            />
          </Field>
        </DialogBody>
        </div>

        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy === 'config'} onClick={() => onOpenChange(false)}>
            {t('panel.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={submit}>
            {t('panel.relay.saveConfig')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
